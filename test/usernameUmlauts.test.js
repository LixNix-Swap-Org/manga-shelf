// Usernames with umlauts ignore case like ASCII ones: login, adding a shelf member and a second account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { foldUsername, sameUsername } = require('../core/lib/usernames');

let ctx;
let admin;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'Jörg', password: 'password123', role: 'editor' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('folding treats umlauts like ASCII letters', () => {
    assert.equal(foldUsername('  JÖRG '), 'jörg');
    assert.ok(sameUsername('Ärik', 'äRIK'));
    assert.ok(!sameUsername('Jorg', 'Jörg'));
});

test('login works in any case of the umlaut', async () => {
    for (const name of ['Jörg', 'jörg', 'JÖRG', 'Jörg']) {
        const res = await ctx.client()('POST', '/auth/login', { username: name, password: 'password123' });
        assert.equal(res.status, 200, name);
        assert.equal(res.body.user.username, 'Jörg');
    }
    assert.equal((await ctx.client()('POST', '/auth/login', { username: 'Jorg', password: 'password123' })).status, 401);
});

test('a shelf member can be added by the name in another case, a twin account is refused', async () => {
    const shelf = (await admin('POST', '/shelves', { name: 'Umlaute' })).body;
    const added = await admin('POST', `/shelves/${shelf.id}/members`, { username: 'JÖRG', role: 'editor' });
    assert.ok(added.status < 300, String(added.status));
    const members = (await admin('GET', `/shelves/${shelf.id}`)).body.members.map((m) => m.username);
    assert.ok(members.includes('Jörg'));
    const twin = await admin('POST', '/users', { username: 'JÖRG', password: 'password123', role: 'editor' });
    assert.deepEqual([twin.status, twin.body.code], [400, 'USERNAME_TAKEN']);
});
