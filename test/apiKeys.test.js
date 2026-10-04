// Per-user and instance API keys for the anime providers: live check, encryption, usage, rate limit, removal (fetch is faked).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { fakeFetch, aniListFixtures, jikanFixtures, json } = require('./anime/helpers');

const realFetch = global.fetch;
const TOKEN = `${'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9'}.${'a'.repeat(80)}.${'b'.repeat(40)}`;
const BAD_TOKEN = `${'eyJbad'}.${'c'.repeat(80)}.${'d'.repeat(40)}`;
const CLIENT_ID = '0123456789abcdef0123456789abcdef';

let ctx;
let admin;
let kim;
let gast;
let db;
let sources;

test.before(async () => {
    ctx = await startTestServer({ env: { MAL_CLIENT_ID: undefined, GOOGLE_BOOKS_KEY: undefined } });
    sources = fakeFetch({
        anilist: (body, init) => {
            if (body.query.includes('Viewer')) {
                return init.headers.Authorization === `Bearer ${TOKEN}`
                    ? json({ data: { Viewer: { id: 7, name: 'kim-anilist' } } })
                    : json({ errors: [{ message: 'Invalid token', status: 401 }], data: null }, { status: 401 });
            }
            return aniListFixtures(body);
        },
        jikan: jikanFixtures,
        mal: (path, init) => (init.headers['X-MAL-CLIENT-ID'] === CLIENT_ID ? json({ data: [] }) : json({ error: 'invalid_client' }, { status: 401 })),
        other: (url) => (url.startsWith('https://www.googleapis.com/books/v1/volumes') ? json({ items: [] }) : undefined)
    });
    global.fetch = (url, init) => (String(url).startsWith(ctx.root) ? realFetch(url, init) : sources.fetch(url, init));
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    for (const [name, role] of [['kim', 'editor'], ['gast', 'guest']]) {
        assert.equal((await admin('POST', '/users', { username: name, password: 'password123', role })).status, 200);
    }
    kim = ctx.client();
    await kim('POST', '/auth/login', { username: 'kim', password: 'password123' });
    gast = ctx.client();
    await gast('POST', '/auth/login', { username: 'gast', password: 'password123' });
    db = require('../db').db;
});

test.after(async () => {
    global.fetch = realFetch;
    await ctx.close();
});

const kimId = () => db.prepare("SELECT id FROM users WHERE username = 'kim'").get().id;

test('save with a successful live check: label from Viewer.name, encrypted, masked in GET, no-store', async () => {
    const saved = await kim('PUT', '/auth/api-keys/anilist', { secret: `  ${TOKEN}  `, allow_background: true });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.label, 'kim-anilist');
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.allow_background, true);
    assert.equal(saved.body.last4, TOKEN.slice(-4));
    assert.ok(!JSON.stringify(saved.body).includes(TOKEN));
    const row = db.prepare("SELECT * FROM user_api_credentials WHERE provider = 'anilist'").get();
    assert.ok(row.secret_enc && !row.secret_enc.includes(TOKEN.slice(0, 20)));

    const res = await realFetch(`${ctx.base}/auth/api-keys`, { headers: { Cookie: kim.cookie } });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const list = await res.json();
    assert.deepEqual(list.map((k) => k.provider), ['anilist', 'mal']);
    assert.ok(!JSON.stringify(list).includes(TOKEN));
    assert.equal(list[1].configured, false);
});

test('the key is used for its owner: Bearer header and credential_used "own"', async () => {
    const res = await kim('GET', '/anime/search?q=Frieren');
    assert.equal(res.status, 200);
    assert.equal(res.body.credential_used, 'own');
    const call = sources.calls.filter((c) => c.host === 'anilist').at(-1);
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    const state = await kim('GET', '/anime/sources');
    assert.equal(state.body.credential.anilist, 'own');
});

test('refused key: 400 with the provider text, nothing stored; wrong format refused before any request', async () => {
    const before = sources.calls.length;
    const format = await gast('PUT', '/auth/api-keys/anilist', { secret: 'zu-kurz-aber-zehn' });
    assert.equal(format.status, 400);
    assert.equal(format.body.code, 'KEY_FORMAT');
    assert.equal(sources.calls.length, before, 'no request for a malformed key');
    const refused = await gast('PUT', '/auth/api-keys/anilist', { secret: BAD_TOKEN });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'AniList lehnt den Token ab (401)');
    const gastId = db.prepare("SELECT id FROM users WHERE username = 'gast'").get().id;
    assert.equal(db.prepare('SELECT count(*) AS n FROM user_api_credentials WHERE user_id = ?').get(gastId).n, 0);
    assert.equal((await gast('PUT', '/auth/api-keys/google_books', { secret: 'AIza' + 'x'.repeat(35) })).status, 400, 'instance-only provider');
});

test('rate limit: 5 checks per minute and user', async () => {
    const { keyLimiter } = require('../routes/apiKeys');
    keyLimiter.reset();
    let last;
    for (let i = 0; i < 6; i++) last = await gast('PUT', '/auth/api-keys/mal', { secret: 'f'.repeat(32) });
    assert.equal(last.status, 429);
    assert.match(last.body.error, /Zu viele Schlüssel-Prüfungen/);
    keyLimiter.reset();
});

test('AniList list sync follows the key: a new key resolves the account again, removing it switches the sync off', async () => {
    const { keyLimiter } = require('../routes/apiKeys');
    keyLimiter.reset();
    const sync = () => db.prepare("SELECT enabled, external_user_id, last_error FROM anime_sync WHERE user_id = ? AND service = 'anilist'").get(kimId());
    const on = await kim('PUT', '/anime/sync', { anilist: { enabled: true } });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    db.prepare("UPDATE anime_sync SET last_error = 'alt' WHERE user_id = ?").run(kimId());
    assert.equal((await kim('PUT', '/auth/api-keys/anilist', { secret: TOKEN })).status, 200);
    assert.deepEqual({ ...sync() }, { enabled: 1, external_user_id: null, last_error: null });
    assert.equal((await kim('PUT', '/auth/api-keys/mal', { secret: CLIENT_ID })).status, 200);
    assert.equal(sync().enabled, 1, 'another provider leaves the sync alone');
    assert.equal((await kim('DELETE', '/auth/api-keys/anilist')).body.removed, true);
    assert.deepEqual({ ...sync() }, { enabled: 0, external_user_id: null, last_error: null });
    assert.equal((await kim('GET', '/anime/sync')).body.anilist.enabled, false);
    assert.equal((await kim('DELETE', '/auth/api-keys/mal')).body.removed, true);
    assert.equal((await kim('PUT', '/auth/api-keys/anilist', { secret: TOKEN })).status, 200);
    keyLimiter.reset();
});

test('delete own key; admins remove another user\'s key but cannot read it', async () => {
    assert.equal((await gast('PUT', '/auth/api-keys/mal', { secret: CLIENT_ID })).status, 200);
    assert.equal((await gast('DELETE', '/auth/api-keys/mal')).body.removed, true);
    assert.equal((await gast('GET', '/auth/api-keys')).body.find((k) => k.provider === 'mal').configured, false);

    assert.equal((await kim('DELETE', `/users/${kimId()}/api-keys/anilist`)).status, 403);
    assert.equal((await admin('GET', `/users/${kimId()}/api-keys`)).status, 404, 'there is no read route');
    const removed = await admin('DELETE', `/users/${kimId()}/api-keys/anilist`);
    assert.equal(removed.body.removed, true);
    assert.equal((await kim('GET', '/auth/api-keys')).body[0].configured, false);
});

test('instance keys: admins only, environment wins and is shown as such, live check like the user keys', async () => {
    assert.equal((await kim('PUT', '/admin/api-keys/mal', { secret: CLIENT_ID })).status, 403);
    const saved = await admin('PUT', '/admin/api-keys/mal', { secret: CLIENT_ID });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.label, `Client-ID …${CLIENT_ID.slice(-4)}`);
    const google = await admin('PUT', '/admin/api-keys/google_books', { secret: 'AIza' + 'x'.repeat(35) });
    assert.equal(google.status, 200);
    const list = await admin('GET', '/admin/api-keys');
    assert.deepEqual(list.body.keys.map((k) => [k.provider, k.configured, k.from_env]), [['mal', true, false], ['google_books', true, false]]);

    const search = await kim('GET', '/anime/search?q=Berserk');
    assert.ok(search.body.sources_used.includes('mal'), 'the instance client id switches Jikan to the official API');

    process.env.MAL_CLIENT_ID = 'f'.repeat(32);
    try {
        const env = await admin('GET', '/admin/api-keys/mal');
        assert.equal(env.body.from_env, true);
        assert.equal(env.body.label, `Client-ID …${CLIENT_ID.slice(-4)}`);
        const { serverProvider } = require('../routes/apiKeys');
        assert.equal(serverProvider.instance('mal').secret, 'f'.repeat(32));
        assert.equal(serverProvider.instance('mal').fromEnv, true);
    } finally {
        delete process.env.MAL_CLIENT_ID;
    }
    assert.equal((await admin('DELETE', '/admin/api-keys/mal')).body.removed, true);
    assert.equal((await admin('DELETE', '/admin/api-keys/google_books')).body.removed, true);
});

test('a refused Google Books instance key is switched off (last_error in the admin list) and no longer sent', async () => {
    const { lookupBookByIsbn } = require('../core/isbnLookup');
    const { createCtx } = require('../db');
    const { serverProvider } = require('../routes/apiKeys');
    const answer = JSON.stringify({ items: [{ volumeInfo: { title: 'Berserk 7' } }] });
    const lookup = async () => {
        const urls = [];
        const book = await lookupBookByIsbn(createCtx(), '9783551745811', {
            fetchText: async (url) => {
                if (!url.includes('googleapis')) return '<empty/>';
                urls.push(url);
                if (url.includes('key=')) throw new Error('HTTP 400');
                return answer;
            }
        });
        return { book, urls };
    };

    assert.equal((await admin('PUT', '/admin/api-keys/google_books', { secret: 'AIza' + 'x'.repeat(35) })).status, 200);
    const first = await lookup();
    assert.equal(first.book.title, 'Berserk 7');
    assert.equal(first.urls.length, 2);
    const listed = (await admin('GET', '/admin/api-keys')).body.keys.find((k) => k.provider === 'google_books');
    assert.equal(listed.configured, true);
    assert.equal(listed.last_error, 'Google Books lehnt den Schlüssel ab (HTTP 400)');
    assert.equal(serverProvider.instance('google_books'), null);
    const second = await lookup();
    assert.deepEqual(second.urls, ['https://www.googleapis.com/books/v1/volumes?q=isbn:9783551745811'], 'no keyed request any more');
    assert.equal((await admin('DELETE', '/admin/api-keys/google_books')).body.removed, true);

    process.env.GOOGLE_BOOKS_KEY = 'AIza' + 'e'.repeat(35);
    try {
        assert.equal((await lookup()).urls.length, 2);
        const env = (await admin('GET', '/admin/api-keys/google_books')).body;
        assert.deepEqual([env.from_env, env.last_error], [true, 'Google Books lehnt den Schlüssel ab (HTTP 400)']);
        assert.equal((await lookup()).urls.length, 1, 'a refused environment key is not sent again');
        process.env.GOOGLE_BOOKS_KEY = 'AIza' + 'f'.repeat(35);
        assert.equal(serverProvider.instance('google_books').fromEnv, true, 'a new value is tried again');
    } finally {
        delete process.env.GOOGLE_BOOKS_KEY;
    }
});

test('serverProvider.used and failed reach the instance row (user_id NULL)', async () => {
    const { serverProvider } = require('../routes/apiKeys');
    assert.equal((await admin('PUT', '/admin/api-keys/mal', { secret: CLIENT_ID })).status, 200);
    db.prepare("UPDATE user_api_credentials SET last_used_at = NULL, last_ok_at = NULL WHERE user_id IS NULL AND provider = 'mal'").run();
    serverProvider.used(null, 'mal', true);
    const row = db.prepare("SELECT last_used_at, last_ok_at FROM user_api_credentials WHERE user_id IS NULL AND provider = 'mal'").get();
    assert.ok(row.last_used_at > 0 && row.last_ok_at > 0);
    serverProvider.failed(null, 'mal', 'MyAnimeList lehnt den Schlüssel ab (401)');
    assert.equal(serverProvider.instance('mal'), null);
    assert.equal((await admin('GET', '/admin/api-keys/mal')).body.last_error, 'MyAnimeList lehnt den Schlüssel ab (401)');
    assert.equal((await admin('DELETE', '/admin/api-keys/mal')).body.removed, true);
});

test('a key that can no longer be decrypted counts as not configured and says so', async () => {
    assert.equal((await kim('PUT', '/auth/api-keys/anilist', { secret: TOKEN })).status, 200);
    db.prepare("UPDATE user_api_credentials SET secret_enc = ? WHERE provider = 'anilist'").run(Buffer.alloc(40, 1).toString('base64'));
    const { serverProvider } = require('../routes/apiKeys');
    assert.equal(serverProvider.get(kimId(), 'anilist'), null);
    const list = await kim('GET', '/auth/api-keys');
    assert.equal(list.body[0].last_error, 'Schlüssel nicht mehr lesbar, bitte neu eintragen');
    const state = await kim('GET', '/anime/sources');
    assert.equal(state.body.anilist.key_disabled, true);
});

test('deleting a user removes their keys (ON DELETE CASCADE)', async () => {
    const id = kimId();
    assert.ok(db.prepare('SELECT count(*) AS n FROM user_api_credentials WHERE user_id = ?').get(id).n > 0);
    assert.equal((await admin('DELETE', `/users/${id}`)).status, 200);
    assert.equal(db.prepare('SELECT count(*) AS n FROM user_api_credentials WHERE user_id = ?').get(id).n, 0);
});

test('ANIME_* and the instance keys go through utils/config.js: typos warn at startup, the defaults apply', () => {
    const { readConfig } = require('../utils/config');
    const typo = readConfig({ ANIME_SOURCES: 'anilst,jiakn', ANIME_ANILIST_RPM: 'dreißig', ANIME_JIKAN_RPM: '5000' });
    assert.deepEqual(typo.values.animeSources, ['anilist', 'jikan']);
    assert.equal(typo.values.animeAnilistRpm, 30);
    assert.equal(typo.values.animeJikanRpm, 600);
    assert.equal(typo.warnings.length, 3);
    assert.match(typo.warnings.find(w => w.startsWith('ANIME_SOURCES')), /keine bekannte Quelle .*es gilt anilist,jikan/);
    const partly = readConfig({ ANIME_SOURCES: 'AniList, jiakn' });
    assert.deepEqual(partly.values.animeSources, ['anilist']);
    assert.match(partly.warnings[0], /unbekannte Quellen \(jiakn/);
    const clean = readConfig({ ANIME_SOURCES: 'anilist,mal', MAL_CLIENT_ID: '  abc  ', GOOGLE_BOOKS_KEY: '' });
    assert.deepEqual([clean.warnings, clean.values.animeSources, clean.values.malClientId, clean.values.googleBooksKey], [[], ['anilist', 'mal'], 'abc', null]);

    const settings = require('../core/anime/settings');
    const { registerServerSources } = require('../routes/apiKeys');
    const saved = { ...process.env };
    Object.assign(process.env, { ANIME_SOURCES: 'anilst,jikan', ANIME_ANILIST_RPM: '12' });
    try {
        registerServerSources();
        assert.deepEqual(settings.settings({}), { anilistRpm: 12, jikanRpm: 60, anilist: false, mal: true });
    } finally {
        for (const key of ['ANIME_SOURCES', 'ANIME_ANILIST_RPM']) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        registerServerSources();
    }
});
