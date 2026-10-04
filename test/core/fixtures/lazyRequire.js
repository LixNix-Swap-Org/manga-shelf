// probe 3: a require that only runs when the function is called
const lazyDb = () => require('./../db');
module.exports = { lazyDb };
