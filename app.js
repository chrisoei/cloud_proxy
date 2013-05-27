#!/usr/bin/env node

var crypto = require('crypto');
var exec = require('child_process').exec;
var express = require('express');
var fs = require('fs');
var gpg = require('gpg');
var growl = require('growl');
var https = require('https');
var redis = require('redis').createClient();

(function(S3Proxy) {

    S3Proxy.defaultMimeType = 'text/html';
    S3Proxy.awsId = process.env.AWS_ACCESS_KEY_ID;
    S3Proxy.awsKey = process.env.AWS_SECRET_ACCESS_KEY;
    S3Proxy.cacheDir = process.env.S3PROXY_CACHE_DIR
    S3Proxy.defaultExpiration = 3600;
    S3Proxy.port = 4000;
    S3Proxy.serverKeyFile = process.env.S3PROXY_SERVER_KEY;
    S3Proxy.serverCertificateFile = process.env.S3PROXY_SERVER_CERTIFICATE;

    S3Proxy.mimeType = function(fn, callback) {
        var match = /\.(\w+)(\.gpg)?$/.exec(fn);
        match ?
            redis.hget('io.oei:mime-types', match[1], callback) :
            callback(S3Proxy.defaultMimeType);
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
        job.filename = S3Proxy.cacheDir + '/' + sha256.digest('hex');
        callback(job);
    };

    S3Proxy.s3url = function(job) {
        job.host = "s3-" + job.region + ".amazonaws.com";
        var expires = ((new Date()).getTime() / 1000 + S3Proxy.defaultExpiration).toFixed(0);
        var stringToSign = [
                'GET',
                '',
                '',
            expires,
                '/' + job.bucket + '/' + job.key
        ].join("\n");
        var hmac = crypto.createHmac('sha1', S3Proxy.awsKey);
        hmac.write(stringToSign);
        var signature = encodeURIComponent(hmac.digest('base64'));
        return job.url = [
                '/',
            job.bucket, '/',
            job.key,
                '?AWSAccessKeyId=', S3Proxy.awsId,
                '&Expires=', expires,
                '&Signature=', signature
        ].join('');
    };

    S3Proxy.sendFile = function(job) {
        var setAndSend = function(contents) {
            job.contents = (contents === undefined) ? '' : contents;
            job.response.setHeader('Content-Length', job.contents.length);
            job.response.end(job.contents);
        };
        if (/\.gpg$/.test(job.key)) {
            gpg.decryptFile(job.filename, function(err, contents) {
                setAndSend(contents);
            });
        } else {
            setAndSend(fs.readFileSync(job.filename));
        }
    };

    S3Proxy.processS3Response = function(job) {
        console.log("Got response from s3: " + job.proxy_res.statusCode);

        if (job.proxy_res.statusCode === 200) {
            var ws = fs.createWriteStream(job.filename);

            job.proxy_res.on('data', function(d) {
                ws.write(d);
            });

            job.proxy_res.on('error', function() {
                console.error("In-transit error");
                ws.end(function() {
                    fs.unlink(job.filename);
                });
            });

            job.proxy_res.on('end', function(d) {
                ws.end(d, function() {
                    S3Proxy.sendFile(job);
                });
            });
        } else {
            job.response.statusCode = job.proxy_response.statusCode;
            job.response.end();
            S3Proxy.notify("ERROR (" + job.proxy_response.statusCode + ") " +
                path);
        }
    };

    S3Proxy.sendResponseBody = function(job) {
        if (fs.existsSync(job.filename)) {
            console.log("Cache hit: " + job.path + " = " + job.filename);
            S3Proxy.sendFile(job);
        } else {

            S3Proxy.s3url(job);

            console.log('Requesting from s3: ' + job.path);

            https.get({
                host: job.host,
                path: job.url
            }, function(proxy_res) {
                job.proxy_res = proxy_res;
                S3Proxy.processS3Response(job);
            }).on('error', function(error) {
                console.error("error: ", error);
                job.response.statusCode = 404;
                job.response.end();
                S3Proxy.notify("ERROR " + job.path);
            });
        }
    };

    S3Proxy.app = express();

    S3Proxy.app.get(/^\/([^\/]+)\/([^\/]+)\/(.+)$/, function(req, res) {

        S3Proxy.parseRequest(req, res, function(job) {

            var remoteAddress = req.connection.remoteAddress;
            console.log("Got request from ", remoteAddress);
            if (remoteAddress !== '127.0.0.1') {
                S3Proxy.notify(remoteAddress + " GET " + path);
            }

            S3Proxy.mimeType(job.key, function(err, mt) {
                job.response.setHeader('Content-Type', mt);
                S3Proxy.sendResponseBody(job);
            });
        });
    });

    S3Proxy.app.delete(/^\/([^\/]+)\/([^\/]+)\/(.+)$/, function(req, res) {
        parseRequest(req, res, function(job) {
            console.log("Got delete ", job.path);
            fs.unlink(job.filename, function() {
                S3Proxy.notify("DELETE " + job.path);
            });
            job.ressponse.end();
        });
    });

})(S3Proxy = typeof S3Proxy == 'undefined' ? {} : S3Proxy);

if (!S3Proxy.cacheDir) {
    console.error("Must set S3PROXY_CACHE_DIR");
    process.exit(1);
}

if (!(S3Proxy.awsId && S3Proxy.awsKey)) {
    console.error("Must set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
    process.exit(1);
}

if (!(S3Proxy.serverKeyFile && S3Proxy.serverCertificateFile)) {
    console.error("Must set S3PROXY_SERVER_KEY and S3PROXY_SERVER_CERTIFICATE");
    process.exit(1);
}

https.createServer({
    key: fs.readFileSync(S3Proxy.serverKeyFile),
    cert: fs.readFileSync(S3Proxy.serverCertificateFile)
}, S3Proxy.app).listen(S3Proxy.port);

console.log('Listening on port ' + S3Proxy.port);
