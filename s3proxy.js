#!/usr/bin/env node

var _ = require('lodash');
var cacheFile = require('./cache_file');
var crypto = require('crypto');
var express = require('express');
var fs = require('fs');
var https = require('https');
var logger = require('./logger');
var redis = require('redis').createClient();
var spawn = require('child_process').spawn;

var config = require('./config');

(function(S3Proxy) {
    'use strict';

    S3Proxy.mimeType = function(fn, callback) {
        var match = /\.(\w+)(\.gpg)?$/.exec(fn);
        match ?
            redis.hget('io.oei:mime-types', match[1], callback) :
            callback(config.defaultMimeType);
    };

    S3Proxy.parseRequest = function(verb, request, response, callback) {
        var job = {
            request: request,
            response: response,
            verb: verb
        };
        job.region = job.request.params[0];
        job.bucket = job.request.params[1];
        job.key = job.request.params[2];
        job.path = job.bucket + '/' + job.key;
        var sha256 = crypto.createHash('sha256');
        sha256.write(job.path);
        var hexDigest = sha256.digest('hex');
        var dirs = cacheFile.cacheDir(2)(hexDigest);
        job.filename = cacheFile.mkpath(config.cacheDir, dirs) + '/' + hexDigest;

        var remoteAddress = request.connection.remoteAddress;
        logger.info("Got " + verb + " request from " + remoteAddress);
        if (!_.contains([ '127.0.0.1', '192.168.1.102' ], remoteAddress)) {
            logger.warn(remoteAddress + " " + verb + " " + job.path);
        }
        callback(job);
    };

    S3Proxy.s3url = function(job) {
        job.host = "s3-" + job.region + ".amazonaws.com";
        var expires = ((new Date()).getTime() / 1000 + config.defaultExpiration).toFixed(0);
        var stringToSign = [
                'GET',
                '',
                '',
                expires,
                '/' + job.bucket + '/' + job.key
            ].join("\n");
        var hmac = crypto.createHmac('sha1', config.awsKey);
        hmac.write(stringToSign);
        var signature = encodeURIComponent(hmac.digest('base64'));
        job.url = [
                '/',
                job.bucket, '/',
                job.key,
                '?AWSAccessKeyId=', config.awsId,
                '&Expires=', expires,
                '&Signature=', signature
            ].join('');
    };

    S3Proxy.sendEmpty = function(job, responseCode) {
        job.response.setHeader('Content-Length', 0);
        job.response.statusCode = responseCode;
        job.response.end();
    };

    S3Proxy.sendFile = function(job) {
        if (/\.gpg$/.test(job.key)) {
            S3Proxy.sendEncryptedFile(job);
        } else {
            job.transmitFilename = job.filename;
            S3Proxy.sendUnencryptedFile(job);
        }
    };

    S3Proxy.sendEncryptedFile = function(job) {
        logger.debug("Sending encrypted file " + job.filename);
        job.transmitFilename = job.filename + ".tmp";
        if (fs.existsSync(job.transmitFilename)) {
            S3Proxy.sendUnencryptedFile(job);
        } else {
            var gpg = spawn('gpg', [  '--output', job.transmitFilename, '--decrypt', job.filename ]);
            gpg.on('exit', function() {
                S3Proxy.sendUnencryptedFile(job);
            });
        }
    };

    function starDate(d) {
        var y = d.getUTCFullYear();
        var t0 = Date.UTC(y, 0, 1, 0, 0, 0, 0);
        var t1 = Date.UTC(y + 1, 0, 1, 0, 0, 0, 0);
        var t = Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(),
            d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
        return (y + (t - t0) / (t1 - t0)).toFixed(15);
    }

    S3Proxy.sendUnencryptedFile = function(job) {
        logger.debug("Transmitting file " + job.transmitFilename);
        fs.stat(job.transmitFilename, function(err, stats) {
            job.response.setHeader('X-Cache-File', job.transmitFilename);
            job.response.setHeader('X-Cache-File-Date', stats.mtime.toString());
            job.response.setHeader('X-Cache-File-Stardate', starDate(stats.mtime));

            if (job.verb === 'HEAD') {
                job.response.setHeader('X-Cache-File-Size', stats.size);
                S3Proxy.sendEmpty(job, 200);
            } else {
                job.response.setHeader('Content-Length', stats.size);
                fs.createReadStream(job.transmitFilename).pipe(job.response);
            }
        });
    };

    S3Proxy.processS3Response = function(job) {
        logger.info("Got response from s3: " + job.proxyRes.statusCode);

        if (job.proxyRes.statusCode === 200) {
            var ws = fs.createWriteStream(job.filename);

            job.proxyRes.on('data', function(d) {
                ws.write(d);
                logger.debug("Received S3 data with length " + d.length);
            });

            job.proxyRes.on('error', function() {
                logger.error("In-transit error");
                ws.end(function() {
                    fs.unlink(job.filename);
                    S3Proxy.sendEmpty(job, 404);
                });
            });

            job.proxyRes.on('close', function() {
                logger.error("S3 closed connection");
                ws.end(function() {
                    fs.unlink(job.filename);
                    S3Proxy.sendEmpty(job, 404);
                });
            });

            job.proxyRes.on('end', function() {
                logger.info("S3 stream ended");
                ws.end(function() {
                    S3Proxy.sendFile(job);
                    spawn('meta', [ 'checksum', job.filename ]);
                });
            });
        } else {
            S3Proxy.sendEmpty(job, job.proxyRes.statusCode);
            logger.error("ERROR (" + job.path + ")");
        }
    };

    S3Proxy.sendResponseBody = function(job) {
        if (fs.existsSync(job.filename)) {
            logger.info("Cache hit: " + job.path + " = " + job.filename);
            S3Proxy.sendFile(job);
        } else {

            S3Proxy.s3url(job);

            logger.info('Requesting from s3: ' + job.path);

            https.get({
                host: job.host,
                path: job.url
            }, function(proxyRes) {
                job.proxyRes = proxyRes;
                S3Proxy.processS3Response(job);
            }).on('close', function() {
                logger.error("connection closed");
                S3Proxy.sendEmpty(job, 404);
            }).on('timeout', function() {
                S3Proxy.sendEmpty(job, 404);
                logger.error("s3 timeout");
            }).on('error', function(error) {
                logger.error("error: " + error);
                S3Proxy.sendEmpty(job, 404);
                logger.error("ERROR " + job.path);
            });
        }
    };

    S3Proxy.app = express();

    S3Proxy.app.get(config.urlRegexp, function(req, res) {

        S3Proxy.parseRequest('GET', req, res, function(job) {

            S3Proxy.mimeType(job.key, function(err, mt) {
                job.response.setHeader('Content-Type', mt);
                S3Proxy.sendResponseBody(job);
            });
        });
    });

    S3Proxy.app.head(config.urlRegexp, function(req, res) {

        S3Proxy.parseRequest('HEAD', req, res, function(job) {
            job.response.setHeader('Content-Type', 'text/plain');
            S3Proxy.sendResponseBody(job);

        });
    });

    S3Proxy.app.delete(config.urlRegexp, function(req, res) {
        S3Proxy.parseRequest('DELETE', req, res, function(job) {
            logger.info("Got delete " + job.path);
            fs.unlink(job.filename, function() {
                logger.warn("DELETE " + job.path);
            });
            fs.exists(job.filename + '.tmp', function(answer) {
                if (answer) { fs.unlink(job.filename + '.tmp'); }
            });
            S3Proxy.sendEmpty(job, 200);
        });
    });

    S3Proxy.start = function() {
        if (config.checkConfig()) {
            https.createServer({
                key: fs.readFileSync(config.serverKeyFile),
                cert: fs.readFileSync(config.serverCertificateFile)
            }, S3Proxy.app).listen(config.port);

            logger.warn('Listening on port ' + config.port);
        }
    };

})(exports = module.exports);
