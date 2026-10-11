process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ownData = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-rollback-'));
process.env.DATA_DIR = ownData;
const { DatabaseSync } = require('node:sqlite');
const update = require('../../services/update');
const verify = require('../../services/update/verify');
const stateFile = require('../../services/update/state');
const pkg = require('../../package.json');
const h = require('../fixtures/update/helpers');

const TARGET = '3.1.0';
const ZIP_NAME = 'pterodactyl-manga-shelf.zip';
const DL = 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/download/';
const SOURCE = `vor-update-v${TARGET}-auf-v${pkg.version}-2026-10-01T10-00-00-000Z.zip`;
const LOCK = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/express': { version: '5.2.1', integrity: 'sha512-a' } } });
const ZIP = h.makeZip([
    { name: 'package.json', data: JSON.stringify({ version: TARGET, engines: { node: '>=22.13.0' }, files: ['index.js', 'db.js'] }) },
    { name: 'package-lock.json', data: LOCK },
    { name: 'index.js', data: 'module.exports = "older";\n' },
    { name: 'db.js', data: 'module.exports = 1;\n' }
]);
const release = h.makeRelease(TARGET, { [ZIP_NAME]: ZIP });
const BUNDLE = Buffer.from(JSON.stringify(h.makeBundle(release.sumsBytes)));

const root = h.tmpDir();
test.after(() => {
    update.resetForTests();
    const cached = require.cache[require.resolve('../../db')];
    if (cached) cached.exports.closeDb();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(ownData, { recursive: true, force: true });
});
let n = 0;

const asset = (v, name, size = 10) => ({ name, size, browser_download_url: `${DL}v${v}/${name}` });
const rawRelease = (v, { signed = true, zip = true } = {}) => ({
    tag_name: `v${v}`, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', body: '',
    assets: [
        ...(signed ? [asset(v, 'SHA256SUMS.txt'), asset(v, 'SHA256SUMS.txt.sigstore.json'), asset(v, `manga-shelf-release-v${v}.json`)] : []),
        ...(zip ? [asset(v, ZIP_NAME, ZIP.length)] : [])
    ]
});

function makeDb(file, schema, marker) {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY); CREATE TABLE marker (v TEXT); CREATE TABLE users (id INTEGER PRIMARY KEY, password_changed_at INTEGER)');
    for (let v = 1; v <= schema; v++) db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(v);
    db.prepare('INSERT INTO marker (v) VALUES (?)').run(marker);
    db.prepare('INSERT INTO users (id, password_changed_at) VALUES (1, 5)').run();
    db.close();
}

const markerOf = (file) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT v FROM marker').get().v; } finally { db.close(); }
};

function setup({ list = [rawRelease('9.1.0'), rawRelease(TARGET)], schemaNow = 27, journal = {}, install = {}, settings = {} } = {}) {
    update.resetForTests();
    const dir = path.join(root, `r-${n++}`);
    const codeDir = path.join(dir, 'code');
    const dataDir = path.join(dir, 'data');
    const backups = path.join(dataDir, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    fs.mkdirSync(codeDir, { recursive: true });
    fs.writeFileSync(path.join(codeDir, 'package.json'), JSON.stringify({ version: pkg.version, files: ['index.js', 'db.js'] }));
    fs.writeFileSync(path.join(codeDir, 'package-lock.json'), LOCK);
    fs.writeFileSync(path.join(codeDir, 'index.js'), 'module.exports = "newer";\n');
    fs.writeFileSync(path.join(codeDir, 'db.js'), 'module.exports = 0;\n');
    const sourceDb = path.join(dir, 'source.db');
    makeDb(sourceDb, 27, 'before the update');
    const sourceZip = h.makeZip([{ name: 'manga.db', data: fs.readFileSync(sourceDb) }]);
    fs.writeFileSync(path.join(backups, SOURCE), sourceZip);
    const sourceSha = h.sha256hex(sourceZip);
    makeDb(path.join(dataDir, 'manga.db'), schemaNow, 'live');
    if (journal !== null) {
        stateFile.writeState(dataDir, {
            phase: 'confirmed', mode: 'pterodactyl', restart: 'pterodactyl', from: TARGET, to: pkg.version, at: '2026-10-01T10:00:00.000Z', user: 1, pid: 1,
            schema_before: 27, backup: { file: SOURCE, sha256: sourceSha }, previous: { sha256: 'a'.repeat(64) }, attempts: 0, code_dir: codeDir,
            finished_at: '2026-10-01T10:10:00.000Z', ...journal
        });
    }
    const calls = [];
    const holds = [];
    const exits = [];
    const files = { 'SHA256SUMS.txt': release.sumsBytes, 'SHA256SUMS.txt.sigstore.json': BUNDLE, [release.markerName]: release.markerBytes };
    update.configureForTests({
        dataDir,
        installMode: { mode: 'pterodactyl', canInstall: true, reason: null, supervisor: 'wings', codeDir, execPath: process.execPath, assetName: ZIP_NAME, restart: 'pterodactyl', ...install },
        download: {
            fetchJson: async (url) => {
                calls.push(url);
                if (url.includes('/releases/tags/')) return rawRelease(/v(\d+\.\d+\.\d+)$/.exec(url)[1]);
                return list;
            },
            fetchBuffer: async (url) => files[path.basename(url)],
            fetchToFile: async (url, { dest, onProgress }) => {
                fs.writeFileSync(dest, ZIP);
                onProgress(ZIP.length, ZIP.length);
                return { sha256: h.sha256hex(ZIP), size: ZIP.length };
            }
        },
        verifier: verify.createVerifier({ verifyBundle: async () => h.goodSigner() }),
        freeBytes: () => 1e12,
        database: { schemaVersion: () => schemaNow, setting: (key) => settings[key] },
        apply: {
            backupsDir: backups,
            schemaVersion: () => schemaNow,
            holdSnapshot: (name) => {
                holds.push(name);
                return () => holds.push(`released ${name}`);
            },
            createBackupSnapshot: async (prefix) => {
                holds.push(`snapshot ${prefix}`);
                const filename = `${prefix}-2026-10-11T10-00-00-000Z.zip`;
                fs.writeFileSync(path.join(backups, filename), 'fresh backup');
                return { filename, verified: true };
            }
        },
        exit: (code) => exits.push(code)
    });
    return { dir, codeDir, dataDir, backups, sourceSha, calls, holds, exits };
}

async function until(fn) {
    for (let i = 0; i < 500; i++) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timed out');
}

const refused = (reason) => (err) => {
    assert.equal(err.code, 'DOWNGRADE_NOT_AVAILABLE');
    assert.equal(err.status, 409);
    assert.equal(err.message, 'Zurück zu dieser Version ist auf diesem Server nicht möglich.');
    assert.deepEqual(err.extra, { reason });
    return true;
};
const prepareBack = (version = TARGET) => update.prepareUpdate({ version, userId: 1, downgrade: true });
const copyPending = (dataDir) => (err) => {
    assert.equal(err.code, 'ROLLBACK_COPY_PENDING');
    assert.equal(err.status, 503);
    assert.equal(err.extra.params.path, path.join(dataDir, 'manga.db.bak'));
    assert.match(err.message, /^Eine frühere Wiederherstellung wurde nicht sauber abgeschlossen\./);
    return true;
};

test('update.rollback: the version before the last update with schema, backup and since; pending until the release is known', async () => {
    const w = setup();
    const expected = {
        version: TARGET, current: pkg.version, method: 'download', schema: { then: 27, now: 27, changed: false },
        backup: { file: SOURCE, at: '2026-10-01T10:00:00.000Z', present: true }, since: '2026-10-01T10:00:00.000Z'
    };
    assert.deepEqual(update.rollbackInfo({ view: null }), { ...expected, available: false, reason: null });
    const view = await update.listReleases();
    assert.equal(view.releases.find((r) => r.version === TARGET).rollback, true);
    assert.equal(view.releases.find((r) => r.version === TARGET).reason, 'older');
    assert.equal('rollback' in view.releases.find((r) => r.version === '9.1.0'), false);
    assert.deepEqual(update.rollbackInfo({ view }), { ...expected, available: true, reason: null });
    assert.deepEqual(update.rollbackInfo({ view: { ...view, error: 'RATE_LIMITED' } }), { ...expected, available: false, reason: null });

    setup({ list: [rawRelease('9.1.0')] });
    const outside = await update.listReleases();
    assert.equal(update.rollbackInfo({ view: outside }).reason, null);
    assert.equal(update.rollbackInfo({ view: outside }).available, false, 'the target is fetched in the background');
    await update.rollbackFetch();
    assert.equal(update.rollbackInfo({ view: outside }).available, true);
    assert.equal(w.calls.length > 0, true);
});

test('prepare { downgrade: true } refuses with each reason in order', async () => {
    process.env.UPDATE_DOWNGRADE = 'false';
    try {
        setup();
        await assert.rejects(prepareBack(), refused('disabled'));
        assert.equal(update.rollbackInfo({ view: null }), null, 'UPDATE_DOWNGRADE=false hides it');
    } finally {
        delete process.env.UPDATE_DOWNGRADE;
    }
    setup({ install: { canInstall: false, reason: 'docker', mode: 'docker' } });
    await assert.rejects(prepareBack(), refused('mode'));
    setup({ journal: { code_dir: '/elsewhere' } });
    await assert.rejects(prepareBack(), refused('mode'));
    setup({ journal: null });
    await assert.rejects(prepareBack(), refused('no_update'));
    setup({ journal: { phase: 'rolled_back', from: pkg.version, to: TARGET, downgrade: { undoes: { from: TARGET, to: pkg.version, at: 'x', backup: null, schema_before: 27 }, db: null } } });
    await assert.rejects(prepareBack(), refused('already_downgraded'));
    assert.equal(update.rollbackInfo({ view: null }).reason, 'already_downgraded');
    setup();
    await assert.rejects(prepareBack('3.0.9'), refused('not_previous'));
    setup({ journal: { from: '3.0.0' } });
    await assert.rejects(prepareBack('3.0.0'), refused('too_old'));
    const missing = setup({ schemaNow: 28 });
    fs.unlinkSync(path.join(missing.backups, SOURCE));
    await assert.rejects(prepareBack(), refused('backup_missing'));
    const changed = setup({ schemaNow: 28 });
    fs.appendFileSync(path.join(changed.backups, SOURCE), 'x');
    await assert.rejects(prepareBack(), refused('backup_changed'));
    setup({ list: [rawRelease(TARGET, { signed: false })] });
    await assert.rejects(prepareBack(), refused('unsigned'));
    setup({ list: [rawRelease(TARGET, { zip: false })] });
    await assert.rejects(prepareBack(), refused('no_asset'));
    assert.equal(update.getStatus().phase, 'idle');
    assert.equal(update.lock.isBusy(), false);
});

test('a downgrade that replaces the database is refused while manga.db.bak exists, at prepare and at apply', async () => {
    const w = setup({ schemaNow: 28 });
    const bak = path.join(w.dataDir, 'manga.db.bak');
    fs.writeFileSync(bak, 'stale');
    await assert.rejects(prepareBack(), copyPending(w.dataDir));
    assert.equal(update.getStatus().phase, 'idle');
    assert.equal(update.lock.isBusy(), false);

    const same = setup({ schemaNow: 27 });
    fs.writeFileSync(path.join(same.dataDir, 'manga.db.bak'), 'stale');
    assert.equal((await prepareBack()).downgrade, true, 'a downgrade that keeps the database is not affected');
    await until(() => update.getStatus().phase === 'ready' || update.getStatus().phase === 'failed');

    const late = setup({ schemaNow: 28 });
    const started = await prepareBack();
    await until(() => update.getStatus().phase === 'ready' || update.getStatus().phase === 'failed');
    assert.equal(update.getStatus().phase, 'ready', JSON.stringify(update.getStatus().error));
    update.registerRestart(async () => {});
    fs.writeFileSync(path.join(late.dataDir, 'manga.db.bak'), 'stale');
    const journal = fs.readFileSync(path.join(late.dataDir, 'update-state.json'), 'utf8');
    assert.throws(() => update.applyUpdate({ stagingId: started.staging_id, userId: 1, acceptDataLoss: true }), copyPending(late.dataDir));
    assert.equal(fs.readFileSync(path.join(late.dataDir, 'update-state.json'), 'utf8'), journal);
    assert.deepEqual(late.exits, []);
    assert.equal(markerOf(path.join(late.dataDir, 'manga.db')), 'live');
});

test('without the 3.3.0 exports of state.js (Pterodactyl swap window) there is no rollback, prepare says mode and holds fall back', async () => {
    setup();
    const saved = stateFile.heldBackups;
    delete stateFile.heldBackups;
    try {
        assert.equal(update.rollbackInfo({ view: null }), null);
        await assert.rejects(prepareBack(), refused('mode'));
        assert.equal(update.heldBackups(), null);
    } finally {
        stateFile.heldBackups = saved;
    }
});

test('a target outside the cached list is read with fetchRelease; prepare → apply journals the downgrade with the original backup held', async () => {
    const w = setup({ list: [rawRelease('9.1.0')], schemaNow: 28 });
    const started = await prepareBack();
    assert.equal(started.downgrade, true);
    assert.ok(w.calls.some((url) => url.endsWith(`/releases/tags/v${TARGET}`)));
    await until(() => update.getStatus().phase === 'ready' || update.getStatus().phase === 'failed');
    const status = update.getStatus();
    assert.equal(status.phase, 'ready', JSON.stringify(status.error));
    assert.equal(status.downgrade, true);
    assert.deepEqual(status.data_loss, { backup: SOURCE, at: '2026-10-01T10:00:00.000Z', schema_then: 27, schema_now: 28 });

    let shutdowns = 0;
    update.registerRestart(async () => {
        shutdowns++;
        const cached = require.cache[require.resolve('../../db')];
        if (cached) cached.exports.closeDb();
    });
    assert.throws(() => update.assertDataLossAccepted({ stagingId: started.staging_id, userId: 1, acceptDataLoss: false }), (e) => e.code === 'DATA_LOSS_NOT_CONFIRMED' && e.status === 409);
    assert.doesNotThrow(() => update.assertDataLossAccepted({ stagingId: started.staging_id, userId: 2, acceptDataLoss: false }), 'only for the own staging');
    assert.throws(() => update.applyUpdate({ stagingId: started.staging_id, userId: 1 }), (e) => e.code === 'DATA_LOSS_NOT_CONFIRMED');
    const accepted = update.applyUpdate({ stagingId: started.staging_id, userId: 1, acceptDataLoss: true });
    assert.deepEqual(accepted, { accepted: true, version: TARGET, restart: 'pterodactyl', downgrade: true });
    await until(() => w.exits.length === 1);
    assert.deepEqual(w.exits, [75]);
    assert.equal(shutdowns, 1);
    const fresh = `vor-update-v${pkg.version}-auf-v${TARGET}-2026-10-11T10-00-00-000Z.zip`;
    assert.deepEqual(w.holds.slice(0, 2), [SOURCE, `snapshot vor-update-v${pkg.version}-auf-v${TARGET}`], 'the original backup is held before the fresh snapshot');
    const s = stateFile.readState(w.dataDir);
    assert.deepEqual([s.phase, s.from, s.to, s.schema_before, s.backup.file], ['swapped', pkg.version, TARGET, 28, fresh]);
    assert.deepEqual(s.downgrade.undoes, { from: TARGET, to: pkg.version, at: '2026-10-01T10:00:00.000Z', backup: { file: SOURCE, sha256: w.sourceSha }, schema_before: 27 });
    assert.deepEqual(s.downgrade.db.source, { file: SOURCE, sha256: w.sourceSha });
    assert.equal(s.downgrade.db.schema, 27);
    assert.ok(s.downgrade.db.replaced_at);
    assert.equal(markerOf(path.join(w.dataDir, 'manga.db')), 'before the update');
    assert.equal(markerOf(path.join(w.dataDir, s.downgrade.db.kept)), 'live');
    assert.equal(fs.readFileSync(path.join(w.codeDir, 'index.js'), 'utf8'), 'module.exports = "older";\n');
    assert.equal(stateFile.lastResult(w.dataDir), null, 'swapped is not a result yet');
    assert.deepEqual(stateFile.heldBackups(w.dataDir, { version: pkg.version }), { hold: [fresh, SOURCE], anchor: null });
});

test('a downgrade that failed before its switch keeps the way back: offered again from downgrade.undoes and preparable', async () => {
    const w = setup({ schemaNow: 28 });
    const undoes = { from: TARGET, to: pkg.version, at: '2026-10-01T10:00:00.000Z', backup: { file: SOURCE, sha256: w.sourceSha }, schema_before: 27 };
    stateFile.writeState(w.dataDir, {
        phase: 'failed', error: 'UPDATE_FAILED', mode: 'pterodactyl', restart: 'pterodactyl', from: pkg.version, to: TARGET, at: '2026-10-11T10:00:00.000Z',
        user: 1, pid: 1, schema_before: 28, backup: { file: 'vor-update-x.zip', sha256: 'd'.repeat(64) }, previous: { sha256: 'a'.repeat(64) }, attempts: 0,
        code_dir: w.codeDir, finished_at: '2026-10-11T10:01:00.000Z',
        downgrade: { undoes, db: { source: undoes.backup, schema: 27, replaced_at: null, kept: null, returned_at: null } }
    });
    const view = await update.listReleases();
    const info = update.rollbackInfo({ view });
    assert.deepEqual([info.version, info.available, info.reason, info.since, info.schema.changed], [TARGET, true, null, undoes.at, true]);
    assert.equal(stateFile.lastResult(w.dataDir).direction, 'downgrade');
    assert.deepEqual(update.heldBackups(), { hold: [], anchor: SOURCE });
    assert.equal((await prepareBack()).downgrade, true);

    stateFile.patchState(w.dataDir, { swapped_at: '2026-10-11T10:00:30.000Z' });
    update.resetForTests();
    setupKeep(w);
    assert.equal(update.rollbackInfo({ view }).reason, 'already_downgraded', 'a downgrade that switched ends the way back');
});

function setupKeep(w) {
    update.configureForTests({
        dataDir: w.dataDir,
        installMode: { mode: 'pterodactyl', canInstall: true, reason: null, codeDir: w.codeDir, assetName: ZIP_NAME, restart: 'pterodactyl' },
        database: { schemaVersion: () => 28, setting: () => undefined }
    });
}

test('instruction modes: going back comes from the version record, with its backup and reasons', () => {
    const record = (current, previous) => ({ app_version: JSON.stringify(current), app_version_previous: previous ? JSON.stringify(previous) : undefined });
    const docker = { mode: 'docker', canInstall: false, reason: 'docker' };
    const snapshot = 'vor-update-v27-auf-v28-2026-10-11T09-00-00-000Z.zip';
    const w = setup({ journal: null, install: docker, schemaNow: 28, settings: record({ version: pkg.version, schema: 28, since: '2026-10-11T09:00:01.000Z', backup: { file: snapshot, sha256: 'e'.repeat(64) } }, { version: TARGET, schema: 27, since: 'x', backup: null }) });
    assert.deepEqual(update.rollbackInfo({ view: null }), {
        version: TARGET, current: pkg.version, available: false, reason: 'backup_missing', method: 'instructions',
        schema: { then: 27, now: 28, changed: true }, backup: { file: snapshot, at: '2026-10-11T09:00:00.000Z', present: false }, since: '2026-10-11T09:00:01.000Z'
    });
    fs.writeFileSync(path.join(w.backups, snapshot), 'snapshot');
    assert.equal(update.rollbackInfo({ view: null }).reason, 'backup_changed');
    assert.deepEqual(update.heldBackups(), { hold: [], anchor: snapshot });

    setup({ journal: null, install: docker, schemaNow: 27, settings: record({ version: pkg.version, schema: 27, since: 's', backup: null }, { version: TARGET, schema: 27 }) });
    const same = update.rollbackInfo({ view: null });
    assert.deepEqual([same.available, same.reason, same.backup, same.schema.changed], [true, null, null, false]);

    setup({ journal: null, install: docker, schemaNow: 28, settings: record({ version: pkg.version, schema: 28, since: 's', backup: null }, { version: TARGET, schema: 27 }) });
    assert.equal(update.rollbackInfo({ view: null }).reason, 'backup_missing', 'the schema changed and no snapshot was recorded');
    setup({ journal: null, install: docker, settings: record({ version: pkg.version, schema: 27, since: 's', backup: null }, { version: '3.0.0', schema: 27 }) });
    assert.equal(update.rollbackInfo({ view: null }).reason, 'too_old');
    setup({ journal: null, install: docker, settings: record({ version: pkg.version, schema: 27, since: 's', backup: null }) });
    assert.equal(update.rollbackInfo({ view: null }), null, 'only app_version: nothing known before');
});

test('the two HTTP-only codes never become a state or status code of their own', () => {
    const { errorSummary, httpOnlyError, UPDATE_TEXTS } = require('../../services/update/errors');
    for (const code of ['DOWNGRADE_NOT_AVAILABLE', 'DATA_LOSS_NOT_CONFIRMED']) {
        assert.equal(code in UPDATE_TEXTS, false);
        assert.deepEqual(errorSummary(httpOnlyError(code, { reason: 'mode' })), { code: 'UPDATE_FAILED', message: UPDATE_TEXTS.UPDATE_FAILED });
    }
});
