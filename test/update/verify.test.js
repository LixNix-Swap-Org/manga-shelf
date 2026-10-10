process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const verify = require('../../services/update/verify');
const C = require('../../services/update/constants');
const { errorSummary } = require('../../services/update/errors');
const h = require('../fixtures/update/helpers');

const ASSET = 'pterodactyl-manga-shelf.zip';
const assetBytes = Buffer.from('zip bytes');
const release = h.makeRelease('3.2.0', { [ASSET]: assetBytes, 'manga-shelf-server-linux-x64': Buffer.from('bin') });

function verifierWith(signer = h.goodSigner(), seen = []) {
    return verify.createVerifier({
        verifyBundle: async (bundle, payload, options) => {
            seen.push({ bundle, payload, options });
            return signer;
        }
    });
}

const input = (over = {}) => ({
    sumsBytes: release.sumsBytes,
    bundleJson: JSON.stringify(h.makeBundle(release.sumsBytes)),
    markerName: release.markerName,
    markerBytes: release.markerBytes,
    version: '3.2.0',
    assetName: ASSET,
    assetSha256: h.sha256hex(assetBytes),
    ...over
});

const rejectsWith = (promise, code) => assert.rejects(promise, (err) => {
    assert.equal(err.code, code);
    return true;
});

test('a good release passes; sigstore gets the exact Buffer and the anchored production policy', async () => {
    const seen = [];
    const r = await verifierWith(h.goodSigner(), seen).verifyRelease(input());
    assert.equal(r.identity, C.SIGNER_IDENTITY);
    assert.equal(r.log_index, '123456');
    assert.equal(seen.length, 1);
    assert.ok(Buffer.isBuffer(seen[0].payload));
    assert.ok(seen[0].payload.equals(release.sumsBytes));
    assert.deepEqual(seen[0].options.policy, { certificateIssuer: C.OIDC_ISSUER, certificateIdentityURI: C.SIGNER_IDENTITY_PATTERN });
});

test('format gate: DSSE refused, unknown media type refused, a bundle for another file refused, before sigstore runs', async () => {
    const seen = [];
    const v = verifierWith(h.goodSigner(), seen);
    const dsse = { ...h.makeBundle(release.sumsBytes), dsseEnvelope: { payload: 'e30=', payloadType: 'application/vnd.in-toto+json', signatures: [] } };
    await rejectsWith(v.verifyRelease(input({ bundleJson: JSON.stringify(dsse) })), 'BUNDLE_FORMAT');
    const dsseOnly = h.makeBundle(release.sumsBytes);
    delete dsseOnly.messageSignature;
    dsseOnly.dsseEnvelope = { payload: 'e30=' };
    await rejectsWith(v.verifyRelease(input({ bundleJson: JSON.stringify(dsseOnly) })), 'BUNDLE_FORMAT');
    await rejectsWith(v.verifyRelease(input({ bundleJson: JSON.stringify(h.makeBundle(release.sumsBytes, { mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.2' })) })), 'BUNDLE_FORMAT');
    const sha512 = h.makeBundle(release.sumsBytes);
    sha512.messageSignature.messageDigest.algorithm = 'SHA2_512';
    await rejectsWith(v.verifyRelease(input({ bundleJson: JSON.stringify(sha512) })), 'BUNDLE_FORMAT');
    const other = h.makeBundle(release.sumsBytes, { digestOf: Buffer.from('another SHA256SUMS.txt') });
    await rejectsWith(v.verifyRelease(input({ bundleJson: JSON.stringify(other) })), 'SIGNATURE_INVALID');
    await rejectsWith(v.verifyRelease(input({ bundleJson: '{not json' })), 'BUNDLE_FORMAT');
    assert.equal(seen.length, 0, 'sigstore never saw a refused bundle');
});

test('a string payload is refused (sigstore would drop the policy)', async () => {
    await rejectsWith(verifierWith().verifyRelease(input({ sumsBytes: release.sumsBytes.toString('utf8') })), 'BUNDLE_FORMAT');
    await rejectsWith(verify.sigstoreVerifyBundle(h.makeBundle(release.sumsBytes), release.sumsBytes.toString('utf8'), { policy: verify.PRODUCTION_POLICY }), 'BUNDLE_FORMAT');
});

test('the policy cannot be swapped for a looser one', async () => {
    await assert.rejects(verifierWith().verifyRelease(input({ policy: { certificateIssuer: C.OIDC_ISSUER, certificateIdentityURI: 'release.yml' } })), /production policy/);
});

test('identity is anchored: main-x, other files, prefixes and suffixes are refused', async () => {
    const pattern = new RegExp(C.SIGNER_IDENTITY_PATTERN);
    const bad = [
        `${C.SIGNER_IDENTITY}-x`,
        'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main-x',
        'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release-yml@refs/heads/main',
        'https://githubXcom/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main',
        `https://evil.example/?${C.SIGNER_IDENTITY}`,
        `${C.SIGNER_IDENTITY}/`,
        'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/tags/v3.2.0'
    ];
    assert.ok(pattern.test(C.SIGNER_IDENTITY));
    for (const san of bad) {
        assert.equal(pattern.test(san), false, san);
        await rejectsWith(verifierWith(h.goodSigner(san)).verifyRelease(input()), 'SIGNATURE_IDENTITY');
        const bundle = h.makeBundle(release.sumsBytes, { cert: h.makeCert({ san }) });
        await rejectsWith(verifierWith().verifyRelease(input({ bundleJson: JSON.stringify(bundle) })), 'SIGNATURE_IDENTITY');
    }
    const wrongIssuer = { identity: { subjectAlternativeName: C.SIGNER_IDENTITY, extensions: { issuer: 'https://accounts.google.com' } } };
    await rejectsWith(verifierWith(wrongIssuer).verifyRelease(input()), 'SIGNATURE_IDENTITY');
});

test('Fulcio pins: repository id, owner id, trigger, runner, ref and repository must all match', async () => {
    for (const oid of Object.keys(C.FULCIO_PINS)) {
        const missing = h.makeBundle(release.sumsBytes, { cert: h.makeCert({ omit: [oid] }) });
        await rejectsWith(verifierWith().verifyRelease(input({ bundleJson: JSON.stringify(missing) })), 'SIGNATURE_IDENTITY');
    }
    const changes = {
        '1.3.6.1.4.1.57264.1.15': '999',
        '1.3.6.1.4.1.57264.1.17': '1',
        '1.3.6.1.4.1.57264.1.20': 'push',
        '1.3.6.1.4.1.57264.1.11': 'self-hosted',
        '1.3.6.1.4.1.57264.1.14': 'refs/heads/main-x',
        '1.3.6.1.4.1.57264.1.12': 'https://github.com/someone/manga-shelf'
    };
    for (const [oid, value] of Object.entries(changes)) {
        const cert = h.makeCert({ pins: { ...C.FULCIO_PINS, [oid]: value } });
        await rejectsWith(verifierWith().verifyRelease(input({ bundleJson: JSON.stringify(h.makeBundle(release.sumsBytes, { cert })) })), 'SIGNATURE_IDENTITY');
    }
    assert.equal(C.FULCIO_PINS['1.3.6.1.4.1.57264.1.15'], '1403549029');
    assert.equal(C.FULCIO_PINS['1.3.6.1.4.1.57264.1.17'], '300401444');
});

test('version marker binds the signed sums to the selected version', async () => {
    const v = verifierWith();
    await rejectsWith(v.verifyRelease(input({ version: '9.0.0', markerName: C.markerName('9.0.0') })), 'VERSION_UNBOUND');
    await rejectsWith(v.verifyRelease(input({ markerBytes: Buffer.from(JSON.stringify({ version: '3.1.0' })) })), 'VERSION_UNBOUND');
    const lying = h.makeRelease('3.2.0', { [ASSET]: assetBytes }, { marker: { version: '3.1.0' } });
    await rejectsWith(v.verifyRelease(input({ sumsBytes: lying.sumsBytes, markerBytes: lying.markerBytes, bundleJson: JSON.stringify(h.makeBundle(lying.sumsBytes)) })), 'VERSION_UNBOUND');
    const two = Buffer.concat([release.sumsBytes, Buffer.from(`${'0'.repeat(64)}  ${C.markerName('3.1.9')}\n`)]);
    await rejectsWith(v.verifyRelease(input({ sumsBytes: two, bundleJson: JSON.stringify(h.makeBundle(two)) })), 'VERSION_UNBOUND');
    const none = h.makeRelease('3.2.0', { [ASSET]: assetBytes });
    const noMarker = Buffer.from(none.sumsBytes.toString().split('\n').filter((l) => !l.includes('manga-shelf-release')).join('\n'));
    await rejectsWith(v.verifyRelease(input({ sumsBytes: noMarker, bundleJson: JSON.stringify(h.makeBundle(noMarker)) })), 'VERSION_UNBOUND');
});

test('asset hash: missing line and mismatch are refused; malformed sums are a format error', async () => {
    const v = verifierWith();
    await rejectsWith(v.verifyRelease(input({ assetName: 'manga-shelf-server-linux-arm64' })), 'CHECKSUM_MISSING');
    await rejectsWith(v.verifyRelease(input({ assetSha256: h.sha256hex(Buffer.from('other')) })), 'CHECKSUM_MISMATCH');
    const loose = Buffer.from(`${h.sha256hex(assetBytes)} ${ASSET}\n`);
    await rejectsWith(v.verifyRelease(input({ sumsBytes: loose, bundleJson: JSON.stringify(h.makeBundle(loose)) })), 'BUNDLE_FORMAT');
    assert.throws(() => verify.parseSums(Buffer.from(`${'a'.repeat(64)}  x\n${'b'.repeat(64)}  x\n`)), (e) => e.code === 'BUNDLE_FORMAT');
    assert.throws(() => verify.parseSums(Buffer.from(`${'a'.repeat(64)}  ../x\n`)), (e) => e.code === 'BUNDLE_FORMAT');
});

test('sigstore failures map to their codes: trust root unavailable, policy, signature', async () => {
    const bundle = h.makeBundle(release.sumsBytes);
    const run = (createVerifier) => verify.sigstoreVerifyBundle(bundle, release.sumsBytes, { policy: verify.PRODUCTION_POLICY, tufCachePath: '/tmp/x', sigstore: { createVerifier } });
    await rejectsWith(run(async () => { throw Object.assign(new Error('fetch failed'), { name: 'TUFError' }); }), 'SIGSTORE_TRUST_UNAVAILABLE');
    await assert.rejects(run(async () => { throw new Error('offline'); }), (err) => {
        assert.deepEqual(errorSummary(err), {
            code: 'SIGSTORE_TRUST_UNAVAILABLE', message: `Signaturdienst nicht erreichbar (${C.TUF_HOST}).`,
            msg: 'Signaturdienst nicht erreichbar ({host}).', params: { host: C.TUF_HOST }
        });
        return true;
    });
    await rejectsWith(run(async () => ({ verify: () => { throw Object.assign(new Error('identity'), { name: 'PolicyError' }); } })), 'SIGNATURE_IDENTITY');
    let options = null;
    await rejectsWith(run(async (o) => {
        options = o;
        return { verify: () => { throw Object.assign(new Error('bad'), { name: 'VerificationError' }); } };
    }), 'SIGNATURE_INVALID');
    assert.equal(options.certificateIdentityURI, C.SIGNER_IDENTITY_PATTERN);
    assert.equal(options.certificateIssuer, C.OIDC_ISSUER);
    assert.equal(options.tlogThreshold, 1);
    assert.equal(options.tufCachePath, '/tmp/x');
    const signer = h.goodSigner();
    let payload = null;
    assert.equal(await run(async () => ({ verify: (b, p) => { payload = p; return signer; } })), signer);
    assert.ok(Buffer.isBuffer(payload));
});

test('derString reads DER strings and refuses anything else', () => {
    assert.equal(verify.derString(h.derUtf8('workflow_dispatch')), 'workflow_dispatch');
    assert.equal(verify.derString(h.derUtf8('x'.repeat(200))), 'x'.repeat(200));
    assert.equal(verify.derString(Buffer.from('workflow_dispatch')), null);
    assert.equal(verify.derString(Buffer.concat([h.derUtf8('a'), Buffer.from([0])])), null);
});
