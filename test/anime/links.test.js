// Streaming links (core/watch/links.js) and POST /anime/resolve-link on the memory core.
const test = require('node:test');
const assert = require('node:assert/strict');
const links = require('../../core/watch/links');
const gateway = require('../../core/anime/gateway');
const { memoryWith, textFixture, offline } = require('./helpers');

test.afterEach(() => gateway.resetGatewayState());

test('detectLink: Crunchyroll watch, series and legacy links, canonical and allowlisted only', () => {
    const watch = links.detectLink('https://www.crunchyroll.com/de/watch/GG1U2Q0ZW/like-a-fairy-tale?utm_source=share#t=10');
    assert.deepEqual(watch, {
        service: 'crunchyroll', kind: 'episode', id: 'GG1U2Q0ZW', slug: 'like-a-fairy-tale',
        url: 'https://www.crunchyroll.com/watch/GG1U2Q0ZW/like-a-fairy-tale', episodeHint: null, seriesSlug: null
    });
    assert.equal(links.detectLink('https://crunchyroll.com/pt-br/watch/GG1U2Q0ZW').url, 'https://www.crunchyroll.com/watch/GG1U2Q0ZW');
    assert.equal(links.detectLink('https://m.crunchyroll.com/watch/gg1u2q0zw/episode-7-like-a-fairy-tale/').episodeHint, 7);
    const series = links.detectLink('https://www.crunchyroll.com/series/GG5H5XQ7D/frieren-beyond-journeys-end');
    assert.deepEqual([series.kind, series.id, series.slug, series.episodeHint], ['series', 'GG5H5XQ7D', 'frieren-beyond-journeys-end', null]);
    const legacy = links.detectLink('https://www.crunchyroll.com/frieren-beyond-journeys-end/episode-7-like-a-fairy-tale-911417');
    assert.deepEqual([legacy.kind, legacy.id, legacy.episodeHint, legacy.seriesSlug], ['legacy', '911417', 7, 'frieren-beyond-journeys-end']);

    for (const refused of [
        'http://www.crunchyroll.com/watch/GG1U2Q0ZW/x',
        'https://www.crunchyroll.com.evil.tld/watch/GG1U2Q0ZW/x',
        'https://evilcrunchyroll.com/watch/GG1U2Q0ZW/x',
        'https://user:pw@www.crunchyroll.com/watch/GG1U2Q0ZW/x',
        'https://www.crunchyroll.com:8443/watch/GG1U2Q0ZW/x',
        'https://www.netflix.com/watch/81726716',
        'https://www.crunchyroll.com/news/latest',
        `https://www.crunchyroll.com/watch/GG1U2Q0ZW/${'a'.repeat(2100)}`
    ]) assert.equal(links.detectLink(refused), null, refused);
    assert.equal(links.detectLink('javascript:alert(1)//https://www.crunchyroll.com/watch/GG1U2Q0ZW').url, 'https://www.crunchyroll.com/watch/GG1U2Q0ZW',
        'only the embedded https link counts, never the javascript: text');
});

test('detectLink reads share texts: the first recognised link, trailing punctuation dropped', () => {
    const text = 'Schau dir „Frieren“ Folge 7 auf Crunchyroll an! https://example.org/x https://www.crunchyroll.com/de/watch/GG1U2Q0ZW/like-a-fairy-tale.';
    assert.equal(links.detectLink(text).url, 'https://www.crunchyroll.com/watch/GG1U2Q0ZW/like-a-fairy-tale');
    assert.equal(links.detectLink('kein Link'), null);
    assert.equal(links.detectLink(null), null);
});

test('episodeFromText, seriesTitleFromText and isAllowedUrl', () => {
    const cases = [['Folge 7', 7], ['Episode 12 - Titel', 12], ['Ep. 3', 3], ['Ep 4', 4], ['S1 E7', 7], ['S2E11', 11], ['E9 – Titel', 9], ['Nur Text', null],
        ['https://www.crunchyroll.com/watch/GE7ABCDEF/x', null]];
    for (const [text, episode] of cases) assert.equal(links.episodeFromText(text), episode, text);
    assert.equal(links.seriesTitleFromText('Schau dir „Frieren“ Folge 7 auf Crunchyroll an! https://www.crunchyroll.com/watch/GG1U2Q0ZW'), 'Frieren');
    assert.equal(links.seriesTitleFromText('Watch Frieren: Beyond Journey\'s End Episode 7 - Like a Fairy Tale on Crunchyroll'), 'Frieren: Beyond Journey\'s End');
    assert.equal(links.seriesTitleFromText('https://www.crunchyroll.com/watch/GG1U2Q0ZW'), null);
    for (const text of ['Schau dir Frieren an: Folge 7', 'Schau dir Frieren an: Folge 7 https://www.crunchyroll.com/watch/GG1U2Q0ZW/x', 'Sieh dir Frieren an, Folge 7',
        'Jetzt schau dir Frieren an – Folge 7', 'Schau dir „Frieren“ auf Crunchyroll an!']) {
        assert.equal(links.seriesTitleFromText(text), 'Frieren', text);
    }
    assert.equal(links.isAllowedUrl('https://www.crunchyroll.com/watch/GG1U2Q0ZW'), true);
    assert.equal(links.isAllowedUrl('http://www.crunchyroll.com/watch/GG1U2Q0ZW'), false);
    assert.equal(links.isAllowedUrl('https://crunchyroll.com.example/watch/GG1U2Q0ZW'), false);
    assert.equal(links.SERVICES[0].searchUrl('Frieren: Beyond'), 'https://www.crunchyroll.com/search?q=Frieren%3A%20Beyond');
});

test('page helpers: og:title with entities, <title> as fallback, series id', () => {
    const watch = textFixture('crunchyroll-watch-frieren-e7.html');
    assert.equal(links.parseOgTitle(watch), 'Frieren: Beyond Journey\'s End Folge 7 – Wie ein Märchen');
    assert.equal(links.parseSeriesId(watch), 'GG5H5XQ7D');
    assert.equal(links.parseOgTitle('<title>Frieren &amp; Co &#x27;S2&#39;</title>'), 'Frieren & Co \'S2\'');
    assert.equal(links.parseOgTitle('<html></html>'), null);
    assert.equal(links.decodeEntities('&lt;b&gt; &#228; &unknown;'), '<b> ä &unknown;');
});

/** Memory core whose fetchText answers `pages` by URL (anything else fails); `limits` records ctx.limit calls. */
function coreWith(pages = {}) {
    const fetched = [];
    const limits = [];
    const core = memoryWith(async (url) => { throw offline(url); }, {
        http: {
            fetch: async (url) => { throw offline(url); },
            fetchText: async (url, timeoutMs, options) => {
                fetched.push({ url, timeoutMs, options });
                const page = pages[url];
                if (page instanceof Error) throw page;
                if (page === undefined) throw offline(url);
                return page;
            },
            fetchImage: async () => { throw new Error('offline'); }
        },
        limit: async (name) => { limits.push(name); }
    });
    return { core, fetched, limits };
}

const addAnime = (core, columns) => {
    const keys = Object.keys(columns);
    return Number(core.conn.prepare(`INSERT INTO animes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => columns[k])).lastInsertRowid);
};
const progress = (core, animeId, userId, status, episodes) => core.conn.prepare('INSERT INTO anime_progress (anime_id, user_id, status, episodes_watched) VALUES (?, ?, ?, ?)').run(animeId, userId, status, episodes);

test('resolve-link: slug episode without a page fetch, title match, visitors refused, foreign links 400', async () => {
    const { core, fetched, limits } = coreWith();
    const frieren = addAnime(core, { title: 'Frieren', title_romaji: 'Sousou no Frieren', title_english: 'Frieren: Beyond Journey’s End', episodes: 28 });
    addAnime(core, { title: 'One Piece', episodes: 1100 });
    const ed = core.client('ed');
    const res = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/frieren-beyond-journeys-end/episode-7-like-a-fairy-tale-911417' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, {
        service: 'crunchyroll', kind: 'legacy', external_id: '911417', series_id: null, series_title: 'frieren beyond journeys end', episode: 7,
        episode_source: 'slug', anime_id: frieren, entry: { id: frieren, title: 'Frieren', episodes: 28, my_status: null, my_episodes: null },
        match: 'title', candidates: [], url: 'https://www.crunchyroll.com/frieren-beyond-journeys-end/episode-7-like-a-fairy-tale-911417', page_checked: false
    });
    assert.deepEqual([fetched.length, limits], [0, []], 'no page fetch and no lookup budget when the slug says it all');

    assert.equal((await core.client('vis')('POST', '/anime/resolve-link', { url: res.body.url })).status, 403);
    const foreign = await ed('POST', '/anime/resolve-link', { url: 'https://www.netflix.com/watch/81726716' });
    assert.deepEqual([foreign.status, foreign.body.code, foreign.body.error], [400, 'UNSUPPORTED_LINK', 'Das ist kein Crunchyroll-Link.']);
    assert.equal((await ed('POST', '/anime/resolve-link', {})).status, 400);
});

test('resolve-link: share text gives the episode; the page fills the rest; every page failure means unknown', async () => {
    const watchUrl = 'https://www.crunchyroll.com/watch/GG1U2Q0ZW/like-a-fairy-tale';
    const { core, fetched, limits } = coreWith({ [watchUrl]: textFixture('crunchyroll-watch-frieren-e7.html') });
    const frieren = addAnime(core, { title: 'Frieren', title_english: 'Frieren: Beyond Journey’s End', episodes: 28 });
    const ed = core.client('ed');

    const fromText = await ed('POST', '/anime/resolve-link', { url: `${watchUrl}?x=1`, text: `Schau dir „Frieren“ Folge 7 auf Crunchyroll an! ${watchUrl}` });
    assert.deepEqual([fromText.body.episode, fromText.body.episode_source, fromText.body.series_title, fromText.body.anime_id, fromText.body.page_checked],
        [7, 'text', 'Frieren', frieren, false]);
    assert.equal(fetched.length, 0);

    const fromPage = await ed('POST', '/anime/resolve-link', { url: watchUrl });
    assert.deepEqual([fromPage.body.episode, fromPage.body.episode_source, fromPage.body.series_id, fromPage.body.page_checked],
        [7, 'page', 'GG5H5XQ7D', true]);
    assert.equal(fromPage.body.series_title, 'Frieren: Beyond Journey\'s End');
    assert.equal(fromPage.body.anime_id, frieren);
    assert.deepEqual(fetched[0], { url: watchUrl, timeoutMs: 6000, options: { quiet: true } });
    assert.deepEqual(limits, ['lookup']);

    const blockedUrl = 'https://www.crunchyroll.com/watch/GRBLOCKED1/a-title';
    const { core: blockedCore } = coreWith({ [blockedUrl]: Object.assign(new Error('HTTP 403'), { status: 403 }) });
    addAnime(blockedCore, { title: 'Frieren', episodes: 28 });
    const blocked = await blockedCore.client('ed')('POST', '/anime/resolve-link', { url: blockedUrl });
    assert.equal(blocked.status, 200);
    assert.deepEqual([blocked.body.episode, blocked.body.episode_source, blocked.body.page_checked, blocked.body.anime_id, blocked.body.match],
        [null, null, false, null, null]);
    const cors = Object.assign(new Error('CORS'), { code: 'CORS_BLOCKED' });
    const { core: corsCore } = coreWith({ [blockedUrl]: cors });
    assert.equal((await corsCore.client('ed')('POST', '/anime/resolve-link', { url: blockedUrl })).body.page_checked, false);
});

test('resolve-link: remembered link before AniList links before titles; seasons sharing a series id', async () => {
    const seriesUrl = 'https://www.crunchyroll.com/series/GG5H5XQ7D/frieren-beyond-journeys-end';
    const { core, fetched } = coreWith();
    const s1 = addAnime(core, { title: 'Frieren', episodes: 28, external_links: JSON.stringify([{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/de/series/GG5H5XQ7D/frieren', type: 'STREAMING' }]) });
    const s2 = addAnime(core, { title: 'Frieren 2', episodes: 12 });
    const ed = core.client('ed');

    let res = await ed('POST', '/anime/resolve-link', { url: seriesUrl });
    assert.deepEqual([res.body.kind, res.body.series_id, res.body.anime_id, res.body.match], ['series', 'GG5H5XQ7D', s1, 'external_links']);
    assert.equal(fetched.length, 0, 'the series slug names the title');

    const link = core.conn.prepare("INSERT INTO anime_links (anime_id, service, external_id) VALUES (?, 'crunchyroll', 'GG5H5XQ7D')");
    link.run(s2);
    res = await ed('POST', '/anime/resolve-link', { url: seriesUrl });
    assert.deepEqual([res.body.anime_id, res.body.match], [s2, 'link'], 'a remembered link wins');

    link.run(s1);
    res = await ed('POST', '/anime/resolve-link', { url: seriesUrl });
    assert.deepEqual([res.body.anime_id, res.body.match, res.body.candidates.map((c) => c.id)], [null, null, [s1, s2]], 'two seasons, nothing to prefer');
    progress(core, s2, 2, 'Schaue', 3);
    res = await ed('POST', '/anime/resolve-link', { url: seriesUrl });
    assert.deepEqual([res.body.anime_id, res.body.match, res.body.candidates[0]], [s2, 'link', { id: s2, title: 'Frieren 2', score: 1, episodes: 12, my_status: 'Schaue', my_episodes: 3 }]);
});

test('resolve-link: ambiguous titles give candidates, the episode range picks a season', async () => {
    const { core } = coreWith();
    const s1 = addAnime(core, { title: 'Frieren', episodes: 28 });
    const s2 = addAnime(core, { title: 'Frieren Season 2', episodes: 10 });
    addAnime(core, { title: 'Ganz anders', episodes: 10 });
    progress(core, s1, 2, 'Gesehen', 28);
    const ed = core.client('ed');
    const text = 'Frieren Folge 30 https://www.crunchyroll.com/watch/GG1U2Q0ZW/a';
    let res = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/watch/GG1U2Q0ZW/a', text });
    assert.deepEqual([res.body.anime_id, res.body.candidates.map((c) => c.id)], [s1, []], 'my own clear hit');
    core.conn.prepare('DELETE FROM anime_progress').run();
    res = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/watch/GG1U2Q0ZW/a', text: 'Frieren Folge 30' });
    assert.deepEqual([res.body.anime_id, res.body.candidates.map((c) => c.id)], [null, [s1, s2]], 'episode 30 fits neither season');
    res = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/watch/GG1U2Q0ZW/a', text: 'Frieren Folge 20' });
    assert.deepEqual([res.body.anime_id, res.body.match], [s1, 'title'], 'only season 1 has an episode 20');
});

test('resolve-link: an old-style series link on AniList matches a legacy episode link; ids match whole path segments', async () => {
    const { core } = coreWith();
    const old = addAnime(core, { title: 'Ganz anderer Titel', episodes: 26, external_links: JSON.stringify([{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/de/mob-psycho-100/', type: 'STREAMING' }]) });
    addAnime(core, { title: 'Längere ID', episodes: 12, external_links: JSON.stringify([{ site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/GG5H5XQ7DX', type: 'STREAMING' }]) });
    const ed = core.client('ed');
    let res = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/mob-psycho-100/episode-3-a-trick-123456' });
    assert.deepEqual([res.body.anime_id, res.body.match, res.body.episode], [old, 'external_links', 3]);
    res = await ed('POST', '/anime/resolve-link', { url: 'https://www.crunchyroll.com/series/GG5H5XQ7D/x' });
    assert.deepEqual([res.body.anime_id, res.body.match], [null, null], 'GG5H5XQ7D is not GG5H5XQ7DX');
});
