const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { makeSafeLookup, isPrivateAddress } = require('../../utils/safeFetch');
const { ALLOWED_HOSTS, MAX_API_BYTES, MAX_SMALL_BYTES, MAX_ASSET_BYTES } = require('./constants');
const { updateError } = require('./errors');
const log = require('../../utils/logger').child('update');
const pkg = require('../../package.json');

const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 30000;
const safeLookup = makeSafeLookup(isPrivateAddress);
const active = new Set();

/** The URL when it is https to an allow-listed host on the default port without credentials; throws DOWNLOAD_HOST. */
function allowedUrl(raw) {
    let url;
    try {
        url = new URL(String(raw));
    } catch (e) {
        throw updateError('DOWNLOAD_HOST');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port !== '' || !ALLOWED_HOSTS.includes(url.hostname)) {
        throw updateError('DOWNLOAD_HOST');
    }
    return url;
}

const withoutQuery = (url) => `${url.origin}${url.pathname}`;

function failed(cause, extra) {
    const err = updateError('DOWNLOAD_FAILED');
    if (extra) Object.assign(err, extra);
    if (cause) err.cause = cause;
    return err;
}

function mapError(err, ctl) {
    if (err && err.expose && err.code) return err;
    if (ctl && ctl.signal.aborted) return ctl.deadline ? failed(err) : updateError('DOWNLOAD_ABORTED');
    return failed(err);
}

function open(url, opts, ctl, depth) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, {
            method: 'GET',
            headers: { 'User-Agent': `manga-shelf/${pkg.version}`, Accept: opts.accept || '*/*', ...(opts.headers || {}) },
            agent: opts.agent,
            lookup: safeLookup,
            signal: ctl.signal,
            timeout: opts.idleTimeoutMs || IDLE_TIMEOUT_MS
        }, (res) => {
            const status = res.statusCode;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (depth >= MAX_REDIRECTS) return reject(failed(null, { reason: 'redirects' }));
                let next;
                try {
                    next = allowedUrl(new URL(res.headers.location, url).toString());
                } catch (err) {
                    log.warn(`[Update] Weiterleitung abgelehnt von ${withoutQuery(url)}`);
                    return reject(err);
                }
                return open(next, opts, ctl, depth + 1).then(resolve, reject);
            }
            if (status !== 200) {
                res.resume();
                return reject(failed(null, { httpStatus: status, headers: res.headers }));
            }
            const declared = Number.parseInt(res.headers['content-length'], 10);
            if (Number.isFinite(declared) && declared > opts.maxBytes) {
                res.destroy();
                return reject(updateError('DOWNLOAD_TOO_LARGE'));
            }
            resolve({ res, url, declared: Number.isFinite(declared) ? declared : null });
        });
        req.on('socket', (socket) => {
            if (!socket.connecting) return;
            const timer = setTimeout(() => req.destroy(failed(null, { reason: 'connect_timeout' })), opts.connectTimeoutMs || CONNECT_TIMEOUT_MS);
            const clear = () => clearTimeout(timer);
            socket.once('secureConnect', clear);
            socket.once('close', clear);
        });
        req.on('timeout', () => req.destroy(failed(null, { reason: 'idle_timeout' })));
        req.on('error', (err) => reject(mapError(err, ctl)));
        req.end();
    });
}

function controller(opts) {
    const ctl = new AbortController();
    ctl.deadline = false;
    const onAbort = () => ctl.abort();
    if (opts.signal) {
        if (opts.signal.aborted) ctl.abort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer = null;
    if (opts.deadlineMs) {
        timer = setTimeout(() => { ctl.deadline = true; ctl.abort(); }, opts.deadlineMs);
        timer.unref();
    }
    active.add(ctl);
    ctl.done = () => {
        active.delete(ctl);
        if (timer) clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };
    return ctl;
}

/** Body of a GET as a Buffer, at most `maxBytes`. Options: accept, headers, maxBytes, signal, deadlineMs, agent. */
async function fetchBuffer(rawUrl, opts = {}) {
    const options = { maxBytes: MAX_SMALL_BYTES, ...opts };
    const ctl = controller(options);
    try {
        const { res, declared } = await open(allowedUrl(rawUrl), options, ctl, 0);
        const chunks = [];
        let size = 0;
        for await (const chunk of res) {
            size += chunk.length;
            if (size > options.maxBytes) {
                res.destroy();
                throw updateError('DOWNLOAD_TOO_LARGE');
            }
            chunks.push(chunk);
        }
        if (declared !== null && size !== declared) throw failed(null, { reason: 'length' });
        return Buffer.concat(chunks);
    } catch (err) {
        throw mapError(err, ctl);
    } finally {
        ctl.done();
    }
}

const fetchText = async (url, opts = {}) => (await fetchBuffer(url, opts)).toString('utf8');

/** GitHub API JSON (2 MB cap by default). */
async function fetchJson(url, opts = {}) {
    const body = await fetchBuffer(url, {
        maxBytes: MAX_API_BYTES,
        accept: 'application/vnd.github+json',
        ...opts,
        headers: { 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) }
    });
    try {
        return JSON.parse(body.toString('utf8'));
    } catch (e) {
        throw failed(e, { reason: 'json' });
    }
}

/** Streams into `<dest>.part` while hashing, renamed to `dest` when size and hash match; resolves { sha256, size }. */
async function fetchToFile(rawUrl, { dest, maxBytes = MAX_ASSET_BYTES, expectedSha256 = null, expectedSize = null, onProgress, ...opts } = {}) {
    const options = { maxBytes, accept: 'application/octet-stream', ...opts };
    const part = `${dest}.part`;
    const ctl = controller(options);
    let fh = null;
    try {
        try { fs.unlinkSync(part); } catch (e) {}
        fh = await fs.promises.open(part, 'wx', 0o600);
        const { res, declared } = await open(allowedUrl(rawUrl), options, ctl, 0);
        if (expectedSize !== null && declared !== null && declared !== expectedSize) {
            res.destroy();
            throw failed(null, { reason: 'length' });
        }
        const hash = crypto.createHash('sha256');
        let size = 0;
        for await (const chunk of res) {
            size += chunk.length;
            if (size > maxBytes || (expectedSize !== null && size > expectedSize)) {
                res.destroy();
                throw updateError('DOWNLOAD_TOO_LARGE');
            }
            hash.update(chunk);
            await fh.write(chunk);
            if (onProgress) onProgress(size, expectedSize ?? declared);
        }
        if ((declared !== null && size !== declared) || (expectedSize !== null && size !== expectedSize)) throw failed(null, { reason: 'length' });
        const sha256 = hash.digest('hex');
        if (expectedSha256 && sha256 !== expectedSha256) throw updateError('CHECKSUM_MISMATCH');
        await fh.sync();
        await fh.close();
        fh = null;
        fs.renameSync(part, dest);
        return { sha256, size };
    } catch (err) {
        if (fh) await fh.close().catch(() => {});
        try { fs.unlinkSync(part); } catch (e) {}
        throw mapError(err, ctl);
    } finally {
        ctl.done();
    }
}

/** Aborts every running download (shutdown, discarded staging). */
function abortAll() {
    for (const ctl of [...active]) ctl.abort();
}

const activeDownloads = () => active.size;

module.exports = { allowedUrl, fetchBuffer, fetchText, fetchJson, fetchToFile, abortAll, activeDownloads, CONNECT_TIMEOUT_MS, IDLE_TIMEOUT_MS };
