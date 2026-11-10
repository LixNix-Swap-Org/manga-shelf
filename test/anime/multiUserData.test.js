// Personal data of the shared anime list (migration 49): tags are seen by everybody and removed only by whoever added
// them (old ones by anyone, an admin any), notes belong to the person, and "Für alle löschen" never takes away the list
// of somebody else unless an admin does it. Plus the account checks that go with it: Unicode names, a deleted account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../helpers');

let ctx;
let admin;
let anna;
let ben;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    anna = ctx.client();
    ben = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    for (const name of ['anna', 'ben']) {
        assert.equal((await admin('POST', '/users', { username: name, password: 'password123', role: 'editor' })).status, 200);
    }
    assert.equal((await anna('POST', '/auth/login', { username: 'anna', password: 'password123' })).status, 200);
    assert.equal((await ben('POST', '/auth/login', { username: 'ben', password: 'password123' })).status, 200);
});
test.after(async () => { await ctx.close(); });

const newEntry = async (client, title) => {
    const res = await client('POST', '/anime', { title, episodes: 12, kind: 'anime' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id;
};

test('tags: everybody sees them all, each person removes only their own and the old ones, an admin any', async () => {
    const id = await newEntry(anna, 'Tag-Serie');
    const { db } = require('../../db');
    db.prepare("INSERT INTO anime_tags (anime_id, user_id, tag) VALUES (?, NULL, 'Alt')").run(id);
    assert.equal((await anna('PUT', `/anime/${id}`, { tags_add: ['Mit Freunden'] })).status, 200);
    const forBen = (await ben('PUT', `/anime/${id}`, { tags_add: ['Herbst', 'mit freunden'] })).body;
    assert.deepEqual(forBen.tags, ['Alt', 'Mit Freunden', 'Herbst'], 'one chip per name, the first spelling');
    assert.deepEqual(forBen.removable_tags, ['Alt', 'Herbst'], "anna's tag is not ben's to remove");

    // ben removing anna's tag changes nothing; his own and the old one go
    const after = (await ben('PUT', `/anime/${id}`, { tags_remove: ['Mit Freunden', 'Alt'] })).body;
    assert.deepEqual(after.tags, ['Mit Freunden', 'Herbst']);
    const list = (await anna('GET', '/anime')).body.find((a) => a.id === id);
    assert.deepEqual([list.tags, list.removable_tags], [['Mit Freunden', 'Herbst'], ['Mit Freunden']]);

    // the whole list from anna: what she may remove and is missing goes, what is new is hers, ben's stays
    const replaced = (await anna('PUT', `/anime/${id}`, { tags: ['Neu'] })).body;
    assert.deepEqual(replaced.tags, ['Herbst', 'Neu']);
    const byAdmin = (await admin('PUT', `/anime/${id}`, { tags_remove: ['Herbst', 'Neu'] })).body;
    assert.deepEqual([byAdmin.tags, byAdmin.removable_tags], [[], []]);
    assert.equal((await anna('PUT', `/anime/${id}`, { tags_add: ['x'.repeat(31)] })).status, 400);
});

test('notes are the own note of each person: PUT /anime/:id writes the caller\'s, nobody else sees it', async () => {
    const id = await newEntry(anna, 'Notiz-Serie');
    const mine = await anna('PUT', `/anime/${id}`, { notes: 'Blu-ray bei Ben' });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.my_progress.notes, 'Blu-ray bei Ben');
    assert.equal(mine.body.notes, null, 'the entry carries no shared note');
    const refused = await ben('PUT', `/anime/${id}`, { notes: 'fremd' });
    assert.deepEqual([refused.status, refused.body.code], [400, 'NOT_ON_LIST'], 'not on his list: nothing to attach a note to');
    assert.equal((await ben('PUT', `/anime/${id}/progress`, { status: 'Geplant' })).status, 200);
    assert.equal((await ben('PUT', `/anime/${id}`, { notes: 'eigene' })).body.my_progress.notes, 'eigene');
    assert.equal((await anna('GET', `/anime/${id}`)).body.my_progress.notes, 'Blu-ray bei Ben', "ben's note did not touch anna's");
    const created = await anna('POST', '/anime', { title: 'Mit Notiz', notes: 'vom Anlegen' });
    assert.equal(created.body.my_progress.notes, 'vom Anlegen', 'the note of a new entry is the creator\'s');

    // an old shared note of an entry that nobody had on their list goes to the first person who adds it
    const orphan = await newEntry(anna, 'Alte Notiz');
    const { db } = require('../../db');
    db.prepare('DELETE FROM anime_progress WHERE anime_id = ?').run(orphan);
    db.prepare("UPDATE animes SET notes = 'von früher' WHERE id = ?").run(orphan);
    const adopted = (await ben('PUT', `/anime/${orphan}/progress`, { status: 'Geplant' })).body;
    assert.equal(adopted.notes ?? adopted.my_progress?.notes, 'von früher');
    assert.equal(db.prepare('SELECT notes FROM animes WHERE id = ?').get(orphan).notes, null);
    assert.equal((await anna('PUT', `/anime/${orphan}/progress`, { status: 'Geplant' })).status, 200);
    assert.equal((await anna('GET', `/anime/${orphan}`)).body.my_progress.notes, null, 'only the first one gets it');
});

test('Für alle löschen: only while nobody else has the title, else only an admin', async () => {
    const id = await newEntry(anna, 'Lösch-Serie');
    assert.equal((await anna('GET', `/anime/${id}`)).body.can_delete_for_all, true, 'only anna has it');
    assert.equal((await ben('PUT', `/anime/${id}/progress`, { status: 'Schaue', episodes_watched: 2, score: 8 })).status, 200);
    assert.equal((await anna('GET', `/anime/${id}`)).body.can_delete_for_all, false);
    const refused = await anna('DELETE', `/anime/${id}`);
    assert.deepEqual([refused.status, refused.body.code], [403, 'ANIME_IN_USE']);
    assert.equal((await ben('GET', `/anime/${id}`)).body.my_progress.score, 8, "ben's list and rating are still there");
    // a hidden list (share_anime_activity off) still counts: the entry is still somebody's
    assert.equal((await ben('PUT', '/auth/profile', { share_anime_activity: false })).status, 200);
    assert.equal((await anna('DELETE', `/anime/${id}`)).status, 403);
    assert.equal((await admin('GET', `/anime/${id}`)).body.can_delete_for_all, true);
    assert.equal((await admin('DELETE', `/anime/${id}`)).status, 200);
    assert.equal((await ben('GET', `/anime/${id}`)).status, 404);
    assert.equal((await ben('PUT', '/auth/profile', { share_anime_activity: true })).status, 200);

    // removing it from the own list leaves the entry for the others, and the last one may then delete it
    const shared = await newEntry(anna, 'Teil-Serie');
    assert.equal((await ben('PUT', `/anime/${shared}/progress`, { status: 'Geplant' })).status, 200);
    assert.equal((await ben('DELETE', `/anime/${shared}/progress`)).body.removed, true);
    assert.equal((await anna('DELETE', `/anime/${shared}`)).status, 200);
});

test('account names that differ only in the case of Umlauts are one name; a deleted account takes its tags along', async () => {
    const first = await admin('POST', '/users', { username: 'Ärik', password: 'password123', role: 'editor' });
    assert.equal(first.status, 200);
    const twin = await admin('POST', '/users', { username: 'ärik', password: 'password123', role: 'editor' });
    assert.deepEqual([twin.status, twin.body.code], [400, 'USERNAME_TAKEN']);
    const decomposed = await admin('POST', '/users', { username: 'Ärik', password: 'password123', role: 'editor' });
    assert.equal(decomposed.status, 400, 'the same name in another Unicode form');
    const erik = ctx.client();
    assert.equal((await erik('POST', '/auth/login', { username: 'Ärik', password: 'password123' })).status, 200);

    const id = await newEntry(anna, 'Erbe-Serie');
    assert.equal((await erik('PUT', `/anime/${id}`, { tags_add: ['Von Ärik'] })).status, 200);
    assert.equal((await erik('POST', '/radar/feed-token')).status, 200);
    const { db } = require('../../db');
    const erikId = first.body.user.id;
    assert.equal((await admin('DELETE', `/users/${erikId}`)).status, 200);
    assert.deepEqual((await anna('GET', `/anime/${id}`)).body.tags, []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM calendar_feeds WHERE user_id = ?').get(erikId).n, 0);
});
