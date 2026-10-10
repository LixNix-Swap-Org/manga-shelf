const fs = require('fs');
const zlib = require('zlib');
const { Readable, Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const { updateError } = require('./errors');
const { unsafeChars } = require('./swap');
const { isHandle } = require('./verifiedFile');

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const CHUNK = 64 * 1024;

const bad = (reason) => updateError('BAD_PACKAGE', null, { reason });

async function readAt(fh, length, position) {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    if (bytesRead !== length) throw bad('truncated');
    return buf;
}

/** { fh, size, entries } of a ZIP file path or an open FileHandle (left open by closeZip); entries carry name, sizes, method, crc32, offsets and attributes. */
async function openZip(source, { maxEntries = 20000 } = {}) {
    const borrowed = isHandle(source);
    const fh = borrowed ? source : await fs.promises.open(source, 'r');
    try {
        const { size } = await fh.stat();
        if (size < 22) throw bad('not_zip');
        const tailLength = Math.min(size, 22 + 0xffff);
        const tail = await readAt(fh, tailLength, size - tailLength);
        let eocd = -1;
        for (let i = tailLength - 22; i >= 0; i--) {
            if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
        }
        if (eocd < 0) throw bad('not_zip');
        let count = tail.readUInt16LE(eocd + 10);
        let cdSize = tail.readUInt32LE(eocd + 12);
        let cdOffset = tail.readUInt32LE(eocd + 16);
        const locatorPosition = size - tailLength + eocd - 20;
        if (locatorPosition >= 0 && (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)) {
            const locator = await readAt(fh, 20, locatorPosition);
            if (locator.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
                const zip64 = await readAt(fh, 56, Number(locator.readBigUInt64LE(8)));
                if (zip64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw bad('zip64');
                count = Number(zip64.readBigUInt64LE(32));
                cdSize = Number(zip64.readBigUInt64LE(40));
                cdOffset = Number(zip64.readBigUInt64LE(48));
            }
        }
        if (count > maxEntries) throw bad('too_many_entries');
        if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES || cdOffset + cdSize > size) throw bad('central_directory');
        const cd = await readAt(fh, cdSize, cdOffset);
        const entries = [];
        let p = 0;
        for (let i = 0; i < count; i++) {
            if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw bad('central_directory');
            const flags = cd.readUInt16LE(p + 8);
            const nameLength = cd.readUInt16LE(p + 28);
            const extraLength = cd.readUInt16LE(p + 30);
            const commentLength = cd.readUInt16LE(p + 32);
            if (p + 46 + nameLength + extraLength > cd.length) throw bad('central_directory');
            const entry = {
                name: cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLength),
                versionMadeBy: cd.readUInt16LE(p + 4),
                flags,
                method: cd.readUInt16LE(p + 10),
                crc32: cd.readUInt32LE(p + 16),
                compressedSize: cd.readUInt32LE(p + 20),
                uncompressedSize: cd.readUInt32LE(p + 24),
                externalAttrs: cd.readUInt32LE(p + 38),
                localOffset: cd.readUInt32LE(p + 42)
            };
            let e = p + 46 + nameLength;
            const extraEnd = e + extraLength;
            while (e + 4 <= extraEnd) {
                const id = cd.readUInt16LE(e);
                const len = cd.readUInt16LE(e + 2);
                if (id === 0x0001) {
                    let q = e + 4;
                    for (const key of ['uncompressedSize', 'compressedSize', 'localOffset']) {
                        if (entry[key] === 0xffffffff && q + 8 <= e + 4 + len) {
                            entry[key] = Number(cd.readBigUInt64LE(q));
                            q += 8;
                        }
                    }
                }
                e += 4 + len;
            }
            entries.push(entry);
            p = extraEnd + commentLength;
        }
        return { fh, size, entries, borrowed };
    } catch (err) {
        if (!borrowed) await fh.close().catch(() => {});
        throw err;
    }
}

/** 'file' | 'dir' | 'symlink' | 'other' from the external attributes (Unix mode or DOS flags) and the name. */
function entryKind(entry) {
    const dirName = entry.name.endsWith('/');
    if (entry.versionMadeBy >> 8 === 3) {
        const type = (entry.externalAttrs >>> 16) & 0o170000;
        if (type === 0o120000) return 'symlink';
        if (type === 0o040000) return dirName ? 'dir' : 'other';
        if (type === 0o100000) return dirName ? 'other' : 'file';
        if (type === 0) return dirName ? 'dir' : 'file';
        return 'other';
    }
    if (entry.externalAttrs & 0x400) return 'symlink';
    if (dirName) return 'dir';
    return entry.externalAttrs & 0x10 ? 'other' : 'file';
}

/** The entry path without a trailing slash when it is a safe relative path, else null. */
function safeName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 400) return null;
    if (unsafeChars(name) || name.startsWith('/')) return null;
    const clean = name.endsWith('/') ? name.slice(0, -1) : name;
    const segments = clean.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
    return clean;
}

function readRange(fh, start, length) {
    let position = start;
    let remaining = length;
    return new Readable({
        highWaterMark: CHUNK,
        read() {
            if (remaining <= 0) {
                this.push(null);
                return;
            }
            const chunk = Buffer.allocUnsafe(Math.min(CHUNK, remaining));
            fh.read(chunk, 0, chunk.length, position).then(({ bytesRead }) => {
                if (bytesRead === 0) return this.destroy(bad('truncated'));
                position += bytesRead;
                remaining -= bytesRead;
                this.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
            }, (err) => this.destroy(err));
        }
    });
}

async function inflateEntry(zip, entry, sink, maxBytes) {
    if (entry.flags & 0x1) throw bad('encrypted');
    if (entry.method !== 0 && entry.method !== 8) throw bad('method');
    if (entry.uncompressedSize > maxBytes) throw bad('entry_too_large');
    const local = await readAt(zip.fh, 30, entry.localOffset);
    if (local.readUInt32LE(0) !== SIG_LOCAL) throw bad('local_header');
    const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (start + entry.compressedSize > zip.size) throw bad('truncated');
    let written = 0;
    let crc = 0;
    const counter = new Transform({
        transform(chunk, encoding, callback) {
            written += chunk.length;
            if (written > maxBytes || written > entry.uncompressedSize) return callback(bad('entry_too_large'));
            crc = zlib.crc32(chunk, crc);
            callback(null, chunk);
        }
    });
    const stages = [readRange(zip.fh, start, entry.compressedSize)];
    if (entry.method === 8) stages.push(zlib.createInflateRaw());
    stages.push(counter, sink);
    try {
        await pipeline(stages);
    } catch (err) {
        if (err && err.expose) throw err;
        throw bad('corrupt');
    }
    if (written !== entry.uncompressedSize || crc !== entry.crc32) throw bad('crc');
    return written;
}

/** The inflated content of one entry. */
async function readEntry(zip, entry, maxBytes) {
    const chunks = [];
    await inflateEntry(zip, entry, new Writable({
        write(chunk, encoding, callback) {
            chunks.push(chunk);
            callback();
        }
    }), maxBytes);
    return Buffer.concat(chunks);
}

/** Inflates one entry into a new file (`wx`, never through an existing path); removes it on failure. */
async function extractEntry(zip, entry, target, maxBytes, mode = 0o644) {
    const fh = await fs.promises.open(target, 'wx', mode);
    try {
        const sink = new Writable({
            write(chunk, encoding, callback) {
                fh.write(chunk).then(() => callback(), callback);
            }
        });
        await inflateEntry(zip, entry, sink, maxBytes);
        await fh.sync();
    } catch (err) {
        await fh.close().catch(() => {});
        await fs.promises.unlink(target).catch(() => {});
        throw err;
    }
    await fh.close();
}

const closeZip = (zip) => (zip.borrowed ? Promise.resolve() : zip.fh.close().catch(() => {}));

module.exports = { openZip, entryKind, safeName, readEntry, extractEntry, closeZip };
