// Shared pieces of the anime tests: fixtures, a fake fetch per URL and a memory core whose ctx.http uses it.
const path = require('path');
const { createMemoryCore } = require('../core/harness');
const gateway = require('../../core/anime/gateway');
const { setCredentialProvider } = require('../../core/sources/credentials');

const fixture = (name) => JSON.parse(JSON.stringify(require(path.join(__dirname, '..', 'fixtures', name))));

const json = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
});

const offline = (url) => Object.assign(new TypeError(`fetch failed (offline in tests): ${url}`), { cause: { code: 'ENOTFOUND' } });

/**
 * fetch that answers by `handlers` ({ anilist(body, init), jikan(path, init), mal(path, init) }); a handler returning
 * undefined, or a host without handler, fails like an unreachable host. `calls` records { host, url, body, headers }.
 */
function fakeFetch(handlers = {}) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const text = String(url);
        const headers = init.headers || {};
        let host = 'other';
        let result;
        if (text.startsWith('https://graphql.anilist.co')) {
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
        } else {
            calls.push({ host, url: text, headers });
            result = handlers.other && await handlers.other(text, init);
        }
        if (result === undefined) throw offline(text);
        return result;
    };
    return { fetch, calls, count: (host) => calls.filter((c) => c.host === host).length };
}

/** AniList answers from the recorded fixtures, by the shape of the query. */
function aniListFixtures(body) {
    const q = body.query;
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

module.exports = { fixture, json, fakeFetch, aniListFixtures, jikanFixtures, memoryWith, ctxAs, offline };
