// ISBN lookup on the server: the HTTPS client for the catalogues; parsing and matching live in core/isbnLookup.js.
const https = require('https');
const core = require('../core/isbnLookup');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * GET a text document over HTTPS (overall deadline, size limit, HTTP errors and dropped connections rejected).
 * `get` is injectable so tests can use a plain HTTP server.
 */
function fetchTextHttps(url, timeoutMs = 7000, { get = https.get } = {}) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let req = null;
        const finish = (fn, value) => {
            if (settled) return false;
            settled = true;
            clearTimeout(deadline);
            fn(value);
            return true;
        };
        const fail = (err) => {
            if (finish(reject, err) && req) req.destroy();
        };
        // req.setTimeout is an idle timer: a server dripping a byte every few seconds would never trip it
        const deadline = setTimeout(() => fail(new Error('Timeout')), timeoutMs);
        try {
            req = get(url, { headers: { 'User-Agent': 'MangaShelf/2.0' } }, (res) => {
                if (res.statusCode >= 300) {
                    res.resume();
                    return fail(new Error(`HTTP ${res.statusCode}`));
                }
                const chunks = [];
                let size = 0;
                res.on('data', chunk => {
                    size += chunk.length;
                    if (size > MAX_BODY_BYTES) return fail(new Error('Antwort zu groß'));
                    chunks.push(chunk);
                });
                res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
                res.on('error', fail);
                res.on('aborted', () => fail(new Error('Verbindung abgebrochen')));
                res.on('close', () => { if (!res.complete) fail(new Error('Verbindung abgebrochen')); });
            });
        } catch (err) {
            return fail(err);
        }
        req.on('error', fail);
        req.setTimeout(timeoutMs, () => fail(new Error('Timeout')));
    });
}

const lookupBookByIsbn = (cleanIsbn, options) => core.lookupBookByIsbn(require('../db').createCtx(), cleanIsbn, options);

module.exports = { ...core, fetchTextHttps, lookupBookByIsbn };
