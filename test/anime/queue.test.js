const test = require('node:test');
const assert = require('node:assert/strict');
const {
    acquire, createCoalescer, createBatcher, createGrouper, createUserLimiter, createBackgroundQueue
} = require('../../core/anime/queue');
const { createBudget } = require('../../core/anime/budget');

test('queue: equal requests share one promise while it runs', async () => {
    const c = createCoalescer();
    let runs = 0;
    const work = () => new Promise((resolve) => setTimeout(() => resolve(++runs), 20));
    const [a, b] = await Promise.all([c.run('search:frieren', work), c.run('search:frieren', work)]);
    assert.equal(runs, 1);
    assert.equal(a, b);
    assert.equal(c.size(), 0);
    await c.run('search:frieren', work);
    assert.equal(runs, 2, 'a finished request is not reused');
});

test('queue: the batcher sends at most 50 ids at once and fires after 150 ms', async () => {
    const batches = [];
    const batcher = createBatcher({
        run: async (ids) => {
            batches.push({ ids, at: Date.now() });
            return new Map(ids.map((id) => [id, `meta-${id}`]));
        }
    });
    const started = Date.now();
    const all = await Promise.all(Array.from({ length: 60 }, (_, i) => batcher.add(i + 1)));
    assert.equal(batches.length, 2);
    assert.equal(batches[0].ids.length, 50, 'full batch goes out at once');
    assert.ok(batches[0].at - started < 100);
    assert.equal(batches[1].ids.length, 10);
    assert.ok(batches[1].at - started >= 140, 'the rest waits for the timer');
    assert.equal(all[59], 'meta-60');

    const failing = createBatcher({ run: async () => { throw new Error('AniList down'); }, maxWaitMs: 10 });
    await assert.rejects(Promise.all([failing.add(1), failing.add(1)]), /AniList down/);
});

test('queue: search terms waiting for the same token go out in one group, at most `size` terms', async () => {
    const groups = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const grouper = createGrouper({
        size: () => 3,
        run: async ({ seal }) => {
            await gate;
            const terms = seal();
            groups.push(terms);
            return terms.map((t) => `hits:${t}`);
        }
    });
    const a = grouper.add(['Frieren']);
    const b = grouper.add(['Tagebücher', 'Tagebucher']);
    const c = grouper.add(['Berserk']);
    release();
    assert.deepEqual(await a, ['hits:Frieren']);
    assert.deepEqual(await b, ['hits:Tagebücher', 'hits:Tagebucher']);
    assert.deepEqual(await c, ['hits:Berserk']);
    assert.deepEqual(groups, [['Frieren', 'Tagebücher', 'Tagebucher'], ['Berserk']]);
});

test('queue: at most 3 waiting interactive requests per user', () => {
    const limiter = createUserLimiter();
    assert.equal(limiter.enter(1), true);
    assert.equal(limiter.enter(1), true);
    assert.equal(limiter.enter(1), true);
    assert.equal(limiter.enter(1), false);
    assert.equal(limiter.enter(2), true, 'other users are not affected');
    limiter.leave(1);
    assert.equal(limiter.enter(1), true);
});

test('queue: background jobs are deduplicated by key, refresh runs before prefetch, beyond 500 they are dropped', async () => {
    const order = [];
    let drops = 0;
    const q = createBackgroundQueue({ onDrop: () => drops++ });
    let unblock;
    const blocker = new Promise((resolve) => { unblock = resolve; });
    q.add('block', 'refresh', () => blocker);
    assert.equal(q.add('resolve:1', 'prefetch', async () => order.push('prefetch')), true);
    assert.equal(q.add('refresh:2', 'refresh', async () => order.push('refresh')), true);
    assert.equal(q.add('refresh:2', 'refresh', async () => order.push('twice')), false, 'same key while waiting');
    for (let i = 0; i < 600; i++) q.add(`fill:${i}`, 'prefetch', async () => {});
    assert.equal(q.size(), 500);
    assert.equal(drops, 1, 'the overflow is reported once');
    unblock();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await q.idle();
    assert.deepEqual(order, ['refresh', 'prefetch']);
});

test('queue: acquire waits for a token up to the deadline; background waits longer', async () => {
    const budget = createBudget();
    const opts = { perMinute: 600 };
    let now = 0;
    for (let i = 0; i < 600; i++) budget.take('k', opts, 'interactive', now);
    assert.equal(await acquire(budget, 'k', opts, 'interactive', { now: () => now, deadlineMs: 50 }), false, '100 ms to the next token');
    now = 100;
    assert.equal(await acquire(budget, 'k', opts, 'interactive', { now: () => now, deadlineMs: 50 }), true);
    budget.rateLimited('k', { retryAfterSec: 3600 }, now);
    assert.equal(await acquire(budget, 'k', opts, 'interactive', { now: () => now }), false, 'a long pause is not waited out');
});
