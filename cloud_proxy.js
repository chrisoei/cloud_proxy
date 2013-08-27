#!/usr/bin/env node

var cacheFile = require('./cache_file');
var crypto = require('crypto');
var express = require('express');
var fs = require('fs');
var https = require('https');
var logger = require('./logger');
var spawn = require('child_process').spawn;

var config = require('./config');

(function (CloudProxy) {
    'use strict';

    function mimeType(fn, callback) {
        var match = /\.(\w+)(\.gpg)?$/.exec(fn);
        match ?
            callback(null, CloudProxy.mimeTypes[match[1]]) :
            callback(null, config.defaultMimeType);
    }

    function sha256hash(s) {
        var sha256 = crypto.createHash('sha256');
        sha256.write(s);
        return sha256.digest('hex');
    }

    var s3 = {};
    var youtube = {};

    function parseCommon(verb, request, response) {
        var job = {
            request: request,
            response: response,
            verb: verb
        };

        if ((request.cookies.auth !== config.authCookie) && (request.path !== config.authPath)) {
            sendEmpty(job, 404);
            return false;
        }
        logger.info("Got " + verb + " request from " + request.connection.remoteAddress);
        return job;
    }

    function fileFromPath(svc, path) {
        var hexDigest = sha256hash(path);
        var dirs = cacheFile.cacheDir(2)(hexDigest);
        return cacheFile.mkpath(config.cacheDir + '/' + svc, dirs) + '/' + hexDigest;
    }

    s3.parseRequest = function (verb, request, response, callback) {

        var job = parseCommon(verb, request, response);

        job.region = job.request.params[0];
        job.bucket = job.request.params[1];
        job.key = job.request.params[2];
        job.path = job.bucket + '/' + job.key;
        job.filename = fileFromPath('s3', job.path);
        callback(job);
    };

    youtube.parseRequest = function (verb, request, response, callback) {
        var job = parseCommon(verb, request, response);
        job.path = job.key = job.request.params[0];
        job.filename = fileFromPath('youtube', job.path);
        callback(job);
    };

    function s3url(job) {
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
    }

    function sendEmpty(job, responseCode) {
        job.response.setHeader('Content-Length', 0);
        job.response.statusCode = responseCode;
        job.response.end();
    }

    function sendFile(job) {
        if (/\.gpg$/.test(job.key)) {
            sendEncryptedFile(job);
        } else if (job.proxyRes && (job.proxyRes.headers['x-amz-meta-openssl'] == 'aes-256-cbc')) {
            sendAESEncryptedFile(job);
        } else {
            job.transmitFilename = job.filename;
            sendUnencryptedFile(job);
        }
    }

    function sendEncryptedFile(job) {
        logger.debug("Sending encrypted file " + job.filename);
        job.transmitFilename = job.filename + ".tmp";
        if (fs.existsSync(job.transmitFilename)) {
            sendUnencryptedFile(job);
        } else {
            var gpg = spawn('gpg', [  '--output', job.transmitFilename, '--decrypt', job.filename ]);
            gpg.on('exit', function () {
                sendUnencryptedFile(job);
            });
        }
    }

    function sendAESEncryptedFile(job) {
        logger.debug("Sending AES-256 encrypted file " + job.filename);
        fs.renameSync(job.filename, job.filename + ".enc");
        job.transmitFilename = job.filename;
        if (fs.existsSync(job.transmitFilename)) {
            sendUnencryptedFile(job);
        } else {
            var openssl = spawn('openssl', [ 'enc', '-d', '-aes-256-cbc', '-pass', 'env:CLOUD_PROXY_AES_KEY',
                '-in', job.filename + ".enc", '-out', job.transmitFilename ]);
            openssl.on('exit', function () {
                fs.unlinkSync(job.filename + ".enc");
                sendUnencryptedFile(job);
            });
        }
    }

    function starDate(d) {
        var y = d.getUTCFullYear();
        var t0 = Date.UTC(y, 0, 1, 0, 0, 0, 0);
        var t1 = Date.UTC(y + 1, 0, 1, 0, 0, 0, 0);
        var t = Date.UTC(y, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(),
            d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
        return (y + (t - t0) / (t1 - t0)).toFixed(15);
    }

    function sendUnencryptedFile(job) {
        logger.debug("Transmitting file " + job.transmitFilename);
        fs.stat(job.transmitFilename, function (err, stats) {
            job.response.setHeader('X-Cache-File', job.transmitFilename);
            job.response.setHeader('X-Cache-File-Date', stats.mtime.toString());
            job.response.setHeader('X-Cache-File-Stardate', starDate(stats.mtime));

            if (job.verb === 'HEAD') {
                job.response.setHeader('X-Cache-File-Size', stats.size);
                sendEmpty(job, 200);
            } else {
                if (job.request.headers.range) {
                    job.response.statusCode = 206;
                    var tmp = job.request.headers.range.match(/bytes=(\d*)-(\d*)/);
                    var startByte = parseInt(tmp[1], 10) || 0;
                    var endByte = parseInt(tmp[2], 10) || (stats.size - 1);
                    job.response.setHeader('Accept-Ranges', 'bytes');
                    job.response.setHeader('Content-Length', endByte - startByte + 1);
                    job.response.setHeader('Content-Range', 'bytes ' + startByte + '-' + endByte + '/' + stats.size);
                    fs.createReadStream(job.transmitFilename, { start: startByte, end: endByte }).pipe(job.response);
                } else {
                    job.response.statusCode = 200;
                    job.response.setHeader('Content-Length', stats.size);
                    fs.createReadStream(job.transmitFilename).pipe(job.response);
                }
            }
        });
    }

    function processS3Response(job) {
        logger.info("Got response from s3: " + job.proxyRes.statusCode);

        if (job.proxyRes.statusCode === 200) {
            var ws = fs.createWriteStream(job.filename);

            job.proxyRes.on('data', function (d) {
                ws.write(d);
                logger.debug("Received S3 data with length " + d.length);
            });

            job.proxyRes.on('error', function () {
                logger.error("In-transit error");
                ws.end(function () {
                    fs.unlink(job.filename);
                    sendEmpty(job, 404);
                });
            });

            job.proxyRes.on('close', function () {
                logger.error("S3 closed connection");
                ws.end(function () {
                    fs.unlink(job.filename);
                    sendEmpty(job, 404);
                });
            });

            job.proxyRes.on('end', function () {
                logger.info("S3 stream ended");
                ws.end(function () {
                    sendFile(job);
                });
            });
        } else {
            sendEmpty(job, job.proxyRes.statusCode);
            logger.error("ERROR (" + job.path + ")");
        }
    }

    youtube.sendResponseBody = function (job) {
        if (fs.existsSync(job.filename)) {
            logger.info('Cache hit: ' + job.path + ' = ' + job.filename);
            sendFile(job);
        } else {
            logger.info('Requesting from youtube: ' + job.path);
            spawn('youtube-dl', [ '--prefer-free-formats', 'http://www.youtube.com/watch?v=' + job.path, '--output', job.filename ]).on('exit',
                function () {
                    sendFile(job);
                });
        }
    };

    s3.sendResponseBody = function (job) {
        if (fs.existsSync(job.filename)) {
            logger.info("Cache hit: " + job.path + " = " + job.filename);
            sendFile(job);
        } else {

            s3url(job);

            logger.info('Requesting from s3: ' + job.path);

            https.get({
                host: job.host,
                path: job.url
            },function (proxyRes) {
                job.proxyRes = proxyRes;
                processS3Response(job);
            }).on('close',function () {
                    logger.error("connection closed");
                }).on('timeout',function () {
                    sendEmpty(job, 404);
                    logger.error("s3 timeout");
                }).on('error', function (error) {
                    logger.error("error: " + error);
                    sendEmpty(job, 404);
                    logger.error("ERROR " + job.path);
                });
        }
    };

    CloudProxy.app = express();

    CloudProxy.app.use(express.cookieParser());

    CloudProxy.app.get(config.s3urlRegexp, function (req, res) {

        s3.parseRequest('GET', req, res, function (job) {

            mimeType(job.key, function (err, mt) {
                job.response.setHeader('Content-Type', mt);
                s3.sendResponseBody(job);
            });
        });
    });

    CloudProxy.app.get(config.youtubeRegexp, function (req, res) {

        youtube.parseRequest('GET', req, res, function (job) {

            mimeType('file.webm', function (err, mt) {
                job.response.setHeader('Content-Type', mt);
                youtube.sendResponseBody(job);
            });
        });
    });

    CloudProxy.app.head(config.s3urlRegexp, function (req, res) {

        s3.parseRequest('HEAD', req, res, function (job) {
            job.response.setHeader('Content-Type', 'text/plain');
            s3.sendResponseBody(job);

        });
    });

    CloudProxy.app.head(config.youtubeRegexp, function (req, res) {

        youtube.parseRequest('HEAD', req, res, function (job) {
            job.response.setHeader('Content-Type', 'text/plain');
            youtube.sendResponseBody(job);

        });
    });

    CloudProxy.app.delete(config.s3urlRegexp, function (req, res) {
        s3.parseRequest('DELETE', req, res, function (job) {
            logger.info("Got delete " + job.path);
            fs.unlink(job.filename, function () {
                logger.warn("DELETE " + job.path);
            });
            fs.exists(job.filename + '.tmp', function (answer) {
                if (answer) {
                    fs.unlink(job.filename + '.tmp');
                }
            });
            sendEmpty(job, 200);
        });
    });

    CloudProxy.app.delete(config.youtubeRegexp, function (req, res) {
        youtube.parseRequest('DELETE', req, res, function (job) {
            logger.info("Got delete " + job.path);
            fs.unlink(job.filename, function () {
                logger.warn("DELETE " + job.path);
            });
            sendEmpty(job, 200);
        });
    });

    CloudProxy.start = function () {
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
