const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let dv;
let dbm;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    dv = require('../utils/dataVersion');
    dbm = require('../db');
});

test.after(async () => { await ctx.close(); });

test('data version: stable while only reading, changes with every write', async () => {
    const first = dv.dataVersionKey();
    await admin('GET', '/mangas');
    await admin('GET', '/stats');
    assert.equal(dv.dataVersionKey(), first);

    const id = (await admin('POST', '/mangas', { title: 'Version' })).body.id;
    const afterInsert = dv.dataVersionKey();
    assert.notEqual(afterInsert, first);
    assert.equal((await admin('POST', '/volumes/batch', { manga_id: id, from: 1, to: 2, status: 'Vorhanden' })).status, 200);
    const afterVolumes = dv.dataVersionKey();
    assert.notEqual(afterVolumes, afterInsert);
    // a cascade counts as well
    assert.equal((await admin('DELETE', `/mangas/${id}`)).status, 200);
    assert.notEqual(dv.dataVersionKey(), afterVolumes);
});

test('data version: a reopened database (restore) gets a new generation, the boot id stays', () => {
    const before = dv.readDataVersion();
    dbm.initDb();
    const after = dv.readDataVersion();
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.boot, before.boot);
    assert.match(after.boot, /^[0-9a-f]{8}$/);
    assert.equal(dv.dataVersionKey(), `${after.boot}.${after.generation}.${after.changes}.${after.dataVersion}`);
});

test('data version: a commit by another connection to the same file changes it', () => {
    const before = dv.dataVersionKey();
    const other = dbm.openRawDb(dbm.dbPath);
    try {
        other.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('probe', 'x')").run();
    } finally { other.close(); }
    assert.notEqual(dv.dataVersionKey(), before);
});
