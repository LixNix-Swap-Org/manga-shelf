// Graceful shutdown and the readiness report: tracked jobs finish before the database closes, with a hard deadline.
const fs = require('fs');
const log = require('../utils/logger').child('lifecycle');

const JOB_DEADLINE_MS = 8000;
const HARD_DEADLINE_MS = 9000;

const jobs = new Set();
let shutdownPromise = null;

/**
 * Registers a running job (snapshot, restore) so a shutdown waits for it before closing the database.
 * Returns the promise unchanged.
 */
function trackJob(name, promise) {
    const job = { name, promise };
    jobs.add(job);
    Promise.resolve(promise).then(() => jobs.delete(job), () => jobs.delete(job));
    return promise;
}

const runningJobs = () => [...jobs].map(j => j.name);

/** Resolves with the names of the jobs still running after `ms` (empty when all finished in time). */
function waitForJobs(ms) {
    if (jobs.size === 0) return Promise.resolve([]);
    let timer;
    const settled = Promise.allSettled([...jobs].map(j => j.promise)).then(() => []);
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(runningJobs()), ms); });
    return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

const isShuttingDown = () => shutdownPromise !== null;

/** Idempotent shutdown of `parts` { server, stopScheduler, closeConsole, abortDownloads, closeDb }, jobs get `jobDeadlineMs`. */
function shutdown(parts = {}, { jobDeadlineMs = JOB_DEADLINE_MS } = {}) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
        const step = (label, fn) => {
            try { fn(); } catch (err) { log.warn(`${label} fehlgeschlagen:`, err); }
        };
        if (parts.stopScheduler) step('Scheduler stoppen', parts.stopScheduler);
        if (parts.closeConsole) step('Konsole schließen', parts.closeConsole);
        if (parts.abortDownloads) step('Update-Downloads abbrechen', parts.abortDownloads);
        const server = parts.server;
        const closed = server && server.listening
            ? new Promise(resolve => server.close(() => resolve()))
            : Promise.resolve();
        const left = await waitForJobs(jobDeadlineMs);
        if (left.length) log.warn(`Beenden ohne auf diese Vorgänge zu warten: ${left.join(', ')}`);
        if (server && typeof server.closeAllConnections === 'function') server.closeAllConnections();
        await closed;
        if (parts.closeDb) step('Datenbank schließen', parts.closeDb);
    })();
    return shutdownPromise;
}

/** Process exit after a shutdown; a timer ends the process even if something still hangs. */
function exitAfterShutdown(parts, code, { hardDeadlineMs = HARD_DEADLINE_MS } = {}) {
    process.exitCode = Math.max(process.exitCode || 0, code);
    setTimeout(() => process.exit(process.exitCode || 1), hardDeadlineMs).unref();
    shutdown(parts).then(
        () => process.exit(),
        (err) => { log.error('Beenden fehlgeschlagen:', err); process.exit(1); }
    );
}

/** For tests: forget a finished shutdown so the next start/stop cycle runs again. */
function resetLifecycle() {
    shutdownPromise = null;
    jobs.clear();
}

const HEALTH_CACHE_MS = 60 * 1000;
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const BACKUP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
let backupCache = null;

function lastVerifiedBackup(lastVerifiedSnapshot, now) {
    if (!backupCache || now - backupCache.at > HEALTH_CACHE_MS) {
        let snapshot = null;
        try { snapshot = lastVerifiedSnapshot(); } catch (e) { snapshot = null; }
        backupCache = { at: now, snapshot };
    }
    return backupCache.snapshot;
}

/**
 * Public readiness report without paths or counts. error (503): database unreachable, data dir not writable or
 * shutting down; degraded (200): low free space or no verified backup for 48 h. `deps` are injected for tests.
 */
function healthReport(deps) {
    const now = deps.now ?? Date.now();
    const checks = { db: 'ok', writable: 'ok', disk: 'ok', backup: 'ok', restoring: Boolean(deps.isRestoreRunning?.()) };
    try {
        deps.db.prepare('SELECT 1').get();
    } catch (e) {
        checks.db = 'error';
    }
    try {
        fs.accessSync(deps.dataDir, fs.constants.W_OK);
    } catch (e) {
        checks.writable = 'error';
    }
    const snapshot = lastVerifiedBackup(deps.lastVerifiedSnapshot, now);
    const free = deps.freeBytes(deps.dataDir);
    if (free === null || free === undefined) checks.disk = 'unknown';
    else if (free < Math.max(MIN_FREE_BYTES, 2 * (snapshot?.size || 0))) checks.disk = 'low';
    if (!snapshot) checks.backup = (deps.uptimeMs ?? 0) > BACKUP_MAX_AGE_MS ? 'missing' : 'pending';
    else if (now - snapshot.time > BACKUP_MAX_AGE_MS) checks.backup = 'stale';

    let status = 'ok';
    if (checks.disk === 'low' || checks.backup === 'stale' || checks.backup === 'missing') status = 'degraded';
    if (checks.db === 'error' || checks.writable === 'error' || isShuttingDown()) status = 'error';
    return { status, checks };
}

const resetHealthCache = () => { backupCache = null; };

module.exports = {
    trackJob, runningJobs, waitForJobs, shutdown, exitAfterShutdown, isShuttingDown, resetLifecycle,
    healthReport, resetHealthCache, JOB_DEADLINE_MS, HARD_DEADLINE_MS
};
