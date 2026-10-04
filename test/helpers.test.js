// startTestServer: hermetic data dir and the one-server-per-process rule.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

test('startTestServer is hermetic and refuses a second server in the same process', async () => {
    process.env.TRUST_PROXY = 'false';
    process.env.CORS_ORIGIN = 'https://leaked.example';
    const ctx = await startTestServer();
    try {
        const res = await fetch(ctx.base + '/health', { headers: { Origin: 'https://leaked.example' } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        assert.equal(process.env.TRUST_PROXY, 'true');
    } finally {
        await ctx.close();
    }
    await assert.rejects(startTestServer(), /only be called once per process/);
});
