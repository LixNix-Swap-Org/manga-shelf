// Token buckets per access ('shared:anilist', 'user:7:anilist'): continuous refill, a reserve for interactive requests,
// feedback from the rate headers, pauses after 429 and a circuit breaker per bucket. Pure: every call takes nowMs.
const MINUTE = 60 * 1000;
const RESERVE_SHARE = 0.4;
const FAILURES_TO_OPEN = 3;
const OPEN_MS = 60 * 1000;
const DEFAULT_PAUSE_MS = 60 * 1000;
const SLOW_WINDOW_MS = 10 * MINUTE;

/**
 * options per bucket: { perMinute, burst?: { size, perMs } } (Jikan: 3 per second on top of 60 per minute).
 * `onChange(key, event)` is told about pauses, resumes and circuit changes (the gateway logs them).
 */
function createBudget({ onChange = () => {} } = {}) {
    const buckets = new Map();

    function bucket(key, options, nowMs) {
        let b = buckets.get(key);
        if (!b) {
            const perMinute = Math.max(1, Number(options && options.perMinute) || 30);
            b = {
                key, capacity: perMinute, tokens: perMinute, refilledAt: nowMs,
                burst: options && options.burst ? { size: options.burst.size, perMs: options.burst.perMs, tokens: options.burst.size, refilledAt: nowMs } : null,
                pausedUntil: 0, resetAt: null, headerRemaining: null,
                circuit: 'closed', failures: 0, openedAt: 0, probing: false,
                waitedAt: 0, used: []
            };
            buckets.set(key, b);
        } else if (options && options.perMinute && !b.fromHeader && options.perMinute !== b.capacity) {
            b.tokens = Math.min(b.tokens, options.perMinute);
            b.capacity = options.perMinute;
        }
        return b;
    }

    function refill(b, nowMs) {
        const elapsed = Math.max(0, nowMs - b.refilledAt);
        b.tokens = Math.min(b.capacity, b.tokens + (elapsed * b.capacity) / MINUTE);
        b.refilledAt = nowMs;
        if (b.burst) {
            const e = Math.max(0, nowMs - b.burst.refilledAt);
            b.burst.tokens = Math.min(b.burst.size, b.burst.tokens + (e * b.burst.size) / b.burst.perMs);
            b.burst.refilledAt = nowMs;
        }
        if (b.pausedUntil && b.pausedUntil <= nowMs) {
            b.pausedUntil = 0;
            onChange(b.key, 'resumed');
        }
        if (b.circuit === 'open' && nowMs - b.openedAt >= OPEN_MS) {
            b.circuit = 'half-open';
            b.probing = false;
            onChange(b.key, 'half-open');
        }
    }

    const floorFor = (b, priority) => (priority === 'interactive' ? 0 : b.capacity * RESERVE_SHARE);

    /** ms until a request of `priority` could take a token (0 = now); Infinity while paused/open for that priority. */
    function waitMs(key, options, priority, nowMs) {
        const b = bucket(key, options, nowMs);
        refill(b, nowMs);
        if (b.pausedUntil > nowMs) return b.pausedUntil - nowMs;
        if (b.circuit === 'open') return Infinity;
        if (b.circuit === 'half-open' && (b.probing || priority === 'interactive')) return Infinity;
        const needed = floorFor(b, priority) + 1;
        let wait = b.tokens >= needed ? 0 : ((needed - b.tokens) * MINUTE) / b.capacity;
        if (b.burst && b.burst.tokens < 1) wait = Math.max(wait, ((1 - b.burst.tokens) * b.burst.perMs) / b.burst.size);
        return Math.ceil(wait);
    }

    /** Takes a token if one is free for `priority` right now (half-open: the one probe). */
    function take(key, options, priority, nowMs, { probe = false } = {}) {
        const b = bucket(key, options, nowMs);
        refill(b, nowMs);
        if (b.pausedUntil > nowMs) return false;
        if (b.circuit !== 'closed') {
            if (b.probing) return false;
            if (!probe && (b.circuit === 'open' || priority === 'interactive')) return false;
        }
        if (b.tokens < floorFor(b, priority) + 1 && !(probe && b.tokens >= 1)) return false;
        if (b.burst && b.burst.tokens < 1) return false;
        if (b.circuit !== 'closed') b.probing = true;
        b.tokens -= 1;
        if (b.burst) b.burst.tokens -= 1;
        b.used.push(nowMs);
        while (b.used.length && b.used[0] < nowMs - 60 * MINUTE) b.used.shift();
        return true;
    }

    /** Header feedback: the limit replaces the configured one, the local count never exceeds what the server reports. */
    function observe(key, rate, nowMs) {
        const b = buckets.get(key);
        if (!b || !rate) return;
        refill(b, nowMs);
        if (rate.limit && rate.limit > 0 && rate.limit !== b.capacity) {
            b.capacity = rate.limit;
            b.fromHeader = true;
            b.tokens = Math.min(b.tokens, b.capacity);
        }
        if (rate.remaining !== null && rate.remaining !== undefined) {
            b.tokens = Math.min(b.tokens, rate.remaining);
            b.headerRemaining = rate.remaining;
        }
        if (rate.reset) b.resetAt = rate.reset * 1000;
    }

    /** 429: no token until Retry-After (seconds) or X-RateLimit-Reset (unix seconds), 60 s without either. */
    function rateLimited(key, { retryAfterSec, resetAt } = {}, nowMs) {
        const b = buckets.get(key);
        if (!b) return;
        let until = nowMs + DEFAULT_PAUSE_MS;
        if (retryAfterSec > 0) until = nowMs + retryAfterSec * 1000;
        else if (resetAt && resetAt * 1000 > nowMs) until = resetAt * 1000;
        b.pausedUntil = until;
        b.tokens = 0;
        b.waitedAt = nowMs;
        if (b.circuit === 'half-open') b.probing = false;
        onChange(key, 'paused', { until });
    }

    function failure(key, nowMs) {
        const b = buckets.get(key);
        if (!b) return;
        b.failures += 1;
        if (b.circuit !== 'closed' || b.failures >= FAILURES_TO_OPEN) {
            if (b.circuit !== 'open') onChange(key, 'open');
            b.circuit = 'open';
            b.openedAt = nowMs;
            b.probing = false;
        }
    }

    function success(key) {
        const b = buckets.get(key);
        if (!b) return;
        b.failures = 0;
        b.probing = false;
        if (b.circuit !== 'closed') {
            b.circuit = 'closed';
            onChange(key, 'closed');
        }
    }

    /** A request that took a probe token but never reached the source gives the probe back. */
    function release(key) {
        const b = buckets.get(key);
        if (b) b.probing = false;
    }

    /** Remembers that a request had to wait for this bucket (the "search is slow" hint). */
    function noteWait(key, nowMs) {
        const b = buckets.get(key);
        if (b) b.waitedAt = nowMs;
    }

    function state(key, nowMs) {
        const b = buckets.get(key);
        if (!b) return null;
        refill(b, nowMs);
        return {
            limit: b.capacity,
            remaining: Math.floor(b.headerRemaining !== null && b.headerRemaining < b.tokens ? b.headerRemaining : b.tokens),
            reset_at: b.resetAt,
            paused_until: b.pausedUntil > nowMs ? b.pausedUntil : null,
            circuit: b.circuit,
            used_last_hour: b.used.filter((t) => t >= nowMs - 60 * MINUTE).length,
            slow_recently: Boolean(b.waitedAt && nowMs - b.waitedAt < SLOW_WINDOW_MS)
        };
    }

    /** True when the bucket can serve now or soon: not paused, circuit not open (half-open counts). */
    function available(key, options, nowMs) {
        const b = bucket(key, options, nowMs);
        refill(b, nowMs);
        return b.pausedUntil <= nowMs && b.circuit !== 'open';
    }

    return {
        waitMs, take, observe, rateLimited, failure, success, release, noteWait, state, available,
        drop: (key) => buckets.delete(key),
        keys: () => [...buckets.keys()],
        reset: () => buckets.clear()
    };
}

module.exports = { createBudget, RESERVE_SHARE, FAILURES_TO_OPEN, OPEN_MS };
