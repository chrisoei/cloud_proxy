#!/usr/bin/env node

var crypto = require('crypto');
var express = require('express');
var fs = require('fs');
var gpg = require('gpg');
var https = require('https');
var http = require('http');
var redis = require('redis').createClient();

function mimeType(fn, callback) {
    var match = /\.(\w+)(\.gpg)?$/.exec(fn);
    match ?
        redis.hget('io.oei:mime-types', match[1], callback) :
        callback('text/html');
}

function parseRequest(req, callback) {
    var region = req.params[0];
    var bucket = req.params[1];
    var key = req.params[2];
    var path = bucket + '/' + key;
    var sha256 = crypto.createHash('sha256');

    sha256.write(path);
    var filename = '/Users/c/.cache/s3proxy/' + sha256.digest('hex');

  callback(region, bucket, key, path, filename);
}

function s3url(options) {

    var expires = ((new Date()).getTime() / 1000 + options.expires).toFixed(0);

    var stringToSign = [
            'GET',
            '',
            '',
        expires,
            '/' + options.bucket + '/' + options.key
    ].join("\n");

    var hmac = crypto.createHmac('sha1', options.awsKey);

    hmac.write(stringToSign);

    var signature = encodeURIComponent(hmac.digest('base64'));

    return [
        '/',
        options.bucket, '/',
        options.key,
        '?AWSAccessKeyId=', options.awsId,
        '&Expires=', expires,
        '&Signature=', signature].join('');
}

function sendFile(key, fn, res) {
    var setAndSend = function(contents) {
        contents = (contents === undefined) ? '' : contents;
        res.setHeader('Content-Length', contents.length);
        res.end(contents);
    };
    if (/\.gpg$/.test(key)) {
        gpg.decryptFile(fn, function(err, contents) {
            setAndSend(contents);
        });
    } else {
        setAndSend(fs.readFileSync(fn));
    }
}

var app = express();


app.get(/^\/([^\/]+)\/([^\/]+)\/(.+)$/, function(req, res) {

    parseRequest(req, function(region, bucket, key, path, filename) {

        console.log("Got request from ", req.connection.remoteAddress);

        mimeType(key, function(err, mt) {

            res.setHeader('Content-Type', mt);

            if (fs.existsSync(filename)) {
                console.log("Cache hit: " + path + " = " + filename);
                sendFile(key, filename, res);
            } else {

                var ws = fs.createWriteStream(filename);

                var url = s3url({
                    bucket: bucket,
                    key: key,
                    awsId: process.env.AWS_ACCESS_KEY_ID,
                    awsKey: process.env.AWS_SECRET_ACCESS_KEY,
                    expires: 3600
                });

                console.log('Requesting from s3: ' + path);

                https.get({
                    host: "s3-" + region + ".amazonaws.com",
                    path: url

                }, function(proxy_res) {
                    console.log("Got response from s3: " + proxy_res.statusCode);

                    proxy_res.on('data', function(d) {
                        ws.write(d);
                    });

                    proxy_res.on('end', function(d) {
                        ws.end(d, function() {
                            sendFile(key, filename, res);
                        });
                    });
                });
            }
        });
    });
});

app.delete(/^\/([^\/]+)\/([^\/]+)\/(.+)$/, function(req, res) {
    parseRequest(req, function(region, bucket, key, path, filename) {
        console.log("Got delete ", path);
        fs.unlink(filename);
        res.end();
    });
});

https.createServer({
    key: fs.readFileSync('/Users/c/Keys/s3proxy/server.key'),
    cert: fs.readFileSync('/Users/c/Keys/s3proxy/server.crt')
}, app).listen(4000);
//http.createServer(app).listen(4001);

console.log('Listening on port 4000');
