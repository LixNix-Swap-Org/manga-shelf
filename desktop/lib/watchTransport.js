const MAX_BODY_BYTES = 8 * 1024 * 1024;
const METHODS = ['GET', 'POST'];

const transportError = (code) => Object.assign(new Error(code), { code });

/** [name, value] pairs of a raw header list or a header record. */
function headerPairs(raw, record) {
    const pairs = [];
    if (Array.isArray(raw) && raw.length) {
        for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), String(raw[i + 1])]);
        return pairs;
    }
    for (const [name, value] of Object.entries(record || {})) {
        for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined && v !== null) pairs.push([name, String(v)]);
    }
    return pairs;
}

/** Response headers with lower-cased names, repeated ones joined with ', '. */
function joinHeaders(pairs) {
    const out = {};
    for (const [name, value] of pairs) {
        const key = name.toLowerCase();
        out[key] = key in out ? `${out[key]}, ${value}` : value;
    }
    return out;
}

/** One Set-Cookie value as { name, value, expires (ms or null) }; Max-Age wins over Expires. */
function parseSetCookie(header, now = Date.now()) {
    const parts = String(header).split(';');
    const first = parts.shift();
    const eq = first.indexOf('=');
    if (eq <= 0) return null;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return null;
    let maxAge = null;
    let expires = null;
    for (const part of parts) {
        const at = part.indexOf('=');
        const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
        const attr = at < 0 ? '' : part.slice(at + 1).trim();
        if (key === 'max-age' && /^-?\d+$/.test(attr)) maxAge = Number(attr);
        else if (key === 'expires') {
            const ms = Date.parse(attr);
            if (Number.isFinite(ms)) expires = ms;
        }
    }
    if (maxAge !== null) return { name, value, expires: maxAge <= 0 ? 0 : now + maxAge * 1000 };
    return { name, value, expires };
}

const cookiesOf = (pairs, now) => pairs
    .filter(([name]) => name.toLowerCase() === 'set-cookie')
    .map(([, value]) => parseSetCookie(value, now))
    .filter(Boolean);

/** Requests to the Crunchyroll API from the main process: no session cookies, no redirects, a deadline and a size cap. */
function createTransport({ net, session, userAgent, isAllowedUrl, deadlineMs }) {
    return function send(request) {
        return new Promise((resolve, reject) => {
            const method = String((request && request.method) || 'GET').toUpperCase();
            if (!request || !isAllowedUrl(request.url) || !METHODS.includes(method)) {
                reject(transportError('not_allowed'));
                return;
            }
            let settled = false;
            let req = null;
            let timer = null;
            const abort = () => {
                try { if (req) req.abort(); } catch (_) { /* already closed */ }
            };
            const settle = (fn, value, close = true) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
                if (close) abort();
            };
            const fail = () => settle(reject, transportError('network'));
            const answer = (status, pairs, text, close) => settle(resolve, { status, headers: joinHeaders(pairs), text, cookies: cookiesOf(pairs, Date.now()) }, close);
            try {
                req = net.request({ method, url: request.url, session, credentials: 'omit', redirect: 'manual' });
                for (const [name, value] of Object.entries(request.headers || {})) {
                    if (name.toLowerCase() !== 'user-agent') req.setHeader(name, String(value));
                }
                req.setHeader('User-Agent', userAgent);
            } catch (_) {
                fail();
                return;
            }
            timer = setTimeout(fail, deadlineMs);
            req.on('redirect', (status, _method, _url, headers) => answer(status, headerPairs(null, headers), ''));
            req.on('response', (response) => {
                const chunks = [];
                let size = 0;
                response.on('data', (chunk) => {
                    if (settled) return;
                    size += chunk.length;
                    if (size > MAX_BODY_BYTES) fail();
                    else chunks.push(chunk);
                });
                response.on('end', () => answer(response.statusCode, headerPairs(response.rawHeaders, response.headers), Buffer.concat(chunks).toString('utf8'), false));
                response.on('error', fail);
                response.on('aborted', fail);
            });
            req.on('error', fail);
            req.on('abort', fail);
            try {
                if (request.body !== undefined && request.body !== null) req.write(String(request.body));
                req.end();
            } catch (_) {
                fail();
            }
        });
    };
}

module.exports = { createTransport, parseSetCookie, joinHeaders, headerPairs, MAX_BODY_BYTES };
