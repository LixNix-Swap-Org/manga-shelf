// Scheduling of source requests: waiting for a token (interactive at most 8 s), coalescing of equal requests, the
// AniList id batcher (50 ids or 150 ms), search groups (aliases), the per-user cap of waiting interactive requests and
// the deduplicated background queue (dropped beyond 500 waiting jobs).
const INTERACTIVE_WAIT_MS = 8000;
const BATCH_SIZE = 50;
const BATCH_WAIT_MS = 150;
const USER_INTERACTIVE_MAX = 3;
const BACKGROUND_MAX = 500;
const PRIORITY_ORDER = { interactive: 0, refresh: 1, prefetch: 2 };

const sleep = (ms, signal) => new Promise((resolve) => {
    if (signal && signal.aborted) {
        resolve();
        return;
    }
    let onAbort = null;
    const t = setTimeout(() => {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        resolve();
    }, ms);
    if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref();
    if (signal) {
        onAbort = () => {
            clearTimeout(t);
            resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
    }
});

/**
 * Waits until `budget` hands out a token for `priority` (true) or the deadline passes / the bucket is paused or open
 * for longer than the deadline (false). Background priorities pass deadlineMs Infinity.
 */
async function acquire(budget, key, options, priority, { now = () => Date.now(), deadlineMs = INTERACTIVE_WAIT_MS, probe = false, signal } = {}) {
    const end = now() + deadlineMs;
    let waited = false;
    for (;;) {
        if (signal && signal.aborted) return false;
        const t = now();
        if (budget.take(key, options, priority, t, { probe })) {
            if (waited) budget.noteWait(key, t);
            return true;
        }
        if (probe) return false;
        const wait = budget.waitMs(key, options, priority, t);
        if (!Number.isFinite(wait) && deadlineMs !== Infinity) return false;
        if (t + Math.min(wait, 60000) > end) return false;
        waited = true;
        budget.noteWait(key, t);
        await sleep(Math.max(25, Math.min(Number.isFinite(wait) ? wait : 5000, 60000)), signal);
    }
}

const abortedError = () => Object.assign(new Error('aborted'), { name: 'AbortError', aborted: true });

/** Callers with the same key share one run; its signal aborts once every joined caller's signal has aborted. */
function createCoalescer() {
    const running = new Map();
    const join = (key, entry, signal) => {
        entry.callers++;
        if (!signal) return entry.promise;
        return new Promise((resolve, reject) => {
            let done = false;
            const onAbort = () => {
                if (done) return;
                done = true;
                entry.gone++;
                if (entry.gone === entry.callers) {
                    if (running.get(key) === entry) running.delete(key);
                    entry.controller.abort();
                }
                reject(abortedError());
            };
            const settle = (fn) => (value) => {
                if (done) return;
                done = true;
                signal.removeEventListener('abort', onAbort);
                fn(value);
            };
            entry.promise.then(settle(resolve), settle(reject));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort);
        });
    };
    return {
        run(key, fn, { signal } = {}) {
            let entry = running.get(key);
            if (!entry) {
                const controller = new AbortController();
                entry = { controller, callers: 0, gone: 0, promise: null };
                const own = entry;
                entry.promise = Promise.resolve().then(() => fn(controller.signal)).finally(() => {
                    if (running.get(key) === own) running.delete(key);
                });
                running.set(key, entry);
            }
            return join(key, entry, signal);
        },
        size: () => running.size
    };
}

/**
 * Collects ids until `maxSize` or `maxWaitMs` and calls run(ids) once; run resolves with a Map id -> result. Each add(id)
 * resolves with its result (undefined when the batch did not return it) or rejects with the batch's error.
 */
function createBatcher({ run, maxSize = BATCH_SIZE, maxWaitMs = BATCH_WAIT_MS }) {
    let pending = null;
    const flush = (batch) => {
        if (pending === batch) pending = null;
        if (batch.timer) clearTimeout(batch.timer);
        const ids = [...batch.waiters.keys()];
        Promise.resolve().then(() => run(ids)).then((results) => {
            for (const [id, list] of batch.waiters) for (const w of list) w.resolve(results ? results.get(id) : undefined);
        }, (err) => {
            for (const list of batch.waiters.values()) for (const w of list) w.reject(err);
        });
    };
    return {
        add(id) {
            return new Promise((resolve, reject) => {
                if (!pending) {
                    const batch = { waiters: new Map(), timer: null };
                    batch.timer = setTimeout(() => flush(batch), maxWaitMs);
                    pending = batch;
                }
                const batch = pending;
                if (!batch.waiters.has(id)) batch.waiters.set(id, []);
                batch.waiters.get(id).push({ resolve, reject });
                if (batch.waiters.size >= maxSize) flush(batch);
            });
        },
        pendingSize: () => (pending ? pending.waiters.size : 0)
    };
}

/**
 * Search terms waiting for the same token go out together (AniList aliases). run({ seal }) calls seal() for the
 * final terms; `size()` is read on every add (the gateway halves it after a "max query complexity" answer).
 */
function createGrouper({ run, size }) {
    let open = null;
    return {
        add(terms) {
            const limit = Math.max(1, size());
            if (!open || open.sealed || open.terms.length + terms.length > limit) {
                const group = { terms: [], sealed: false };
                const seal = () => {
                    group.sealed = true;
                    if (open === group) open = null;
                    return group.terms.slice();
                };
                group.promise = Promise.resolve().then(() => run({ seal })).finally(seal);
                open = group;
            }
            const group = open;
            const from = group.terms.length;
            group.terms.push(...terms);
            return group.promise.then((results) => results.slice(from, from + terms.length));
        }
    };
}

/** At most `max` waiting interactive requests per user. enter(userId) -> false when the user is at the cap. */
function createUserLimiter(max = USER_INTERACTIVE_MAX) {
    const counts = new Map();
    return {
        enter(userId) {
            const key = userId ?? 'anon';
            const n = counts.get(key) || 0;
            if (n >= max) return false;
            counts.set(key, n + 1);
            return true;
        },
        leave(userId) {
            const key = userId ?? 'anon';
            const n = (counts.get(key) || 1) - 1;
            if (n > 0) counts.set(key, n);
            else counts.delete(key);
        },
        count: (userId) => counts.get(userId ?? 'anon') || 0
    };
}

/**
 * Background jobs by key (a key already waiting is not added twice), run one after another, refresh before prefetch.
 * Beyond `max` waiting jobs new ones are dropped (onDrop is told once per overflow).
 */
function createBackgroundQueue({ max = BACKGROUND_MAX, onDrop = () => {}, onError = () => {} } = {}) {
    const waiting = new Map();
    let running = null;
    let dropping = false;

    async function work() {
        while (waiting.size) {
            const [key, job] = [...waiting.entries()].sort((a, b) => PRIORITY_ORDER[a[1].priority] - PRIORITY_ORDER[b[1].priority] || a[1].seq - b[1].seq)[0];
            waiting.delete(key);
            try {
                await job.fn();
            } catch (err) {
                onError(key, err);
            }
        }
        running = null;
    }

    let seq = 0;
    return {
        add(key, priority, fn) {
            if (waiting.has(key)) return false;
            if (waiting.size >= max) {
                if (!dropping) onDrop(waiting.size);
                dropping = true;
                return false;
            }
            dropping = false;
            waiting.set(key, { priority, fn, seq: seq++ });
            if (!running) running = Promise.resolve().then(work);
            return true;
        },
        size: () => waiting.size,
        idle: () => running || Promise.resolve(),
        clear: () => waiting.clear()
    };
}

module.exports = {
    acquire, sleep, createCoalescer, createBatcher, createGrouper, createUserLimiter, createBackgroundQueue,
    INTERACTIVE_WAIT_MS, BATCH_SIZE, BATCH_WAIT_MS, USER_INTERACTIVE_MAX, BACKGROUND_MAX, PRIORITY_ORDER
};
