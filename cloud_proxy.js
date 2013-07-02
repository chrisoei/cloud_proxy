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

(function(CloudProxy) {
    'use strict';

    CloudProxy.mimeType = function(fn, callback) {
        var match = /\.(\w+)(\.gpg)?$/.exec(fn);
        match ?
            callback(null, CloudProxy.mimeTypes[match[1]]) :
            callback(null, config.defaultMimeType);
    };

    CloudProxy.parseRequest = function(verb, request, response, callback) {
        var job = {
            request: request,
            response: response,
            verb: verb
        };

        if ((request.cookies.auth !== config.authCookie) && (request.path !== config.authPath)) {
          CloudProxy.sendEmpty(job, 404);
          return false;
        }

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

    CloudProxy.s3url = function(job) {
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

    CloudProxy.sendEmpty = function(job, responseCode) {
        job.response.setHeader('Content-Length', 0);
        job.response.statusCode = responseCode;
        job.response.end();
    };

    CloudProxy.sendFile = function(job) {
        if (/\.gpg$/.test(job.key)) {
            CloudProxy.sendEncryptedFile(job);
        } else {
            job.transmitFilename = job.filename;
            CloudProxy.sendUnencryptedFile(job);
        }
    };

    CloudProxy.sendEncryptedFile = function(job) {
        logger.debug("Sending encrypted file " + job.filename);
        job.transmitFilename = job.filename + ".tmp";
        if (fs.existsSync(job.transmitFilename)) {
            CloudProxy.sendUnencryptedFile(job);
        } else {
            var gpg = spawn('gpg', [  '--output', job.transmitFilename, '--decrypt', job.filename ]);
            gpg.on('exit', function() {
                CloudProxy.sendUnencryptedFile(job);
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

    CloudProxy.sendUnencryptedFile = function(job) {
        logger.debug("Transmitting file " + job.transmitFilename);
        fs.stat(job.transmitFilename, function(err, stats) {
            job.response.setHeader('X-Cache-File', job.transmitFilename);
            job.response.setHeader('X-Cache-File-Date', stats.mtime.toString());
            job.response.setHeader('X-Cache-File-Stardate', starDate(stats.mtime));

            if (job.verb === 'HEAD') {
                job.response.setHeader('X-Cache-File-Size', stats.size);
                CloudProxy.sendEmpty(job, 200);
            } else {
                job.response.setHeader('Content-Length', stats.size);
                fs.createReadStream(job.transmitFilename).pipe(job.response);
            }
        });
    };

    CloudProxy.processS3Response = function(job) {
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
                    CloudProxy.sendEmpty(job, 404);
                });
            });

            job.proxyRes.on('close', function() {
                logger.error("S3 closed connection");
                ws.end(function() {
                    fs.unlink(job.filename);
                    CloudProxy.sendEmpty(job, 404);
                });
            });

            job.proxyRes.on('end', function() {
                logger.info("S3 stream ended");
                ws.end(function() {
                    CloudProxy.sendFile(job);
                    spawn('meta', [ 'checksum', job.filename ]);
                });
            });
        } else {
            CloudProxy.sendEmpty(job, job.proxyRes.statusCode);
            logger.error("ERROR (" + job.path + ")");
        }
    };

    CloudProxy.sendResponseBody = function(job) {
        if (fs.existsSync(job.filename)) {
            logger.info("Cache hit: " + job.path + " = " + job.filename);
            CloudProxy.sendFile(job);
        } else {

            CloudProxy.s3url(job);

            logger.info('Requesting from s3: ' + job.path);

            https.get({
                host: job.host,
                path: job.url
            }, function(proxyRes) {
                job.proxyRes = proxyRes;
                CloudProxy.processS3Response(job);
            }).on('close', function() {
                logger.error("connection closed");
            }).on('timeout', function() {
                CloudProxy.sendEmpty(job, 404);
                logger.error("s3 timeout");
            }).on('error', function(error) {
                logger.error("error: " + error);
                CloudProxy.sendEmpty(job, 404);
                logger.error("ERROR " + job.path);
            });
        }
    };

    CloudProxy.app = express();

    CloudProxy.app.use(express.cookieParser());

    CloudProxy.app.get(config.urlRegexp, function(req, res) {

        CloudProxy.parseRequest('GET', req, res, function(job) {

            CloudProxy.mimeType(job.key, function(err, mt) {
                job.response.setHeader('Content-Type', mt);
                CloudProxy.sendResponseBody(job);
            });
        });
    });

    CloudProxy.app.head(config.urlRegexp, function(req, res) {

        CloudProxy.parseRequest('HEAD', req, res, function(job) {
            job.response.setHeader('Content-Type', 'text/plain');
            CloudProxy.sendResponseBody(job);

        });
    });

    CloudProxy.app.delete(config.urlRegexp, function(req, res) {
        CloudProxy.parseRequest('DELETE', req, res, function(job) {
            logger.info("Got delete " + job.path);
            fs.unlink(job.filename, function() {
                logger.warn("DELETE " + job.path);
            });
            fs.exists(job.filename + '.tmp', function(answer) {
                if (answer) { fs.unlink(job.filename + '.tmp'); }
            });
            CloudProxy.sendEmpty(job, 200);
        });
    });

    CloudProxy.start = function() {
        if (config.checkConfig()) {

            CloudProxy.mimeTypes = JSON.parse(
                fs.readFileSync(config.mimeTypesFile));
            https.createServer({
                key: fs.readFileSync(config.serverKeyFile),
                cert: fs.readFileSync(config.serverCertificateFile)
            }, CloudProxy.app).listen(config.port);

            logger.warn('Listening on port ' + config.port);
        }
    };

})(exports = module.exports);
