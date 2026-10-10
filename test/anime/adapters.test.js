// AniList, Jikan and MyAnimeList adapters and the shared normalize helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const anilist = require('../../core/anime/anilist');
const jikan = require('../../core/anime/jikan');
const mal = require('../../core/anime/mal');
const {
    mergeResults, mergeMeta, emptyMeta, foldUmlauts, estimateNextAiring, rankByTitle, nextCheckAt, cleanDescription, DAY, HOUR, MINUTE
} = require('../../core/anime/normalize');
const { cleanAniListDescription } = require('../../core/anilist');
const { fixture } = require('./helpers');

const NOW = Date.parse('2026-10-04T10:00:00Z');

test('AniList: Media is normalised to AnimeMeta (ids, titles, studios, relations, airing)', () => {
    const media = fixture('anilist-media-154587.json').data.Media;
    const meta = anilist.normalize(media, NOW);
    assert.equal(meta.anilist_id, 154587);
    assert.equal(meta.mal_id, 52991);
    assert.equal(meta.title.romaji, 'Sousou no Frieren');
    assert.equal(meta.title.preferred, meta.title.english);
    assert.equal(meta.format, 'TV');
    assert.equal(meta.status, 'FINISHED');
    assert.equal(meta.episodes, 28);
    assert.equal(meta.duration, 24);
    assert.equal(meta.start_date, '2023-09-29');
    assert.ok(meta.studios.includes('MADHOUSE'));
    assert.ok(meta.score > 80 && meta.score <= 100);
    assert.equal(meta.urls.anilist, 'https://anilist.co/anime/154587');
    assert.equal(meta.urls.mal, 'https://myanimelist.net/anime/52991');
    assert.ok(!/<br/i.test(meta.description), 'no HTML in the description');
    assert.ok(meta.relations.some((r) => r.relation === 'SOURCE' && r.kind === 'MANGA'));
    assert.equal(meta.source, 'anilist');

    const ids = fixture('anilist-ids.json').data.Page.media.map((m) => anilist.normalize(m, NOW));
    const onePiece = ids.find((m) => m.anilist_id === 21);
    assert.equal(onePiece.status, 'RELEASING');
    assert.equal(onePiece.episodes, null, 'ongoing shows have no episode count');
    assert.deepEqual(onePiece.next_airing, { episode: 1181, at: 1798985760 });
    assert.equal(onePiece.next_airing_estimated, false);
});

test('Jikan: status and score mapping, English title, broadcast estimate of a running show', () => {
    const [frieren, season2] = fixture('jikan-search-frieren.json').data.map((e) => jikan.normalize(e, NOW));
    assert.equal(frieren.mal_id, 52991);
    assert.equal(frieren.anilist_id, null);
    assert.equal(frieren.status, 'FINISHED');
    assert.equal(frieren.score, 93, 'MAL score x 10');
    assert.equal(frieren.title.english, "Frieren: Beyond Journey's End");
    assert.equal(frieren.duration, 24);
    assert.equal(frieren.season, 'FALL');
    assert.ok(frieren.synonyms.includes('Frieren – Nach dem Ende der Reise'));
    assert.ok(!frieren.description.includes('MAL Rewrite'));
    assert.equal(frieren.next_airing, null, 'finished shows get no estimate');
    assert.equal(season2.status, 'NOT_YET_RELEASED');

    const onePiece = jikan.normalize(fixture('jikan-anime-21-full.json').data, NOW);
    assert.equal(onePiece.status, 'RELEASING');
    assert.equal(onePiece.next_airing_estimated, true);
    const at = new Date(onePiece.next_airing.at * 1000);
    assert.equal(at.toISOString(), '2026-10-04T14:15:00.000Z', 'Sunday 23:15 JST is 14:15 UTC');
    assert.ok(onePiece.next_airing.episode > 1300);
    assert.ok(onePiece.relations.some((r) => r.relation === 'ADAPTATION' && r.kind === 'MANGA' && r.mal_id === 13));
    assert.equal(onePiece.source, 'jikan');
});

test('MAL API: normalised like Jikan (alternative titles, mean x 10, related anime and manga)', () => {
    const [frieren] = fixture('mal-search-frieren.json').data.map((d) => mal.normalize(d.node, NOW));
    assert.equal(frieren.mal_id, 52991);
    assert.equal(frieren.title.english, "Frieren: Beyond Journey's End");
    assert.equal(frieren.title.native, '葬送のフリーレン');
    assert.equal(frieren.score, 93);
    assert.equal(frieren.episodes, 28);
    assert.equal(frieren.duration, 25);
    assert.equal(frieren.status, 'FINISHED');
    assert.equal(frieren.season, 'FALL');
    assert.equal(frieren.cover_url, 'https://cdn.myanimelist.net/images/anime/1015/138006l.jpg');

    const onePiece = mal.normalize(fixture('mal-anime-21.json'), NOW);
    assert.equal(onePiece.episodes, null, 'num_episodes 0 means unknown');
    assert.equal(onePiece.next_airing_estimated, true);
    assert.deepEqual(onePiece.relations.map((r) => [r.relation, r.kind, r.mal_id]), [['SIDE_STORY', 'ANIME', 459], ['ADAPTATION', 'MANGA', 13]]);
    assert.equal(onePiece.source, 'mal');
});

test('merge by MAL id: AniList fields first, gaps from MyAnimeList, both ids and links kept', () => {
    const ani = fixture('anilist-search-frieren.json').data.Page.media.map((m) => anilist.normalize(m, NOW));
    const jik = fixture('jikan-search-frieren.json').data.map((e) => jikan.normalize(e, NOW));
    ani[0].title.english = null;
    const merged = mergeResults(ani, jik);
    const frieren = merged.find((m) => m.anilist_id === 154587);
    assert.equal(frieren.mal_id, 52991);
    assert.equal(frieren.source, 'merged');
    assert.equal(frieren.title.english, "Frieren: Beyond Journey's End", 'gap filled from Jikan');
    assert.equal(frieren.urls.anilist, 'https://anilist.co/anime/154587');
    assert.match(frieren.urls.mal, /^https:\/\/myanimelist.net\/anime\/52991/);
    assert.equal(merged.filter((m) => m.mal_id === 52991).length, 1, 'one entry per MAL id');
    const ranked = rankByTitle('Frieren', merged);
    assert.match(ranked[0].title.romaji, /Frieren/);
});

test('umlauts are folded; next checks follow the data', () => {
    assert.equal(foldUmlauts('Tagebücher der Apothekerin – Größe'), 'Tagebucher der Apothekerin – Grosse');
    const base = { status: 'FINISHED' };
    assert.equal(nextCheckAt(base, NOW), NOW + 14 * DAY);
    assert.equal(nextCheckAt({ status: 'CANCELLED' }, NOW), NOW + 14 * DAY);
    assert.equal(nextCheckAt({ status: 'NOT_YET_RELEASED', start_date: '2027-01-01' }, NOW), NOW + DAY);
    assert.equal(nextCheckAt({ status: 'NOT_YET_RELEASED', start_date: '2026-10-05' }, NOW), Date.parse('2026-10-05T00:00:00Z'), 'exactly on the start day');
    const airing = { status: 'RELEASING', next_airing: { episode: 9, at: Math.floor((NOW + 3 * HOUR) / 1000) } };
    assert.equal(nextCheckAt(airing, NOW), NOW + 3 * HOUR + 30 * MINUTE);
    const farAway = { status: 'RELEASING', next_airing: { episode: 9, at: Math.floor((NOW + 5 * DAY) / 1000) } };
    assert.equal(nextCheckAt(farAway, NOW), NOW + DAY, 'never later than 24 h');
    assert.equal(nextCheckAt({ ...airing, next_airing_estimated: true }, NOW), NOW + 12 * HOUR, 'an estimate is checked every 12 h');
    assert.equal(nextCheckAt({ status: 'RELEASING' }, NOW), NOW + 12 * HOUR);
});

test('broadcast estimate: next weekly slot in the broadcast time zone, null without a slot', () => {
    const est = estimateNextAiring({ day: 'Fridays', time: '23:00', timezone: 'Asia/Tokyo' }, '2026-10-02T14:00:00Z', NOW);
    assert.equal(new Date(est.at * 1000).toISOString(), '2026-10-09T14:00:00.000Z');
    assert.equal(est.episode, 2);
    assert.equal(estimateNextAiring({ day: null, time: null }, null, NOW), null);
    assert.equal(estimateNextAiring({ day: 'Fridays', time: '23:00' }, '2026-01-02T14:00:00Z', NOW, 12), null, 'past the last episode');
});

test('AniList: external links and streaming episodes (http upgraded, episode number from the title); mergeMeta keeps them', () => {
    const meta = anilist.normalize(fixture('anilist-media-154587.json').data.Media, NOW);
    assert.deepEqual(meta.external_links[1], { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/GG5H5XQ7D/frieren-beyond-journeys-end', type: 'STREAMING' });
    assert.deepEqual(meta.streaming_episodes[0], {
        title: 'Episode 1 - The Journey\'s End', url: 'https://www.crunchyroll.com/frieren-beyond-journeys-end/episode-1-the-journeys-end-911401', site: 'Crunchyroll', episode: 1
    });
    assert.deepEqual(meta.streaming_episodes.map((e) => e.episode), [1, 2, 3]);
    const odd = anilist.normalize({ id: 1, title: { romaji: 'X' }, externalLinks: [null, { site: 'X', url: 'ftp://x' }], streamingEpisodes: [{ title: 'Special', url: 'https://x' }] }, NOW);
    assert.deepEqual([odd.external_links, odd.streaming_episodes[0].episode], [[], null]);
    const bare = anilist.normalize({ id: 2, title: { romaji: 'Y' } }, NOW);
    assert.deepEqual([bare.external_links, bare.streaming_episodes], [[], []]);
    const merged = mergeMeta(emptyMeta({ anilist_id: 154587, title: { romaji: 'F' } }), meta);
    assert.equal(merged.external_links.length, 3, 'gaps filled from the other side');
    assert.equal(mergeMeta(meta, emptyMeta({ title: { romaji: 'F' } })).streaming_episodes.length, 3);
});

test('descriptions: no tag survives, entities are decoded once and only after the tags are gone', () => {
    for (const clean of [cleanDescription, cleanAniListDescription]) {
        assert.equal(clean('<i>x</i><br>y<br/>z'), 'x\ny\nz', clean.name);
        assert.equal(clean('&lt;Twilight&gt; &amp; co.'), '<Twilight> & co.', clean.name);
        assert.equal(clean('&amp;lt;b&amp;gt;'), '&lt;b&gt;', clean.name);
        assert.equal(clean('<scr<script>ipt>alert(1)</script>'), 'ipt>alert(1)', clean.name);
        for (const raw of ['<<script>script>x', '<scr<b>ipt>', '<<b>i>x</<i>b>', '<a href="x"<b>>y']) {
            assert.doesNotMatch(clean(raw) || '', /<[a-z/!]/i, `${clean.name}: ${raw}`);
        }
        assert.equal(clean('<b></b>'), null, clean.name);
    }
});

test('AniList list: collection without duplicates of custom lists, a missing entry is null, the save mutation', async () => {
    const { fakeFetch, aniListFixtures, memoryWith, json } = require('./helpers');
    const http = fakeFetch({
        anilist: (body) => (body.query.includes('MediaList(') && body.variables.m === 1 ? json({ data: { MediaList: null }, errors: [{ message: 'Not Found.', status: 404 }] }, { status: 404 }) : aniListFixtures(body))
    });
    const ctx = memoryWith(http.fetch).ctx;
    const credential = { secret: 'tok' };
    const { entries } = await anilist.listCollection(ctx, 7, { credential });
    assert.deepEqual(entries.map((e) => e.mediaId), [154587, 21, 16498, 101922]);
    assert.deepEqual(entries[0], { mediaId: 154587, status: 'CURRENT', progress: 10, updatedAt: 1759300000 });
    assert.deepEqual((await anilist.listEntry(ctx, 7, 154587, { credential })).entry, { mediaId: 154587, status: 'CURRENT', progress: 6, updatedAt: 1759300000 });
    assert.equal((await anilist.listEntry(ctx, 7, 1, { credential })).entry, null);
    const saved = await anilist.saveListEntry(ctx, { mediaId: 154587, progress: 7, status: 'CURRENT' }, { credential });
    assert.deepEqual([saved.entry.progress, saved.entry.status], [7, 'CURRENT']);
    assert.deepEqual(http.calls.at(-1).body.variables, { m: 154587, p: 7, s: 'CURRENT' });
    assert.ok(http.calls.every((c) => c.headers.Authorization === 'Bearer tok'));
});

test('AniList details of several ids: one id_in request with relations and links, unknown ids missing', async () => {
    const calls = [];
    const media = fixture('anilist-media-154587.json').data.Media;
    const ctx = {
        now: () => new Date(NOW),
        config: { appVersion: 'test' },
        http: {
            fetch: async (url, init) => {
                calls.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ data: { Page: { media: [media] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
        }
    };
    const { metas } = await anilist.byIdsDetail(ctx, [154587, 1]);
    assert.deepEqual(metas.map((m) => m.anilist_id), [154587]);
    assert.ok(metas[0].relations.length > 0 && metas[0].external_links.length > 0);
    assert.deepEqual(calls[0].variables, { ids: [154587, 1] });
    assert.match(calls[0].query, /id_in: \$ids/);
    assert.match(calls[0].query, /relations \{ edges/);
    assert.deepEqual(await anilist.byIdsDetail(ctx, []), { metas: [], rate: null });
    assert.equal(calls.length, 1);
});
