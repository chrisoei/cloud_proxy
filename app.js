#!/usr/bin/env node

var crypto = require('crypto');
var express = require('express');
var fs = require('fs');
var https = require('https');
var http = require('http');

function mimeType(fn) {
  if (/\.webp$/.test(fn)) { return 'image/webp'; }
  if (/\.webm$/.test(fn)) { return 'video/webm'; }
}


function s3url(options) {

    var expires = ((new Date()).getTime()/1000 + options.expires).toFixed(0);

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
      '&Signature=', signature
    ].join('');
};

var app = express();


app.get('/:endPoint/:bucket/:key', function(req, res) {

  res.setHeader('Content-Type', mimeType(req.params.key));

  var sha256 = crypto.createHash('sha256');
  sha256.write(req.params.bucket + '/' + req.params.key);
  var fn = '/Users/c/.cache/s3proxy/' + sha256.digest('hex'); 

  if (fs.existsSync(fn)) {
    console.log("Cache hit");
    res.end(fs.readFileSync(fn));
  } else {

  ws = fs.createWriteStream(fn);

  var url = s3url({
    bucket: req.params.bucket,
    key: req.params.key,
    awsId: process.env.AWS_ACCESS_KEY_ID,
    awsKey: process.env.AWS_SECRET_ACCESS_KEY,
    expires: 3600
  });

  console.log('Requesting from s3: ' + url);
  https.get({
    host: "s3-" + req.params.endPoint + ".amazonaws.com",
    path: url,

  }, function(proxy_res) {
    console.log("Got response from s3: " + proxy_res.statusCode);

    proxy_res.on('data', function(d) {
      console.log("Got data with length " + d.length);
      ws.write(d);
    });

    proxy_res.on('end', function(d) { 
      ws.end(d, function() {
        res.end(fs.readFileSync(fn));
      });
    });
  });

}
});

app.listen(4000);
console.log('Listening on port 4000');

