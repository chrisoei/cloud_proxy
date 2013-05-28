exports = module.exports = logger = {};

logger.debug = function(s) {
    console.log(s);
    return this;
};

logger.info = function(s) {
    console.log(s);
    return this;
};
