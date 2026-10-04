/**
 * Strips metadata (camera data, GPS, comments, XMP) from uploaded JPEG/PNG/WebP in pure JS, without re-encoding;
 * JPEG keeps ICC, Adobe APP14 and the EXIF orientation. Unparseable files and ones over MAX_SEGMENTS come back unchanged.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);
const WEBP_DROP = new Set(['EXIF', 'XMP ']);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;
const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const ORIENTATION_TAG = 0x0112;

const startsWith = (buf, offset, prefix) => buf.length >= offset + prefix.length && buf.subarray(offset, offset + prefix.length).equals(prefix);

/** Orientation (1-8) from an APP1 EXIF payload, or null. */
function readExifOrientation(payload) {
    if (!startsWith(payload, 0, EXIF_HEADER)) return null;
    const tiff = payload.subarray(EXIF_HEADER.length);
    if (tiff.length < 8) return null;
    const order = tiff.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const le = order === 'II';
    const u16 = (o) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
    const u32 = (o) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
    if (u16(2) !== 42) return null;
    const ifd = u32(4);
    if (ifd + 2 > tiff.length) return null;
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > tiff.length) return null;
        if (u16(entry) !== ORIENTATION_TAG) continue;
        const value = u16(entry + 2) === 3 ? u16(entry + 8) : null;
        return value >= 1 && value <= 8 ? value : null;
    }
    return null;
}

/** APP1 segment holding nothing but the orientation tag (big-endian TIFF, one IFD entry). */
function orientationSegment(orientation) {
    const tiff = Buffer.alloc(26);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(ORIENTATION_TAG, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const payload = Buffer.concat([EXIF_HEADER, tiff]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([header, payload]);
}

const JFIF_ID = Buffer.from('JFIF\0', 'latin1');
const ICC_ID = Buffer.from('ICC_PROFILE\0', 'latin1');
const ADOBE_ID = Buffer.from('Adobe', 'latin1');
// A real image has a few dozen segments/chunks; marker-dense input is refused instead of parsed.
const MAX_SEGMENTS = 4096;

function keepJpegSegment(marker, payload) {
    if (marker === 0xe0) return startsWith(payload, 0, JFIF_ID);
    if (marker === 0xe2) return startsWith(payload, 0, ICC_ID);
    if (marker === 0xee) return startsWith(payload, 0, ADOBE_ID);
    if (marker >= 0xe1 && marker <= 0xef) return false;
    return marker !== 0xfe;
}

/** End of the entropy-coded data that starts at `pos`: the offset of the next marker other than RSTn (or the end). */
function entropyEnd(buf, pos) {
    for (;;) {
        const ff = buf.indexOf(0xff, pos);
        if (ff < 0 || ff + 1 >= buf.length) return buf.length;
        const next = buf[ff + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) pos = ff + 2;
        else if (next === 0xff) pos = ff + 1;
        else return ff;
    }
}

/**
 * Collects the edits of one stripper: byte ranges to drop or replace, in ascending order. Only the edits are held,
 * so memory stays proportional to what is removed, not to the number of segments in the file.
 */
function editList() {
    const edits = [];
    return {
        edits,
        drop(start, end) {
            if (end <= start) return;
            const last = edits[edits.length - 1];
            if (last && !last.data && last.end === start) last.end = end;
            else edits.push({ start, end, data: null });
        },
        replace(start, end, data) {
            edits.push({ start, end, data });
        }
    };
}

function applyEdits(buf, edits) {
    let size = buf.length;
    for (const e of edits) size += (e.data ? e.data.length : 0) - (e.end - e.start);
    const out = Buffer.allocUnsafe(size);
    let src = 0;
    let dst = 0;
    for (const e of edits) {
        dst += buf.copy(out, dst, src, e.start);
        if (e.data) dst += e.data.copy(out, dst);
        src = e.end;
    }
    buf.copy(out, dst, src);
    return out;
}

// Everything after EOI (MPF secondary images, gain maps, vendor trailers with their own EXIF) is dropped as well.
function stripJpeg(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    const list = editList();
    let insertAt = 2;
    let insertSettled = false;
    let orientation = null;
    let segments = 0;
    let pos = 2;
    while (pos < buf.length) {
        if (++segments > MAX_SEGMENTS) return null;
        if (buf[pos] !== 0xff) return null;
        while (pos < buf.length && buf[pos] === 0xff) pos++;
        if (pos >= buf.length) return null;
        const marker = buf[pos++];
        if (marker === 0xd9) {
            list.drop(pos, buf.length);
            break;
        }
        // RSTn and TEM only occur inside entropy-coded data, which entropyEnd skips
        if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null;
        if (pos + 2 > buf.length) return null;
        const length = buf.readUInt16BE(pos);
        if (length < 2 || pos + length > buf.length) return null;
        const payload = buf.subarray(pos + 2, pos + length);
        const start = pos - 2;
        pos += length;
        if (marker === 0xda) {
            pos = entropyEnd(buf, pos);
            insertSettled = true;
            continue;
        }
        if (marker === 0xe1 && orientation === null) orientation = readExifOrientation(payload);
        if (!keepJpegSegment(marker, payload)) {
            list.drop(start, pos);
            continue;
        }
        if (!insertSettled && marker === 0xe0) insertAt = pos;
        else insertSettled = true;
    }
    const { edits } = list;
    if (orientation && orientation !== 1) {
        const at = edits.findIndex(e => e.start >= insertAt);
        edits.splice(at < 0 ? edits.length : at, 0, { start: insertAt, end: insertAt, data: orientationSegment(orientation) });
    }
    return edits.length ? applyEdits(buf, edits) : null;
}

function stripPng(buf) {
    if (!startsWith(buf, 0, PNG_SIGNATURE)) return null;
    const list = editList();
    let removed = false;
    let segments = 0;
    let pos = PNG_SIGNATURE.length;
    while (pos < buf.length) {
        if (++segments > MAX_SEGMENTS) return null;
        if (pos + 12 > buf.length) return null;
        const length = buf.readUInt32BE(pos);
        const end = pos + 12 + length;
        if (end > buf.length) return null;
        const type = buf.toString('latin1', pos + 4, pos + 8);
        if (PNG_DROP.has(type)) {
            removed = true;
            list.drop(pos, end);
        }
        pos = end;
        if (type === 'IEND') break;
    }
    if (!removed) return null;
    list.drop(pos, buf.length);
    return applyEdits(buf, list.edits);
}

function stripWebp(buf) {
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
    const end = Math.min(buf.length, 8 + buf.readUInt32LE(4));
    const list = editList();
    let removed = false;
    let segments = 0;
    let pos = 12;
    while (pos + 8 <= end) {
        if (++segments > MAX_SEGMENTS) return null;
        const type = buf.toString('latin1', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        const next = pos + 8 + size + (size % 2);
        if (pos + 8 + size > end) return null;
        if (WEBP_DROP.has(type)) {
            removed = true;
            list.drop(pos, Math.min(next, end));
        } else if (type === 'VP8X' && size >= 1) {
            const flags = buf[pos + 8] & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
            if (flags !== buf[pos + 8]) list.replace(pos + 8, pos + 9, Buffer.from([flags]));
        }
        pos = next;
    }
    if (!removed) return null;
    list.drop(Math.min(pos, end), buf.length);
    const out = applyEdits(buf, list.edits);
    out.writeUInt32LE(out.length - 8, 4);
    return out;
}

const STRIPPERS = { '.jpg': stripJpeg, '.png': stripPng, '.webp': stripWebp };

/**
 * Returns the image without metadata, or the same buffer when there was nothing to remove, the format is not handled
 * (GIF, AVIF) or the file does not parse. `ext` is the detected extension ('.jpg', '.png', ...).
 */
function stripImageMetadata(buf, ext) {
    const strip = STRIPPERS[ext === '.jpeg' ? '.jpg' : ext];
    if (!strip || !Buffer.isBuffer(buf)) return buf;
    try {
        return strip(buf) || buf;
    } catch {
        return buf;
    }
}

module.exports = { stripImageMetadata, readExifOrientation };
