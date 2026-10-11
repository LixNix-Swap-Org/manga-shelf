// Shared pieces of the anime tests: fixtures, a fake fetch per URL and a memory core whose ctx.http uses it.
const fs = require('fs');
const path = require('path');
const { createMemoryCore } = require('../core/harness');
const gateway = require('../../core/anime/gateway');
const { setCredentialProvider } = require('../../core/sources/credentials');

const fixture = (name) => JSON.parse(JSON.stringify(require(path.join(__dirname, '..', 'fixtures', name))));
const textFixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
});

const offline = (url) => Object.assign(new TypeError(`fetch failed (offline in tests): ${url}`), { cause: { code: 'ENOTFOUND' } });

/**
 * fetch that answers by `handlers` ({ anilist(body, init), jikan(path, init), mal(path, init), tmdb(path, init) }); a handler returning
 * undefined, or a host without handler, fails like an unreachable host. `calls` records { host, url, body, headers }.
 */
function fakeFetch(handlers = {}) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const text = String(url);
        const headers = init.headers || {};
        let host = 'other';
        let result;
        if (URL.parse(text)?.hostname === 'graphql.anilist.co') {
            host = 'anilist';
            const body = JSON.parse(init.body);
            calls.push({ host, url: text, body, headers });
            result = handlers.anilist && await handlers.anilist(body, init);
        } else if (text.startsWith('https://api.jikan.moe/v4')) {
            host = 'jikan';
            calls.push({ host, url: text, headers });
            result = handlers.jikan && await handlers.jikan(text.slice('https://api.jikan.moe/v4'.length), init);
        } else if (text.startsWith('https://api.myanimelist.net/v2')) {
            host = 'mal';
            calls.push({ host, url: text, headers });
            result = handlers.mal && await handlers.mal(text.slice('https://api.myanimelist.net/v2'.length), init);
        } else if (text.startsWith('https://api.themoviedb.org/3')) {
            host = 'tmdb';
            calls.push({ host, url: text, headers });
            result = handlers.tmdb && await handlers.tmdb(text.slice('https://api.themoviedb.org/3'.length), init);
        } else {
            calls.push({ host, url: text, headers });
            result = handlers.other && await handlers.other(text, init);
        }
        if (result === undefined) throw offline(text);
        return result;
    };
    return { fetch, calls, count: (host) => calls.filter((c) => c.host === host).length };
}

/** AniList answers from the recorded fixtures, by the shape of the query (list queries before Viewer). */
function aniListFixtures(body) {
    const q = body.query;
    if (q.includes('SaveMediaListEntry')) {
        const saved = fixture('anilist-save-entry.json');
        const v = body.variables || {};
        Object.assign(saved.data.SaveMediaListEntry, { mediaId: v.m, progress: v.p, status: v.s });
        return json(saved);
    }
    if (q.includes('MediaListCollection')) return json(fixture('anilist-medialist-collection.json'));
    if (q.includes('MediaList(')) return json(fixture('anilist-medialist-entry.json'));
    if (q.includes('Viewer')) return json({ data: { Viewer: { id: 7, name: 'kim-anilist' } } });
    if (q.includes('id_in') || q.includes('idMal_in')) return json(fixture('anilist-ids.json'), { headers: { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '25' } });
    if (q.includes('Media(')) return json(fixture('anilist-media-154587.json'), { headers: { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '27' } });
    if (q.includes('type: MANGA') && q.includes('relations')) return json(fixture('anilist-adaptations-frieren.json'));
    if (q.includes('type: MANGA')) return json(fixture('anilist-manga-berserk.json'));
    if (body.variables && body.variables.s1) return json(fixture('anilist-search-apothekerin.json'));
    return json(fixture('anilist-search-frieren.json'), { headers: { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '29' } });
}

function jikanFixtures(urlPath) {
    if (urlPath.startsWith('/anime?')) return json(fixture('jikan-search-frieren.json'));
    if (urlPath.startsWith('/anime/')) return json(fixture('jikan-anime-21-full.json'));
    if (urlPath.startsWith('/manga?')) return json(fixture('jikan-manga-berserk.json'));
    if (/^\/manga\/\d+\/relations/.test(urlPath)) return json(fixture('jikan-manga-relations-berserk.json'));
    return undefined;
}

/** TMDb answers from the hand-written fixtures, by path. */
function tmdbFixtures(urlPath) {
    if (urlPath.startsWith('/search/multi?')) return json(fixture('tmdb-search-multi-frieren.json'));
    if (urlPath.startsWith('/tv/209867?')) return json(fixture('tmdb-tv-209867.json'));
    if (urlPath.startsWith('/movie/550123?')) return json(fixture('tmdb-movie-550123.json'));
    if (urlPath.startsWith('/authentication')) return json(fixture('tmdb-authentication.json'));
    if (/^\/(tv|movie)\/\d+\?/.test(urlPath)) return json({ success: false, status_code: 34, status_message: 'The resource you requested could not be found.' }, { status: 404 });
    return undefined;
}

/** Memory core (test/core/harness.js) with `fetch` as ctx.http.fetch and a fresh gateway state. */
function memoryWith(fetch, overrides = {}) {
    gateway.resetGatewayState();
    setCredentialProvider(null);
    const core = createMemoryCore({
        http: {
            fetch,
            fetchText: async (url) => { throw offline(url); },
            fetchImage: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }
        },
        ...overrides
    });
    return core;
}

/** ctx of the memory core acting as `username`. */
function ctxAs(core, username) {
    const user = core.users.find((u) => u.username === username) || null;
    return { ...core.ctx, user };
}

module.exports = { fixture, textFixture, json, fakeFetch, aniListFixtures, jikanFixtures, tmdbFixtures, memoryWith, ctxAs, offline };
