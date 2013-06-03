var growl = require('growl');

var logger = {};
exports = module.exports = logger;

function notify(s) {
    'use strict';
    growl(s, {
        title: 'S3proxy'
    });
}

logger.debug = function(s) {
    'use strict';
//    console.log(s);
    return this;
};

logger.info = function(s) {
    'use strict';
    console.log(s);
    return this;
};

logger.warn = function(s) {
    'use strict';
    console.log(s);
    notify(s);
    return this;
};

logger.error = function(s) {
    'use strict';
    console.error(s);
    notify(s);
    return this;
};