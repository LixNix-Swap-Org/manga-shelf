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
const { parseVersion, compareVersions } = require('./version');
const { updateError, errorSummary, UPDATE_TEXTS } = require('./errors');
const { SUMS_NAME, BUNDLE_NAME, markerName, MAX_SMALL_BYTES } = require('./constants');

const ASSET_DEADLINE_MS = 60 * 60 * 1000;
const BLOCKING_JOBS = /Snapshot|Wiederherstellung/;

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
    exit: undefined
});

let deps = DEFAULT_DEPS();
let install = null;
let windowsAcl = null;

const idleStatus = () => ({
    phase: 'idle', version: null, bytes: 0, total: 0, staging_id: null, expires_at: null,
    verified: null, admin_notes: [], error: null, step: null
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

/** Releases newest first with signed / installable / reason for this server, plus fetched_at, error, next_try_at. */
async function listReleases({ force = false } = {}) {
    const inst = installMode();
    const list = await github.listReleases({ dataDir: dataDir(), force, now: deps.now(), transport: deps.transport, fetchJson: deps.download.fetchJson });
    return { ...list, releases: list.releases.map((r) => github.decorate(r, { current: pkg.version, assetName: inst.assetName })) };
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
        await preflight.runPreflight({
            mode: inst.mode, file: handle, sha256: expected, assetName: rec.assetName, version: rec.version, dataDir: dataDir(),
            codeDir: inst.codeDir, execPath: inst.execPath, assetSize: got.size, workDir: rec.dir, freeBytes: deps.freeBytes,
            signal: rec.abort.signal, ...deps.preflight
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

/** Quick checks, then download, verification and preflight in the background; resolves { staging_id, expires_at }. */
async function prepareUpdate({ version, userId } = {}) {
    const inst = installMode();
    if (!inst.canInstall) throw updateError('NOT_INSTALLABLE', null, { reason: inst.reason });
    lock.assertNoUpdate();
    if (lock.currentPhase() === 'preparing') throw updateError('UPDATE_BUSY');
    if (!parseVersion(version)) throw updateError('VERSION_UNKNOWN');
    if (compareVersions(version, pkg.version) <= 0) throw updateError('VERSION_NOT_NEWER');
    const list = await listReleases();
    const release = list.releases.find((r) => r.version === version);
    if (!release) throw updateError('VERSION_UNKNOWN');
    if (!release.signed) throw updateError('RELEASE_UNSIGNED');
    const asset = release.assets.find((a) => a.name === inst.assetName);
    if (!asset) throw updateError('NOT_INSTALLABLE', null, { reason: 'no_asset' });
    preflight.checkSpace({ mode: inst.mode, dataDir: dataDir(), codeDir: inst.codeDir, execPath: inst.execPath, assetSize: asset.size || 0, freeBytes: deps.freeBytes });
    lock.begin('preparing');
    let rec;
    try {
        rec = stage.create({ dataDir: dataDir(), version, assetName: inst.assetName, userId, now: deps.now() });
    } catch (err) {
        lock.release();
        throw err;
    }
    status = {
        ...idleStatus(),
        phase: 'downloading',
        version,
        total: asset.size || 0,
        staging_id: rec.id,
        expires_at: iso(rec.expiresAt),
        admin_notes: adminNotesUpTo(list.releases, version)
    };
    runPrepare(rec, inst);
    return { staging_id: rec.id, expires_at: iso(rec.expiresAt) };
}

/** { phase, version, bytes, total, staging_id, expires_at, verified, admin_notes, error, step }. */
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

async function runApply(rec, inst, userId) {
    try {
        lock.setMaintenance(true);
        const { state } = await applyModule.prepareSwitch({
            staged: { file: stage.assetPath(rec), handle: rec.handle, sha256: rec.sha256, version: rec.version, assetName: rec.assetName },
            install: inst,
            from: pkg.version,
            dataDir: dataDir(),
            userId,
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

/** Checks, then backup, new code and restart in the background; returns { accepted, version, restart }. */
function applyUpdate({ stagingId, userId, audit = {} } = {}) {
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
    lock.begin('applying');
    setStatus({ phase: 'applying', error: null, step: null });
    log.warn(`[Update] Installation v${pkg.version} → v${rec.version} durch ${audit.username || userId} (${audit.authScheme || '-'}, ${audit.ip || '-'}): ${rec.assetName} sha256=${rec.sha256} Signatur=${rec.signer} Log-Index=${rec.logIndex}`);
    runApply(rec, inst, userId);
    return { accepted: true, version: rec.version, restart: inst.restart };
}

/** Backup file the update still needs (keep it out of pruning and DELETE /backups/:filename), or null. */
const heldBackup = () => stateFile.heldBackup(dataDir());

/** { from, to, at, result, error, backup } of the last update, or null. */
const lastResult = () => stateFile.lastResult(dataDir());

/** Start-up sweep of leftover staging folders (temp/update/*). */
const sweepStaging = () => (lock.isBusy() ? 0 : stage.sweep(dataDir()));

/** The newest release in the cache without a network call (for the daily update notice), or null. */
const cachedLatest = () => github.cachedLatest(dataDir());

/** For tests: replace downloads, verifier, install mode, data folder, clock, preflight/apply dependencies, exit. */
function configureForTests(overrides = {}) {
    deps = { ...deps, ...overrides };
    if (overrides.installMode) install = overrides.installMode;
}

function resetForTests() {
    deps = DEFAULT_DEPS();
    install = null;
    windowsAcl = null;
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
    lock,
    isUpdateRunning: lock.isUpdateRunning,
    maintenanceGuard: lock.maintenanceGuard,
    registerRestart: restart.registerRestart,
    requestRestart: restart.requestRestart,
    hasRestartHandler: restart.hasRestartHandler,
    heldBackup,
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
