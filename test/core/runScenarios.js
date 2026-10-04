// Registers every scenario of scenarios.js as a test against one harness (Express or memory).
const test = require('node:test');
const { scenarios } = require('./scenarios');

function runScenarios(label, start) {
    let harness;
    let clients;
    test.before(async () => {
        harness = await start();
        clients = {
            admin: harness.client('admin'),
            ed: harness.client('ed'),
            vis: harness.client('vis'),
            anonymous: harness.client(null),
            users: harness.users,
            run: harness.run
        };
    });
    test.after(async () => { await harness.close(); });
    for (const scenario of scenarios) {
        test(`${label}: ${scenario.name}`, () => scenario.run(clients));
    }
}

module.exports = { runScenarios };
