var growl = require('growl');

exports = module.exports = logger = {};

function notify(s) {
    growl(s, {
        title: 'S3proxy'
    });
};

logger.debug = function(s) {
//    console.log(s);
    return this;
};

logger.info = function(s) {
    console.log(s);
    return this;
};

logger.warn = function(s) {
    console.log(s);
    notify(s);
    return this;
};

logger.error = function(s) {
    console.error(s);
    notify(s);
    return this;
};