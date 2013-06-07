var _ = require('lodash');
var fs = require('fs');

var cacheFile = {};

exports = module.exports = cacheFile;

cacheFile.cacheDir = function (n) {
    'use strict';
    return function (s) {
        return _.map(_.range(n), function (m) {
            return s.slice(2 * m, 2 * m + 2);
        });
    };

};

cacheFile.mkpath = function (prefix, path) {
    'use strict';
    return _.reduce(path, function (accumulator, value, key, collection) {
        var newValue = accumulator + '/' + value;
        if (!fs.existsSync(newValue)) {
            fs.mkdirSync(newValue);
        }
        return newValue;
    }, prefix);
};