const crypto = require('crypto');
const { SIGNER_IDENTITY, SIGNER_IDENTITY_PATTERN, OIDC_ISSUER, FULCIO_PINS, BUNDLE_MEDIA_TYPES, markerName, MARKER_PATTERN } = require('./constants');
const { parseVersion } = require('./version');
const { updateError } = require('./errors');

const PRODUCTION_POLICY = Object.freeze({ certificateIssuer: OIDC_ISSUER, certificateIdentityURI: SIGNER_IDENTITY_PATTERN });
const SUMS_LINE = /^([0-9a-f]{64}) {2}([^\\/\r\n]+)$/;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function parseBundle(bundleJson) {
    let bundle = bundleJson;
    if (Buffer.isBuffer(bundle)) bundle = bundle.toString('utf8');
    if (typeof bundle === 'string') {
        try {
            bundle = JSON.parse(bundle);
        } catch (e) {
            throw updateError('BUNDLE_FORMAT');
        }
    }
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw updateError('BUNDLE_FORMAT');
    return bundle;
}

/** Format gate before Sigstore sees the bundle: v0.3 message signature over exactly these bytes, no DSSE. */
function checkFormat(bundle, sumsBytes) {
    if (!Buffer.isBuffer(sumsBytes)) throw updateError('BUNDLE_FORMAT');
    if (!BUNDLE_MEDIA_TYPES.includes(bundle.mediaType)) throw updateError('BUNDLE_FORMAT');
    if (Object.prototype.hasOwnProperty.call(bundle, 'dsseEnvelope')) throw updateError('BUNDLE_FORMAT');
    const signature = bundle.messageSignature;
    const digest = signature && typeof signature === 'object' ? signature.messageDigest : null;
    if (!digest || digest.algorithm !== 'SHA2_256' || typeof digest.digest !== 'string') throw updateError('BUNDLE_FORMAT');
    if (typeof signature.signature !== 'string' || !signature.signature) throw updateError('BUNDLE_FORMAT');
    const given = Buffer.from(digest.digest, 'base64');
    if (given.length !== 32 || given.toString('base64') !== digest.digest) throw updateError('BUNDLE_FORMAT');
    if (!crypto.timingSafeEqual(given, sha256(sumsBytes))) throw updateError('SIGNATURE_INVALID');
    const material = bundle.verificationMaterial;
    const raw = material && (material.certificate?.rawBytes || material.x509CertificateChain?.certificates?.[0]?.rawBytes);
    if (typeof raw !== 'string' || !raw) throw updateError('BUNDLE_FORMAT');
    const entries = material.tlogEntries;
    if (!Array.isArray(entries) || entries.length === 0) throw updateError('BUNDLE_FORMAT');
    return { leafDer: Buffer.from(raw, 'base64'), logIndex: String(entries[0].logIndex ?? '') };
}

/** Name → hex hash of a sha256sum file ("<64 hex><two spaces><name>" per line); throws BUNDLE_FORMAT on anything else. */
function parseSums(sumsBytes) {
    const lines = sumsBytes.toString('utf8').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const sums = new Map();
    for (const line of lines) {
        const m = SUMS_LINE.exec(line);
        if (!m || sums.has(m[2])) throw updateError('BUNDLE_FORMAT');
        sums.set(m[2], m[1]);
    }
    if (sums.size === 0) throw updateError('BUNDLE_FORMAT');
    return sums;
}

/** String value of a DER UTF8String / IA5String / PrintableString, else null. */
function derString(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 2 || ![0x0c, 0x13, 0x16].includes(buf[0])) return null;
    let length = buf[1];
    let offset = 2;
    if (length & 0x80) {
        const n = length & 0x7f;
        if (n < 1 || n > 2 || buf.length < 2 + n) return null;
        length = 0;
        for (let i = 0; i < n; i++) length = length * 256 + buf[2 + i];
        offset = 2 + n;
    }
    if (offset + length !== buf.length) return null;
    return buf.toString('utf8', offset);
}

/** Signer and leaf certificate must name release.yml on main of this repository, pinned by id. */
function checkIdentity(signer, leafDer) {
    const identity = signer && signer.identity;
    if (!identity || identity.subjectAlternativeName !== SIGNER_IDENTITY) throw updateError('SIGNATURE_IDENTITY');
    if (!identity.extensions || identity.extensions.issuer !== OIDC_ISSUER) throw updateError('SIGNATURE_IDENTITY');
    let cert;
    try {
        const { X509Certificate } = require('@sigstore/core');
        cert = X509Certificate.parse(leafDer);
    } catch (e) {
        throw updateError('BUNDLE_FORMAT');
    }
    if (cert.subjectAltName !== SIGNER_IDENTITY) throw updateError('SIGNATURE_IDENTITY');
    for (const [oid, expected] of Object.entries(FULCIO_PINS)) {
        let ext;
        try { ext = cert.extension(oid); } catch (e) { ext = null; }
        if (!ext || derString(ext.value) !== expected) throw updateError('SIGNATURE_IDENTITY');
    }
}

/** Exactly one marker line, for `version`, and the marker file itself says that version. */
function checkMarker(sums, version, markerBytes) {
    const markers = [...sums.keys()].filter((name) => MARKER_PATTERN.test(name));
    const name = markerName(version);
    if (markers.length !== 1 || markers[0] !== name || !Buffer.isBuffer(markerBytes)) throw updateError('VERSION_UNBOUND');
    if (sha256(markerBytes).toString('hex') !== sums.get(name)) throw updateError('VERSION_UNBOUND');
    let data;
    try {
        data = JSON.parse(markerBytes.toString('utf8'));
    } catch (e) {
        throw updateError('VERSION_UNBOUND');
    }
    if (!data || typeof data !== 'object' || data.version !== version) throw updateError('VERSION_UNBOUND');
}

function checkAsset(sums, assetName, assetSha256) {
    if (typeof assetName !== 'string' || !sums.has(assetName)) throw updateError('CHECKSUM_MISSING');
    if (typeof assetSha256 !== 'string' || sums.get(assetName) !== assetSha256) throw updateError('CHECKSUM_MISMATCH');
}

function assertPolicy(policy) {
    if (!policy || policy.certificateIssuer !== OIDC_ISSUER || policy.certificateIdentityURI !== SIGNER_IDENTITY_PATTERN) {
        throw new Error('verification policy is not the production policy');
    }
}

/** sigstore-js keyless verification; the payload must be a Buffer (a string would drop the policy). */
async function sigstoreVerifyBundle(bundle, payload, { policy, tufCachePath, sigstore = require('sigstore') } = {}) {
    if (!Buffer.isBuffer(payload)) throw updateError('BUNDLE_FORMAT');
    assertPolicy(policy);
    let verifier;
    try {
        verifier = await sigstore.createVerifier({ ...policy, tufCachePath, tlogThreshold: 1, ctLogThreshold: 1 });
    } catch (e) {
        throw Object.assign(updateError('SIGSTORE_TRUST_UNAVAILABLE'), { cause: e });
    }
    try {
        return verifier.verify(bundle, payload);
    } catch (e) {
        throw Object.assign(updateError(e && e.name === 'PolicyError' ? 'SIGNATURE_IDENTITY' : 'SIGNATURE_INVALID'), { cause: e });
    }
}

/** Verifier with an injectable `verifyBundle(bundle, payload, { policy, tufCachePath }) -> signer` (tests). */
function createVerifier({ verifyBundle = sigstoreVerifyBundle } = {}) {
    async function verifySums({ sumsBytes, bundleJson, version, markerBytes, policy = PRODUCTION_POLICY, tufCachePath } = {}) {
        assertPolicy(policy);
        if (!parseVersion(version)) throw updateError('VERSION_UNBOUND');
        const bundle = parseBundle(bundleJson);
        const { leafDer, logIndex } = checkFormat(bundle, sumsBytes);
        const sums = parseSums(sumsBytes);
        const signer = await verifyBundle(bundle, sumsBytes, { policy, tufCachePath });
        checkIdentity(signer, leafDer);
        checkMarker(sums, version, markerBytes);
        return { sums, identity: SIGNER_IDENTITY, log_index: logIndex };
    }

    async function verifyRelease({ sumsBytes, bundleJson, markerName: name, markerBytes, version, assetName, assetSha256, policy, tufCachePath } = {}) {
        if (name !== undefined && name !== markerName(version)) throw updateError('VERSION_UNBOUND');
        const result = await verifySums({ sumsBytes, bundleJson, version, markerBytes, policy, tufCachePath });
        checkAsset(result.sums, assetName, assetSha256);
        return { identity: result.identity, log_index: result.log_index, sha256: assetSha256, sums: result.sums };
    }

    return { verifySums, verifyRelease, checkAsset };
}

const production = createVerifier();

module.exports = {
    PRODUCTION_POLICY, createVerifier, verifyRelease: production.verifyRelease, verifySums: production.verifySums,
    sigstoreVerifyBundle, parseSums, checkFormat, checkIdentity, checkMarker, checkAsset, derString
};
