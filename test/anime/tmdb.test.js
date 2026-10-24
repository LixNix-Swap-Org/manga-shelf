// TMDb source: adapter mapping, key transport, search with kinds and the anime fold, refresh paths and the sources row.
const test = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../core/anime/gateway');
const tmdb = require('../../core/anime/tmdb');
const cache = require('../../core/anime/cache');
const { SourceError } = require('../../core/anime/request');
const { fakeFetch, aniListFixtures, jikanFixtures, tmdbFixtures, memoryWith, ctxAs, json, fixture } = require('./helpers');

const HEX_KEY = '0123456789abcdef0123456789abcdef';
const READ_TOKEN = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(120)}.${'b'.repeat(43)}`;
const DAY = 24 * 60 * 60 * 1000;

test.afterEach(() => gateway.resetGatewayState());

/** A credential provider with optional own keys by user id, an instance key and volunteers; records failures. */
function keys({ own = {}, instance = null, volunteers = [] } = {}) {
    const failed = [];
    let instanceKey = instance;
    return {
        failed,
        provider: {
            get: (userId, provider) => (provider === 'tmdb' && own[userId] ? { secret: own[userId], allowBackground: false } : null),
            instance: (provider) => (provider === 'tmdb' && instanceKey ? { secret: instanceKey, fromEnv: false } : null),
            background: (provider) => (provider === 'tmdb' ? volunteers : []),
            failed: (userId, provider, message) => {
                failed.push([userId, provider, message]);
                if (userId === null) instanceKey = null;
            },
            used: () => {},
            status: (userId, provider) => (userId === null && provider === 'tmdb' && failed.length ? { configured: true, last_error: failed.at(-1)[2] } : null)
        }
    };
}

const ctxWith = (http, credentials) => ctxAs(memoryWith(http.fetch, { credentials }), 'ed');

test('adapter: search/multi drops people, keeps films and shows with the TMDb fields; the key goes as api_key or Bearer', async () => {
    const http = fakeFetch({ tmdb: tmdbFixtures });
    const ctx = ctxWith(http, keys().provider);
    const { metas } = await tmdb.search(ctx, 'Frieren', { language: 'de-DE', credential: { secret: HEX_KEY } });
    assert.deepEqual(metas.map((m) => [m.tmdb_kind, m.tmdb_id]), [['tv', 209867], ['movie', 550123], ['tv', 300400]]);
    const [show, film, doc] = metas;
    assert.deepEqual([show.kind, show.format, show.title.english, show.title.native, show.season_year, show.start_date],
        ['tv', 'TV', 'Frieren – Nach dem Ende der Reise', '葬送のフリーレン', 2023, '2023-09-29']);
    assert.deepEqual([show.original_language, show.tmdb_genre_ids, show.score, show.source], ['ja', [16, 10759, 10765], 88, 'tmdb']);
    assert.equal(show.cover_url, 'https://image.tmdb.org/t/p/w342/dqZENchTd7lp5zht7BdlqM7RBhD.jpg');
    assert.deepEqual(show.urls, { anilist: null, mal: null, tmdb: 'https://www.themoviedb.org/tv/209867', imdb: null });
    assert.deepEqual([film.kind, film.format, film.episodes, film.score], ['movie', 'MOVIE', 1, null], 'no votes, no score');
    assert.equal(doc.cover_url, null);
    const [call] = http.calls;
    assert.match(call.url, /^https:\/\/api\.themoviedb\.org\/3\/search\/multi\?query=Frieren&include_adult=false&language=de-DE&page=1&api_key=0123456789abcdef0123456789abcdef$/);
    assert.equal(call.headers.Authorization, undefined);

    await tmdb.search(ctx, 'Frieren', { credential: { secret: READ_TOKEN } });
    const bearer = http.calls.at(-1);
    assert.equal(bearer.headers.Authorization, `Bearer ${READ_TOKEN}`);
    assert.ok(!bearer.url.includes('api_key'));
    assert.match(bearer.url, /language=en-US/);
});

test('adapter: a TV show counts the aired regular seasons, next airing is absolute at 12:00 UTC, IMDb from external_ids', async () => {
    const http = fakeFetch({ tmdb: tmdbFixtures });
    const ctx = ctxWith(http, keys().provider);
    const { meta } = await tmdb.byId(ctx, 'tv', 209867, { credential: { secret: HEX_KEY } });
    assert.match(http.calls[0].url, /\/tv\/209867\?language=en-US&append_to_response=external_ids&api_key=/);
    assert.deepEqual(meta.seasons, [
        { season_number: 1, episode_count: 28, air_date: '2023-09-29' },
        { season_number: 2, episode_count: 10, air_date: '2026-01-16' },
        { season_number: 3, episode_count: 12, air_date: '2099-01-07' }
    ]);
    assert.equal(meta.episodes, 38, 'specials and the unaired season are not counted');
    assert.deepEqual(meta.next_airing, { episode: 39, at: Date.parse('2099-01-07T12:00:00Z') / 1000 });
    assert.equal(meta.next_airing_estimated, true);
    assert.deepEqual([meta.title.english, meta.title.native, meta.status, meta.duration, meta.end_date], ["Frieren: Beyond Journey's End", '葬送のフリーレン', 'RELEASING', 24, null]);
    assert.deepEqual([meta.imdb_id, meta.urls.imdb], ['tt22248376', 'https://www.imdb.com/title/tt22248376/']);
    assert.deepEqual([meta.genres, meta.tmdb_genre_ids, meta.spoken_languages], [['Animation', 'Action & Adventure', 'Sci-Fi & Fantasy'], [16, 10759, 10765], ['ja']]);

    const film = (await tmdb.byId(ctx, 'movie', 550123, { credential: { secret: HEX_KEY } })).meta;
    assert.deepEqual([film.kind, film.episodes, film.duration, film.status, film.imdb_id, film.score, film.spoken_languages, film.seasons],
        ['movie', 1, 104, 'FINISHED', 'tt9000001', null, ['de', 'en'], []]);
    assert.equal((await tmdb.byId(ctx, 'tv', 4040, { credential: { secret: HEX_KEY } })).meta, null, 'unknown id');
});

test('adapter: status mapping, end date and the runtime fallback', () => {
    const tv = (fields) => tmdb.normalizeDetail('tv', { ...fixture('tmdb-tv-209867.json'), ...fields }, Date.now());
    const ended = tv({ status: 'Ended', next_episode_to_air: null });
    assert.deepEqual([ended.status, ended.end_date, ended.next_airing], ['FINISHED', '2026-03-27', null]);
    assert.equal(tv({ status: 'Pilot' }).status, 'NOT_YET_RELEASED');
    assert.equal(tv({ status: 'Planned' }).status, 'NOT_YET_RELEASED');
    assert.equal(tv({ status: 'In Production' }).status, 'RELEASING');
    assert.equal(tv({ status: 'Canceled' }).status, 'CANCELLED');
    assert.equal(tv({ status: 'Something new' }).status, null);
    assert.equal(tv({ episode_run_time: [] }).duration, 25, 'last_episode_to_air.runtime');
    const special = tv({ next_episode_to_air: { season_number: 0, episode_number: 3, air_date: '2026-11-01' } });
    assert.deepEqual([special.next_airing, special.next_airing_estimated, special.episodes], [null, false, 38], 'a special is no next episode');
    assert.equal(tv({ next_episode_to_air: { season_number: 7, episode_number: 1, air_date: '2099-05-01' } }).next_airing, null, 'unknown season');
    assert.deepEqual(tv({ next_episode_to_air: { season_number: 2, episode_number: 4, air_date: '2026-02-06' } }).next_airing,
        { episode: 32, at: Date.parse('2026-02-06T12:00:00Z') / 1000 });
    const movie = (status) => tmdb.normalizeDetail('movie', { ...fixture('tmdb-movie-550123.json'), status }, Date.now()).status;
    assert.deepEqual(['Rumored', 'Planned', 'In Production', 'Post Production', 'Canceled', 'Released', 'Odd'].map(movie),
        ['NOT_YET_RELEASED', 'NOT_YET_RELEASED', 'NOT_YET_RELEASED', 'NOT_YET_RELEASED', 'CANCELLED', 'FINISHED', null]);
});

test('adapter: the key check answers with the last four characters; a refused key is an auth error', async () => {
    const http = fakeFetch({ tmdb: (path) => (path.includes(HEX_KEY) ? tmdbFixtures(path) : json({ status_code: 7, status_message: 'Invalid API key' }, { status: 401 })) });
    const ctx = ctxWith(http, keys().provider);
    assert.deepEqual(await gateway.validateCredential(ctx, 'tmdb', HEX_KEY), { label: 'Schlüssel …cdef' });
    await assert.rejects(gateway.validateCredential(ctx, 'tmdb', 'f'.repeat(32)), (err) => err instanceof SourceError && err.kind === 'auth');
});

test('search: TMDb only with a key; the Japanese animation hit folds into the AniList hit of the same year', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures, tmdb: tmdbFixtures });
    const none = await gateway.searchAnime(ctxWith(http, keys().provider), 'Frieren');
    assert.deepEqual(none.sources_available, ['anilist', 'mal']);
    assert.equal(http.count('tmdb'), 0, 'never an attempt without an access');
    gateway.resetGatewayState();

    const ctx = ctxWith(http, keys({ own: { 2: HEX_KEY } }).provider);
    const result = await gateway.searchAnime(ctx, 'Frieren', { language: 'de' });
    assert.deepEqual(result.sources_available, ['anilist', 'mal', 'tmdb']);
    assert.deepEqual([result.sources_used.sort(), result.partial, result.credential_used], [['anilist', 'jikan', 'tmdb'], false, 'shared']);
    const frieren = result.results.find((r) => r.anilist_id === 154587);
    assert.deepEqual(frieren.also_on, ['tmdb']);
    assert.deepEqual(frieren.folded_tmdb, { tmdb_kind: 'tv', tmdb_id: 209867 });
    assert.equal(result.results.filter((r) => r.tmdb_id === 209867).length, 0, 'folded, not listed twice');
    assert.ok(result.results.some((r) => r.tmdb_id === 550123) && result.results.some((r) => r.tmdb_id === 300400));
    const row = cache.read(ctx, 'anime:search:tmdb:de-DE:frieren:10').value;
    assert.deepEqual(row.metas.map((m) => m.tmdb_id), [209867, 550123, 300400], 'the row holds the whole answer');
    assert.ok(!cache.read(ctx, 'anime:search:frieren:10').value.results.some((r) => r.tmdb_id || r.also_on), 'no TMDb in the legacy row');
    assert.match(http.calls.find((c) => c.host === 'tmdb').url, /language=de-DE/);

    await gateway.searchAnime(ctx, 'Frieren', { language: 'en' });
    assert.match(http.calls.filter((c) => c.host === 'tmdb').at(-1).url, /language=en-US/, 'one row per TMDb language');
    assert.ok(cache.read(ctx, 'anime:search:tmdb:en-US:frieren:10'));
});

test('search: kind tv or movie asks TMDb only and filters after the read; anime asks AniList and MyAnimeList only', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, jikan: jikanFixtures, tmdb: tmdbFixtures });
    const ctx = ctxWith(http, keys({ instance: HEX_KEY }).provider);
    const shows = await gateway.searchAnime(ctx, 'Frieren', { kind: 'tv' });
    assert.deepEqual([shows.sources_used, http.count('anilist'), http.count('jikan')], [['tmdb'], 0, 0]);
    assert.deepEqual(shows.results.map((r) => r.tmdb_id).sort(), [209867, 300400], 'the anime show stays a TMDb hit without AniList');
    const films = await gateway.searchAnime(ctx, 'Frieren', { kind: 'movie' });
    assert.deepEqual([films.results.map((r) => r.tmdb_id), films.cached, http.count('tmdb')], [[550123], true, 1]);
    const anime = await gateway.searchAnime(ctx, 'Frieren', { kind: 'anime' });
    assert.ok(anime.results.length > 0 && anime.results.every((r) => r.kind === 'anime' && !r.tmdb_id));
    assert.equal(http.count('tmdb'), 1);
    const all = await gateway.searchAnime(ctx, 'Frieren', { kind: 'all', sources: ['tmdb'] });
    assert.deepEqual(all.results.map((r) => r.tmdb_id).sort(), [209867, 300400, 550123]);
});

test('search: when TMDb alone was asked and fails, the 503 names TMDB', async () => {
    const http = fakeFetch({ tmdb: () => json({}, { status: 502 }) });
    const ctx = ctxWith(http, keys({ instance: HEX_KEY }).provider);
    await assert.rejects(gateway.searchAnime(ctx, 'Frieren', { kind: 'movie' }),
        (err) => err.status === 503 && err.code === 'SOURCES_UNAVAILABLE' && err.message === 'TMDB ist gerade nicht erreichbar. Bitte später erneut versuchen.');
});

test('sources state: the tmdb row tells whether the caller can use TMDb and shows a refused instance key', () => {
    const http = fakeFetch({});
    const plain = gateway.sourcesState(ctxWith(http, keys().provider));
    assert.deepEqual([plain.anilist.available, plain.mal.available], [true, true]);
    assert.deepEqual(plain.tmdb, { enabled: true, name: 'TMDB', own: null, key_disabled: false, available: false, error: null });
    gateway.resetGatewayState();
    const own = gateway.sourcesState(ctxWith(http, keys({ own: { 2: HEX_KEY } }).provider)).tmdb;
    assert.deepEqual([own.available, own.own.limit, own.limit], [true, 120, undefined], 'shared budget only with an instance key');
    gateway.resetGatewayState();
    const shared = gateway.sourcesState(ctxWith(http, keys({ instance: HEX_KEY }).provider)).tmdb;
    assert.deepEqual([shared.available, shared.limit, shared.circuit], [true, 120, 'closed']);
    gateway.resetGatewayState();
    const off = { ...ctxWith(http, keys({ instance: HEX_KEY }).provider), config: { anime: { sources: ['anilist', 'jikan'] } } };
    assert.deepEqual([gateway.sourcesState(off).tmdb.enabled, gateway.sourcesState(off).tmdb.available], [false, false]);
});

function tmdbEntry(core, { id = 50, tmdbId = 209867, next = 1 } = {}) {
    core.conn.prepare(`INSERT INTO animes (id, title, title_english, kind, tmdb_id, tmdb_kind, status, next_check_at, meta_fetched_at)
        VALUES (?, 'Frieren – Nach dem Ende der Reise', 'Frieren: Beyond Journey''s End', 'tv', ?, 'tv', 'RELEASING', ?, 1)`).run(id, tmdbId, next);
}

const rowOf = (core, id) => core.conn.prepare('SELECT * FROM animes WHERE id = ?').get(id);

test('refresh: TMDb rows outside the AniList groups; without a background key they are skipped for a day', async () => {
    const http = fakeFetch({ anilist: aniListFixtures, tmdb: tmdbFixtures });
    const core = memoryWith(http.fetch, { credentials: keys({ own: { 2: HEX_KEY } }).provider });
    tmdbEntry(core);
    core.conn.prepare("INSERT INTO animes (id, title, anilist_id, status, next_check_at) VALUES (51, 'Frieren', 154587, 'RELEASING', 1)").run();
    const before = Date.now();
    const report = await gateway.refreshDue(core.ctx);
    assert.deepEqual([report.due, report.updated, report.stopped], [2, 1, false]);
    assert.equal(http.count('tmdb'), 0, 'a personal key is never used in the background');
    const skipped = rowOf(core, 50);
    assert.ok(skipped.next_check_at >= before + DAY - 1000 && skipped.next_check_at <= Date.now() + DAY);
    assert.equal((await core.client('ed')('GET', '/anime')).body.find((e) => e.id === 50).stale, false);
});

test('refresh: over the instance key a TMDb row gets the snapshot, keeps its title and hotlinks the poster', async () => {
    const http = fakeFetch({ tmdb: tmdbFixtures });
    const images = [];
    const core = memoryWith(http.fetch, {
        credentials: keys({ instance: HEX_KEY }).provider,
        http: { fetch: http.fetch, fetchText: async () => '', fetchImage: async (url) => { images.push(url); throw new Error('no download expected'); } }
    });
    tmdbEntry(core);
    const report = await gateway.refreshDue(core.ctx);
    assert.deepEqual([report.updated, report.stopped], [1, false]);
    const row = rowOf(core, 50);
    assert.deepEqual([row.title, row.title_english, row.episodes, row.imdb_id, row.original_language],
        ['Frieren – Nach dem Ende der Reise', "Frieren: Beyond Journey's End", 38, 'tt22248376', 'ja'], 'the localised title stays');
    assert.equal(row.cover_image, 'https://image.tmdb.org/t/p/w342/dqZENchTd7lp5zht7BdlqM7RBhD.jpg');
    assert.equal(row.cover_source, row.cover_image);
    assert.deepEqual(images, [], 'nothing copied into the uploads');
    assert.deepEqual(JSON.parse(row.seasons).map((s) => s.season_number), [1, 2, 3]);
    assert.deepEqual([row.kind, row.tmdb_id, row.tmdb_kind], ['tv', 209867, 'tv']);
});

test('refresh: a refused instance key is marked failed and the next rows go to a volunteer; a failing call waits an hour', async () => {
    const VOLUNTEER = 'fedcba9876543210fedcba9876543210';
    const http = fakeFetch({
        tmdb: (path) => (path.includes(VOLUNTEER) ? tmdbFixtures(path) : json({ status_code: 7, status_message: 'Invalid API key' }, { status: 401 }))
    });
    const credentials = keys({ instance: HEX_KEY, volunteers: [{ userId: 2, secret: VOLUNTEER }] });
    const core = memoryWith(http.fetch, { credentials: credentials.provider });
    tmdbEntry(core, { id: 50 });
    tmdbEntry(core, { id: 52, tmdbId: 209868 });
    const report = await gateway.refreshDue(core.ctx);
    assert.deepEqual(credentials.failed, [[null, 'tmdb', 'TMDB lehnt den Schlüssel ab (401)']]);
    assert.equal(http.calls.filter((c) => c.url.includes(HEX_KEY)).length, 1, 'the refused key is not sent again');
    assert.deepEqual([report.updated, report.missing, report.stopped], [1, 1, false], 'the volunteer key serves both rows');
    assert.equal(gateway.sourcesState(ctxAs(core, 'ed')).tmdb.error, 'TMDB lehnt den Schlüssel ab (401)');

    gateway.resetGatewayState();
    const down = fakeFetch({ tmdb: () => json({}, { status: 503 }) });
    const broken = memoryWith(down.fetch, { credentials: keys({ instance: HEX_KEY }).provider });
    tmdbEntry(broken);
    const before = Date.now();
    const failed = await gateway.refreshDue(broken.ctx);
    assert.deepEqual([failed.updated, failed.stopped], [0, false]);
    const next = rowOf(broken, 50).next_check_at;
    assert.ok(next >= before + 60 * 60 * 1000 - 1000 && next < before + 2 * 60 * 60 * 1000);
});

test('refresh: without a background key the detail refreshes an old TMDb row with the caller\'s own key, once a day', async () => {
    const http = fakeFetch({ tmdb: tmdbFixtures });
    const core = memoryWith(http.fetch, { credentials: keys({ own: { 2: HEX_KEY } }).provider });
    tmdbEntry(core, { next: Date.now() + DAY });
    const ed = core.client('ed');
    assert.equal((await ed('GET', '/anime/50')).status, 200);
    await gateway.state().background.idle();
    assert.equal(http.count('tmdb'), 1);
    assert.equal(rowOf(core, 50).imdb_id, 'tt22248376');
    core.conn.prepare('UPDATE animes SET meta_fetched_at = 1 WHERE id = 50').run();
    await ed('GET', '/anime/50');
    await gateway.state().background.idle();
    assert.equal(http.count('tmdb'), 1, 'at most once per row and day');
    assert.equal(gateway.scheduleOwnTmdbRefresh(ctxAs(core, 'admin'), rowOf(core, 50)), false, 'only with an own key');
});

test('fold: only Japanese animation, only hits with an AniList id, only in the same year; MAL-only hits stay targets of nothing', () => {
    const { foldTmdbHits, emptyMeta } = require('../../core/anime/normalize');
    const hit = (fields) => emptyMeta({ kind: 'tv', tmdb_id: 1, tmdb_kind: 'tv', original_language: 'ja', tmdb_genre_ids: [16], season_year: 2023,
        title: { romaji: null, english: 'Frieren – Nach dem Ende der Reise', native: '葬送のフリーレン', preferred: null }, ...fields });
    const ani = emptyMeta({ anilist_id: 154587, season_year: 2023, title: { romaji: 'Sousou no Frieren', english: null, native: '葬送のフリーレン', preferred: null } });
    const malOnly = { ...ani, anilist_id: null, mal_id: 52991 };
    assert.equal(foldTmdbHits([ani], [hit()]).rest.length, 0);
    assert.equal(foldTmdbHits([malOnly], [hit()]).rest.length, 1, 'a MyAnimeList-only hit is no target');
    assert.equal(foldTmdbHits([ani], [hit({ season_year: 2025 })]).rest.length, 1, 'another year');
    assert.equal(foldTmdbHits([ani], [hit({ original_language: 'en' })]).rest.length, 1, 'not Japanese');
    assert.equal(foldTmdbHits([ani], [hit({ tmdb_genre_ids: [10759] })]).rest.length, 1, 'not animation');
    const byStartDate = foldTmdbHits([{ ...ani, season_year: null, start_date: '2023-09-29' }], [hit({ season_year: null, start_date: '2023-10-01' })]);
    assert.deepEqual([byStartDate.rest.length, byStartDate.metas[0].also_on], [0, ['tmdb']], 'the year of start_date counts too');
});

test('season suggestion: the TMDb twin of an anime entry, names in the UI language, unaired seasons past the count dropped', async () => {
    const http = fakeFetch({ tmdb: tmdbFixtures });
    const ctx = ctxWith(http, keys({ instance: HEX_KEY }).provider);
    const row = { kind: 'anime', title: 'Sousou no Frieren', title_romaji: 'Sousou no Frieren', title_native: '葬送のフリーレン', season_year: 2023, episodes: 38 };
    const result = await gateway.tmdbSeasons(ctx, row, { language: 'de' });
    assert.deepEqual(result, {
        seasons: [
            { start: 1, name: 'Season 1', episodes: 28, season_number: 1 },
            { start: 29, name: 'Season 2', episodes: 10, season_number: 2 }
        ],
        reason: null,
        tmdb_id: 209867
    });
    assert.match(http.calls[0].url, /\/search\/multi\?query=Sousou%20no%20Frieren&.*language=de-DE/);
    assert.match(http.calls[1].url, /\/tv\/209867\?language=de-DE&api_key=/);

    const own = await gateway.tmdbSeasons(ctx, { kind: 'tv', tmdb_kind: 'tv', tmdb_id: 209867, title: 'Frieren', episodes: null }, { language: 'en' });
    assert.deepEqual(own.seasons.map((s) => s.start), [1, 29, 39], 'its own TMDb show, no search; without a count every season stays');
    assert.match(http.calls.at(-1).url, /\/tv\/209867\?language=en-US/);

    const nothing = await gateway.tmdbSeasons(ctx, { kind: 'anime', title: 'Völlig unbekannt', episodes: 12 });
    assert.deepEqual(nothing, { seasons: [], reason: 'not_found', tmdb_id: null });

    const keyless = await gateway.tmdbSeasons(ctxWith(http, keys().provider), row);
    assert.deepEqual(keyless, { seasons: [], reason: 'no_key', tmdb_id: null });
});

test('season suggestion: an answer for a stored entry is cached, so reopening it asks TMDb once', async () => {
    const http = fakeFetch({ tmdb: tmdbFixtures });
    const ctx = ctxWith(http, keys({ instance: HEX_KEY }).provider);
    const row = { id: 7, kind: 'anime', title: 'Sousou no Frieren', title_romaji: 'Sousou no Frieren', title_native: '葬送のフリーレン', season_year: 2023, episodes: 38 };
    const first = await gateway.tmdbSeasons(ctx, row, { language: 'de' });
    const calls = http.calls.length;
    assert.deepEqual(await gateway.tmdbSeasons(ctx, row, { language: 'de' }), first);
    assert.equal(http.calls.length, calls, 'second call from api_cache');
});
