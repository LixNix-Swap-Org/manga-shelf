const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowStore, createRateLimiter, createFailureTracker, clientKey, resetRateLimits } = require('../middleware/rateLimit');

const v6 = (n) => clientKey(`2001:db8:1:${n.toString(16)}::1`);

function hitter(limiter) {
    return (key) => {
        let status = 200;
        const res = { setHeader() {}, status(code) { status = code; return this; }, json() { return this; } };
        limiter({ key, headers: {} }, res, () => {});
        return status;
    };
}

test('store: one IPv6 /48 holds at most maxPerPrefix keys, further /64s share one entry', () => {
    const store = createWindowStore({ windowMs: 60000, lockAt: 3, maxPerPrefix: 4 });
    for (let n = 0; n < 10; n++) store.increment(v6(n));
    assert.equal(store.size(), 5);
    assert.ok(store.keys().includes('2001:db8:1::/48'));
    assert.equal(store.live(v6(9)).count, 6, 'the six overflow /64s count together');
    assert.equal(store.live(v6(0)).count, 1, 'the first four keep their own entries');
    store.increment('2001:db8:2:1::/64');
    assert.equal(store.live('2001:db8:2:1::/64').count, 1, 'another /48 is not affected');
});

test('store: the /48 cap also applies to account-and-address keys of the login guard', () => {
    const tracker = createFailureTracker({ windowMs: 60000, max: 3 });
    for (let n = 0; n < 300; n++) tracker.fail(`alice\n${v6(n)}`);
    assert.equal(tracker.size(), 257);
    assert.equal(tracker.isLocked(`alice\n${v6(299)}`), true, '44 failures in the shared /48 entry lock it');
    assert.equal(tracker.isLocked(`alice\n${v6(1)}`), false);
    assert.equal(tracker.isLocked(`bob\n${v6(299)}`), false);
});

test('store: a freed slot in a full /48 gives the next /64 its own entry again', () => {
    const store = createWindowStore({ windowMs: 60000, lockAt: 3, maxPerPrefix: 2 });
    store.increment(v6(1));
    store.increment(v6(2));
    store.increment(v6(3));
    assert.ok(store.keys().includes('2001:db8:1::/48'));
    store.delete(v6(1));
    store.increment(v6(4));
    assert.ok(store.keys().includes(v6(4)));
});

test('request limiter: refunds unlock an entry, which may then make room again', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, maxEntries: 1, keyFn: (req) => req.key });
    const hit = hitter(limiter);
    assert.equal(hit('a'), 200);
    assert.equal(hit('a'), 429);
    assert.equal(hit('b'), 200, 'fails open while a is limited');
    limiter.refund({ key: 'a', headers: {} });
    limiter.refund({ key: 'a', headers: {} });
    assert.equal(hit('b'), 200, 'a is unlimited again and made room for b');
    assert.equal(hit('b'), 429);
});

test('failure tracker: stays fail-closed when its store is full of locks', () => {
    const tracker = createFailureTracker({ windowMs: 60000, max: 1, maxEntries: 2 });
    tracker.fail('a');
    tracker.fail('b');
    assert.equal(tracker.isLocked('c'), true);
    assert.equal(tracker.fail('c'), Infinity);
});

test('a saturated store answers new keys without scanning all entries', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, maxEntries: 20000, keyFn: (req) => req.key });
    const hit = hitter(limiter);
    for (let i = 0; i < 20000; i++) { hit('k' + i); hit('k' + i); }
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20000; i++) assert.equal(hit('new' + i), 200);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `20000 requests took ${ms} ms`);
});

test('resetRateLimits also clears limiters created in other modules', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, keyFn: (req) => req.key });
    const hit = hitter(limiter);
    hit('x');
    assert.equal(hit('x'), 429);
    resetRateLimits();
    assert.equal(hit('x'), 200);
});

test('exempt requests are counted but never refused', () => {
    const limiter = createRateLimiter({ windowMs: 60000, max: 1, keyFn: (req) => req.key });
    const res = { setHeader() {}, status() { throw new Error('refused'); }, json() { return this; } };
    for (let i = 0; i < 5; i++) assert.equal(limiter.consume({ key: 'k', headers: {} }, res, { exempt: true }), false);
    assert.equal(hitter(limiter)('k'), 429);
});
