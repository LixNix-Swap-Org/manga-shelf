// AniList, Jikan and MyAnimeList adapters and the shared normalize helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const anilist = require('../../core/anime/anilist');
const jikan = require('../../core/anime/jikan');
const mal = require('../../core/anime/mal');
const {
    mergeResults, foldUmlauts, estimateNextAiring, rankByTitle, nextCheckAt, DAY, HOUR, MINUTE
} = require('../../core/anime/normalize');
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
