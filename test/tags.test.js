const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { startTestServer } = require('./helpers');
const tags = require('../core/lib/tags');

const loadFrontend = () => import(pathToFileURL(path.join(__dirname, '..', 'frontend', 'src', 'utils', 'tags.js')).href);

let ctx;
let editor;

test.before(async () => {
    ctx = await startTestServer();
    editor = ctx.client();
    assert.equal((await editor('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('normalizeTags: German genres, target groups kept, unique, whole tags up to 500 characters', () => {
    assert.equal(tags.normalizeTags('Shounen, Adventure, Fantasy, Comedy, Slice of Life, Drama, Supernatural'),
        'Shounen, Abenteuer, Fantasy, Komödie, Alltag, Drama, Übernatürlich');
    assert.equal(tags.normalizeTags(' shonen ;  romance\nRomantik, Piraten  , piraten'), 'Shounen, Romantik, Piraten');
    assert.equal(tags.normalizeTags('  ,  '), null);
    const long = Array.from({ length: 40 }, (_, i) => `Schlagwort${String(i).padStart(2, '0')}xxxxx`).join(', ');
    const stored = tags.normalizeTags(long);
    assert.ok(stored.length <= 500);
    assert.ok(stored.split(', ').every(t => /^Schlagwort\d\dxxxxx$/.test(t)), 'no tag is cut in half');
});

test('the frontend map and helpers match the backend', async () => {
    const front = await loadFrontend();
    assert.deepEqual(front.GENRE_DE, tags.GENRE_DE);
    const input = 'Shounen, Adventure, adventure, Mecha, School Life';
    assert.deepEqual(front.splitTags(input), tags.splitTags(input));
    assert.deepEqual(front.collectTags([{ tags: 'Action, Drama' }, { tags: 'drama' }, { tags: null }]), [{ tag: 'Drama', count: 2 }, { tag: 'Action', count: 1 }]);
    assert.equal(front.hasAllTags({ tags: 'Adventure, Drama' }, ['abenteuer', 'Drama']), true);
    assert.equal(front.hasAllTags({ tags: 'Drama' }, ['Drama', 'Action']), false);
});

test('POST and PUT store normalized tags; GET /tags counts them across series', async () => {
    const a = await editor('POST', '/mangas', { title: 'Tag A', tags: 'Adventure, Fantasy' });
    const b = await editor('POST', '/mangas', { title: 'Tag B', tags: 'abenteuer' });
    assert.equal((await editor('GET', `/mangas/${a.body.id}`)).body.tags, 'Abenteuer, Fantasy');
    assert.equal((await editor('PUT', `/mangas/${b.body.id}`, { tags: 'Abenteuer, Romance, ' })).status, 200);
    assert.equal((await editor('GET', `/mangas/${b.body.id}`)).body.tags, 'Abenteuer, Romantik');
    assert.equal((await editor('PUT', `/mangas/${b.body.id}`, { tags: ['x'] })).status, 400);
    const res = await editor('GET', '/tags');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.tags, [{ tag: 'Abenteuer', count: 2 }, { tag: 'Fantasy', count: 1 }, { tag: 'Romantik', count: 1 }]);
});
