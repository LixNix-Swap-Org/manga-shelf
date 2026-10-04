const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;
const TOTAL_TIMEOUT_MS = 30000;
const USER_AGENT = 'MangaShelf (+https://github.com/MoltresHD/manga-shelf)';

function isPrivateIPv4(address) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||   // the rest of 192.0/16 is public (e.g. i0.wp.com)
        (a === 192 && b === 88 && c === 99) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224;
}

/** Expands an IPv6 address (any notation, incl. "::" and a trailing dotted IPv4) to 8 numbers. */
function ipv6Groups(address) {
    let addr = address.toLowerCase().replace(/%.*$/, '');
    const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) {
        const [a, b, c, d] = v4[1].split('.').map(Number);
        addr = addr.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
    }
    const [head, tail] = addr.split('::');
    const parse = part => (part ? part.split(':').map(h => parseInt(h, 16)) : []);
    const left = parse(head);
    const right = parse(tail);
    const zeros = tail === undefined ? [] : new Array(8 - left.length - right.length).fill(0);
    return [...left, ...zeros, ...right];
}

const v4FromGroups = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');

/**
 * True for loopback, private, link-local, CGNAT, multicast and other non-public addresses.
 * IPv6 is compared numerically, because the URL parser and DNS write the same address in
 * different notations ("[::ffff:127.0.0.1]" becomes "[::ffff:7f00:1]"). IPv6 forms that carry
 * an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by that IPv4 address.
 */
function isPrivateAddress(address) {
    if (net.isIPv4(address)) return isPrivateIPv4(address);
    if (!net.isIPv6(address)) return true;
    const g = ipv6Groups(address);
    if (g.length !== 8 || g.some(n => !Number.isInteger(n))) return true;
    const zeroUntil = n => g.slice(0, n).every(x => x === 0);
    if (zeroUntil(8)) return true;                                          // ::
    if (zeroUntil(7) && g[7] === 1) return true;                            // ::1
    if (zeroUntil(5) && g[5] === 0xffff) return isPrivateIPv4(v4FromGroups(g[6], g[7]));   // ::ffff:a.b.c.d
    if (zeroUntil(4) && g[4] === 0xffff && g[5] === 0) return isPrivateIPv4(v4FromGroups(g[6], g[7]));
    if (zeroUntil(6)) return isPrivateIPv4(v4FromGroups(g[6], g[7]));    // ::a.b.c.d (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b) {                                 // NAT64
        if (g[2] === 1) return true;                                        // 64:ff9b:1::/48 local use
        return isPrivateIPv4(v4FromGroups(g[6], g[7]));
    }
    if (g[0] === 0x2002) return isPrivateIPv4(v4FromGroups(g[1], g[2]));   // 6to4
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;     // Teredo, documentation
    if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true;  // 100::/64 discard
    return (g[0] & 0xfe00) === 0xfc00 ||                                    // fc00::/7 unique local
        (g[0] & 0xffc0) === 0xfe80 ||                                       // fe80::/10 link-local
        (g[0] & 0xffc0) === 0xfec0 ||                                       // fec0::/10 site-local
        (g[0] & 0xff00) === 0xff00;                                         // ff00::/8 multicast
}

/**
 * DNS lookup that refuses non-public addresses. Because the connection uses the very address
 * validated here, DNS rebinding between check and connect is not possible.
 */
function makeSafeLookup(isBlocked) {
    return (hostname, options, callback) => {
        dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return callback(err);
            const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
            if (list.length === 0 || list.some(a => isBlocked(a.address))) {
                return callback(new Error('Zieladresse nicht erlaubt'));
            }
            if (options && options.all) return callback(null, list);
            callback(null, list[0].address, list[0].family);
        });
    };
}

const AVIF_BRANDS = new Set(['avif', 'avis']);

/** AVIF writers may use a generic major brand ('mif1', 'miaf') and list avif only among the compatible brands. */
function isAvifFtyp(buf) {
    if (buf.slice(4, 8).toString('ascii') !== 'ftyp') return false;
    const boxEnd = Math.min(buf.readUInt32BE(0), buf.length);
    if (AVIF_BRANDS.has(buf.slice(8, 12).toString('ascii'))) return true;
    for (let i = 16; i + 4 <= boxEnd; i += 4) {
        if (AVIF_BRANDS.has(buf.slice(i, i + 4).toString('ascii'))) return true;
    }
    return false;
}

/** Image extension from the first bytes (at least 12; pass 64 or more so AVIF compatible brands are seen). */
function detectImageExt(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (buf.slice(0, 4).toString('ascii') === 'GIF8') return '.gif';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
    if (isAvifFtyp(buf)) return '.avif';
    return null;
}

function requestOnce(url, depthLeft, ctx) {
    const { reject } = ctx;
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return reject(new Error('Ungültige URL'));
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return reject(new Error('Nur http(s)-URLs sind erlaubt'));
    }
    if (parsed.username || parsed.password) {
        return reject(new Error('URLs mit Zugangsdaten sind nicht erlaubt'));
    }
    const literal = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && ctx.isBlocked(literal)) {
        return reject(new Error('Zieladresse nicht erlaubt'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'image/*' },
        lookup: ctx.lookup,
        timeout: ctx.idleTimeoutMs
    }, (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (depthLeft <= 0) return reject(new Error('Zu viele Weiterleitungen'));
            let next;
            try { next = new URL(res.headers.location, parsed).toString(); } catch (e) { return reject(new Error('Ungültige Weiterleitung')); }
            return requestOnce(next, depthLeft - 1, ctx);
        }
        if (status !== 200) {
            res.resume();
            return reject(new Error('Bild konnte nicht geladen werden (Status ' + status + ')'));
        }
        const declared = parseInt(res.headers['content-length'], 10);
        if (declared > MAX_IMAGE_BYTES) {
            res.resume();
            return reject(new Error('Bild ist zu groß'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES) {
                req.destroy();
                return reject(new Error('Bild ist zu groß'));
            }
            chunks.push(chunk);
        });
        res.on('end', () => ctx.resolve(Buffer.concat(chunks)));
        res.on('error', (err) => reject(err));
        res.on('aborted', () => reject(new Error('Download abgebrochen')));
    });
    ctx.current = req;

    req.on('timeout', () => {
        req.destroy();
        reject(new Error('Download-Zeitüberschreitung'));
    });
    req.on('error', (err) => reject(err));
}

/**
 * Downloads an image from a remote URL with SSRF protection (public addresses only), a size cap,
 * an idle timeout plus an overall deadline and magic-byte verification. Resolves with { buffer, ext }.
 * `options` exists for tests only; production callers pass just the URL.
 */
function fetchRemoteImage(url, options = {}) {
    const isBlocked = options.isBlockedAddress || isPrivateAddress;
    return new Promise((resolve, reject) => {
        let settled = false;
        const ctx = {
            isBlocked,
            lookup: makeSafeLookup(isBlocked),
            idleTimeoutMs: options.idleTimeoutMs || TIMEOUT_MS,
            current: null,
            resolve: (buffer) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                const ext = detectImageExt(buffer);
                if (!ext) return reject(new Error('Die Datei ist kein gültiges Bild'));
                resolve({ buffer, ext });
            },
            reject: (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                if (ctx.current) ctx.current.destroy();
                reject(err);
            }
        };
        // the idle timeout alone lets a server drip one byte every few seconds for hours
        const deadline = setTimeout(() => ctx.reject(new Error('Download-Zeitüberschreitung')), options.totalTimeoutMs || TOTAL_TIMEOUT_MS);
        requestOnce(url, MAX_REDIRECTS, ctx);
    });
}

module.exports = { fetchRemoteImage, isPrivateAddress, detectImageExt, MAX_IMAGE_BYTES };
