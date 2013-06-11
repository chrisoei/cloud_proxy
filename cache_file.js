var _ = require('lodash');
var fs = require('fs');

(function (cacheFile) {
    'use strict';

    cacheFile.cacheDir = function (n) {
        return function (s) {
            return _.map(_.range(n), function (m) {
                return s.slice(2 * m, 2 * m + 2);
            });
        };

    };

    cacheFile.mkpath = function (prefix, path) {
        return _.reduce(path, function (accumulator, value) {
            var newValue = accumulator + '/' + value;
            if (!fs.existsSync(newValue)) {
                fs.mkdirSync(newValue);
            }
            return newValue;
        }, prefix);
    };

})(exports = module.exports);