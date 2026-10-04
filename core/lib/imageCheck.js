// Image type from the first bytes (magic bytes), on any byte array (Buffer, Uint8Array). Shared by the server's
// safe download and upload checks and by the device downloads in the apps.

const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const AVIF_BRANDS = new Set(['avif', 'avis']);

const ascii = (buf, start, end) => {
    let text = '';
    for (let i = start; i < Math.min(end, buf.length); i++) text += String.fromCharCode(buf[i]);
    return text;
};

const uint32 = (buf, at) => ((buf[at] << 24) | (buf[at + 1] << 16) | (buf[at + 2] << 8) | buf[at + 3]) >>> 0;

/** AVIF writers may use a generic major brand ('mif1', 'miaf') and list avif only among the compatible brands. */
function isAvifFtyp(buf) {
    if (ascii(buf, 4, 8) !== 'ftyp') return false;
    const boxEnd = Math.min(uint32(buf, 0), buf.length);
    if (AVIF_BRANDS.has(ascii(buf, 8, 12))) return true;
    for (let i = 16; i + 4 <= boxEnd; i += 4) {
        if (AVIF_BRANDS.has(ascii(buf, i, i + 4))) return true;
    }
    return false;
}

/** Image extension from the first bytes (at least 12; pass 64 or more so AVIF compatible brands are seen). */
function detectImageExt(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (PNG_SIGNATURE.every((b, i) => buf[i] === b)) return '.png';
    if (ascii(buf, 0, 4) === 'GIF8') return '.gif';
    if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return '.webp';
    if (isAvifFtyp(buf)) return '.avif';
    return null;
}

/** ctx.http.fetchImage plus the magic-byte check here, whatever the host's download already checked. */
async function fetchImage(ctx, url) {
    const image = await ctx.http.fetchImage(url);
    const ext = detectImageExt(image && image.buffer);
    if (!ext) throw new Error('Die Datei ist kein gültiges Bild');
    return { buffer: image.buffer, ext };
}

module.exports = { detectImageExt, fetchImage, ALLOWED_IMAGE_EXTS };
