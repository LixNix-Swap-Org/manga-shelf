const fs = require('fs');
const path = require('path');
const pkg = require('../../package.json');
const { config } = require('../../utils/config');
const disk = require('../../utils/disk');
const lifecycle = require('../lifecycle');
const log = require('../../utils/logger').child('update');
const { detectInstallMode } = require('./installMode');
const github = require('./github');
const download = require('./download');
const verify = require('./verify');
const stage = require('./stage');
const lock = require('./lock');
const preflight = require('./preflight');
const applyModule = require('./apply');
const restart = require('./restart');
const stateFile = require('./state');
const swap = require('./swap');
const { parseVersion, compareVersions } = require('./version');
const { HttpError, msg } = require('../../core/errors');
const { updateError, httpOnlyError, errorSummary, UPDATE_TEXTS } = require('./errors');
const { SUMS_NAME, BUNDLE_NAME, markerName, MAX_SMALL_BYTES, RELEASES_TTL_MS } = require('./constants');

const ASSET_DEADLINE_MS = 60 * 60 * 1000;
const BLOCKING_JOBS = /Snapshot|Wiederherstellung/;
const JOURNAL_MODES = new Set(['pterodactyl', 'sea-user']);
const IN_PROGRESS = new Set(['staged', 'ready-to-swap', 'swapping']);
const ROLLBACK_FROM = '3.1.0';
const NEW_STATE_EXPORTS = ['heldBackups', 'journalRollback', 'versionRecord', 'recordRollback', 'isDowngradeBackup'];
const BACKUP_TIME = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.zip$/;
const FETCH_RETRY_MS = 5 * 60 * 1000;

const DEFAULT_DEPS = () => ({
    download,
    verifier: verify.createVerifier(),
    transport: {},
    installMode: null,
    dataDir: null,
    now: () => Date.now(),
    freeBytes: disk.freeBytes,
    preflight: {},
    apply: {},
    database: null,
    exit: undefined
});

let deps = DEFAULT_DEPS();
let install = null;
let windowsAcl = null;
let targetFetch = null;
const hashCache = new Map();

const idleStatus = () => ({
    phase: 'idle', version: null, bytes: 0, total: 0, staging_id: null, expires_at: null,
    verified: null, admin_notes: [], error: null, step: null, downgrade: false, data_loss: null
});
let status = idleStatus();

const dataDir = () => deps.dataDir || config.dataDir;
const setStatus = (patch) => { status = { ...status, ...patch }; };
const iso = (ms) => new Date(ms).toISOString();

/** detectInstallMode() once per process (or the injected result). */
function installMode() {
    if (!install) install = deps.installMode || detectInstallMode({ windowsAcl });
    return install;
}

/** The binary hands in its Windows ACL helpers (scripts/server-bin/acl.js); the install mode is detected again on next use. */
function useWindowsAcl(acl) {
    windowsAcl = acl || null;
    if (!deps.installMode) install = null;
}

const stateReady = () => NEW_STATE_EXPORTS.every((name) => typeof stateFile[name] === 'function');

function database() {
    if (deps.database) return deps.database;
    return {
        schemaVersion: () => {
            const { db } = require('../../db');
            return require('../../core/schema').appliedSchemaVersion(db);
        },
        setting: (key) => {
            const { db } = require('../../db');
            const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
            return row ? row.value : undefined;
        }
    };
}

function versionRecord() {
    const store = database();
    return stateFile.versionRecord((key) => {
        try {
            return store.setting(key);
        } catch (e) {
            return undefined;
        }
    });
}

function sameInstall(state, inst) {
    if (!inst.canInstall || state.mode !== inst.mode) return false;
    if (inst.mode === 'sea-user') return typeof state.exec_path === 'string' && path.resolve(state.exec_path) === path.resolve(inst.execPath);
    return typeof state.code_dir === 'string' && Boolean(inst.codeDir) && path.resolve(state.code_dir) === path.resolve(inst.codeDir);
}

function journalCandidate(inst) {
    if (!JOURNAL_MODES.has(inst.mode)) return null;
    const state = stateFile.readState(dataDir());
    if (!state) return null;
    const found = stateFile.journalRollback(state, pkg.version);
    if (found) return { state, target: found.target, undoes: found.undoes, ended: false };
    const undoes = state.downgrade && state.downgrade.undoes;
    if (undoes && typeof undoes === 'object' && state.from === pkg.version) return { state, target: state.to, undoes, ended: !IN_PROGRESS.has(state.phase) };
    return null;
}

function backupTime(name, st) {
    const m = BACKUP_TIME.exec(name);
    if (m) return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`).toISOString();
    return st ? st.mtime.toISOString() : null;
}

function backupFacts(backup) {
    if (!backup || typeof backup.file !== 'string') return { info: null, file: null, st: null };
    const file = path.join(dataDir(), 'backups', path.basename(backup.file));
    let st = null;
    try { st = fs.statSync(file); } catch (e) {}
    const present = Boolean(st && st.isFile());
    return { info: { file: backup.file, at: backupTime(backup.file, st), present }, file, st: present ? st : null };
}

function backupIntact(backup, facts, { fresh }) {
    if (!facts.st) return false;
    const key = `${facts.file}|${facts.st.size}|${facts.st.mtimeMs}`;
    let hash = fresh ? null : hashCache.get(key);
    if (!hash) {
        hash = swap.sha256FileSync(facts.file);
        if (hashCache.size >= 16) hashCache.clear();
        hashCache.set(key, hash);
    }
    return hash === backup.sha256;
}

function schemaOf(then, now) {
    const known = Number.isInteger(then);
    return { then: known ? then : null, now, changed: !known || then !== now };
}

function backupReason(schema, backup, facts, options) {
    if (!schema.changed) return null;
    if (!facts.info || !facts.info.present) return 'backup_missing';
    return backupIntact(backup, facts, options) ? null : 'backup_changed';
}

function assessRollback({ requested = null, fresh = false } = {}) {
    if (!config.updateDowngrade) return { reason: 'disabled', info: null };
    if (!stateReady()) return { reason: 'mode', info: null };
    const inst = installMode();
    const options = { fresh };
    const journal = journalCandidate(inst);
    if (!journal) {
        const offer = stateFile.recordRollback(versionRecord(), pkg.version);
        const refusal = inst.canInstall ? 'no_update' : 'mode';
        if (!offer) return { reason: refusal, info: null };
        const schema = schemaOf(offer.schema_before, database().schemaVersion());
        const facts = backupFacts(offer.backup);
        let reason;
        if (compareVersions(offer.target, ROLLBACK_FROM) < 0) reason = 'too_old';
        else if (schema.changed && !offer.backup) reason = 'backup_missing';
        else reason = backupReason(schema, offer.backup, facts, options);
        const info = { version: offer.target, current: pkg.version, available: reason === null, reason, method: 'instructions', schema, backup: facts.info, since: offer.since };
        return { reason: requested === null ? reason : refusal, info };
    }
    const { state, target, undoes, ended } = journal;
    const schema = schemaOf(undoes.schema_before, database().schemaVersion());
    const facts = backupFacts(undoes.backup);
    let reason;
    if (!sameInstall(state, inst)) reason = 'mode';
    else if (ended) reason = 'already_downgraded';
    else if (requested !== null && requested !== target) reason = 'not_previous';
    else if (compareVersions(target, ROLLBACK_FROM) < 0) reason = 'too_old';
    else reason = backupReason(schema, undoes.backup, facts, options);
    const info = { version: target, current: pkg.version, available: reason === null, reason, method: 'download', schema, backup: facts.info, since: undoes.at || null };
    const plan = reason === null && !ended ? {
        target,
        undoes,
        db: schema.changed ? { source: { file: undoes.backup.file, sha256: undoes.backup.sha256 }, schema: schema.then } : null,
        schema,
        backupAt: facts.info ? facts.info.at : null
    } : null;
    return { reason, info, plan };
}

function rollbackTarget() {
    if (!config.updateDowngrade || !stateReady()) return null;
    const inst = installMode();
    const journal = journalCandidate(inst);
    return journal && !journal.ended && sameInstall(journal.state, inst) ? journal.target : null;
}

function fetchedTarget(version, inst) {
    const now = deps.now();
    const entry = targetFetch;
    if (entry && entry.version === version) {
        if (entry.running) return { known: false };
        if (now - entry.at < (entry.failed ? FETCH_RETRY_MS : RELEASES_TTL_MS)) return entry.failed ? { known: false } : { known: true, release: entry.release };
    }
    const next = { version, at: now, running: true, failed: false, release: null };
    targetFetch = next;
    next.promise = github.fetchRelease(version, { transport: deps.transport, fetchJson: deps.download.fetchJson })
        .then((release) => {
            next.release = release ? github.decorate(release, { current: pkg.version, assetName: inst.assetName }) : null;
        }, (err) => {
            if (err && err.httpStatus === 404) next.release = null;
            else next.failed = true;
            log.debug(`[Update] v${version} nicht abrufbar:`, err && err.message);
        })
        .finally(() => {
            next.running = false;
            next.at = deps.now();
        });
    return { known: false };
}

function releaseReason(release, inst) {
    if (!release) return 'no_asset';
    if (!release.signed) return 'unsigned';
    return release.assets.some((a) => a.name === inst.assetName) ? null : 'no_asset';
}

/** update.rollback of GET /api/system for the release list `view` (null while it is not loaded), or null. */
function rollbackInfo({ view = null } = {}) {
    const { info } = assessRollback();
    if (!info) return null;
    if (info.method !== 'download' || info.reason !== null) return info;
    const inst = installMode();
    if (!view || !Array.isArray(view.releases) || view.error) return { ...info, available: false, reason: null };
    let release = view.releases.find((r) => r.version === info.version);
    if (!release) {
        const fetched = fetchedTarget(info.version, inst);
        if (!fetched.known) return { ...info, available: false, reason: null };
        release = fetched.release;
    }
    const reason = releaseReason(release, inst);
    return { ...info, available: reason === null, reason };
}

/** For tests: the running background fetch of the rollback target, or null. */
const rollbackFetch = () => (targetFetch && targetFetch.running ? targetFetch.promise : null);

const downgradeRefused = (reason) => httpOnlyError('DOWNGRADE_NOT_AVAILABLE', { reason });

function assertNoRollbackCopy(plan) {
    if (!plan || !plan.db) return;
    const bak = path.join(dataDir(), 'manga.db.bak');
    if (!swap.lexists(bak)) return;
    throw new HttpError(503, msg('Eine frühere Wiederherstellung wurde nicht sauber abgeschlossen. Die vorherige Datenbank liegt als {path}. Von Hand: Server stoppen, manga.db.bak nach manga.db kopieren (oder löschen, wenn die aktuelle Datenbank stimmt) und neu starten. Oder auf dem Server "node scripts/admin.js rollback-aufraeumen" ausführen (Docker: "docker exec -it -u node manga-shelf node scripts/admin.js rollback-aufraeumen", in der Server-Konsole "rollback-aufraeumen"): es prüft die aktuelle Datenbank und löscht die Kopie erst nach Bestätigung.', { path: bak }), 'ROLLBACK_COPY_PENDING');
}

function downgradePlan(version) {
    const { reason, plan } = assessRollback({ requested: version, fresh: true });
    if (reason || !plan) throw downgradeRefused(reason || 'no_update');
    return plan;
}

const dataLoss = (plan) => (plan && plan.db ? { backup: plan.db.source.file, at: plan.backupAt, schema_then: plan.schema.then, schema_now: plan.schema.now } : null);

/** Releases newest first with signed / installable / reason for this server (rollback: true on the target of going back), plus fetched_at, error, next_try_at. */
async function listReleases({ force = false } = {}) {
    const inst = installMode();
    const list = await github.listReleases({ dataDir: dataDir(), force, now: deps.now(), transport: deps.transport, fetchJson: deps.download.fetchJson });
    const target = rollbackTarget();
    return { ...list, releases: list.releases.map((r) => github.decorate(r, { current: pkg.version, assetName: inst.assetName, rollbackTarget: target })) };
}

const refreshReleases = () => listReleases({ force: true });

function adminNotesUpTo(releases, version) {
    return releases
        .filter((r) => compareVersions(r.version, pkg.version) > 0 && compareVersions(r.version, version) <= 0)
        .map((r) => ({ version: r.version, url: r.html_url, text: github.adminNotes(r.body) }))
        .filter((n) => n.text)
        .sort((a, b) => compareVersions(a.version, b.version));
}

async function runPrepare(rec, inst) {
    const transport = { ...deps.transport, signal: rec.abort.signal };
    const dl = deps.download;
    const alive = () => stage.get() === rec;
    try {
        const fresh = await github.fetchRelease(rec.version, { transport, fetchJson: dl.fetchJson });
        if (!fresh) throw updateError('VERSION_UNKNOWN');
        const asset = (name) => fresh.assets.find((a) => a.name === name);
        const sums = asset(SUMS_NAME);
        const bundle = asset(BUNDLE_NAME);
        const marker = asset(markerName(rec.version));
        const file = asset(rec.assetName);
        if (!sums || !bundle || !marker) throw updateError('RELEASE_UNSIGNED');
        if (!file) throw updateError('NOT_INSTALLABLE', null, { reason: 'no_asset' });
        const small = { ...transport, maxBytes: MAX_SMALL_BYTES };
        const sumsBytes = await dl.fetchBuffer(sums.url, small);
        const bundleBytes = await dl.fetchBuffer(bundle.url, small);
        const markerBytes = await dl.fetchBuffer(marker.url, small);
        if (!alive()) return;
        setStatus({ phase: 'verifying' });
        const signed = await deps.verifier.verifySums({
            sumsBytes, bundleJson: bundleBytes, version: rec.version, markerBytes,
            tufCachePath: path.join(dataDir(), 'cache', 'sigstore')
        });
        const expected = signed.sums.get(rec.assetName);
        if (!expected) throw updateError('CHECKSUM_MISSING');
        if (!alive()) return;
        setStatus({ phase: 'downloading', bytes: 0, total: file.size || 0 });
        const got = await dl.fetchToFile(file.url, {
            ...transport,
            dest: stage.assetPath(rec),
            expectedSha256: expected,
            expectedSize: file.size,
            deadlineMs: ASSET_DEADLINE_MS,
            onProgress: (bytes, total) => setStatus({ bytes, total: total || 0 })
        });
        if (!alive()) return;
        setStatus({ phase: 'verifying' });
        deps.verifier.checkAsset(signed.sums, rec.assetName, got.sha256);
        const handle = await stage.openVerified(rec, expected);
        setStatus({ phase: 'preflight' });
        const replacing = rec.downgrade && rec.downgrade.db;
        await preflight.runPreflight({
            mode: inst.mode, file: handle, sha256: expected, assetName: rec.assetName, version: rec.version, dataDir: dataDir(),
            codeDir: inst.codeDir, execPath: inst.execPath, assetSize: got.size, workDir: rec.dir, freeBytes: deps.freeBytes,
            signal: rec.abort.signal, sourceDbBytes: replacing ? rec.downgrade.sourceDbBytes : null,
            ...(replacing ? { copyDatabase: preflight.backupDatabaseCopy(path.join(dataDir(), 'backups', replacing.source.file)) } : {}),
            ...deps.preflight
        });
        if (!alive()) return;
        stage.markVerified(rec, { sha256: got.sha256, size: got.size, signer: signed.identity, logIndex: signed.log_index, now: deps.now() });
        lock.setPhase('ready');
        setStatus({ phase: 'ready', expires_at: iso(rec.expiresAt), verified: { identity: signed.identity, log_index: signed.log_index } });
        log.info(`[Update] v${rec.version} geprüft: ${rec.assetName} sha256=${got.sha256} Signatur=${signed.identity} Log-Index=${signed.log_index}`);
    } catch (err) {
        if (!alive()) return;
        stage.discard(rec.id);
        if (lock.currentPhase() === 'preparing') lock.release();
        const summary = errorSummary(err);
        setStatus({ phase: 'failed', error: summary });
        log.warn(`[Update] Vorbereitung von v${rec.version} fehlgeschlagen: ${summary.code}`);
    }
}

/** Quick checks, then download, verification and preflight in the background; resolves { staging_id, expires_at } (plus downgrade: true for going back). */
async function prepareUpdate({ version, userId, downgrade = false } = {}) {
    const inst = installMode();
    if (!downgrade && !inst.canInstall) throw updateError('NOT_INSTALLABLE', null, { reason: inst.reason });
    if (downgrade && !config.updateDowngrade) throw downgradeRefused('disabled');
    lock.assertNoUpdate();
    if (lock.currentPhase() === 'preparing') throw updateError('UPDATE_BUSY');
    if (!parseVersion(version)) throw updateError('VERSION_UNKNOWN');
    const plan = downgrade ? downgradePlan(version) : null;
    if (!plan && compareVersions(version, pkg.version) <= 0) throw updateError('VERSION_NOT_NEWER');
    const list = await listReleases();
    let release = list.releases.find((r) => r.version === version);
    if (!release && plan) {
        const fresh = await github.fetchRelease(version, { transport: deps.transport, fetchJson: deps.download.fetchJson });
        release = fresh ? github.decorate(fresh, { current: pkg.version, assetName: inst.assetName }) : null;
    }
    if (!release) throw updateError('VERSION_UNKNOWN');
    if (plan) {
        const reason = releaseReason(release, inst);
        if (reason) throw downgradeRefused(reason);
    } else if (!release.signed) {
        throw updateError('RELEASE_UNSIGNED');
    }
    const asset = release.assets.find((a) => a.name === inst.assetName);
    if (!asset) throw updateError('NOT_INSTALLABLE', null, { reason: 'no_asset' });
    assertNoRollbackCopy(plan);
    const sourceDbBytes = plan && plan.db ? await preflight.databaseSizeInBackup(path.join(dataDir(), 'backups', plan.db.source.file)) : null;
    preflight.checkSpace({ mode: inst.mode, dataDir: dataDir(), codeDir: inst.codeDir, execPath: inst.execPath, assetSize: asset.size || 0, freeBytes: deps.freeBytes, sourceDbBytes });
    lock.begin('preparing');
    let rec;
    try {
        rec = stage.create({ dataDir: dataDir(), version, assetName: inst.assetName, userId, now: deps.now() });
    } catch (err) {
        lock.release();
        throw err;
    }
    if (plan) rec.downgrade = { ...plan, sourceDbBytes };
    status = {
        ...idleStatus(),
        phase: 'downloading',
        version,
        total: asset.size || 0,
        staging_id: rec.id,
        expires_at: iso(rec.expiresAt),
        admin_notes: adminNotesUpTo(list.releases, version),
        downgrade: Boolean(plan),
        data_loss: dataLoss(plan)
    };
    runPrepare(rec, inst);
    return { staging_id: rec.id, expires_at: iso(rec.expiresAt), ...(plan ? { downgrade: true } : {}) };
}

/** { phase, version, bytes, total, staging_id, expires_at, verified, admin_notes, error, step, downgrade, data_loss }. */
function getStatus() {
    const rec = stage.get();
    if (rec && status.phase === 'ready' && stage.isExpired(rec, deps.now())) {
        stage.discard(rec.id);
        lock.release();
        status = { ...idleStatus(), phase: 'failed', version: rec.version, error: errorSummary(updateError('STAGING_EXPIRED')) };
    }
    return { ...status, admin_notes: [...status.admin_notes] };
}

/** Discards the staging `id` (also cancels its download). With `userId`, only that user's staging. */
function discardStaging(id, { userId } = {}) {
    lock.assertNoUpdate();
    const rec = stage.get();
    if (!rec || rec.id !== id || (userId !== undefined && rec.userId !== userId)) throw updateError('STAGING_NOT_FOUND');
    stage.discard(id);
    lock.release();
    status = idleStatus();
    return { discarded: true };
}

async function runApply(rec, inst, userId, plan) {
    try {
        lock.setMaintenance(true);
        const { state } = await applyModule.prepareSwitch({
            staged: { file: stage.assetPath(rec), handle: rec.handle, sha256: rec.sha256, version: rec.version, assetName: rec.assetName },
            install: inst,
            from: pkg.version,
            dataDir: dataDir(),
            userId,
            downgrade: plan ? { undoes: plan.undoes, db: plan.db } : null,
            deps: deps.apply,
            onStep: (step) => setStatus({ step })
        });
        setStatus({ phase: 'restarting', step: null });
        log.warn(`[Update] Backup ${state.backup.file} gesichert, Wechsel auf v${state.to} beim Neustart`);
        await restart.requestRestart({ dataDir: dataDir(), codeDir: inst.codeDir, execPath: inst.execPath, ...(deps.exit ? { exit: deps.exit } : {}) });
    } catch (err) {
        lock.release();
        if (stage.get() === rec) stage.discard(rec.id);
        const summary = errorSummary(err);
        setStatus({ phase: 'failed', step: null, error: summary });
        log.error(`[Update] Installation von v${rec.version} fehlgeschlagen: ${summary.code}`, err);
    }
}

/** 409 DATA_LOSS_NOT_CONFIRMED when the staging `stagingId` of `userId` replaces the database and `acceptDataLoss` is not true. */
function assertDataLossAccepted({ stagingId, userId, acceptDataLoss } = {}) {
    const rec = stage.get();
    if (rec && rec.id === stagingId && rec.userId === userId && rec.downgrade && rec.downgrade.db && acceptDataLoss !== true) {
        throw httpOnlyError('DATA_LOSS_NOT_CONFIRMED');
    }
}

/** Checks, then backup, new code and restart in the background; returns { accepted, version, restart } (plus downgrade: true). */
function applyUpdate({ stagingId, userId, audit = {}, acceptDataLoss = false } = {}) {
    const inst = installMode();
    if (!inst.canInstall) throw updateError('NOT_INSTALLABLE', null, { reason: inst.reason });
    if (!restart.hasRestartHandler()) throw updateError('NOT_INSTALLABLE', null, { reason: 'no_restart' });
    lock.assertNoUpdate();
    if (lifecycle.runningJobs().some((name) => BLOCKING_JOBS.test(name))) throw updateError('JOB_RUNNING');
    const rec = stage.get();
    if (!rec || rec.id !== stagingId || rec.userId !== userId) throw updateError('STAGING_NOT_FOUND');
    if (!rec.verified || lock.currentPhase() !== 'ready') throw updateError('UPDATE_BUSY');
    if (stage.isExpired(rec, deps.now())) {
        stage.discard(rec.id);
        lock.release();
        status = idleStatus();
        throw updateError('STAGING_EXPIRED');
    }
    let plan = null;
    if (rec.downgrade) {
        assertDataLossAccepted({ stagingId, userId, acceptDataLoss });
        plan = downgradePlan(rec.version);
        if (plan.db && acceptDataLoss !== true) throw httpOnlyError('DATA_LOSS_NOT_CONFIRMED');
        assertNoRollbackCopy(plan);
        preflight.checkSpace({ mode: inst.mode, dataDir: dataDir(), codeDir: inst.codeDir, execPath: inst.execPath, assetSize: rec.size || 0, freeBytes: deps.freeBytes, sourceDbBytes: plan.db ? rec.downgrade.sourceDbBytes : null });
    }
    lock.begin('applying');
    setStatus({ phase: 'applying', error: null, step: null });
    log.warn(`[Update] Installation v${pkg.version} → v${rec.version}${plan ? ' (zurück)' : ''} durch ${audit.username || userId} (${audit.authScheme || '-'}, ${audit.ip || '-'}): ${rec.assetName} sha256=${rec.sha256} Signatur=${rec.signer} Log-Index=${rec.logIndex}`);
    runApply(rec, inst, userId, plan);
    return { accepted: true, version: rec.version, restart: inst.restart, ...(plan ? { downgrade: true } : {}) };
}

/** Backup file the update still needs (keep it out of pruning and DELETE /backups/:filename), or null. */
const heldBackup = () => stateFile.heldBackup(dataDir());

/** { hold, anchor } (state.heldBackups for this version and its version record), or null while state.js lacks it. */
function heldBackups() {
    if (!stateReady()) return null;
    return stateFile.heldBackups(dataDir(), { version: pkg.version, record: versionRecord() });
}

/** { from, to, at, result, error, backup, direction } of the last update, or null. */
const lastResult = () => stateFile.lastResult(dataDir());

/** Start-up sweep of leftover staging folders (temp/update/*). */
const sweepStaging = () => (lock.isBusy() ? 0 : stage.sweep(dataDir()));

/** The newest release in the cache without a network call (for the daily update notice), or null. */
const cachedLatest = () => github.cachedLatest(dataDir());

/** For tests: replace downloads, verifier, install mode, data folder, clock, preflight/apply dependencies, database, exit. */
function configureForTests(overrides = {}) {
    deps = { ...deps, ...overrides };
    if (overrides.installMode) install = overrides.installMode;
}

function resetForTests() {
    deps = DEFAULT_DEPS();
    install = null;
    windowsAcl = null;
    targetFetch = null;
    hashCache.clear();
    status = idleStatus();
    stage.reset();
    lock.reset();
    restart.reset();
    github.resetCache();
}

module.exports = {
    detectInstallMode,
    installMode,
    useWindowsAcl,
    listReleases,
    refreshReleases,
    prepareUpdate,
    getStatus,
    discardStaging,
    applyUpdate,
    assertDataLossAccepted,
    rollbackInfo,
    rollbackFetch,
    lock,
    isUpdateRunning: lock.isUpdateRunning,
    maintenanceGuard: lock.maintenanceGuard,
    registerRestart: restart.registerRestart,
    requestRestart: restart.requestRestart,
    hasRestartHandler: restart.hasRestartHandler,
    heldBackup,
    heldBackups,
    lastResult,
    sweepStaging,
    abortDownloads: download.abortAll,
    cachedLatest,
    adminNotes: github.adminNotes,
    updateError,
    UPDATE_TEXTS,
    configureForTests,
    resetForTests
};
