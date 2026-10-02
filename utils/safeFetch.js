const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 192 && b === 0) ||
            (a === 198 && (b === 18 || b === 19)) ||
            a >= 224;
    }
    if (net.isIPv6(address)) {
        const lower = address.toLowerCase();
        if (lower === '::' || lower === '::1') return true;
        const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateAddress(mapped[1]);
        return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
    }
    return true;
}

/**
 * DNS lookup that refuses non-public addresses. Because the connection uses the very address
 * validated here, DNS rebinding between check and connect is not possible.
 */
function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
        if (list.length === 0 || list.some(a => isPrivateAddress(a.address))) {
            return callback(new Error('Zieladresse nicht erlaubt'));
        }
        if (options && options.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
    });
}

function detectImageExt(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
    if (buf.slice(0, 4).toString('ascii') === 'GIF8') return '.gif';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
    if (buf.slice(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(buf.slice(8, 12).toString('ascii'))) return '.avif';
    return null;
}

function requestOnce(url, depthLeft, resolve, reject) {
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
    if (net.isIP(parsed.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(parsed.hostname.replace(/^\[|\]$/g, ''))) {
        return reject(new Error('Zieladresse nicht erlaubt'));
    }

    const client = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
    };

    const req = client.get(parsed, {
        headers: { 'User-Agent': 'MangaShelf', 'Accept': 'image/*' },
        lookup: safeLookup,
        timeout: TIMEOUT_MS
    }, (res) => {
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (depthLeft <= 0) return finish(reject, new Error('Zu viele Weiterleitungen'));
            let next;
            try { next = new URL(res.headers.location, parsed).toString(); } catch (e) { return finish(reject, new Error('Ungültige Weiterleitung')); }
            settled = true;
            return requestOnce(next, depthLeft - 1, resolve, reject);
        }
        if (status !== 200) {
            res.resume();
            return finish(reject, new Error('Bild konnte nicht geladen werden (Status ' + status + ')'));
        }
        const declared = parseInt(res.headers['content-length'], 10);
        if (declared > MAX_IMAGE_BYTES) {
            res.resume();
            return finish(reject, new Error('Bild ist zu groß'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_IMAGE_BYTES) {
                req.destroy();
                return finish(reject, new Error('Bild ist zu groß'));
            }
            chunks.push(chunk);
        });
        res.on('end', () => finish(resolve, Buffer.concat(chunks)));
        res.on('error', (err) => finish(reject, err));
        res.on('aborted', () => finish(reject, new Error('Download abgebrochen')));
    });

    req.on('timeout', () => {
        req.destroy();
        finish(reject, new Error('Download-Zeitüberschreitung'));
    });
    req.on('error', (err) => finish(reject, err));
}

/**
 * Downloads an image from a remote URL with SSRF protection (public addresses only), a size cap,
 * a timeout and magic-byte verification. Resolves with { buffer, ext }.
 */
function fetchRemoteImage(url) {
    return new Promise((resolve, reject) => {
        requestOnce(url, MAX_REDIRECTS, (buffer) => {
            const ext = detectImageExt(buffer);
            if (!ext) return reject(new Error('Die Datei ist kein gültiges Bild'));
            resolve({ buffer, ext });
        }, reject);
    });
}

module.exports = { fetchRemoteImage, isPrivateAddress, detectImageExt, MAX_IMAGE_BYTES };
