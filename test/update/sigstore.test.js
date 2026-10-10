process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const verify = require('../../services/update/verify');
const C = require('../../services/update/constants');
const h = require('../fixtures/update/helpers');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'update', 'release');
const markers = fs.existsSync(FIXTURE) ? fs.readdirSync(FIXTURE).filter((n) => /^manga-shelf-release-v.+\.json$/.test(n)) : [];
const present = markers.length === 1 && ['SHA256SUMS.txt', 'SHA256SUMS.txt.sigstore.json'].every((f) => fs.existsSync(path.join(FIXTURE, f)));

test('the real sigstore verifier accepts the published release signature', { skip: present ? false : 'no fixture in test/fixtures/update/release' }, async (t) => {
    const markerBytes = fs.readFileSync(path.join(FIXTURE, markers[0]));
    const version = JSON.parse(markerBytes.toString('utf8')).version;
    const tufCachePath = h.tmpDir('manga-shelf-tuf-');
    t.after(() => fs.rmSync(tufCachePath, { recursive: true, force: true }));
    let result;
    try {
        result = await verify.verifySums({
            sumsBytes: fs.readFileSync(path.join(FIXTURE, 'SHA256SUMS.txt')),
            bundleJson: fs.readFileSync(path.join(FIXTURE, 'SHA256SUMS.txt.sigstore.json')),
            version,
            markerBytes,
            tufCachePath
        });
    } catch (err) {
        if (err.code === 'SIGSTORE_TRUST_UNAVAILABLE') return t.skip('no network for the Sigstore trust root');
        throw err;
    }
    assert.equal(result.identity, 'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main');
    assert.match(result.log_index, /^\d+$/);
    await assert.rejects(verify.verifySums({
        sumsBytes: Buffer.concat([fs.readFileSync(path.join(FIXTURE, 'SHA256SUMS.txt')), Buffer.from('\n')]),
        bundleJson: fs.readFileSync(path.join(FIXTURE, 'SHA256SUMS.txt.sigstore.json')),
        version,
        markerBytes,
        tufCachePath
    }), (e) => e.code === 'SIGNATURE_INVALID' || e.code === 'BUNDLE_FORMAT');
});

function shippedTrustRoot() {
    const tufPath = require.resolve('@sigstore/tuf', { paths: [path.dirname(require.resolve('sigstore'))] });
    const seeds = JSON.parse(fs.readFileSync(path.join(path.dirname(tufPath), '..', 'seeds.json'), 'utf8'));
    const json = JSON.parse(Buffer.from(seeds['https://tuf-repo-cdn.sigstore.dev'].targets['trusted_root.json'], 'base64').toString('utf8'));
    const { TrustedRoot } = require(require.resolve('@sigstore/protobuf-specs', { paths: [path.dirname(tufPath)] }));
    return { tuf: require(tufPath), json, TrustedRoot };
}

function completeBundle(sumsBytes, logKeyId) {
    const bundle = h.makeBundle(sumsBytes);
    const body = {
        apiVersion: '0.0.1',
        kind: 'hashedrekord',
        spec: {
            data: { hash: { algorithm: 'sha256', value: crypto.createHash('sha256').update(sumsBytes).digest('hex') } },
            signature: { content: bundle.messageSignature.signature, publicKey: { content: Buffer.from('key').toString('base64') } }
        }
    };
    bundle.verificationMaterial.tlogEntries = [{
        logIndex: '123456',
        logId: { keyId: logKeyId },
        kindVersion: { kind: 'hashedrekord', version: '0.0.1' },
        integratedTime: '1760000000',
        inclusionPromise: { signedEntryTimestamp: Buffer.from('set').toString('base64') },
        inclusionProof: {
            logIndex: '123456',
            rootHash: Buffer.alloc(32, 1).toString('base64'),
            treeSize: '200000',
            hashes: [Buffer.alloc(32, 2).toString('base64')],
            checkpoint: { envelope: 'rekor.sigstore.dev - 1\n200000\nAQEB\n\n— rekor.sigstore.dev abc=\n' }
        },
        canonicalizedBody: Buffer.from(JSON.stringify(body)).toString('base64')
    }];
    return bundle;
}

test('the real sigstore verifier, offline with its shipped trust root, takes the production options and refuses a certificate Fulcio never issued', async (t) => {
    const { tuf, json, TrustedRoot } = shippedTrustRoot();
    let tufOptions = null;
    t.mock.method(tuf, 'getTrustedRoot', async (options) => {
        tufOptions = options;
        return TrustedRoot.fromJSON(json);
    });
    const release = h.makeRelease('3.2.0', { 'pterodactyl-manga-shelf.zip': Buffer.from('zip') });
    const bundle = completeBundle(release.sumsBytes, json.tlogs[0].logId.keyId);
    assert.doesNotThrow(() => verify.checkFormat(bundle, release.sumsBytes), 'the bundle passes the format gate');
    await assert.rejects(verify.sigstoreVerifyBundle(bundle, release.sumsBytes, { policy: verify.PRODUCTION_POLICY, tufCachePath: '/nonexistent/tuf' }), (err) => {
        assert.equal(err.code, 'SIGNATURE_INVALID');
        assert.equal(err.cause.name, 'VerificationError');
        assert.equal(err.cause.code, 'CERTIFICATE_ERROR');
        return true;
    });
    assert.equal(tufOptions.cachePath, '/nonexistent/tuf');
});

const opensslPresent = h.opensslCert({ san: 'https://example.org' }) !== null;
const openssl = { skip: opensslPresent ? false : 'openssl is not available' };

test('a real certificate of another repository is refused; its Fulcio extensions read as written by openssl', openssl, () => {
    const { X509Certificate } = require('@sigstore/core');
    const foreign = h.opensslCert({
        san: 'https://github.com/octo-org/other-repo/.github/workflows/release.yml@refs/heads/main',
        extensions: { ...C.FULCIO_PINS, '1.3.6.1.4.1.57264.1.12': 'https://github.com/octo-org/other-repo', '1.3.6.1.4.1.57264.1.15': '42' }
    });
    const cert = X509Certificate.parse(foreign);
    assert.equal(verify.derString(cert.extension('1.3.6.1.4.1.57264.1.12').value), 'https://github.com/octo-org/other-repo');
    assert.equal(verify.derString(cert.extension('1.3.6.1.4.1.57264.1.14').value), 'refs/heads/main');
    assert.throws(() => verify.checkIdentity(h.goodSigner(), foreign), (e) => e.code === 'SIGNATURE_IDENTITY');
    const pinnedOnly = h.opensslCert({ san: C.SIGNER_IDENTITY, extensions: { ...C.FULCIO_PINS, '1.3.6.1.4.1.57264.1.15': '42' } });
    assert.throws(() => verify.checkIdentity(h.goodSigner(), pinnedOnly), (e) => e.code === 'SIGNATURE_IDENTITY', 'another repository id');
    const own = h.opensslCert({ san: C.SIGNER_IDENTITY, extensions: C.FULCIO_PINS });
    assert.doesNotThrow(() => verify.checkIdentity(h.goodSigner(), own));
});
