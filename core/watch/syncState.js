// A user's Crunchyroll history sync state (anime_sync row 'crunchyroll'), outcome memories and lookup caps; keys '<SERIES ID>:<season>'.
const cache = require('../anime/cache');
const gateway = require('../anime/gateway');
const { sqlNow } = require('../anime/progress');
const { anySignal } = require('../lib/signals');

const SERVICE = 'crunchyroll';
const LIMITS = { added: 100, matched: 200, declined: 500, skipped: 200 };
const HOUR_MS = 60 * 60 * 1000;
const OUTCOME_TTL_MS = 7 * 24 * HOUR_MS;
const CAPS = { lookups: 10, creations: 5 };
const MIN_REQUEST_MS = 2000;
const KEY_RE = /^([A-Z0-9]{6,20}):(\d{1,2})$/i;

/** '<SERIES ID>:<season>' with the id upper-cased and the season 1-99, or null. */
function cleanKey(raw) {
    const m = typeof raw === 'string' ? KEY_RE.exec(raw) : null;
    const season = m ? Number(m[2]) : 0;
    return m && season >= 1 && season <= 99 ? `${m[1].toUpperCase()}:${season}` : null;
}

const keyOf = (externalId, season) => cleanKey(`${externalId}:${season}`);

const tail = (list, limit) => list.slice(Math.max(0, list.length - limit));
const isCount = (n) => Number.isInteger(n) && n >= 0;

const cleanPairs = (list) => (Array.isArray(list) ? list : [])
    .filter((p) => p && Number.isInteger(p.anime_id) && cleanKey(p.key) === p.key && Number.isFinite(p.at))
    .map((p) => ({ anime_id: p.anime_id, key: p.key, at: p.at }));

const cleanKeys = (list) => [...new Set((Array.isArray(list) ? list : []).map(cleanKey).filter(Boolean))];

const parseJson = (text) => {
    try {
        return text ? JSON.parse(text) : null;
    } catch (_) {
        return null;
    }
};

function parseReport(text) {
    const raw = parseJson(text);
    const report = raw && typeof raw === 'object' ? raw : {};
    const last = report.last && typeof report.last === 'object' ? report.last : null;
    return {
        last: last ? {
            platform: typeof last.platform === 'string' ? last.platform : null,
            applied: isCount(last.applied) ? last.applied : 0,
            added: isCount(last.added) ? last.added : 0
        } : null,
        added: cleanPairs(report.added),
        matched: cleanPairs(report.matched),
        declined: cleanKeys(report.declined),
        skipped: cleanKeys(report.skipped)
    };
}

/** { exists, auto_add (true without a row), last_at, last, added, matched, declined, skipped } of one user. */
function readWatchState(ctx, userId) {
    const row = ctx.db.prepare('SELECT enabled, last_synced_at, last_report FROM anime_sync WHERE user_id = ? AND service = ?').get(userId, SERVICE);
    return {
        exists: Boolean(row),
        auto_add: row ? Boolean(row.enabled) : true,
        last_at: row && Number.isFinite(row.last_synced_at) ? row.last_synced_at : null,
        ...parseReport(row && row.last_report)
    };
}

/** Stores a state read by readWatchState (lists cut to their limits). */
function writeWatchState(ctx, userId, state) {
    const report = JSON.stringify({
        last: state.last || null,
        added: tail(state.added, LIMITS.added),
        matched: tail(state.matched, LIMITS.matched),
        declined: tail(state.declined, LIMITS.declined),
        skipped: tail(state.skipped, LIMITS.skipped)
    });
    ctx.db.prepare(`
        INSERT INTO anime_sync (user_id, service, enabled, last_synced_at, last_report, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, service) DO UPDATE SET enabled = excluded.enabled, last_synced_at = excluded.last_synced_at,
            last_report = excluded.last_report, updated_at = excluded.updated_at
    `).run(userId, SERVICE, state.auto_add ? 1 : 0, state.last_at ?? null, report, sqlNow(ctx));
    state.exists = true;
}

/** The `watch` object of GET /anime/sync. */
const watchOf = (state) => ({
    auto_add: state.auto_add,
    last_at: state.last_at,
    last_platform: state.last ? state.last.platform : null,
    last_applied: state.last ? state.last.applied : 0,
    last_added: state.last ? state.last.added : 0
});

const isDeclined = (state, key) => state.declined.includes(key);

const withKeys = (list, keys, limit) => tail([...list.filter((k) => !keys.includes(k)), ...keys], limit);

/** Adds { anime_id, key, at } pairs to the state's `added` list. */
function rememberAdded(state, pairs) {
    state.added = tail([...state.added, ...pairs], LIMITS.added);
}

/** Adds pairs to the state's `matched` list: one per (anime_id, key), the newest kept. */
function rememberMatched(state, pairs) {
    const same = (a, b) => a.anime_id === b.anime_id && a.key === b.key;
    let list = state.matched;
    for (const pair of pairs) list = [...list.filter((p) => !same(p, pair)), pair];
    state.matched = tail(list, LIMITS.matched);
}

/** Merges skip keys into the state (union, the last 200). */
function rememberSkipped(state, keys) {
    state.skipped = withKeys(state.skipped, cleanKeys(keys), LIMITS.skipped);
}

/** Keys of the state's `added` and `matched` pairs with this entry. */
const keysFor = (state, animeId) => [...new Set([...state.added, ...state.matched].filter((p) => p.anime_id === animeId).map((p) => p.key))];

const outcomeKey = (userId, key) => `watch:outcome:${userId}:${key}`;

/** The outcome memory of one key ({ outcome, anime_id?, anilist_id?, candidates? }) or null. */
function readOutcome(ctx, userId, key) {
    const hit = cache.read(ctx, outcomeKey(userId, key));
    return hit && hit.value && typeof hit.value === 'object' ? hit.value : null;
}

function writeOutcome(ctx, userId, key, value) {
    cache.write(ctx, outcomeKey(userId, key), value, OUTCOME_TTL_MS);
}

function forgetOutcome(ctx, userId, key) {
    cache.remove(ctx, outcomeKey(userId, key));
}

/** Adds keys to the user's declined list and drops their outcome memories. */
function recordDecline(ctx, userId, keys) {
    const list = cleanKeys(keys);
    if (!list.length) return;
    for (const key of list) forgetOutcome(ctx, userId, key);
    const state = readWatchState(ctx, userId);
    state.declined = withKeys(state.declined, list, LIMITS.declined);
    writeWatchState(ctx, userId, state);
}

/** Takes keys off the user's declined list and drops their outcome memories. */
function liftDeclines(ctx, userId, keys) {
    const list = cleanKeys(keys);
    if (!list.length) return;
    for (const key of list) forgetOutcome(ctx, userId, key);
    const state = readWatchState(ctx, userId);
    const left = state.declined.filter((k) => !list.includes(k));
    if (left.length === state.declined.length) return;
    state.declined = left;
    writeWatchState(ctx, userId, state);
}

/** Thrown by a lookup gate: the run stops looking up, quietly. */
class LookupStop extends Error {}

function capsOf(userId) {
    const s = gateway.state();
    if (!s.watchCaps) s.watchCaps = new Map();
    if (!s.watchCaps.has(userId)) s.watchCaps.set(userId, { lookups: [], creations: [] });
    return s.watchCaps.get(userId);
}

/** What is left of a user's hourly cap ('lookups' or 'creations'). */
function capLeft(ctx, userId, kind) {
    const now = ctx.now().getTime();
    const caps = capsOf(userId);
    caps[kind] = caps[kind].filter((t) => t > now - HOUR_MS && t <= now);
    return CAPS[kind] - caps[kind].length;
}

function useCap(ctx, userId, kind) {
    capsOf(userId)[kind].push(ctx.now().getTime());
}

/** A wall-clock budget: { signal (also ctx.signal), remainingMs(), end() }. */
function startPhase(ctx, budgetMs) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    return {
        signal: anySignal([ctx.signal, controller.signal]),
        remainingMs: () => budgetMs - (Date.now() - started),
        end: () => clearTimeout(timer)
    };
}

/** beforeRequest of the spare lookups: 2 s of the budget left, the hourly cap and the soft per-account limit; counts. */
const lookupGate = (ctx, userId, phase) => () => {
    if (phase.remainingMs() < MIN_REQUEST_MS || (ctx.signal && ctx.signal.aborted)) throw new LookupStop('budget');
    if (capLeft(ctx, userId, 'lookups') < 1) throw new LookupStop('cap');
    if (ctx.limit('lookup', { soft: true }) === false) throw new LookupStop('limit');
    useCap(ctx, userId, 'lookups');
};

module.exports = {
    readWatchState, writeWatchState, recordDecline, liftDeclines, isDeclined, rememberAdded, rememberMatched, rememberSkipped, keysFor, watchOf,
    readOutcome, writeOutcome, forgetOutcome, cleanKey, keyOf, capLeft, useCap, startPhase, lookupGate, LookupStop, SERVICE, LIMITS, CAPS
};
