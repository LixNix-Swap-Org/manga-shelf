// iCalendar writer (RFC 5545) for the release feed, plus SHA-256 for its token: core/ has neither WebCrypto nor
// Node's crypto, and the feed handler runs here.

const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function utf8Bytes(text) {
    const out = [];
    for (const ch of String(text)) {
        const c = ch.codePointAt(0);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a UTF-8 string as lower-case hex. */
function sha256Hex(text) {
    const bytes = utf8Bytes(text);
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const high = Math.floor(bitLength / 0x100000000);
    for (let i = 3; i >= 0; i--) bytes.push((high >>> (8 * i)) & 0xff);
    for (let i = 3; i >= 0; i--) bytes.push((bitLength >>> (8 * i)) & 0xff);

    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let offset = 0; offset < bytes.length; offset += 64) {
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) | 0;
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** TEXT value: backslash, semicolon, comma and line breaks escaped. */
function escapeText(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds a content line at 75 octets (continuation lines start with a space), never inside a UTF-8 sequence. */
function foldLine(line) {
    const parts = [];
    let current = '';
    let octets = 0;
    for (const ch of line) {
        const size = utf8Bytes(ch).length;
        if (octets + size > 75) {
            parts.push(current);
            current = ' ';
            octets = 1;
        }
        current += ch;
        octets += size;
    }
    parts.push(current);
    return parts.join('\r\n');
}

const pad = (n, len = 2) => String(n).padStart(len, '0');

/** UTC timestamp for DTSTAMP: 20261004T081500Z. */
function formatStamp(date) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' -> { start: 'YYYYMMDD', end: next day } for an all-day event; null for month-only or invalid dates. */
function allDay(value) {
    const m = DAY.exec(String(value || '').trim());
    if (!m) return null;
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (date.getUTCMonth() !== Number(m[2]) - 1 || date.getUTCDate() !== Number(m[3])) return null;
    const next = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
    return { start: fmt(date), end: fmt(next) };
}

/**
 * The whole calendar as text with CRLF line ends. events: [{ uid, date: 'YYYY-MM-DD', summary, description?,
 * categories? }]; events without a full date are left out.
 */
function buildCalendar({ name, description, events, now, refreshHours = 6 }) {
    const stamp = formatStamp(now);
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Manga Shelf//Erscheinungstermine//DE',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeText(name)}`,
        `NAME:${escapeText(name)}`,
        `REFRESH-INTERVAL;VALUE=DURATION:PT${refreshHours}H`,
        `X-PUBLISHED-TTL:PT${refreshHours}H`
    ];
    if (description) lines.push(`X-WR-CALDESC:${escapeText(description)}`);
    for (const event of events) {
        const day = allDay(event.date);
        if (!day) continue;
        lines.push(
            'BEGIN:VEVENT',
            `UID:${escapeText(event.uid)}`,
            `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${day.start}`,
            `DTEND;VALUE=DATE:${day.end}`,
            `SUMMARY:${escapeText(event.summary)}`
        );
        if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
        if (event.categories) lines.push(`CATEGORIES:${escapeText(event.categories)}`);
        lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { sha256Hex, escapeText, foldLine, formatStamp, allDay, buildCalendar };
