// Backend config flag UPDATE_CHECK and calendar feed token cleanup on user deletion.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('config: UPDATE_CHECK is a flag (default on, unknown values warn and keep it on)', () => {
    const { readConfig, config } = require('../utils/config');
    assert.equal(readConfig({}).values.updateCheck, true);
    for (const off of ['false', '0', 'off', 'no', 'nein', ' FALSE ']) assert.equal(readConfig({ UPDATE_CHECK: off }).values.updateCheck, false, off);
    for (const on of ['true', '1', 'ja', 'on']) assert.equal(readConfig({ UPDATE_CHECK: on }).values.updateCheck, true, on);
    const odd = readConfig({ UPDATE_CHECK: 'vielleicht' });
    assert.equal(odd.values.updateCheck, true);
    assert.deepEqual(odd.warnings, ['UPDATE_CHECK="vielleicht" ist unbekannt (erlaubt: true oder false), es gilt true']);
    process.env.UPDATE_CHECK = 'off';
    try {
        assert.equal(config.updateCheck, false, 'read at access time');
    } finally {
        delete process.env.UPDATE_CHECK;
    }
});

test('users: deleting a user removes the calendar feed tokens of that user only', async () => {
    assert.equal((await admin('POST', '/users', { username: 'kalender', password: 'password123', role: 'editor' })).status, 200);
    const member = ctx.client();
    assert.equal((await member('POST', '/auth/login', { username: 'kalender', password: 'password123' })).status, 200);
    assert.equal((await member('POST', '/radar/feed-token')).status, 200);
    assert.equal((await admin('POST', '/radar/feed-token')).status, 200);
    const { db } = require('../db');
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('calendar_feed:kaputt', 'kein json')").run();
    const feeds = () => db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'calendar\\_feed:%' ESCAPE '\\'").all()
        .map(r => { try { return JSON.parse(r.value).user_id; } catch (e) { return r.key; } });
    const memberId = (await admin('GET', '/users')).body.find(u => u.username === 'kalender').id;
    assert.deepEqual(feeds().sort(), [1, memberId, 'calendar_feed:kaputt'].sort());

    assert.equal((await admin('DELETE', `/users/${memberId}`)).status, 200);
    assert.deepEqual(feeds().sort(), [1, 'calendar_feed:kaputt'].sort());
});
