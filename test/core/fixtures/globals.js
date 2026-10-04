// probe 1: a global through globalThis, module.require and a path that leaves core/ through './../'
module.exports = [globalThis.process, module.require('fs'), require('./../db')];
