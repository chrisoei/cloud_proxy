exports.defaultMimeType = 'text/html';
exports.awsId = process.env.AWS_ACCESS_KEY_ID;
exports.awsKey = process.env.AWS_SECRET_ACCESS_KEY;
exports.cacheDir = process.env.S3PROXY_CACHE_DIR;
exports.defaultExpiration = 3600;
exports.port = 63446;
exports.serverKeyFile = process.env.S3PROXY_SERVER_KEY;
exports.serverCertificateFile = process.env.S3PROXY_SERVER_CERTIFICATE;
exports.urlRegexp = /^\/s3\/([^\/]+)\/([^\/]+)\/(.+)$/;

exports.checkConfig = function() {
    'use strict';
    if (!exports.cacheDir) {
        console.error("Must set S3PROXY_CACHE_DIR");
        return false;
    }
    if (!(exports.awsId && exports.awsKey)) {
        console.error("Must set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
        return false;
    }
    if (!(exports.serverKeyFile && exports.serverCertificateFile)) {
        console.error("Must set S3PROXY_SERVER_KEY and S3PROXY_SERVER_CERTIFICATE");
        return false;
    }
    return true; // Config seems to be OK
};

