// One HTTP call of a source adapter over ctx.http.fetch: timeout, size cap, and every failure as a SourceError whose
// kind tells the budget what happened (rate limit, refused key, server error, network).
const { timeoutSignal, anySignal } = require('../lib/signals');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BYTES = 4 * 1024 * 1024;

class SourceError extends Error {
    /** kind: rate | auth | server | network | complexity | notfound | bad */
    /** graphql: the answer carried GraphQL error messages (a refused-like answer, see gateway refusedLike). */
    constructor(kind, message, { status = 0, retryAfterSec = null, resetAt = null, graphql = false } = {}) {
        super(message);
        this.name = 'SourceError';
        this.kind = kind;
        this.status = status;
        this.graphql = graphql;
        this.retryAfterSec = retryAfterSec;
        this.resetAt = resetAt;
    }

    /** Counts toward the circuit breaker of the source. */
    get isOutage() { return this.kind === 'server' || this.kind === 'network'; }
}

async function readCapped(res) {
    const declared = parseInt(res.headers.get('content-length'), 10);
    if (declared > MAX_BYTES) throw new Error('Antwort zu groß');
    if (!res.body || typeof res.body.getReader !== 'function') return typeof res.text === 'function' ? res.text() : '';
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error('Antwort zu groß');
        }
        chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
        all.set(chunk, at);
        at += chunk.length;
    }
    return new TextDecoder('utf-8').decode(all);
}

const headerNumber = (headers, name) => {
    const value = headers && typeof headers.get === 'function' ? headers.get(name) : null;
    const n = value === null || value === undefined || value === '' ? NaN : Number(value);
    return Number.isFinite(n) ? n : null;
};

/** The rate headers of an answer: { limit, remaining, reset (unix s), retryAfter (s) } (null where absent). */
const rateHeaders = (headers) => ({
    limit: headerNumber(headers, 'x-ratelimit-limit'),
    remaining: headerNumber(headers, 'x-ratelimit-remaining'),
    reset: headerNumber(headers, 'x-ratelimit-reset'),
    retryAfter: headerNumber(headers, 'retry-after')
});

/**
 * fetch + JSON. Resolves { status, headers, rate, json }; rejects with a SourceError. `label` names the source in
 * messages. A 404 is 'notfound', 401/403 and a GraphQL "Invalid token" 'auth', 429 'rate', 5xx 'server', a dropped or timed out request 'network'.
 */
async function requestJson(ctx, url, init = {}, { label, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    let res;
    try {
        res = await ctx.http.fetch(url, { ...init, signal: anySignal([signal, timeoutSignal(timeoutMs)]) });
    } catch (err) {
        throw new SourceError('network', `${label} nicht erreichbar (${err && err.name === 'TimeoutError' ? 'Zeitüberschreitung' : 'Netzwerkfehler'})`);
    }
    const rate = rateHeaders(res.headers);
    if (res.status === 429) {
        await res.body?.cancel?.().catch(() => {});
        throw new SourceError('rate', `${label}: zu viele Anfragen`, { status: 429, retryAfterSec: rate.retryAfter, resetAt: rate.reset });
    }
    let text;
    try {
        text = await readCapped(res);
    } catch (err) {
        throw new SourceError('network', `${label}: Antwort abgebrochen`, { status: res.status });
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* not JSON */ }
    if (res.status === 401 || res.status === 403) throw new SourceError('auth', `${label} lehnt den Schlüssel ab (${res.status})`, { status: res.status });
    if (res.status === 404) throw new SourceError('notfound', `${label}: nicht gefunden`, { status: 404 });
    if (res.status >= 500) throw new SourceError('server', `${label}: Serverfehler (HTTP ${res.status})`, { status: res.status });
    const graphqlErrors = json && Array.isArray(json.errors) ? json.errors : [];
    if (graphqlErrors.some((e) => /max query complexity/i.test(String(e && e.message)))) {
        throw new SourceError('complexity', `${label}: Anfrage zu komplex`, { status: res.status });
    }
    if (graphqlErrors.some((e) => e && (e.status === 429 || /too many requests/i.test(String(e.message))))) {
        throw new SourceError('rate', `${label}: zu viele Anfragen`, { status: 429, retryAfterSec: rate.retryAfter, resetAt: rate.reset });
    }
    // AniList answers an expired, revoked or made-up token with HTTP 400 { errors: [{ message: 'Invalid token' }] }
    if ((res.status === 400 || res.status === 401) && graphqlErrors.some((e) => e && /invalid token|unauthori[sz]ed/i.test(String(e.message)))) {
        throw new SourceError('auth', `${label} lehnt den Schlüssel ab (${res.status})`, { status: res.status });
    }
    if (res.status >= 400 || json === null) {
        const detail = graphqlErrors.map((e) => e && e.message).filter(Boolean).join('; ');
        throw new SourceError(res.status === 400 && graphqlErrors.some((e) => e && e.status === 404) ? 'notfound' : 'bad',
            `${label}: ungültige Antwort (HTTP ${res.status}${detail ? `: ${detail}` : ''})`, { status: res.status, graphql: Boolean(detail) });
    }
    return { status: res.status, headers: res.headers, rate, json };
}

module.exports = { SourceError, requestJson, rateHeaders, DEFAULT_TIMEOUT_MS };
