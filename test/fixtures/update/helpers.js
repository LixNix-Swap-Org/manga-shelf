const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const C = require('../../../services/update/constants');

/** ZIP bytes; entry: { name, data?, type?: 'file'|'dir'|'symlink', mode?, method?: 0|8, madeBy? }. */
function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const type = e.type || (e.name.endsWith('/') ? 'dir' : 'file');
        const name = Buffer.from(e.name, 'utf8');
        const data = type === 'dir' ? Buffer.alloc(0) : Buffer.from(e.data ?? '');
        const method = type === 'dir' ? 0 : (e.method ?? 8);
        const body = method === 8 ? zlib.deflateRawSync(data) : data;
        const crc = zlib.crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0x21, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, body);
        const mode = e.mode ?? (type === 'dir' ? 0o040755 : type === 'symlink' ? 0o120777 : 0o100644);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(e.madeBy ?? ((3 << 8) | 20), 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((mode << 16) | (type === 'dir' ? 0x10 : 0)) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
}

function tlv(tag, content) {
    const len = content.length;
    let head;
    if (len < 0x80) head = Buffer.from([tag, len]);
    else if (len < 0x100) head = Buffer.from([tag, 0x81, len]);
    else head = Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
    return Buffer.concat([head, content]);
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));

function oid(text) {
    const arcs = text.split('.').map(Number);
    const out = [40 * arcs[0] + arcs[1]];
    for (const arc of arcs.slice(2)) {
        const bytes = [arc & 0x7f];
        let rest = Math.floor(arc / 128);
        while (rest > 0) {
            bytes.unshift((rest & 0x7f) | 0x80);
            rest = Math.floor(rest / 128);
        }
        out.push(...bytes);
    }
    return tlv(0x06, Buffer.from(out));
}

const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const extension = (id, valueDer) => seq(oid(id), tlv(0x04, valueDer));

/** DER of a leaf certificate with a URI SAN and Fulcio extensions ({ oid: string }); not signed (parse-only). */
function makeCert({ san = C.SIGNER_IDENTITY, pins = C.FULCIO_PINS, omit = [] } = {}) {
    const name = seq(tlv(0x31, seq(oid('2.5.4.3'), utf8('sigstore-intermediate'))));
    const validity = seq(tlv(0x17, Buffer.from('250101000000Z')), tlv(0x17, Buffer.from('350101000000Z')));
    const point = Buffer.concat([Buffer.from([0x00, 0x04]), Buffer.alloc(64, 1)]);
    const spki = seq(seq(oid('1.2.840.10045.2.1'), oid('1.2.840.10045.3.1.7')), tlv(0x03, point));
    const exts = [extension('2.5.29.17', seq(tlv(0x86, Buffer.from(san, 'ascii'))))];
    for (const [id, value] of Object.entries(pins)) if (!omit.includes(id)) exts.push(extension(id, utf8(value)));
    const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1])), seq(oid('1.2.840.10045.4.3.3')), name, validity, name, spki, tlv(0xa3, seq(...exts)));
    return seq(tbs, seq(oid('1.2.840.10045.4.3.3')), tlv(0x03, Buffer.from([0x00, 0x30, 0x00])));
}

/** Bundle JSON (v0.3 message signature) for `sumsBytes`; `overrides` replace top-level fields. */
function makeBundle(sumsBytes, { cert = makeCert(), digestOf = sumsBytes, ...overrides } = {}) {
    return {
        mediaType: C.BUNDLE_MEDIA_TYPES[0],
        verificationMaterial: {
            certificate: { rawBytes: cert.toString('base64') },
            tlogEntries: [{ logIndex: '123456', kindVersion: { kind: 'hashedrekord', version: '0.0.1' } }]
        },
        messageSignature: {
            messageDigest: { algorithm: 'SHA2_256', digest: crypto.createHash('sha256').update(digestOf).digest('base64') },
            signature: Buffer.from('signature').toString('base64')
        },
        ...overrides
    };
}

/** Signer the fake verifyBundle returns (what sigstore-js returns after a successful verification). */
const goodSigner = (san = C.SIGNER_IDENTITY) => ({ identity: { subjectAlternativeName: san, extensions: { issuer: C.OIDC_ISSUER } } });

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** { sumsBytes, markerBytes, markerName, files } for `version` with the given asset files ({ name: Buffer }). */
function makeRelease(version, files = {}, { marker = { version, tag: `v${version}`, commit: 'abc', built_at: '2026-10-10T00:00:00Z' } } = {}) {
    const markerName = C.markerName(version);
    const markerBytes = Buffer.from(JSON.stringify(marker));
    const all = { ...files, [markerName]: markerBytes };
    const lines = Object.keys(all).sort().map((name) => `${sha256hex(all[name])}  ${name}`);
    return { sumsBytes: Buffer.from(lines.join('\n') + '\n'), markerBytes, markerName, files: all };
}

/** { key, cert } PEM for the allow-listed hosts, made with openssl; null when openssl is missing. */
function tlsPair() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-tls-'));
    try {
        const san = 'subjectAltName=DNS:api.github.com,DNS:github.com,DNS:objects.githubusercontent.com,DNS:release-assets.githubusercontent.com';
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=manga-shelf-test',
            '-addext', san, '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
        return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
    } catch (e) {
        return null;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A real X.509 certificate (DER) made by openssl with a URI SAN and Fulcio-style UTF8String extensions; null without openssl. */
function opensslCert({ san, extensions = {} }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-cert-'));
    try {
        const lines = ['[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', 'O = sigstore.dev', '[ext]', `subjectAltName = critical, URI:${san}`];
        for (const [id, value] of Object.entries(extensions)) lines.push(`${id} = ASN1:UTF8String:${value}`);
        fs.writeFileSync(path.join(dir, 'cert.cnf'), lines.join('\n') + '\n');
        execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path.join(dir, 'key.pem')], { stdio: 'ignore' });
        execFileSync('openssl', ['req', '-x509', '-new', '-key', path.join(dir, 'key.pem'), '-days', '1', '-config', path.join(dir, 'cert.cnf'),
            '-extensions', 'ext', '-outform', 'DER', '-out', path.join(dir, 'cert.der')], { stdio: 'ignore' });
        return fs.readFileSync(path.join(dir, 'cert.der'));
    } catch (e) {
        return null;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** A fake server binary (node script with shebang) answering `version` and `db-check`, each after `delayMs`. */
function writeFakeBinary(file, { version, dbCheckExit = 0, versionExit = 0, delayMs = 0 }) {
    const body = fs.readFileSync(path.join(__dirname, 'fake-server.js'), 'utf8');
    const head = `#!${process.execPath}\nconst VERSION = ${JSON.stringify(version)};\nconst DB_CHECK_EXIT = ${dbCheckExit};\nconst VERSION_EXIT = ${versionExit};\nconst DELAY_MS = ${delayMs};\n`;
    fs.writeFileSync(file, head + body, { mode: 0o755 });
    return file;
}

const tmpDir = (prefix = 'manga-shelf-update-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

module.exports = { makeZip, makeCert, makeBundle, goodSigner, makeRelease, sha256hex, tlsPair, opensslCert, writeFakeBinary, tmpDir, derUtf8: utf8 };
