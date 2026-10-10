process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyReleaseDir } = require('../../scripts/release/verify-bundle');
const verify = require('../../services/update/verify');
const h = require('../fixtures/update/helpers');

const root = h.tmpDir();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function releaseDir({ bundle } = {}) {
    const dir = path.join(root, `r-${n++}`);
    fs.mkdirSync(dir);
    const r = h.makeRelease('3.2.0', { 'pterodactyl-manga-shelf.zip': Buffer.from('zip'), 'manga-shelf-server-linux-x64': Buffer.from('bin') });
    for (const [name, data] of Object.entries(r.files)) fs.writeFileSync(path.join(dir, name), data);
    fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), r.sumsBytes);
    fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt.sigstore.json'), JSON.stringify(bundle || h.makeBundle(r.sumsBytes)));
    return dir;
}

const seen = [];
const verifier = verify.createVerifier({ verifyBundle: async (bundle, payload, options) => { seen.push(options); return h.goodSigner(); } });

test('verify before publish: the shipped verifier accepts the fresh signature and every file matches', async () => {
    const r = await verifyReleaseDir(releaseDir(), { verifier, tufCachePath: '/tmp/tuf' });
    assert.deepEqual(r, { version: '3.2.0', identity: 'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main', log_index: '123456', files: 3 });
    assert.equal(seen.at(-1).tufCachePath, '/tmp/tuf');
    assert.deepEqual(seen.at(-1).policy, verify.PRODUCTION_POLICY);
});

test('a changed file, a second marker or a DSSE bundle fail the job', async () => {
    const changed = releaseDir();
    fs.writeFileSync(path.join(changed, 'manga-shelf-server-linux-x64'), 'other');
    await assert.rejects(verifyReleaseDir(changed, { verifier }), /Prüfsumme falsch: manga-shelf-server-linux-x64/);
    const two = releaseDir();
    fs.writeFileSync(path.join(two, 'manga-shelf-release-v3.1.0.json'), '{"version":"3.1.0"}');
    await assert.rejects(verifyReleaseDir(two, { verifier }), /Genau eine Versionsmarke/);
    const empty = releaseDir();
    fs.writeFileSync(path.join(empty, 'manga-shelf-release-v.json'), '{}');
    await assert.rejects(verifyReleaseDir(empty, { verifier }), /Genau eine Versionsmarke/);
    const dsse = releaseDir({ bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', dsseEnvelope: {} } });
    await assert.rejects(verifyReleaseDir(dsse, { verifier }), (e) => e.code === 'BUNDLE_FORMAT');
});

test('command line: usage error exits 2', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'release', 'verify-bundle.js')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Aufruf: node scripts\/release\/verify-bundle\.js <ordner>/);
});
