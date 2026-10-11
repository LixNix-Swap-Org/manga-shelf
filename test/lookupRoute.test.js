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
    mangaPassion.searchMangaPassionForLookup = (core, term, opts) => mpResult(term, core, opts);
    global.fetch = (url, opts) => {
        if (URL.parse(String(url))?.hostname === 'graphql.anilist.co') return realFetch(anilistUrl(mode), opts);
        if (String(url).startsWith(ctx.base)) return realFetch(url, opts);
        return Promise.reject(new Error('no network in tests: ' + url));
    };
    t.after(() => {
        mangaPassion.searchMangaPassionForLookup = original;
        global.fetch = realFetch;
        Object.assign(lookup.lookupTimings, { searchTimeoutMs: 5000, sourceDeadlineMs: 6000 });
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
    lookup.lookupTimings.searchTimeoutMs = 500;
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

test('outbound lookups are limited per account, a lookup without an outbound call is refunded, ISBNs of the collection are not counted', async (t) => {
    const { resetRateLimits } = require('../middleware/rateLimit');
    const { USER_LOOKUPS_PER_MINUTE } = require('../middleware/userLimits');
    const gateway = require('../core/anime/gateway');
    resetRateLimits();
    t.after(resetRateLimits);
    let outbound = false;
    stubSources(t, 'ok', async (term, core) => {
        if (outbound) await core.http.fetch(`https://api.manga-passion.de/editions?title=${encodeURIComponent(term)}`).catch(() => {});
        return [MP_RESULT];
    });
    const searchManga = gateway.searchManga;
    gateway.searchManga = async () => [];
    t.after(() => { gateway.searchManga = searchManga; });
    assert.equal((await admin('POST', '/users', { username: 'busy-guest', password: 'password123', role: 'guest' })).status, 200);
    const guest = ctx.client();
    assert.equal((await guest('POST', '/auth/login', { username: 'busy-guest', password: 'password123' })).status, 200);

    for (let i = 0; i < USER_LOOKUPS_PER_MINUTE + 10; i++) assert.equal((await guest('GET', '/lookup/manga?q=Berserk')).status, 200, `refunded ${i}`);
    outbound = true;
    for (let i = 0; i < USER_LOOKUPS_PER_MINUTE; i++) assert.equal((await guest('GET', `/lookup/manga?q=Berserk ${i}`)).status, 200, String(i));
    const limited = await guest('GET', '/lookup/manga?q=Berserk neu');
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

test('lookup/manga: Manga Passion gets the request signal and the 5 s search timeout', async (t) => {
    const seen = [];
    stubSources(t, 'ok', async (term, core, opts) => {
        seen.push(opts);
        return [];
    });
    assert.equal((await admin('GET', '/lookup/manga?q=Signalreihe')).status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].requestTimeoutMs, 5000);
    assert.ok(seen[0].signal && typeof seen[0].signal.aborted === 'boolean');
    assert.equal(lookup.lookupTimings.sourceDeadlineMs, 6000);
});

test('lookup/manga: a stuck Manga Passion detail request gives up at the search timeout, so the hit still arrives before the deadline', async (t) => {
    const gateway = require('../core/anime/gateway');
    const searchManga = gateway.searchManga;
    gateway.searchManga = async () => [];
    const details = [];
    global.fetch = (url, opts) => {
        const target = URL.parse(String(url));
        if (target?.hostname === 'api.manga-passion.de' && target.pathname === '/editions') {
            const member = [{ id: 42, title: 'Detailstau', numVolumes: 3, status: 2, publishers: [{ name: 'Carlsen' }] }];
            return Promise.resolve(new Response(JSON.stringify({ 'hydra:member': member }), { headers: { 'Content-Type': 'application/ld+json' } }));
        }
        if (target?.hostname === 'api.manga-passion.de' && target.pathname === '/editions/42') {
            details.push(url);
            return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
        }
        if (String(url).startsWith(ctx.base)) return realFetch(url, opts);
        return Promise.reject(new Error('no network in tests: ' + url));
    };
    Object.assign(lookup.lookupTimings, { searchTimeoutMs: 300, sourceDeadlineMs: 2000 });
    t.after(() => {
        gateway.searchManga = searchManga;
        global.fetch = realFetch;
        Object.assign(lookup.lookupTimings, { searchTimeoutMs: 5000, sourceDeadlineMs: 6000 });
    });

    const started = Date.now();
    const res = await admin('GET', '/lookup/manga?q=Detailstau');
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 2000, 'answered before the source deadline');
    assert.equal(details.length, 1);
    assert.deepEqual(res.body.map((h) => h.id), ['mp_42']);
    assert.deepEqual([res.body[0].title, res.body[0].author, res.body[0].description], ['Detailstau', null, null]);
});

test('core routes: an aborted request is neither answered nor passed on as an error', async () => {
    const express = require('express');
    const { createCoreRouter } = require('../routes/core');
    const { HttpError } = require('../core/errors');
    let started;
    const running = new Promise((resolve) => { started = resolve; });
    let finished;
    const ended = new Promise((resolve) => { finished = resolve; });
    const rows = [{
        method: 'GET', path: '/abort-probe', role: 'public', handler: async (core) => {
            started();
            await new Promise((resolve) => core.signal.addEventListener('abort', resolve));
            finished();
            throw new HttpError(503, 'Manga Passion und AniList sind gerade nicht erreichbar.', 'SOURCES_UNAVAILABLE');
        }
    }];
    const errors = [];
    const app = express();
    app.use(createCoreRouter(rows));
    app.use((err, req, res, next) => {
        errors.push(err);
        res.status(500).end();
    });
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const controller = new AbortController();
        const pending = realFetch(`http://127.0.0.1:${server.address().port}/abort-probe`, { signal: controller.signal }).catch(() => 'aborted');
        await running;
        controller.abort();
        assert.equal(await pending, 'aborted');
        await ended;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(errors, []);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

const { rankLookupHits } = require('../core/handlers/lookup');

const marcBook = (title) => `<searchRetrieveResponse><records><record><recordData><record><datafield tag="245" ind1=" " ind2=" "><subfield code="a">${title}</subfield></datafield></record></recordData></record></records></searchRetrieveResponse>`;

test('lookup/isbn: a found book is cached for 30 days, a complete miss for a day, a failed catalogue not at all; cached answers cost no lookup', async (t) => {
    const isbnService = require('../services/isbnLookup');
    const { resetRateLimits } = require('../middleware/rateLimit');
    const { db } = require('../db');
    const original = isbnService.fetchTextHttps;
    const urls = [];
    isbnService.fetchTextHttps = async (url) => {
        urls.push(url);
        if (url.includes('9780140449136')) throw new Error('Timeout');
        if (url.includes('dnb.de') && url.includes('9783551745811')) return marcBook('Zwischengespeichert');
        return url.includes('googleapis') ? '{}' : '<empty/>';
    };
    resetRateLimits();
    t.after(() => {
        isbnService.fetchTextHttps = original;
        resetRateLimits();
    });
    const ttl = (isbn) => {
        const row = db.prepare('SELECT created_at, expires_at FROM api_cache WHERE cache_key = ?').get(`isbn:${isbn}`);
        return row ? row.expires_at - row.created_at : null;
    };

    const found = await admin('GET', '/lookup/isbn?isbn=978-3-551-74581-1');
    assert.equal(found.body.book.title, 'Zwischengespeichert');
    assert.equal(ttl('9783551745811'), 30 * 24 * 60 * 60 * 1000);
    const missing = await admin('GET', '/lookup/isbn?isbn=9780306406157');
    assert.equal(missing.body.found, false);
    assert.equal(ttl('9780306406157'), 24 * 60 * 60 * 1000);
    const failing = await admin('GET', '/lookup/isbn?isbn=9780140449136');
    assert.equal(failing.body.found, false);
    assert.equal(ttl('9780140449136'), null, 'not every catalogue answered');

    const asked = urls.length;
    const { USER_LOOKUPS_PER_MINUTE } = require('../middleware/userLimits');
    for (let i = 0; i < USER_LOOKUPS_PER_MINUTE + 5; i++) {
        const again = await admin('GET', `/lookup/isbn?isbn=${i % 2 ? '9783551745811' : '9780306406157'}`);
        assert.equal(again.status, 200, String(i));
    }
    assert.equal(urls.length, asked, 'answered from the cache');
    assert.equal((await admin('GET', '/lookup/isbn?isbn=3551745811')).body.book.title, 'Zwischengespeichert', 'an ISBN-10 shares the ISBN-13 row');
});

test('rankLookupHits: an AniList hit with the title of exactly one Manga Passion edition is folded into it and ranked by its romaji', () => {
    const edition = {
        id: 'mp_5', manga_passion_id: 5, source: 'manga_passion', source_label: 'Manga Passion', title: 'Delicious in Dungeon', alt_title: null,
        author: null, publisher: 'Egmont', description: 'Deutscher Text', cover_image: 'https://mp.example/c.jpg', tags: null, total_volumes: 14, status: 'Abgeschlossen'
    };
    const tower = { ...edition, id: 'mp_6', manga_passion_id: 6, title: 'Tower Dungeon', description: null };
    const ani = {
        id: 'al_86082', source: 'anilist', title: 'Delicious in Dungeon', alt_title: 'ダンジョン飯', alt_titles: ['Dungeon Meshi', 'Delicious in Dungeon', 'ダンジョン飯'],
        author: 'Ryoko Kui', description: 'English text', cover_image: 'https://anilist.example/c.jpg', tags: 'Fantasy', total_volumes: 14, mal_id: 85781, also_on: ['mal']
    };
    const hits = rankLookupHits('dungeon meshi', [tower, edition], [ani]);
    assert.deepEqual(hits.map((h) => h.id), ['mp_5', 'mp_6']);
    const folded = hits[0];
    assert.deepEqual(
        [folded.author, folded.alt_title, folded.description, folded.cover_image, folded.tags, folded.publisher],
        ['Ryoko Kui', 'ダンジョン飯', 'Deutscher Text', 'https://mp.example/c.jpg', 'Fantasy', 'Egmont']
    );
    assert.deepEqual([folded.also_on, folded.work_key, folded.anilist_id, folded.mal_id], [['anilist', 'mal'], 'anilist:86082', 86082, 85781]);
    assert.equal(hits[1].work_key, undefined, 'an edition without a fold gets no work key');
});

test('rankLookupHits: a fold needs a unique pair; a MyAnimeList hit next to an AniList hit with a MAL id stays separate', () => {
    const mp = (id, title) => ({ id: `mp_${id}`, manga_passion_id: id, source: 'manga_passion', title, author: null, description: null });
    const al = (id, title, extra = {}) => ({ id: `al_${id}`, source: 'anilist', title, alt_title: title, author: `Autor ${id}`, ...extra });
    const mal = (id, title, extra = {}) => ({ id: `mal_${id}`, source: 'mal', title, alt_title: title, author: `MAL ${id}`, description: `MAL Text ${id}`, ...extra });

    const twoEditions = rankLookupHits('Monster', [mp(1, 'Monster'), mp(2, 'Monster')], [al(10, 'Monster')]);
    assert.equal(twoEditions.length, 3);
    assert.ok(twoEditions.every((h) => !h.also_on), 'one AniList hit for two editions: no fold');
    const twoWorks = rankLookupHits('Monster', [mp(1, 'Monster')], [al(10, 'Monster'), al(11, 'Monster')]);
    assert.equal(twoWorks.length, 3);
    assert.ok(twoWorks.every((h) => !h.also_on), 'two AniList hits for one edition: no fold');

    const otherWork = rankLookupHits('Blue', [mp(1, 'Blue')], [al(10, 'Blue', { mal_id: 50 }), mal(60, 'Blue')]);
    assert.deepEqual(otherWork.map((h) => h.id), ['mp_1', 'mal_60']);
    assert.deepEqual([otherWork[0].also_on, otherWork[0].author, otherWork[1].work_key], [['anilist'], 'Autor 10', 'mal:60']);

    const sameWork = rankLookupHits('Blue', [mp(1, 'Blue')], [al(10, 'Blue', { author: null }), mal(60, 'Blue')]);
    assert.equal(sameWork.length, 1);
    assert.deepEqual([sameWork[0].also_on, sameWork[0].author, sameWork[0].description, sameWork[0].mal_id, sameWork[0].work_key],
        [['anilist', 'mal'], 'MAL 60', 'MAL Text 60', 60, 'anilist:10'], 'AniList fills first, then MyAnimeList');

    const malOnly = rankLookupHits('Blue', [mp(1, 'Blue')], [mal(60, 'Blue')]);
    assert.deepEqual([malOnly.length, malOnly[0].work_key, malOnly[0].mal_id, malOnly[0].anilist_id], [1, 'mal:60', 60, undefined]);
});

test('rankLookupHits: at most 10 hits, up to 3 Manga Passion hits with a score kept, ties put Manga Passion first', () => {
    const editions = [1, 2, 3, 4].map((i) => ({ id: `mp_${i}`, source: 'manga_passion', title: `Die Reihe Band ${i}` }));
    const gatewayHits = Array.from({ length: 12 }, (_, i) => ({ id: `al_${i + 1}`, source: 'anilist', title: `Reihe ${i + 1}` }));
    const hits = rankLookupHits('Reihe', editions, gatewayHits);
    assert.equal(hits.length, 10);
    assert.deepEqual(hits.filter((h) => h.source === 'manga_passion').map((h) => h.id), ['mp_1', 'mp_2', 'mp_3']);
    assert.deepEqual(hits.slice(0, 7).map((h) => h.id), ['al_1', 'al_2', 'al_3', 'al_4', 'al_5', 'al_6', 'al_7']);

    const tie = rankLookupHits('Berserk', [{ id: 'mp_9', source: 'manga_passion', title: 'Berserk Deluxe' }], [{ id: 'al_9', source: 'anilist', title: 'Berserk Ultimate' }]);
    assert.deepEqual(tie.map((h) => h.id), ['mp_9', 'al_9']);
    assert.deepEqual(rankLookupHits('Berserk', [], []), []);
});
