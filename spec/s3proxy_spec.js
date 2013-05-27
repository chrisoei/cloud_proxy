var config = require('../config.js');

describe('S3proxy', function() {

    it('should check configuration', function() {
        expect(config.checkConfig()).toEqual(true);
    });

});