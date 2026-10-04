// Rate budget: token refill, per-user and shared buckets, circuit breaker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBudget, OPEN_MS } = require('../../core/anime/budget');

const ANI = { perMinute: 30 };
const T0 = 1_000_000;

test('budget: tokens refill continuously up to the minute budget', () => {
    const b = createBudget();
    for (let i = 0; i < 30; i++) assert.equal(b.take('shared:anilist', ANI, 'interactive', T0), true, `token ${i}`);
    assert.equal(b.take('shared:anilist', ANI, 'interactive', T0), false);
    assert.equal(b.waitMs('shared:anilist', ANI, 'interactive', T0), 2000);
    assert.equal(b.take('shared:anilist', ANI, 'interactive', T0 + 2000), true, 'one token per 2 s at 30/min');
    assert.equal(b.state('shared:anilist', T0 + 120000).remaining, 30, 'never more than the minute budget');
});

test('budget: 40 % stay reserved for interactive requests', () => {
    const b = createBudget();
    let background = 0;
    while (b.take('shared:anilist', ANI, 'refresh', T0)) background++;
    assert.equal(background, 18, 'background stops at the reserve (12 of 30)');
    let interactive = 0;
    while (b.take('shared:anilist', ANI, 'interactive', T0)) interactive++;
    assert.equal(interactive, 12);
    assert.ok(b.waitMs('shared:anilist', ANI, 'prefetch', T0) > b.waitMs('shared:anilist', ANI, 'interactive', T0));
});

test('budget: rate headers lower the local count and replace the configured limit', () => {
    const b = createBudget();
    b.take('shared:anilist', { perMinute: 90 }, 'interactive', T0);
    b.observe('shared:anilist', { limit: 30, remaining: 5, reset: null }, T0);
    const s = b.state('shared:anilist', T0);
    assert.equal(s.limit, 30);
    assert.equal(s.remaining, 5);
    let n = 0;
    while (b.take('shared:anilist', { perMinute: 90 }, 'interactive', T0)) n++;
    assert.equal(n, 5);
});

test('budget: 429 pauses until Retry-After (or the reset time), then resumes', () => {
    const events = [];
    const b = createBudget({ onChange: (key, event) => events.push(event) });
    b.take('shared:anilist', ANI, 'interactive', T0);
    b.rateLimited('shared:anilist', { retryAfterSec: 30 }, T0);
    assert.equal(b.available('shared:anilist', ANI, T0 + 29000), false);
    assert.equal(b.take('shared:anilist', ANI, 'interactive', T0 + 29000), false);
    assert.equal(b.state('shared:anilist', T0 + 1000).paused_until, T0 + 30000);
    assert.equal(b.available('shared:anilist', ANI, T0 + 30000), true);
    assert.deepEqual(events, ['paused', 'resumed']);

    b.take('shared:anilist', ANI, 'interactive', T0 + 40000);
    b.rateLimited('shared:anilist', { resetAt: Math.floor((T0 + 100000) / 1000) }, T0 + 40000);
    assert.equal(b.available('shared:anilist', ANI, T0 + 99000), false);
    b.take('shared:jikan', { perMinute: 60 }, 'interactive', T0);
    b.rateLimited('shared:jikan', {}, T0);
    assert.equal(b.state('shared:jikan', T0).paused_until, T0 + 60000, 'no headers (Jikan): 60 s');
});

test('budget: circuit opens after 3 outages, half-open lets one low-priority probe through, success closes it', () => {
    const events = [];
    const b = createBudget({ onChange: (key, event) => events.push(event) });
    for (let i = 0; i < 3; i++) {
        assert.equal(b.take('shared:jikan', { perMinute: 60 }, 'interactive', T0 + i * 1000), true);
        b.failure('shared:jikan', T0 + i * 1000);
    }
    assert.equal(b.state('shared:jikan', T0 + 3000).circuit, 'open');
    assert.equal(b.available('shared:jikan', { perMinute: 60 }, T0 + 3000), false);
    const later = T0 + 2000 + OPEN_MS;
    assert.equal(b.state('shared:jikan', later).circuit, 'half-open');
    assert.equal(b.take('shared:jikan', { perMinute: 60 }, 'interactive', later), false, 'interactive does not probe');
    assert.equal(b.take('shared:jikan', { perMinute: 60 }, 'refresh', later), true, 'one background probe');
    assert.equal(b.take('shared:jikan', { perMinute: 60 }, 'refresh', later), false, 'exactly one');
    b.success('shared:jikan');
    assert.equal(b.state('shared:jikan', later).circuit, 'closed');
    assert.deepEqual(events, ['open', 'half-open', 'closed']);
});

test('budget: a failed half-open probe opens the circuit again; an explicit probe may pass an open circuit', () => {
    const b = createBudget();
    for (let i = 0; i < 3; i++) {
        b.take('shared:anilist', ANI, 'interactive', T0);
        b.failure('shared:anilist', T0);
    }
    assert.equal(b.take('shared:anilist', ANI, 'interactive', T0 + 1000, { probe: true }), true);
    b.failure('shared:anilist', T0 + 1000);
    assert.equal(b.state('shared:anilist', T0 + 1000 + OPEN_MS - 1).circuit, 'open');
});

test('budget: Jikan bursts at most 3 per second on top of the minute budget', () => {
    const b = createBudget();
    const jikan = { perMinute: 60, burst: { size: 3, perMs: 1000 } };
    let n = 0;
    while (b.take('shared:jikan', jikan, 'interactive', T0)) n++;
    assert.equal(n, 3);
    assert.ok(b.waitMs('shared:jikan', jikan, 'interactive', T0) >= 300);
    assert.equal(b.take('shared:jikan', jikan, 'interactive', T0 + 1000), true);
});

test('budget: buckets per access are independent; a dropped bucket starts fresh', () => {
    const b = createBudget();
    b.rateLimited('user:5:anilist', {}, T0);
    b.take('user:5:anilist', ANI, 'interactive', T0);
    b.rateLimited('user:5:anilist', { retryAfterSec: 60 }, T0);
    assert.equal(b.available('user:5:anilist', ANI, T0), false);
    assert.equal(b.available('shared:anilist', ANI, T0), true, 'a personal key never affects the shared pool');
    b.drop('user:5:anilist');
    assert.equal(b.available('user:5:anilist', ANI, T0), true);
});
