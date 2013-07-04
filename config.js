(function (config) {
    'use strict';

    config.defaultMimeType = 'text/html';
    config.authCookie = process.env.CLOUD_PROXY_AUTH_COOKIE;
    config.authPath = process.env.CLOUD_PROXY_AUTH_PATH;
    config.awsId = process.env.AWS_ACCESS_KEY_ID;
    config.awsKey = process.env.AWS_SECRET_ACCESS_KEY;
    config.cacheDir = process.env.CLOUD_PROXY_CACHE_DIR;
    config.defaultExpiration = 3600;
    config.mimeTypesFile = process.env.MIME_TYPES_FILE;
    config.port = 63446;
    config.serverKeyFile = process.env.CLOUD_PROXY_SERVER_KEY;
    config.serverCertificateFile = process.env.CLOUD_PROXY_SERVER_CERTIFICATE;
    config.s3urlRegexp = /^\/s3\/([^\/]+)\/([^\/]+)\/(.+)$/;

    config.checkConfig = function () {
        if (!config.mimeTypesFile) {
            console.error("Must set MIME_TYPES_FILE");
            return false;
        }
        if (!config.authCookie) {
            console.error("Must set CLOUD_PROXY_AUTH_COOKIE");
            return false;
        }
        if (!config.cacheDir) {
            console.error("Must set CLOUD_PROXY_CACHE_DIR");
            return false;
        }
        if (!(config.awsId && config.awsKey)) {
            console.error("Must set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
            return false;
        }
        if (!(config.serverKeyFile && config.serverCertificateFile)) {
            console.error("Must set CLOUD_PROXY_SERVER_KEY and CLOUD_PROXY_SERVER_CERTIFICATE");
            return false;
        }
        return true; // Config seems to be OK
    };

})(exports = module.exports);
