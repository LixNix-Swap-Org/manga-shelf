// Opt-in sync of a user's progress with their own AniList list: the higher episode count wins and the status follows
// it, updatedAt decides a tie, nothing ever goes backwards. Only the user's own token is used (gateway ownOnly).
const { HttpError } = require('../errors');
const { credentialsOf } = require('../sources/credentials');
const { SourceError } = require('./request');
const gateway = require('./gateway');
const anilist = require('./anilist');
const { writeProgress, sqlNow } = require('./progress');

const SERVICE = 'anilist';
const RUN_MIN_MS = 60 * 1000;
// the anime tab asks on every load; it only pulls when the last sync is older than this
const AUTO_MIN_MS = 15 * 60 * 1000;
const BACKGROUND_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_PUSH_PER_RUN = 25;
// quick +1 presses within this window become one AniList write
const PUSH_DELAY_MS = 2000;
// visitors and guests are read-only; the sync routes are editor-only, so they could not switch it off themselves
const SYNC_ROLES = ['admin', 'editor'];

const TO_LOCAL = { CURRENT: 'Schaue', REPEATING: 'Schaue', PLANNING: 'Geplant', COMPLETED: 'Gesehen', PAUSED: 'Pausiert', DROPPED: 'Abgebrochen' };
const TO_REMOTE = { Schaue: 'CURRENT', Geplant: 'PLANNING', Gesehen: 'COMPLETED', Pausiert: 'PAUSED', Abgebrochen: 'DROPPED' };

const TEXT = {
    noToken: 'Kein eigener AniList-Token hinterlegt',
    rejected: 'AniList lehnt den Token ab – bitte im Konto neu eintragen',
    unreachable: 'AniList ist gerade nicht erreichbar'
};

const nowMs = (ctx) => ctx.now().getTime();

/** Throttle state lives on the gateway state, so resetGatewayState() clears it too. */
function runs() {
    const s = gateway.state();
    if (!s.listSync) s.listSync = { lastRun: new Map(), running: new Set(), pushTimers: new Map(), pushDelayMs: PUSH_DELAY_MS };
    return s.listSync;
}

const syncRow = (ctx, userId) => ctx.db.prepare('SELECT * FROM anime_sync WHERE user_id = ? AND service = ?').get(userId, SERVICE) || null;

function writeSync(ctx, userId, columns) {
    const row = { enabled: 0, external_user_id: null, last_synced_at: null, last_error: null, last_report: null, ...(syncRow(ctx, userId) || {}), ...columns };
    ctx.db.prepare(`
        INSERT INTO anime_sync (user_id, service, enabled, external_user_id, last_synced_at, last_error, last_report, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, service) DO UPDATE SET enabled = excluded.enabled, external_user_id = excluded.external_user_id,
            last_synced_at = excluded.last_synced_at, last_error = excluded.last_error, last_report = excluded.last_report,
            updated_at = excluded.updated_at
    `).run(userId, SERVICE, row.enabled ? 1 : 0, row.external_user_id, row.last_synced_at, row.last_error, row.last_report, sqlNow(ctx));
}

const parseReport = (text) => {
    try {
        const r = text ? JSON.parse(text) : null;
        return r && typeof r === 'object' ? { pulled: r.pulled || 0, pushed: r.pushed || 0, not_in_list: r.not_in_list || 0 } : null;
    } catch (_) {
        return null;
    }
};

/** GET /anime/sync shape of one user's AniList sync. */
function stateOf(ctx, userId) {
    const row = syncRow(ctx, userId);
    return {
        enabled: Boolean(row && row.enabled),
        external_user_id: row ? row.external_user_id : null,
        last_synced_at: row ? row.last_synced_at : null,
        last_error: row ? row.last_error : null,
        last_report: row ? parseReport(row.last_report) : null,
        available: Boolean(credentialsOf(ctx).get(userId, SERVICE))
    };
}

const errorText = (err) => (err.kind === 'auth' ? TEXT.rejected : err.kind === 'notoken' ? TEXT.noToken : TEXT.unreachable);

const ownCall = (ctx, userId, priority, exec) => gateway.call(ctx, SERVICE, { priority, userId, ownOnly: true }, exec);

/** Switches the sync on (checks the own token with Viewer and stores the AniList user id) or off. */
async function setEnabled(ctx, userId, enabled) {
    if (!enabled) {
        // switching off is deliberate: an old token error must not keep the 'paused' hint alive
        if (syncRow(ctx, userId)) writeSync(ctx, userId, { enabled: 0, last_error: null });
        return stateOf(ctx, userId);
    }
    let viewer;
    try {
        viewer = (await ownCall(ctx, userId, 'interactive', async (credential) => ({ viewer: await anilist.viewer(ctx, credential.secret) }))).viewer;
    } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        if (err.kind === 'notoken') throw new HttpError(400, 'Für den Abgleich braucht es einen eigenen AniList-Token (Konto → Quellen).', 'NO_TOKEN');
        if (err.kind === 'auth') throw new HttpError(400, `${TEXT.rejected}.`, 'TOKEN_REJECTED');
        throw new HttpError(503, 'AniList ist gerade nicht erreichbar. Bitte später erneut versuchen.', 'SOURCES_UNAVAILABLE');
    }
    writeSync(ctx, userId, { enabled: 1, external_user_id: String(viewer.id), last_error: null });
    return stateOf(ctx, userId);
}

const localSeconds = (sqlTime) => {
    const t = sqlTime ? Date.parse(`${String(sqlTime).replace(' ', 'T')}Z`) : NaN;
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

/**
 * 'pull', 'push' or null for one AniList entry against the local progress row (null when there is none). A rewatch
 * (REPEATING) is never pushed over and never lowers anything.
 */
function decide(remote, local) {
    const remoteStatus = TO_LOCAL[remote.status] || null;
    if (!local || !local.status) return remoteStatus ? 'pull' : null;
    const rp = remote.progress || 0;
    const lp = local.episodes_watched || 0;
    if (rp > lp) return 'pull';
    if (rp < lp) return remote.status === 'REPEATING' ? null : 'push';
    if (!remoteStatus || remoteStatus === local.status || remote.status === 'REPEATING') return null;
    const remoteAt = remote.updatedAt || 0;
    const localAt = localSeconds(local.updated_at);
    if (remoteAt > localAt) return 'pull';
    return localAt > remoteAt ? 'push' : null;
}

const idleResult = (row, extra = {}) => ({
    ran: false, pulled: 0, pushed: 0, not_in_list: 0, changed: false,
    last_synced_at: row ? row.last_synced_at : null, last_error: row ? row.last_error : null, ...extra
});

/**
 * One sync of a user's list: { ran, pulled, pushed, not_in_list, changed, last_synced_at, last_error }. Throttled to
 * once per minute per user; `auto` (anime tab) also skips a sync younger than 15 min; `background` (scheduler) runs only
 * with allowBackground and stays silent without a token.
 */
async function run(ctx, userId, { priority = 'interactive', auto = false, background = false } = {}) {
    const row = syncRow(ctx, userId);
    if (!row || !row.enabled) return idleResult(row);
    const now = nowMs(ctx);
    if (auto && row.last_synced_at && now - row.last_synced_at < AUTO_MIN_MS) return idleResult(row);
    const state = runs();
    if (state.running.has(userId) || now - (state.lastRun.get(userId) || 0) < RUN_MIN_MS) return idleResult(row);
    const own = credentialsOf(ctx).get(userId, SERVICE);
    if (!own) {
        if (background) return idleResult(row);
        writeSync(ctx, userId, { last_error: TEXT.noToken });
        return idleResult(row, { last_error: TEXT.noToken });
    }
    if (background && !own.allowBackground) return idleResult(row);
    state.lastRun.set(userId, now);
    state.running.add(userId);
    try {
        return await runLocked(ctx, userId, row, priority);
    } finally {
        state.running.delete(userId);
    }
}

async function runLocked(ctx, userId, row, priority) {
    const generation = gateway.generationOf(ctx);
    const report = { pulled: 0, pushed: 0, not_in_list: 0 };
    let error = null;
    let entries = null;
    let externalId = row.external_user_id;
    try {
        if (!externalId) {
            const viewer = (await ownCall(ctx, userId, priority, async (credential) => ({ viewer: await anilist.viewer(ctx, credential.secret) }))).viewer;
            externalId = String(viewer.id);
        }
        entries = (await ownCall(ctx, userId, priority, (credential) => anilist.listCollection(ctx, externalId, { credential }))).entries;
    } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        error = errorText(err);
    }
    if (gateway.generationOf(ctx) !== generation) return idleResult(row);
    const pushes = [];
    if (entries) {
        const locals = new Map(ctx.db.prepare(`
            SELECT a.id, a.anilist_id, p.status, p.episodes_watched, p.updated_at
            FROM animes a LEFT JOIN anime_progress p ON p.anime_id = a.id AND p.user_id = ?
            WHERE a.anilist_id IS NOT NULL
        `).all(userId).map((r) => [r.anilist_id, r]));
        ctx.db.transaction(() => {
            for (const remote of entries) {
                const local = locals.get(remote.mediaId);
                if (!local) {
                    report.not_in_list++;
                    continue;
                }
                const action = decide(remote, local.status ? local : null);
                if (action === 'push') {
                    pushes.push({ mediaId: remote.mediaId, progress: local.episodes_watched, status: TO_REMOTE[local.status] });
                } else if (action === 'pull') {
                    const status = TO_LOCAL[remote.status];
                    const change = (remote.progress || 0) > (local.episodes_watched || 0) ? { episodes_watched: remote.progress, status } : { status };
                    const saved = writeProgress(ctx, local.id, userId, change, { monotonic: true });
                    if (saved && (!local.status || saved.status !== local.status || saved.episodes_watched !== local.episodes_watched)) report.pulled++;
                }
            }
        });
        for (const push of pushes.slice(0, MAX_PUSH_PER_RUN)) {
            try {
                await ownCall(ctx, userId, priority, (credential) => anilist.saveListEntry(ctx, push, { credential }));
                report.pushed++;
            } catch (err) {
                if (!(err instanceof SourceError)) throw err;
                error = errorText(err);
                break;
            }
        }
    }
    if (gateway.generationOf(ctx) !== generation) return idleResult(row);
    const current = syncRow(ctx, userId);
    // a key change during the run cleared the id: the next run must resolve the new account
    const keyChanged = current && current.external_user_id !== row.external_user_id;
    const columns = { external_user_id: keyChanged ? current.external_user_id : externalId, last_error: error };
    if (entries) Object.assign(columns, { last_synced_at: nowMs(ctx), last_report: JSON.stringify(report) });
    writeSync(ctx, userId, columns);
    const after = syncRow(ctx, userId);
    return { ran: true, ...report, changed: report.pulled > 0, last_synced_at: after.last_synced_at, last_error: after.last_error };
}

/** Pushes one entry after the caller's own +1 or share; presses within 2 s coalesce into one job that reads the latest row. */
function schedulePush(ctx, userId, animeId) {
    if (!ctx.user || ctx.user.id !== userId) return false;
    const row = syncRow(ctx, userId);
    if (!row || !row.enabled || !row.external_user_id) return false;
    const anime = ctx.db.prepare('SELECT anilist_id FROM animes WHERE id = ?').get(animeId);
    if (!anime || !anime.anilist_id || !credentialsOf(ctx).get(userId, SERVICE)) return false;
    const generation = gateway.generationOf(ctx);
    const key = `anilist-push:${userId}:${animeId}`;
    const state = runs();
    if (state.pushTimers.has(key)) return true;
    const timer = setTimeout(() => {
        state.pushTimers.delete(key);
        gateway.runInBackground(ctx, key, 'interactive', (host) => pushOne(host, userId, animeId, generation));
    }, state.pushDelayMs);
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    state.pushTimers.set(key, timer);
    return true;
}

/** Tests: shorter coalescing window. */
function setPushDelay(ms) {
    runs().pushDelayMs = ms;
}

async function pushOne(ctx, userId, animeId, generation) {
    if (gateway.generationOf(ctx) !== generation) return;
    const row = syncRow(ctx, userId);
    const local = ctx.db.prepare(`
        SELECT p.status, p.episodes_watched, p.updated_at, a.anilist_id FROM anime_progress p JOIN animes a ON a.id = p.anime_id
        WHERE p.anime_id = ? AND p.user_id = ?
    `).get(animeId, userId);
    if (!row || !row.enabled || !row.external_user_id || !local || !local.anilist_id) return;
    let error = null;
    try {
        const { entry } = await ownCall(ctx, userId, 'interactive', (credential) => anilist.listEntry(ctx, row.external_user_id, local.anilist_id, { credential }));
        const status = entry && entry.status === 'REPEATING' && local.status === 'Schaue' ? 'REPEATING' : TO_REMOTE[local.status];
        const ahead = !entry || local.episodes_watched > entry.progress
            || (local.episodes_watched === entry.progress && TO_LOCAL[entry.status] !== local.status && localSeconds(local.updated_at) > (entry.updatedAt || 0));
        if (!ahead) return;
        await ownCall(ctx, userId, 'interactive', (credential) => anilist.saveListEntry(ctx, { mediaId: local.anilist_id, progress: local.episodes_watched, status }, { credential }));
    } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        error = errorText(err);
    }
    if (gateway.generationOf(ctx) !== generation) return;
    if (error || row.last_error) writeSync(ctx, userId, { last_error: error });
}

/**
 * A personal key was saved or removed (server: routes/apiKeys.js, device: the local key store). A new key may belong to
 * another AniList account, so the next run resolves Viewer again; without a key the sync is switched off.
 */
function onCredentialChanged(ctx, userId, provider, { removed = false } = {}) {
    if (provider !== SERVICE || userId === null || userId === undefined) return;
    const set = removed ? 'enabled = 0, external_user_id = NULL, last_error = NULL' : 'external_user_id = NULL, last_error = NULL';
    ctx.db.prepare(`UPDATE anime_sync SET ${set}, updated_at = ? WHERE user_id = ? AND service = ?`).run(sqlNow(ctx), userId, SERVICE);
}

/** A role change to visitor or guest switches the sync off. */
function onRoleChanged(ctx, userId, role) {
    if (SYNC_ROLES.includes(role)) return;
    ctx.db.prepare('UPDATE anime_sync SET enabled = 0, updated_at = ? WHERE user_id = ? AND enabled = 1').run(sqlNow(ctx), userId);
}

/** Scheduler: every enabled editor or admin whose last sync is older than 6 h, in the background share. { due, ran } */
async function runDue(ctx, { shouldStop = () => false } = {}) {
    const rows = ctx.db.prepare(`
        SELECT s.user_id FROM anime_sync s JOIN users u ON u.id = s.user_id
        WHERE s.service = ? AND s.enabled = 1 AND u.role IN (${SYNC_ROLES.map(() => '?').join(', ')})
            AND (s.last_synced_at IS NULL OR s.last_synced_at <= ?)
        ORDER BY s.user_id
    `).all(SERVICE, ...SYNC_ROLES, nowMs(ctx) - BACKGROUND_EVERY_MS);
    const report = { due: rows.length, ran: 0 };
    for (const { user_id: userId } of rows) {
        if (shouldStop()) break;
        if ((await run(ctx, userId, { priority: 'refresh', background: true })).ran) report.ran++;
    }
    return report;
}

module.exports = {
    stateOf, setEnabled, run, schedulePush, setPushDelay, runDue, onCredentialChanged, onRoleChanged, decide, TO_LOCAL, TO_REMOTE, RUN_MIN_MS,
    AUTO_MIN_MS, BACKGROUND_EVERY_MS, SYNC_ROLES, TEXT
};
