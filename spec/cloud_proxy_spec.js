var config = require('../config.js');

describe('CloudProxy', function() {

    it('should check configuration', function() {
        expect(config.checkConfig()).toEqual(true);
    });

});