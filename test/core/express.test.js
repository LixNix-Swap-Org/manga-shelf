// The handler scenarios against the Express test server (the same scenarios run in memory.test.js).
const { runScenarios } = require('./runScenarios');
const { startExpressCore } = require('./harness');

runScenarios('express', startExpressCore);
