// POST /anime/watch-sync: progress from a streaming history the app read on the device (core/watch/crunchyroll.js).
// Only series ids, episode numbers and episode links arrive here, never cookies, tokens or the raw history.
const { HttpError, msg, badRequest } = require('../errors');
const { writeProgress, readProgress } = require('../anime/progress');
const { searchKey, keyScore } = require('../anime/normalize');
const gateway = require('../anime/gateway');
const listSync = require('../anime/listSync');
const store = require('../anime/store');
const links = require('../watch/links');
const crunchyroll = require('../watch/crunchyroll');
const anime = require('./anime');

const MAX_CANDIDATES = 5;
const THROTTLE_MS = 30 * 1000;
const SYNC_SERVICES = ['crunchyroll'];

const generationOf = (ctx) => (ctx.db && typeof ctx.db.generation === 'function' ? ctx.db.generation() : null);
const reopenedError = () => new HttpError(503, 'Die Datenbank wurde während des Abgleichs neu geöffnet (Wiederherstellung). Bitte erneut versuchen.');

function readBody(body) {
    const service = body && SYNC_SERVICES.includes(body.service) ? links.findService(body.service) : null;
    if (!service) throw badRequest('Abgleich gibt es nur für Crunchyroll');
    if (!Array.isArray(body.items) || body.items.length > crunchyroll.MAX_ITEMS) {
        throw badRequest(msg('Erwartet: { service, items: [...] } mit höchstens {max_items} Einträgen', { max_items: crunchyroll.MAX_ITEMS }));
    }
    const items = body.items.map((raw, i) => {
        const item = crunchyroll.cleanItem(raw);
        if (!item) throw badRequest(msg('Ungültiger Eintrag Nr. {number}', { number: i + 1 }));
        return item;
    });
    // one item per series and season, whatever the client sent
    return { service, items: crunchyroll.mergeItems(items) };
}

const titlesOf = (row) => [row.title, row.title_de, row.title_romaji, row.title_english, row.title_native].filter(Boolean);

/** The caller's rows with title keys and seasons made once per request (the item loop only compares them). */
function prepareRows(rows) {
    return rows.map((row) => {
        const titles = titlesOf(row);
        const marker = crunchyroll.seasonMarkerOf(titles);
        const listed = store.parseJson(row.external_links, []).map((l) => (l ? anime.servicePath(l.url) : null)).filter(Boolean);
        return { row, keys: titles.map(searchKey), season: marker || 1, marker, listed };
    });
}

/** What the caller's list knows about links: series links, season links ('<SERIES>:<n>') and the seasons each entry holds. */
function linkIndex(ctx, service) {
    const prefix = crunchyroll.seasonServiceOf(service.id, '');
    const bySeries = new Map();
    const bySeason = new Map();
    const seasonsOf = new Map();
    const push = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);
    for (const r of ctx.db.prepare('SELECT anime_id, service, external_id FROM anime_links WHERE service = ? OR substr(service, 1, ?) = ? ORDER BY anime_id')
        .all(service.id, prefix.length, prefix)) {
        if (r.service === service.id) {
            push(bySeries, r.external_id, r.anime_id);
            continue;
        }
        push(bySeason, r.external_id, r.anime_id);
        if (!seasonsOf.has(r.anime_id)) seasonsOf.set(r.anime_id, new Set());
        seasonsOf.get(r.anime_id).add(r.external_id);
    }
    return { bySeries, bySeason, seasonsOf };
}

const candidateOf = (p, score = 1) => ({ ...anime.candidateOf(p.row, score), season: p.season });

/** One of several fitting entries by the shared-link rule (the one the caller watches, else the one the episode fits), or null. */
function pickAmong(found, item) {
    const list = found.map((p) => candidateOf(p));
    if (list.length === 1) return { pick: list[0], candidates: list };
    const pick = anime.preferred(list, item.episode);
    return { pick, candidates: pick ? [pick, ...list.filter((c) => c !== pick)] : list };
}

// The entry for one season of a series: its season link, else entries linked to the series whose titles name that season, else
// entries listing the series on AniList that do, else a clear title hit. Returns { anime_id, learn } or { reason, candidates }
// (candidates: every entry tried, minus those naming another season).
function matchItem(item, { service, prepared, byId, index }) {
    const key = crunchyroll.seasonLinkOf(service.id, item.external_id, item.season).external_id;
    const seasonLinked = (index.bySeason.get(key) || []).map((id) => byId.get(id)).filter(Boolean);
    if (seasonLinked.length) {
        const { pick, candidates } = pickAmong(seasonLinked, item);
        return pick ? { anime_id: pick.id, learn: false } : { reason: 'ambiguous', candidates };
    }
    // an entry linked to another season of this series is never this one
    const seriesPrefix = `${item.external_id}:`;
    const free = (p) => ![...(index.seasonsOf.get(p.row.id) || [])].some((k) => k.startsWith(seriesPrefix));
    const fits = (p) => p.season === item.season;
    const tried = new Map();
    const needle = `/series/${item.external_id.toLowerCase()}`;
    const families = [
        (index.bySeries.get(item.external_id) || []).map((id) => byId.get(id)).filter((p) => p && free(p)),
        prepared.filter((p) => free(p) && p.listed.some((path) => path === needle || path.startsWith(`${needle}/`)))
    ];
    for (const family of families) {
        const fitting = family.filter(fits);
        if (fitting.length) {
            const { pick, candidates } = pickAmong(fitting, item);
            return pick ? { anime_id: pick.id, learn: fitting.length === 1 } : { reason: 'ambiguous', candidates: candidates.slice(0, MAX_CANDIDATES) };
        }
        for (const p of family) tried.set(p.row.id, { p, score: 1 });
    }
    const query = item.series_title ? searchKey(item.series_title) : '';
    const scored = query ? prepared.map((p) => ({ p, score: keyScore(query, p.keys) })).filter((x) => x.score >= 0.5) : [];
    // the caller's own entries first: a clear hit there wins over a better-sounding entry nobody watches
    for (const pool of [scored.filter((x) => x.p.row.my_status), scored]) {
        const high = pool.filter((x) => x.score >= 0.9 && fits(x.p)).sort((a, b) => b.score - a.score);
        if (!high.length) continue;
        const pick = high.length === 1 ? candidateOf(high[0].p, high[0].score) : anime.preferred(high.map((x) => candidateOf(x.p, x.score)), item.episode);
        if (pick) return { anime_id: pick.id, learn: false };
        return { reason: 'ambiguous', candidates: high.slice(0, MAX_CANDIDATES).map((x) => candidateOf(x.p, x.score)) };
    }
    for (const x of scored) if (!tried.has(x.p.row.id)) tried.set(x.p.row.id, x);
    // an entry whose title names another season would be the wrong pick in the dialog
    const candidates = [...tried.values()]
        .filter((x) => x.p.marker === null || x.p.marker === item.season)
        .sort((a, b) => Number(fits(b.p)) - Number(fits(a.p)) || b.score - a.score
            || Number(Boolean(b.p.row.my_status)) - Number(Boolean(a.p.row.my_status)));
    return { reason: 'no_match', candidates: candidates.slice(0, MAX_CANDIDATES).map((x) => candidateOf(x.p, x.score)) };
}

const unmatchedOf = (item, reason, candidates) => ({
    external_id: item.external_id,
    series_title: item.series_title,
    season: item.season,
    episode: item.episode,
    episodes_watched: crunchyroll.watchedCount(item),
    reason,
    candidates
});

/** At most one run per user and THROTTLE_MS; the state lives on the gateway state (resetGatewayState clears it). */
function throttled(ctx, userId) {
    const s = gateway.state();
    if (!s.watchSync) s.watchSync = new Map();
    const now = ctx.now().getTime();
    const last = s.watchSync.get(userId);
    if (last !== undefined && now - last < THROTTLE_MS && now >= last) return true;
    s.watchSync.set(userId, now);
    return false;
}

// Applies the caller's history items: matched entries only move forward (monotonic, "Gesehen" at the known total, resume link =
// next episode); the rest returns as unmatched with candidates. Always the caller's own progress; with AniList list sync on,
// applied entries are pushed like +1. Matching runs before the transaction (synchronous handler); only the writes run inside.
function sync(ctx, { body }) {
    const { service, items } = readBody(body);
    const userId = ctx.user.id;
    if (throttled(ctx, userId)) return { body: { applied: [], unmatched: [], throttled: true } };
    const generation = generationOf(ctx);
    const prepared = prepareRows(anime.matchRows(ctx));
    const byId = new Map(prepared.map((p) => [p.row.id, p]));
    const index = linkIndex(ctx, service);
    const unmatched = [];
    const perAnime = new Map();
    const learned = new Map();
    for (const item of items) {
        if (crunchyroll.watchedCount(item) < 1) continue;
        const found = matchItem(item, { service, prepared, byId, index });
        if (!found.anime_id) {
            unmatched.push(unmatchedOf(item, found.reason, found.candidates));
            continue;
        }
        perAnime.set(found.anime_id, [...(perAnime.get(found.anime_id) || []), item]);
        if (found.learn) learned.set(found.anime_id, [...(learned.get(found.anime_id) || []), item]);
    }
    const result = ctx.db.transaction(() => {
        if (generationOf(ctx) !== generation) throw reopenedError();
        const applied = [];
        let unchanged = 0;
        const learn = ctx.db.prepare('INSERT INTO anime_links (anime_id, service, external_id, url) VALUES (?, ?, ?, NULL) ON CONFLICT (anime_id, service) DO NOTHING');
        for (const [animeId, list] of perAnime) {
            const p = byId.get(animeId);
            const stored = readProgress(ctx, animeId, userId);
            const plan = crunchyroll.planProgress(list, { episodes: p.row.episodes, episodes_watched: stored ? stored.episodes_watched : 0, resume_url: stored ? stored.resume_url : null });
            if (plan && plan.above_total) {
                for (const item of list) unmatched.push(unmatchedOf(item, 'episode_above_total', [candidateOf(p)]));
                continue;
            }
            for (const item of learned.get(animeId) || []) {
                const link = crunchyroll.seasonLinkOf(service.id, item.external_id, item.season);
                learn.run(animeId, link.service, link.external_id);
            }
            if (!plan) {
                unchanged++;
                continue;
            }
            const saved = writeProgress(ctx, animeId, userId, plan.change, { monotonic: true });
            applied.push({ anime_id: animeId, episodes_watched: saved.episodes_watched, status: saved.status });
        }
        return { applied, unmatched, unchanged };
    });
    for (const entry of result.applied) listSync.schedulePush(ctx, userId, entry.anime_id);
    return { body: result };
}

module.exports = { sync };
