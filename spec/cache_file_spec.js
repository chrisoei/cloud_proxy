var cacheFile = require('../cache_file.js');

describe('CacheFile', function() {
    'use strict';

    it('should split filename', function() {
        var f = cacheFile.cacheDir(2);
        expect(f('abcdef')).toEqual(['ab','cd']);
    });

});