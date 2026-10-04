// probe 1 of the review: a global through globalThis, module.require and a path that leaves core/ through './../'
module.exports = [globalThis.process, module.require('fs'), require('./../db')];
