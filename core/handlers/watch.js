// POST /anime/watch-sync: progress from a streaming history the app read on the device (core/watch/crunchyroll.js).
// Only series ids, episode numbers and episode links arrive here, never cookies, tokens or the raw history.
const { HttpError, msg, badRequest, notFound, conflict } = require('../errors');
const { writeProgress, readProgress } = require('../anime/progress');
const { searchKey, keyScore } = require('../anime/normalize');
const { settings } = require('../anime/settings');
const { SourceError } = require('../anime/request');
const gateway = require('../anime/gateway');
const listSync = require('../anime/listSync');
const store = require('../anime/store');
const links = require('../watch/links');
const crunchyroll = require('../watch/crunchyroll');
const syncState = require('../watch/syncState');
const anime = require('./anime');

const MAX_CANDIDATES = 5;
const MAX_EXTERNAL = 3;
const MAX_SKIP = 200;
const THROTTLE_MS = 30 * 1000;
const SYNC_SERVICES = ['crunchyroll'];
const PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android'];
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKUP_ITEMS = 3;
const PHASE_MS = 10 * 1000;
const LOOKUP_TIMEOUT_MS = 8000;
const ADDED_PUSH_MS = 60 * 1000;
const UNDO_MS = 60 * 60 * 1000;
const SEASON_FORMATS = ['TV', 'TV_SHORT', 'ONA'];

const generationOf = (ctx) => (ctx.db && typeof ctx.db.generation === 'function' ? ctx.db.generation() : null);
const reopenedError = () => new HttpError(503, 'Die Datenbank wurde während des Abgleichs neu geöffnet (Wiederherstellung). Bitte erneut versuchen.');
const undoExpired = () => conflict(msg('Rückgängig geht nicht mehr – die Stunde ist um oder jemand anderes hat schon Fortschritt eingetragen'), 'UNDO_EXPIRED');

function readBody(body) {
    const service = body && SYNC_SERVICES.includes(body.service) ? links.findService(body.service) : null;
    if (!service) throw badRequest('Abgleich gibt es nur für Crunchyroll');
    if (!Array.isArray(body.items) || body.items.length > crunchyroll.MAX_ITEMS) {
        throw badRequest(msg('Erwartet: { service, items: [...] } mit höchstens {max_items} Einträgen', { max_items: crunchyroll.MAX_ITEMS }));
    }
    if (Array.isArray(body.skip) && body.skip.length > MAX_SKIP) {
        throw badRequest(msg('Erwartet: { skip: [...] } mit höchstens {max_items} Einträgen', { max_items: MAX_SKIP }));
    }
    const items = body.items.map((raw, i) => {
        const item = crunchyroll.cleanItem(raw);
        if (!item) throw badRequest(msg('Ungültiger Eintrag Nr. {number}', { number: i + 1 }));
        return item;
    });
    return {
        service,
        // one item per series and season, whatever the client sent
        items: crunchyroll.mergeItems(items),
        skip: Array.isArray(body.skip) ? [...new Set(body.skip.map(syncState.cleanKey).filter(Boolean))] : [],
        autoAdd: body.auto_add === true,
        platform: PLATFORMS.includes(body.platform) ? body.platform : null
    };
}

const itemKey = (item) => syncState.keyOf(item.external_id, item.season);

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

function loadView(ctx, service) {
    const prepared = prepareRows(anime.matchRows(ctx));
    return { service, prepared, byId: new Map(prepared.map((p) => [p.row.id, p])), index: linkIndex(ctx, service) };
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
// entries listing the series on AniList that do, else a clear title hit. Returns { anime_id, learn, via } or { reason, candidates }
// (candidates: every entry tried, minus those naming another season).
function matchItem(item, { service, prepared, byId, index }) {
    const key = crunchyroll.seasonLinkOf(service.id, item.external_id, item.season).external_id;
    const seasonLinked = (index.bySeason.get(key) || []).map((id) => byId.get(id)).filter(Boolean);
    if (seasonLinked.length) {
        const { pick, candidates } = pickAmong(seasonLinked, item);
        return pick ? { anime_id: pick.id, learn: false, via: 'season' } : { reason: 'ambiguous', candidates };
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
            return pick ? { anime_id: pick.id, learn: fitting.length === 1, via: 'family' } : { reason: 'ambiguous', candidates: candidates.slice(0, MAX_CANDIDATES) };
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
        if (pick) return { anime_id: pick.id, learn: false, via: 'title' };
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
    if (last !== undefined && now - last < THROTTLE_MS && now >= last) return Math.max(1, Math.ceil((THROTTLE_MS - (now - last)) / 1000));
    s.watchSync.set(userId, now);
    return null;
}

const isRecent = (item, nowMs) => {
    const at = item.watched_at ? Date.parse(item.watched_at) : NaN;
    return Number.isFinite(at) && at >= nowMs - RECENT_MS;
};

const isStarting = (item, nowMs) => item.episode === 1 && !item.fully_watched && isRecent(item, nowMs);

function rememberedId(ctx, memory) {
    if (!memory || !Number.isInteger(memory.anime_id)) return null;
    const row = ctx.db.prepare('SELECT anilist_id FROM animes WHERE id = ?').get(memory.anime_id);
    return row && row.anilist_id === memory.anilist_id ? memory.anime_id : null;
}

const isRemembered = (ctx, memory) => Boolean(memory) && (!Number.isInteger(memory.anime_id) || rememberedId(ctx, memory) !== null);

const SEASON_WORDS = [
    /\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi, /\bseason\s+\d{1,2}\b/gi, /\b\d{1,2}\.\s*staffel\b/gi, /\bstaffel\s+\d{1,2}\b/gi,
    /(?:^|\s)(?:second|third|fourth|fifth|sixth)\s+season\b/gi, /(?:^|\s)(?:zweite|dritte|vierte|fünfte)\s+staffel\b/gi
];

/** A title without its season marker ('Show Season 2' -> 'Show'), or null when it has none. */
function withoutSeason(title) {
    if (!title) return null;
    let t = title;
    for (const re of SEASON_WORDS) t = t.replace(re, ' ');
    t = t.replace(/\s+/g, ' ').replace(/^[\s:–-]+|[\s:–-]+$/g, '').trim();
    return t && t !== title.trim() ? t : null;
}

/** Search terms of an item: series title, the slug as words, the title without its season marker (at most 3). */
function termsOf(item) {
    const seen = new Set();
    const out = [];
    for (const term of [item.series_title, item.series_slug ? links.titleFromSlug(item.series_slug) : null, withoutSeason(item.series_title)]) {
        const key = term ? searchKey(term) : '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(term);
    }
    return out.slice(0, 3);
}

const titleListOf = (meta) => {
    const t = meta.title || {};
    return [t.romaji, t.english, t.preferred, t.native, ...(meta.synonyms || [])].filter(Boolean);
};

/** Season 1: no season marker and no TV prequel; season N: the marker N. */
function fitsSeason(meta, season) {
    const marker = crunchyroll.seasonMarkerOf(titleListOf(meta));
    if (season === 1) {
        return marker === null && !(meta.relations || []).some((r) => r.relation === 'PREQUEL' && SEASON_FORMATS.includes(r.format));
    }
    return marker === season;
}

function crunchyrollLinks(meta, item) {
    const paths = (meta.external_links || []).map((l) => (l ? anime.servicePath(l.url) : null)).filter(Boolean);
    const needle = `/series/${item.external_id.toLowerCase()}`;
    const slug = item.series_slug ? `/${item.series_slug}` : null;
    return { match: paths.some((p) => p === needle || p.startsWith(`${needle}/`) || (slug !== null && p === slug)), any: paths.length > 0 };
}

const namesSeries = (meta, item) => (meta.external_links || []).some((l) => {
    const path = l ? anime.servicePath(l.url) : null;
    const needle = `/series/${item.external_id.toLowerCase()}`;
    return path !== null && (path === needle || path.startsWith(`${needle}/`));
});

const externalOf = ({ meta, score }) => ({
    kind: 'external',
    anilist_id: meta.anilist_id,
    mal_id: meta.mal_id || null,
    title: (meta.title && (meta.title.preferred || meta.title.romaji)) || null,
    format: meta.format || null,
    season_year: meta.season_year ?? null,
    episodes: meta.episodes ?? null,
    score: Math.round(score * 100) / 100
});

async function lookUp(ctx, item, options) {
    const terms = termsOf(item);
    if (!terms.length) return { outcome: 'none' };
    const hits = anime.strongHits(await gateway.spareSearch(ctx, terms, options), terms);
    if (!hits.length) return { outcome: 'none' };
    const scores = new Map(hits.map((h) => [h.meta.anilist_id, h.score]));
    const details = (await gateway.spareDetail(ctx, hits.map((h) => h.meta.anilist_id), options))
        .filter((meta) => meta && scores.has(meta.anilist_id) && anime.LOOKUP_FORMATS.includes(meta.format))
        .map((meta) => ({ meta, score: scores.get(meta.anilist_id), links: crunchyrollLinks(meta, item) }));
    const fitting = details.filter((c) => fitsSeason(c.meta, item.season));
    const externals = (list) => list.slice(0, MAX_EXTERNAL).map(externalOf);
    if (!fitting.length) return details.length ? { outcome: 'season_mismatch', candidates: externals(details) } : { outcome: 'none' };
    if (item.season > 1 && fitting.length > 1) return { outcome: 'ambiguous', candidates: externals(fitting) };
    const matching = fitting.filter((c) => c.links.match);
    if (matching.length === 1) return { outcome: 'proposed', meta: matching[0].meta };
    if (matching.length > 1) return { outcome: 'ambiguous', candidates: externals(matching) };
    const perfect = fitting.filter((c) => c.score === 1);
    if (!fitting.some((c) => c.links.any) && perfect.length === 1) return { outcome: 'proposed', meta: perfect[0].meta };
    return { outcome: 'ambiguous', candidates: externals(fitting) };
}

async function propose(ctx, userId, eligible) {
    const proposals = new Map();
    const phase = syncState.startPhase(ctx, PHASE_MS);
    const options = { userId, timeoutMs: LOOKUP_TIMEOUT_MS, signal: phase.signal, beforeRequest: syncState.lookupGate(ctx, userId, phase) };
    try {
        for (const item of eligible.slice(0, LOOKUP_ITEMS)) {
            try {
                proposals.set(itemKey(item), await lookUp(ctx, item, options));
            } catch (err) {
                if (err instanceof syncState.LookupStop || err instanceof SourceError || (err && (err.status === 429 || err.status === 503))) break;
                ctx.log.child('anime').debug('Watch-sync lookup failed:', err && err.message);
            }
        }
    } finally {
        phase.end();
    }
    return proposals;
}

function eligibleItems(ctx, items, view, state, skip) {
    const now = ctx.now().getTime();
    const blocked = new Set([...state.declined, ...state.skipped, ...skip]);
    const out = [];
    for (const item of items) {
        const key = itemKey(item);
        if (blocked.has(key) || !isRecent(item, now)) continue;
        if (crunchyroll.watchedCount(item) < 1 && !isStarting(item, now)) continue;
        const found = matchItem(item, view);
        if (found.anime_id || (found.candidates || []).some((c) => c.season === item.season)) continue;
        if (isRemembered(ctx, syncState.readOutcome(ctx, ctx.user.id, key))) continue;
        out.push(item);
    }
    return out.sort((a, b) => String(b.watched_at || '').localeCompare(String(a.watched_at || '')));
}

const inCollection = (ctx, candidate) => Boolean((candidate.anilist_id && ctx.db.prepare('SELECT 1 FROM animes WHERE anilist_id = ?').get(candidate.anilist_id))
    || (candidate.mal_id && ctx.db.prepare('SELECT 1 FROM animes WHERE mal_id = ?').get(candidate.mal_id)));

function externalCandidates(ctx, memory) {
    const list = memory && Array.isArray(memory.candidates) ? memory.candidates : [];
    return list.filter((c) => c && c.kind === 'external' && Number.isInteger(c.anilist_id) && !inCollection(ctx, c)).slice(0, MAX_EXTERNAL);
}

function commit(ctx, { service, items, skip, platform, proposals, generation }) {
    if (generationOf(ctx) !== generation) throw reopenedError();
    const uid = ctx.user.id;
    const now = ctx.now().getTime();
    const state = syncState.readWatchState(ctx, uid);
    syncState.rememberSkipped(state, skip);
    const declined = new Set(state.declined);
    const skipped = new Set(state.skipped);
    const usable = proposals && state.auto_add ? proposals : new Map();
    const view = loadView(ctx, service);
    const rowOf = (id) => view.byId.get(id) || prepareRows(anime.matchRows(ctx).filter((r) => r.id === id))[0] || null;
    const learnStmt = ctx.db.prepare('INSERT INTO anime_links (anime_id, service, external_id, url) VALUES (?, ?, ?, NULL) ON CONFLICT (anime_id, service) DO NOTHING');
    const learnLink = (animeId, item) => {
        const link = crunchyroll.seasonLinkOf(service.id, item.external_id, item.season);
        learnStmt.run(animeId, link.service, link.external_id);
    };
    const unmatched = [];
    const perAnime = new Map();
    const learned = new Map();
    const starting = [];
    const matchedPairs = [];
    const pending = [];
    const push = (map, key, value) => map.set(key, [...(map.get(key) || []), value]);
    const take = (item, key, found) => {
        if (found.via !== 'season') matchedPairs.push({ anime_id: found.anime_id, key, at: now });
        if (crunchyroll.watchedCount(item) >= 1) {
            push(perAnime, found.anime_id, item);
            if (found.learn) push(learned, found.anime_id, item);
        } else if (isStarting(item, now)) {
            starting.push({ item, found });
        }
    };

    for (const item of items) {
        const key = itemKey(item);
        const count = crunchyroll.watchedCount(item);
        const memory = syncState.readOutcome(ctx, uid, key);
        const found = matchItem(item, view);
        const remembered = found.anime_id ? null : rememberedId(ctx, memory);
        if (declined.has(key)) {
            if (count < 1) continue;
            const picked = found.anime_id || remembered;
            const list = [...(picked && rowOf(picked) ? [candidateOf(rowOf(picked))] : []), ...(found.candidates || [])];
            const unique = list.filter((c, i) => list.findIndex((x) => x.id === c.id) === i).slice(0, MAX_CANDIDATES);
            unmatched.push(unmatchedOf(item, 'declined', unique));
            continue;
        }
        if (found.anime_id) {
            take(item, key, found);
            continue;
        }
        if (remembered && rowOf(remembered)) {
            syncState.writeOutcome(ctx, uid, key, memory);
            take(item, key, { anime_id: remembered, learn: false, via: 'memory' });
            continue;
        }
        pending.push({ item, key, found, memory });
    }

    const groups = new Map();
    const leftovers = [];
    for (const entry of pending) {
        const proposal = usable.get(entry.key);
        if (!proposal || skipped.has(entry.key)) {
            leftovers.push(entry);
            continue;
        }
        if (proposal.outcome === 'proposed') {
            const group = groups.get(proposal.meta.anilist_id) || { meta: proposal.meta, entries: [] };
            group.entries.push(entry);
            groups.set(proposal.meta.anilist_id, group);
            continue;
        }
        entry.memory = { outcome: proposal.outcome, ...(proposal.candidates && proposal.candidates.length ? { candidates: proposal.candidates } : {}) };
        syncState.writeOutcome(ctx, uid, entry.key, entry.memory);
        leftovers.push(entry);
    }

    const added = [];
    const addedPairs = [];
    const created = [];
    for (const { meta, entries } of groups.values()) {
        const remember = (outcome, extra = {}) => {
            for (const e of entries) syncState.writeOutcome(ctx, uid, e.key, { outcome, ...extra });
        };
        const duplicate = anime.duplicateOf(ctx, meta.anilist_id, meta.mal_id);
        if (duplicate && rowOf(duplicate)) {
            for (const e of entries) {
                take(e.item, e.key, { anime_id: duplicate, learn: false, via: 'duplicate' });
                if (namesSeries(meta, e.item) && crunchyroll.watchedCount(e.item) >= 1) learnLink(duplicate, e.item);
            }
            remember('matched', { anime_id: duplicate, anilist_id: ctx.db.prepare('SELECT anilist_id FROM animes WHERE id = ?').get(duplicate).anilist_id });
            continue;
        }
        if (syncState.capLeft(ctx, uid, 'creations') < 1) {
            leftovers.push(...entries);
            continue;
        }
        const plan = crunchyroll.planProgress(entries.map((e) => e.item), { episodes: meta.episodes, episodes_watched: 0, resume_url: null });
        const begun = entries.find((e) => crunchyroll.watchedCount(e.item) < 1 && isStarting(e.item, now));
        if (plan && plan.above_total) {
            remember('above_total', { anilist_id: meta.anilist_id });
            leftovers.push(...entries);
            continue;
        }
        if (!plan && !begun) {
            leftovers.push(...entries);
            continue;
        }
        const inserted = anime.insertPrepared(ctx, { meta, images: {} });
        syncState.useCap(ctx, uid, 'creations');
        const change = plan ? plan.change : { status: 'Schaue', episodes_watched: 0, resume_url: begun.item.resume_url, resume_episode: begun.item.resume_url ? 1 : null };
        const saved = writeProgress(ctx, inserted.id, uid, change);
        for (const e of entries) if (namesSeries(meta, e.item)) learnLink(inserted.id, e.item);
        const newest = [...entries].sort((a, b) => String(b.item.watched_at || '').localeCompare(String(a.item.watched_at || '')))[0];
        const title = ctx.db.prepare('SELECT title FROM animes WHERE id = ?').get(inserted.id).title;
        added.push({
            anime_id: inserted.id, title, external_id: newest.item.external_id, season: newest.item.season,
            episodes_watched: saved.episodes_watched, status: saved.status
        });
        for (const e of entries) addedPairs.push({ anime_id: inserted.id, key: e.key, at: now });
        remember('added', { anime_id: inserted.id, anilist_id: meta.anilist_id });
        created.push({ id: inserted.id, meta });
    }

    for (const { item, found, memory } of leftovers) {
        if (crunchyroll.watchedCount(item) < 1) continue;
        unmatched.push(unmatchedOf(item, found.reason, [...(found.candidates || []).slice(0, MAX_CANDIDATES), ...externalCandidates(ctx, memory)]));
    }

    const applied = [];
    let unchanged = 0;
    for (const [animeId, list] of perAnime) {
        const p = rowOf(animeId);
        const stored = readProgress(ctx, animeId, uid);
        const plan = crunchyroll.planProgress(list, { episodes: p.row.episodes, episodes_watched: stored ? stored.episodes_watched : 0, resume_url: stored ? stored.resume_url : null });
        if (plan && plan.above_total) {
            for (const item of list) unmatched.push(unmatchedOf(item, 'episode_above_total', [candidateOf(p)]));
            continue;
        }
        for (const item of learned.get(animeId) || []) learnLink(animeId, item);
        if (!plan) {
            unchanged++;
            continue;
        }
        const saved = writeProgress(ctx, animeId, uid, plan.change, { monotonic: true });
        applied.push({ anime_id: animeId, episodes_watched: saved.episodes_watched, status: saved.status });
    }
    for (const { item, found } of starting) {
        if (perAnime.has(found.anime_id) || readProgress(ctx, found.anime_id, uid)) continue;
        const saved = writeProgress(ctx, found.anime_id, uid, { status: 'Schaue', episodes_watched: 0, resume_url: item.resume_url, resume_episode: item.resume_url ? 1 : null });
        if (!saved) continue;
        if (found.learn) learnLink(found.anime_id, item);
        applied.push({ anime_id: found.anime_id, episodes_watched: saved.episodes_watched, status: saved.status });
    }

    syncState.rememberAdded(state, addedPairs);
    syncState.rememberMatched(state, matchedPairs);
    state.last = { platform, applied: applied.length, added: added.length };
    state.last_at = now;
    syncState.writeWatchState(ctx, uid, state);
    return { body: { applied, unmatched, unchanged, added, watch: syncState.watchOf(state) }, created };
}

// Applies the caller's history items: matched entries only move forward (monotonic, "Gesehen" at the known total, resume link =
// next episode); the rest returns as unmatched with candidates. Always the caller's own progress; with AniList list sync on,
// applied entries are pushed like +1.
async function sync(ctx, { body }) {
    const { service, items, skip, autoAdd, platform } = readBody(body);
    const uid = ctx.user.id;
    const wait = throttled(ctx, uid);
    if (wait !== null) return { body: { applied: [], unmatched: [], added: [], throttled: true, retry_after: wait } };
    const generation = generationOf(ctx);
    let proposals = null;
    const before = syncState.readWatchState(ctx, uid);
    if (autoAdd && before.auto_add && settings(ctx).anilist && !gateway.poolDown(ctx, 'anilist')) {
        const eligible = eligibleItems(ctx, items, loadView(ctx, service), before, skip);
        if (eligible.length) proposals = await propose(ctx, uid, eligible);
    }
    if (generationOf(ctx) !== generation) throw reopenedError();
    if (ctx.signal && ctx.signal.aborted) proposals = null;
    const result = ctx.db.transaction(() => commit(ctx, { service, items, skip, platform, proposals, generation }));
    const addedIds = new Set(result.created.map((c) => c.id));
    for (const entry of result.body.applied) if (!addedIds.has(entry.anime_id)) listSync.schedulePush(ctx, uid, entry.anime_id);
    for (const { id, meta } of result.created) {
        listSync.schedulePush(ctx, uid, id, { delayMs: ADDED_PUSH_MS });
        gateway.scheduleIdResolution(ctx, id);
        gateway.runInBackground(ctx, `images:${id}`, 'prefetch', async (host) => {
            const row = host.db.prepare('SELECT * FROM animes WHERE id = ?').get(id);
            if (!row) return;
            const images = await store.freshImages(host, meta, row);
            if (generationOf(host) !== generation || !host.db.prepare('SELECT 1 FROM animes WHERE id = ?').get(id)) return;
            store.updateRow(host, id, images);
        });
    }
    return { body: result.body };
}

const utcMs = (sqlTime) => {
    const t = sqlTime ? Date.parse(`${String(sqlTime).replace(' ', 'T')}Z`) : NaN;
    return Number.isFinite(t) ? t : null;
};

/** POST /anime/watch-sync/undo: takes back an entry added within the hour ({ anime_id, external_id, season } or { anime_id }). */
function undo(ctx, { body }) {
    const input = body && typeof body === 'object' ? body : {};
    const animeId = anime.parseId(input.anime_id, 'id');
    const keyed = input.external_id !== undefined || input.season !== undefined;
    const key = keyed && typeof input.external_id === 'string' && Number.isInteger(input.season) ? syncState.keyOf(input.external_id, input.season) : null;
    const uid = ctx.user.id;
    const now = ctx.now().getTime();
    const removed = ctx.db.transaction(() => {
        const row = ctx.db.prepare('SELECT id, created_at FROM animes WHERE id = ?').get(animeId);
        if (!row) throw notFound('Anime');
        const others = ctx.db.prepare('SELECT COUNT(*) AS n FROM anime_progress WHERE anime_id = ? AND user_id <> ?').get(animeId, uid).n > 0;
        const deleteEntry = () => ctx.db.prepare('DELETE FROM animes WHERE id = ?').run(animeId);
        if (!keyed) {
            const created = utcMs(row.created_at);
            if (created === null || now - created > UNDO_MS || others) throw undoExpired();
            deleteEntry();
            return 'entry';
        }
        const state = syncState.readWatchState(ctx, uid);
        const pair = key ? state.added.find((p) => p.anime_id === animeId && p.key === key) : null;
        if (!pair) throw notFound('Anime');
        if (now - pair.at > UNDO_MS) throw undoExpired();
        if (!others) {
            const keys = state.added.filter((p) => p.anime_id === animeId).map((p) => p.key);
            state.added = state.added.filter((p) => p.anime_id !== animeId);
            syncState.writeWatchState(ctx, uid, state);
            syncState.recordDecline(ctx, uid, keys);
            deleteEntry();
            return 'entry';
        }
        const link = crunchyroll.seasonLinkOf(SYNC_SERVICES[0], input.external_id, input.season);
        ctx.db.prepare('DELETE FROM anime_progress WHERE anime_id = ? AND user_id = ?').run(animeId, uid);
        ctx.db.prepare('DELETE FROM anime_links WHERE anime_id = ? AND service = ? AND external_id = ?').run(animeId, link.service, link.external_id);
        state.added = state.added.filter((p) => !(p.anime_id === animeId && p.key === key));
        syncState.writeWatchState(ctx, uid, state);
        syncState.recordDecline(ctx, uid, [key]);
        return 'progress';
    });
    return { body: { removed } };
}

module.exports = { sync, undo, withoutSeason, termsOf, fitsSeason };
