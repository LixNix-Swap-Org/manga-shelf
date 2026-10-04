// The handler scenarios against an in-memory ctx (node:sqlite ':memory:') through core/routes.js dispatch().
const { runScenarios } = require('./runScenarios');
const { createMemoryCore } = require('./harness');

runScenarios('memory', async () => createMemoryCore());
