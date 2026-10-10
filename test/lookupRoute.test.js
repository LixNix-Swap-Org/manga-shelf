// Lookup routes: AniList and Manga Passion failure modes and description cleaning.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let lookup;
let anilistUrl;
let anilistServer;
const realFetch = global.fetch;
const timers = [];

const MP_RESULT = { id: 'mp_1', source: 'manga_passion', title: 'Berserk' };
const anilistBody = JSON.stringify({
    data: { Page: { media: [{
        id: 7, title: { romaji: 'Berserk', english: 'Berserk', native: 'ベルセルク' }, status: 'FINISHED',
        description: 'The spy &lt;Twilight&gt; &amp; co.<br><br>\nNext &#8217;line&#8217; <i>x</i>'
    }] } }
});

test.before(async () => {
    anilistServer = http.createServer((req, res) => {
        req.resume();
        if (req.url === '/drop') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
            res.write('{"data":{"Pa');
            setTimeout(() => req.socket.destroy(), 20);
        } else if (req.url === '/drip') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100000' });
            timers.push(setInterval(() => res.write(' '), 100));
        } else if (req.url === '/error') {
            res.writeHead(502, { 'Content-Type': 'text/html' });
            res.end('<html>Bad Gateway</html>');
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(anilistBody);
        }
    });
    await new Promise((resolve) => anilistServer.listen(0, '127.0.0.1', resolve));
    anilistUrl = (mode) => `http://127.0.0.1:${anilistServer.address().port}/${mode}`;

    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    lookup = require('../routes/lookup');
});

test.after(async () => {
    global.fetch = realFetch;
    timers.forEach(clearInterval);
    anilistServer.closeAllConnections();
    await new Promise((resolve) => anilistServer.close(resolve));
    await ctx.close();
});

/** AniList requests go to the local server in `mode`; the test client's own requests pass through. */
function stubSources(t, mode, mpResult = async () => [MP_RESULT]) {
    // the handler calls the core client (core/handlers/lookup.js), with the ctx first
    const mangaPassion = require('../core/mangaPassion/client');
    const original = mangaPassion.searchMangaPassionForLookup;
    mangaPassion.searchMangaPassionForLookup = (ctx, term) => mpResult(term);
    global.fetch = (url, opts) => {
        if (URL.parse(String(url))?.hostname === 'graphql.anilist.co') return realFetch(anilistUrl(mode), opts);
        if (String(url).startsWith(ctx.base)) return realFetch(url, opts);
        return Promise.reject(new Error('no network in tests: ' + url));
    };
    t.after(() => {
        mangaPassion.searchMangaPassionForLookup = original;
        global.fetch = realFetch;
        Object.assign(lookup.lookupTimings, { aniListTimeoutMs: 8000, sourceDeadlineMs: 12000 });
    });
}

test('lookup/manga: an AniList connection dropped mid-body still answers with the Manga Passion results', async (t) => {
    stubSources(t, 'drop');
    const started = Date.now();
    const res = await admin('GET', '/lookup/manga?q=Berserk');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [MP_RESULT]);
    assert.ok(Date.now() - started < 3000);
});

test('lookup/manga: a slowly dripping AniList answer is cut off by the overall timeout', async (t) => {
    stubSources(t, 'drip');
    lookup.lookupTimings.aniListTimeoutMs = 500;
    const started = Date.now();
    const res = await admin('GET', '/lookup/manga?q=Berserk');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [MP_RESULT]);
    assert.ok(Date.now() - started < 3000);
});

test('lookup/manga: an AniList error page gives only the Manga Passion results', async (t) => {
    stubSources(t, 'error');
    const res = await admin('GET', '/lookup/manga?q=Berserk');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [MP_RESULT]);
});

test('lookup/manga: a stuck Manga Passion search does not block the AniList results', async (t) => {
    stubSources(t, 'ok', () => new Promise(() => {}));
    lookup.lookupTimings.sourceDeadlineMs = 300;
    const res = await admin('GET', '/lookup/manga?q=Berserk');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].source, 'anilist');
    assert.equal(res.body[0].source_label, 'AniList', 'plain text: the badge icon is drawn by the frontend');
    assert.equal(res.body[0].description, 'The spy <Twilight> & co.\n\nNext ’line’ x');
});

test('lookup/manga: the term is capped at 100 characters, like /anime/search', async (t) => {
    const terms = [];
    stubSources(t, 'ok', async (term) => { terms.push(term); return []; });
    const long = 'Berserk ' + 'x'.repeat(300);
    const res = await admin('GET', `/lookup/manga?q=${encodeURIComponent(long)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(terms, [long.slice(0, 100)]);
});

test('cleanAniListDescription: tags removed before entities are decoded, breaks kept, one decoding pass', () => {
    const clean = require('../core/anilist').cleanAniListDescription;
    assert.equal(clean('&lt;Twilight&gt; &amp; co.<br><br>Next'), '<Twilight> & co.\n\nNext');
    assert.equal(clean('a &#8212; b'), 'a — b');
    assert.equal(clean('<i>x</i>'), 'x');
    assert.equal(clean('&amp;lt;'), '&lt;');
    assert.equal(clean('a<br>\n<br>\n<br>\n<br>b'), 'a\n\nb');
    assert.equal(clean(''), null);
    assert.equal(clean(null), null);
});

test('upload-remote: blocked and unresolvable hosts answer alike, without internal error details', async () => {
    const blocked = await admin('POST', '/upload-remote', { url: 'http://localhost/a.jpg' });
    const unknown = await admin('POST', '/upload-remote', { url: 'http://nonexistent-host-xyz.invalid/a.jpg' });
    assert.equal(blocked.status, 400);
    assert.equal(unknown.status, blocked.status);
    assert.deepEqual(unknown.body, blocked.body);
    assert.doesNotMatch(JSON.stringify(unknown.body), /ENOTFOUND|getaddrinfo|EAI_|EPROTO|ssl/i);
});

test('remoteImageError: fixed texts and statuses per failure kind', () => {
    const map = (message, code) => lookup.remoteImageError(Object.assign(new Error(message), code ? { code } : {}));
    const blocked = map('Zieladresse nicht erlaubt');
    assert.deepEqual(map('getaddrinfo ENOTFOUND x.invalid', 'ENOTFOUND'), blocked);
    assert.deepEqual(map('getaddrinfo EAI_AGAIN x', 'EAI_AGAIN'), blocked);
    assert.equal(map('Ungültige URL').status, 400);
    assert.equal(map('URLs mit Zugangsdaten sind nicht erlaubt').status, 400);
    assert.equal(map('Bild konnte nicht geladen werden (Status 503)').status, 502);
    assert.equal(map('Download-Zeitüberschreitung').status, 504);
    assert.equal(map('Bild ist zu groß').status, 413);
    assert.equal(map('Die Datei ist kein gültiges Bild').status, 415);
    const tls = map('write EPROTO 0080:error:0A00010B:SSL routines:ssl/record/methods/tlsany_meth.c:78', 'EPROTO');
    assert.equal(tls.status, 502);
    assert.doesNotMatch(tls.error, /EPROTO|ssl/);
    assert.deepEqual(map('connect ECONNREFUSED 1.2.3.4:81', 'ECONNREFUSED'), map('read ECONNRESET', 'ECONNRESET'));
});

test('lookup/isbn: a volume of the collection names its owners and whether the caller owns it', async () => {
    assert.equal((await admin('POST', '/users', { username: 'scan-ed', password: 'password123', role: 'editor' })).status, 200);
    const editor = ctx.client();
    assert.equal((await editor('POST', '/auth/login', { username: 'scan-ed', password: 'password123' })).status, 200);
    const manga = await admin('POST', '/mangas', { title: 'Scan-Reihe' });
    const vol = await admin('POST', '/volumes', { manga_id: manga.body.id, volume_number: '4', status: 'Vorhanden', isbn: '978-3-16-148410-0', type: 'special', notes: 'Collectors Edition' });
    assert.equal(vol.status, 200);

    const mine = await admin('GET', '/lookup/isbn?isbn=9783161484100');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.matched_volume.owned_by_me, true);
    assert.deepEqual(mine.body.matched_volume.owners, ['admin']);
    assert.equal(mine.body.matched_volume.type, 'special');
    assert.equal(mine.body.matched_volume.notes, 'Collectors Edition');

    const theirs = await editor('GET', '/lookup/isbn?isbn=978-3-16-148410-0');
    assert.equal(theirs.body.matched_volume.owned_by_me, false);
    assert.deepEqual(theirs.body.matched_volume.owners, ['admin']);
    assert.equal(theirs.body.matched_volume.status, 'Vorhanden');
});

test('outbound lookups are limited per account, ISBNs of the collection are not counted', async (t) => {
    const { resetRateLimits } = require('../middleware/rateLimit');
    const { USER_LOOKUPS_PER_MINUTE } = require('../middleware/userLimits');
    resetRateLimits();
    t.after(resetRateLimits);
    stubSources(t, 'ok');
    assert.equal((await admin('POST', '/users', { username: 'busy-guest', password: 'password123', role: 'guest' })).status, 200);
    const guest = ctx.client();
    assert.equal((await guest('POST', '/auth/login', { username: 'busy-guest', password: 'password123' })).status, 200);

    for (let i = 0; i < USER_LOOKUPS_PER_MINUTE; i++) assert.equal((await guest('GET', '/lookup/manga?q=Berserk')).status, 200, String(i));
    const limited = await guest('GET', '/lookup/manga?q=Berserk');
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /Zu viele Suchanfragen/);
    const unknownIsbn = await guest('GET', '/lookup/isbn?isbn=9780306406157');
    assert.equal(unknownIsbn.status, 429, 'an ISBN that needs the catalogues shares the budget');
    for (let i = 0; i < 5; i++) assert.equal((await guest('GET', '/lookup/isbn?isbn=9783161484100')).status, 200);

    assert.equal((await admin('GET', '/lookup/manga?q=Berserk')).status, 200, 'other accounts keep their own budget');
    for (let i = 0; i < USER_LOOKUPS_PER_MINUTE; i++) {
        assert.equal((await admin('POST', '/upload-remote', { url: 'http://localhost/a.jpg' })).status, 400, 'image downloads have a budget of their own');
    }
    const downloads = await admin('POST', '/upload-remote', { url: 'http://localhost/a.jpg' });
    assert.equal(downloads.status, 429);
    assert.match(downloads.body.error, /Bild-Downloads/);
});
