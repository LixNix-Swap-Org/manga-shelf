const test = require('node:test');
const assert = require('node:assert/strict');
const { stripImageMetadata, readExifOrientation } = require('../utils/imageMeta');

const latin = (s) => Buffer.from(s, 'latin1');
const seg = (marker, payload) => {
    const head = Buffer.from([0xff, marker, 0, 0]);
    head.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([head, payload]);
};

/** APP1 EXIF payload with a Make string and an Orientation tag. */
function exifPayload({ orientation, text = 'GPS-SECRET 52.5N 13.4E', littleEndian = false }) {
    const str = latin(text + '\0');
    const strOffset = 8 + 2 + 2 * 12 + 4;
    const tiff = Buffer.alloc(strOffset + str.length);
    const w16 = (v, o) => (littleEndian ? tiff.writeUInt16LE(v, o) : tiff.writeUInt16BE(v, o));
    const w32 = (v, o) => (littleEndian ? tiff.writeUInt32LE(v, o) : tiff.writeUInt32BE(v, o));
    tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1');
    w16(42, 2);
    w32(8, 4);
    w16(2, 8);
    w16(0x010f, 10); w16(2, 12); w32(str.length, 14); w32(strOffset, 18);
    w16(0x0112, 22); w16(3, 24); w32(1, 26); w16(orientation, 30);
    w32(0, 34);
    str.copy(tiff, strOffset);
    return Buffer.concat([latin('Exif\0\0'), tiff]);
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const JFIF = seg(0xe0, latin('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'));
const ICC = seg(0xe2, Buffer.concat([latin('ICC_PROFILE\0\x01\x01'), Buffer.alloc(20, 7)]));
const MPF = seg(0xe2, latin('MPF\0 secondary image index'));
const ADOBE = seg(0xee, latin('Adobe\0\x64\0\0\0\0\x01'));
const XMP = seg(0xe1, latin('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS-SECRET</x:xmpmeta>'));
const IPTC = seg(0xed, latin('Photoshop 3.0\0GPS-SECRET'));
const COM = seg(0xfe, latin('GPS-SECRET comment'));
const DQT = seg(0xdb, Buffer.alloc(65, 1));
const SOF = seg(0xc0, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0]));
const DHT = seg(0xc4, Buffer.alloc(20, 2));
const SOS = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
// entropy-coded data with a stuffed 0xFF and a restart marker, which are not segment boundaries
const SCAN = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56]);
const TRAILER = latin('second image with GPS-SECRET');

test('JPEG: EXIF, XMP, IPTC, comments, MPF and data after EOI go; JFIF, ICC, Adobe and the image data stay', () => {
    const input = Buffer.concat([SOI, JFIF, seg(0xe1, exifPayload({ orientation: 6 })), XMP, ICC, MPF, IPTC, COM, ADOBE, DQT, SOF, SOS, SCAN, EOI, TRAILER]);
    const out = stripImageMetadata(input, '.jpg');
    assert.equal(out.includes('GPS-SECRET'), false);
    assert.equal(out.includes('MPF'), false);
    const expectedTail = Buffer.concat([ICC, ADOBE, DQT, SOF, SOS, SCAN, EOI]);
    assert.deepEqual(out.subarray(out.length - expectedTail.length), expectedTail);
    assert.deepEqual(out.subarray(0, 2 + JFIF.length), Buffer.concat([SOI, JFIF]), 'JFIF stays first');
    const app1 = out.subarray(2 + JFIF.length);
    assert.deepEqual([app1[0], app1[1]], [0xff, 0xe1], 'the orientation block follows JFIF');
    const payload = app1.subarray(4, 2 + app1.readUInt16BE(2));
    assert.equal(readExifOrientation(payload), 6);
    assert.equal(payload.length, 32, 'nothing but the orientation tag');
});

test('JPEG: orientation 1 or none adds no EXIF block; little-endian EXIF is read too', () => {
    for (const orientation of [1, 0]) {
        const input = Buffer.concat([SOI, seg(0xe1, exifPayload({ orientation })), DQT, SOS, SCAN, EOI]);
        assert.deepEqual(stripImageMetadata(input, '.jpeg'), Buffer.concat([SOI, DQT, SOS, SCAN, EOI]));
    }
    assert.equal(readExifOrientation(exifPayload({ orientation: 8, littleEndian: true })), 8);
    const input = Buffer.concat([SOI, seg(0xe1, exifPayload({ orientation: 3, littleEndian: true })), DQT, SOS, SCAN, EOI]);
    const out = stripImageMetadata(input, '.jpg');
    assert.equal(readExifOrientation(out.subarray(6, 6 + 32)), 3);
});

test('JPEG: progressive scans with tables and a comment between them keep every scan', () => {
    const input = Buffer.concat([SOI, JFIF, DQT, SOF, DHT, SOS, SCAN, DHT, COM, SOS, SCAN, EOI]);
    assert.deepEqual(stripImageMetadata(input, '.jpg'), Buffer.concat([SOI, JFIF, DQT, SOF, DHT, SOS, SCAN, DHT, SOS, SCAN, EOI]));
});

test('JPEG: nothing to remove or a broken structure returns the very same buffer', () => {
    const clean = Buffer.concat([SOI, JFIF, DQT, SOF, SOS, SCAN, EOI]);
    assert.equal(stripImageMetadata(clean, '.jpg'), clean);
    const badLength = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0xff, 0xff, 1, 2, 3])]);
    assert.equal(stripImageMetadata(badLength, '.jpg'), badLength);
    const garbage = Buffer.concat([SOI, Buffer.from([0x00, 0x01, 0x02, 0x03])]);
    assert.equal(stripImageMetadata(garbage, '.jpg'), garbage);
});

const pngChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, latin(type), data, Buffer.alloc(4, 9)]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('PNG: text and EXIF chunks and data after IEND go, image chunks stay in order', () => {
    const IHDR = pngChunk('IHDR', Buffer.alloc(13, 1));
    const IDAT = pngChunk('IDAT', Buffer.alloc(30, 2));
    const IEND = pngChunk('IEND', Buffer.alloc(0));
    const iCCP = pngChunk('iCCP', Buffer.alloc(10, 3));
    const input = Buffer.concat([PNG_SIG, IHDR, pngChunk('tEXt', latin('Comment\0GPS-SECRET')), iCCP, pngChunk('eXIf', exifPayload({ orientation: 6 }).subarray(6)),
        IDAT, pngChunk('iTXt', latin('XML:com.adobe.xmp\0\0\0\0\0GPS-SECRET')), pngChunk('zTXt', latin('k\0\0x')), IEND, latin('GPS-SECRET')]);
    assert.deepEqual(stripImageMetadata(input, '.png'), Buffer.concat([PNG_SIG, IHDR, iCCP, IDAT, IEND]));
    const clean = Buffer.concat([PNG_SIG, IHDR, IDAT, IEND]);
    assert.equal(stripImageMetadata(clean, '.png'), clean);
    const truncated = Buffer.concat([PNG_SIG, IHDR, pngChunk('tEXt', latin('a\0b')).subarray(0, 10)]);
    assert.equal(stripImageMetadata(truncated, '.png'), truncated);
});

const webpChunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const riff = (body) => {
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length + 4, 4);
    head.write('WEBP', 8, 'latin1');
    return Buffer.concat([head, body]);
};

test('WebP: EXIF and XMP chunks go, their VP8X flags are cleared, the ICC flag and image stay', () => {
    const vp8x = (flags) => webpChunk('VP8X', Buffer.from([flags, 0, 0, 0, 7, 0, 0, 7, 0, 0]));
    const ICCP = webpChunk('ICCP', Buffer.alloc(11, 5));
    const VP8 = webpChunk('VP8 ', Buffer.alloc(41, 6));
    const input = Buffer.concat([riff(Buffer.concat([vp8x(0x20 | 0x08 | 0x04), ICCP, VP8, webpChunk('EXIF', exifPayload({ orientation: 6 })), webpChunk('XMP ', latin('GPS-SECRET!'))])), latin('trailing')]);
    const out = stripImageMetadata(input, '.webp');
    assert.deepEqual(out, riff(Buffer.concat([vp8x(0x20), ICCP, VP8])));
    assert.equal(out.readUInt32LE(4), out.length - 8);
    const clean = riff(Buffer.concat([vp8x(0x20), ICCP, VP8]));
    assert.equal(stripImageMetadata(clean, '.webp'), clean);
});

test('GIF, AVIF and unknown inputs are returned unchanged', () => {
    const gif = latin('GIF89a GPS-SECRET');
    assert.equal(stripImageMetadata(gif, '.gif'), gif);
    assert.equal(stripImageMetadata(gif, '.avif'), gif);
    assert.equal(stripImageMetadata('not a buffer', '.jpg'), 'not a buffer');
});

test('JPEG: RSTn or TEM outside a scan is refused, the buffer comes back unchanged', () => {
    for (const marker of [0xd0, 0xd7, 0x01]) {
        const input = Buffer.concat([SOI, Buffer.from([0xff, marker]), COM, DQT, SOS, SCAN, EOI]);
        assert.equal(stripImageMetadata(input, '.jpg'), input);
    }
});

test('JPEG: many segments below the cap are all handled; above the cap the file is left alone', () => {
    const pairs = 2000;
    const body = [];
    for (let i = 0; i < pairs; i++) body.push(DQT, COM);
    const input = Buffer.concat([SOI, ...body, SOS, SCAN, EOI]);
    const out = stripImageMetadata(input, '.jpg');
    assert.equal(out.includes('GPS-SECRET'), false);
    assert.equal(out.length, input.length - pairs * COM.length);
    const tooMany = Buffer.concat([SOI, ...body, ...body.slice(0, 200), SOS, SCAN, EOI]);
    assert.equal(stripImageMetadata(tooMany, '.jpg'), tooMany);
});

function heapGrowthMB(fn) {
    const before = process.memoryUsage();
    const result = fn();
    const after = process.memoryUsage();
    const growth = Math.max(after.rss - before.rss, after.heapUsed - before.heapUsed);
    return { result, growthMB: growth / 1024 / 1024 };
}

test('15 MB marker-dense files are refused with bounded memory', () => {
    const size = 15 * 1024 * 1024;
    const rst = Buffer.alloc(size);
    for (let i = 0; i < size; i += 2) { rst[i] = 0xff; rst[i + 1] = 0xd0; }
    rst[1] = 0xd8;
    const shortDqt = Buffer.alloc(size);
    shortDqt[0] = 0xff; shortDqt[1] = 0xd8;
    for (let i = 2; i + 4 <= size; i += 4) { shortDqt[i] = 0xff; shortDqt[i + 1] = 0xdb; shortDqt[i + 3] = 2; }
    const comAndDqt = Buffer.alloc(size);
    comAndDqt[0] = 0xff; comAndDqt[1] = 0xd8;
    for (let i = 2; i + 8 <= size; i += 8) {
        comAndDqt.set([0xff, 0xfe, 0, 2, 0xff, 0xdb, 0, 2], i);
    }
    const png = Buffer.alloc(size);
    PNG_SIG.copy(png);
    for (let i = 8, n = 0; i + 12 <= size; i += 12, n++) png.write(n % 2 ? 'IDAT' : 'tEXt', i + 4, 'latin1');
    const webp = Buffer.alloc(size);
    webp.write('RIFF', 0, 'latin1');
    webp.writeUInt32LE(size - 8, 4);
    webp.write('WEBP', 8, 'latin1');
    for (let i = 12, n = 0; i + 8 <= size; i += 8, n++) webp.write(n % 2 ? 'VP8 ' : 'EXIF', i, 'latin1');

    for (const [name, buf, ext] of [['rst', rst, '.jpg'], ['dqt', shortDqt, '.jpg'], ['com', comAndDqt, '.jpg'], ['png', png, '.png'], ['webp', webp, '.webp']]) {
        const { result, growthMB } = heapGrowthMB(() => stripImageMetadata(buf, ext));
        assert.equal(result, buf, `${name}: left unchanged`);
        assert.ok(growthMB < 100, `${name}: grew by ${growthMB.toFixed(1)} MB`);
    }
});

test('a 15 MB JPEG with a large scan is stripped in one pass', () => {
    const scan = Buffer.alloc(15 * 1024 * 1024 - 4096, 0x5a);
    for (let i = 0; i < scan.length; i += 64) { scan[i] = 0xff; scan[i + 1] = i % 128 ? 0x00 : 0xd1; }
    const input = Buffer.concat([SOI, JFIF, seg(0xe1, exifPayload({ orientation: 6 })), DQT, SOF, SOS, scan, EOI]);
    const { result, growthMB } = heapGrowthMB(() => stripImageMetadata(input, '.jpg'));
    assert.equal(result.includes('GPS-SECRET'), false);
    assert.deepEqual(result.subarray(result.length - scan.length - 2), Buffer.concat([scan, EOI]));
    assert.ok(growthMB < 100, `grew by ${growthMB.toFixed(1)} MB`);
});
