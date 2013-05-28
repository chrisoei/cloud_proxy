#!/usr/bin/env node

var crypto = require('crypto');
var exec = require('child_process').exec;
var express = require('express');
var fs = require('fs');
var gpg = require('gpg');
var growl = require('growl');
var https = require('https');
var logger = require('./logger');
var redis = require('redis').createClient();
var spawn = require('child_process').spawn;

var config = require('./config');

(function(S3Proxy) {

    S3Proxy.mimeType = function(fn, callback) {
        var match = /\.(\w+)(\.gpg)?$/.exec(fn);
        match ?
            redis.hget('io.oei:mime-types', match[1], callback) :
            callback(config.defaultMimeType);
    };

    S3Proxy.notify = function(s) {
        growl(s, {
            title: 'S3proxy'
        });
    };

    S3Proxy.parseRequest = function(request, response, callback) {
        job = {
            request: request,
            response: response
        };
        job.region = job.request.params[0];
        job.bucket = job.request.params[1];
        job.key = job.request.params[2];
        job.path = job.bucket + '/' + job.key;
        var sha256 = crypto.createHash('sha256');
        sha256.write(job.path);
        job.filename = config.cacheDir + '/' + sha256.digest('hex');
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
        return job.url = [
                '/',
            job.bucket, '/',
            job.key,
                '?AWSAccessKeyId=', config.awsId,
                '&Expires=', expires,
                '&Signature=', signature
        ].join('');
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

    S3Proxy.sendUnencryptedFile = function(job) {
        logger.debug("Transmitting file " + job.transmitFilename);
        fs.stat(job.transmitFilename, function(err, stats) {
            job.response.setHeader('Content-Length', stats.size);
            fs.createReadStream(job.transmitFilename).pipe(job.response);
        });
    };

    S3Proxy.setAndSend = function(job) {
        job.contents = (job.contents === undefined) ? '' : job.contents;
        logger.debug('job.contents.length = ' + job.contents.length);
        job.response.setHeader('Content-Length', job.contents.length);
        job.response.end(job.contents);
    };

    S3Proxy.processS3Response = function(job) {
        logger.info("Got response from s3: " + job.proxy_res.statusCode);

        if (job.proxy_res.statusCode === 200) {
            var ws = fs.createWriteStream(job.filename);

            job.proxy_res.on('data', function(d) {
                ws.write(d);
                logger.debug("Received S3 data with length " + d.length);
            });

            job.proxy_res.on('error', function() {
                console.error("In-transit error");
                ws.end(function() {
                    fs.unlink(job.filename);
                });
            });

            job.proxy_res.on('close', function() {
               console.error("S3 closed connection");
                ws.end(function() {
                    fs.unlink(job.filename);
                });
            });

            job.proxy_res.on('end', function() {
                logger.debug("S3 stream ended");
                ws.end(function() {
                    S3Proxy.sendFile(job);
                });
            });
        } else {
            job.response.statusCode = 404;;
            job.response.end();
            S3Proxy.notify("ERROR (" + job.proxy_response.statusCode + ") " +
                path);
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
            }, function(proxy_res) {
                job.proxy_res = proxy_res;
                S3Proxy.processS3Response(job);
            }).on('close', function() {
                console.error("connection closed");
                job.response.end();
            }).on('timeout', function() {
                console.error("s3 timeout");
            }).on('error', function(error) {
                console.error("error: ", error);
                job.response.statusCode = 404;
                job.response.end();
                S3Proxy.notify("ERROR " + job.path);
            });
        }
    };

    S3Proxy.app = express();

    S3Proxy.app.get(config.urlRegexp, function(req, res) {

        S3Proxy.parseRequest(req, res, function(job) {

            var remoteAddress = req.connection.remoteAddress;
            logger.info("Got request from ", remoteAddress);
            if (remoteAddress !== '127.0.0.1') {
                S3Proxy.notify(remoteAddress + " GET " + path);
            }

            S3Proxy.mimeType(job.key, function(err, mt) {
                job.response.setHeader('Content-Type', mt);
                S3Proxy.sendResponseBody(job);
            });
        });
    });

    S3Proxy.app.delete(config.urlRegexp, function(req, res) {
        S3Proxy.parseRequest(req, res, function(job) {
            logger.info("Got delete ", job.path);
            fs.unlink(job.filename, function() {
                S3Proxy.notify("DELETE " + job.path);
            });
            fs.exists(job.filename + '.tmp', function(answer) {
                if (answer) fs.unlink(job.filename + '.tmp');
            });
            job.response.end();
        });
    });

    S3Proxy.start = function() {
        if (config.checkConfig()) {
            https.createServer({
                key: fs.readFileSync(config.serverKeyFile),
                cert: fs.readFileSync(config.serverCertificateFile)
            }, S3Proxy.app).listen(config.port);

            S3Proxy.notify('Listening on port ' + config.port);
        }
    };

})(exports);
