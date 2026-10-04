// Shared helpers for the browser suites: every lookup waits and throws instead of silently skipping a step.
const assert = require('node:assert/strict');
const http = require('http');
const https = require('https');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Endpoints backed by external services (Manga Passion, DNB, AniList); their failures say nothing about the app.
// The personal radar (/api/release-radar) is pure SQLite and stays watched; only its date check calls Manga Passion.
const EXTERNAL_API = /^\/api\/(lookup|manga-passion|upload-remote|volumes\/lookup|release-radar\/changes|anime\/search|anime\/\d+\/refresh)\b|^\/api\/mangas\/\d+\/(gaps|sync-edition|adaptations)\b/;

/** Variables set by test/browser/run.js; exits with a hint when a suite is started without it. */
function suiteEnv() {
    const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
    const user = process.env.E2E_USER;
    const password = process.env.E2E_PASSWORD;
    if (!baseUrl || !user || !password) {
        console.error('Set BASE_URL, E2E_USER and E2E_PASSWORD, or use the npm scripts (they start an isolated server).');
        process.exit(2);
    }
    return { baseUrl, user, password };
}

// utils/notify.js fires this window event for every toast
const NOTIFY_EVENT = 'mangashelf:notify';
const TOAST_LOG_PREFIX = '[e2e-toast] ';

/**
 * Records page exceptions, console errors, failed API calls (status >= 400, external lookups excepted), error toasts
 * and any alert() that is left. confirm() prompts (deletes) are accepted.
 */
function watchPage(page) {
    const state = { exceptions: [], consoleErrors: [], apiErrors: [], alerts: [], errorToasts: [] };
    // registered before the first navigation; every later document load runs it again
    page.evaluateOnNewDocument((event, prefix) => {
        window.addEventListener(event, e => {
            if (e.detail && e.detail.kind === 'error') console.info(prefix + e.detail.message);
        });
    }, NOTIFY_EVENT, TOAST_LOG_PREFIX).catch(() => {});
    page.on('pageerror', err => {
        console.error('  [Page Exception]:', err.message);
        state.exceptions.push(err.message);
    });
    page.on('console', msg => {
        if (msg.type() === 'info' && msg.text().startsWith(TOAST_LOG_PREFIX)) {
            const message = msg.text().slice(TOAST_LOG_PREFIX.length);
            console.error('  [Error Toast]:', message);
            state.errorToasts.push(message);
            return;
        }
        // failed requests are reported by the response listener (with the allow-list), not twice here
        if (msg.type() !== 'error' || /^Failed to load resource/.test(msg.text())) return;
        console.error('  [Browser Error]:', msg.text());
        state.consoleErrors.push(msg.text());
    });
    page.on('response', res => {
        let pathname;
        try { pathname = new URL(res.url()).pathname; } catch (e) { return; }
        if (!pathname.startsWith('/api/') || res.status() < 400 || EXTERNAL_API.test(pathname)) return;
        const entry = `${res.request().method()} ${pathname} -> ${res.status()}`;
        console.error('  [API Error]:', entry);
        state.apiErrors.push(entry);
    });
    page.on('dialog', async dialog => {
        console.log(`  [Dialog ${dialog.type()}]:`, dialog.message());
        if (dialog.type() === 'alert') state.alerts.push(dialog.message());
        await dialog.accept().catch(() => {});
    });
    return {
        state,
        /** Forget what happened so far (e.g. the expected 401 probes before the login). */
        reset() {
            for (const list of Object.values(state)) list.length = 0;
        },
        /** Drops an API failure the test provoked on purpose, e.g. 'GET /api/mangas/7 -> 404'. */
        async expectApiError(entry) {
            await waitUntil(() => state.apiErrors.includes(entry), { timeout: 3000, message: `expected API failure "${entry}" was not seen` });
            state.apiErrors.splice(state.apiErrors.indexOf(entry), 1);
        },
        assertClean(label = '') {
            const where = label ? ` (${label})` : '';
            assert.deepEqual(state.exceptions, [], `uncaught exceptions in the page${where}`);
            assert.deepEqual(state.apiErrors, [], `failed API calls${where}`);
            assert.deepEqual(state.consoleErrors, [], `console errors${where}`);
            assert.deepEqual(state.alerts, [], `alert() dialogs${where}`);
            assert.deepEqual(state.errorToasts, [], `error toasts${where}`);
        }
    };
}

/** Waits for a visible toast containing `text` (kind: 'error', 'success' or 'info'); returns its selector. */
let toastSeq = 0;

// Runs in the page: tags the newest visible matching toast (an untagged one first) and reports whether one was found.
function tagToast(sel, txt, id) {
    const matches = Array.from(document.querySelectorAll(sel))
        .filter(el => el.offsetParent !== null && (el.innerText || '').includes(txt))
        .reverse();
    const match = matches.find(el => !el.hasAttribute('data-e2e-toast')) || matches[0];
    if (!match) return false;
    match.setAttribute('data-e2e-toast', id);
    return true;
}

/** Waits for a toast with `text` and returns a selector for exactly that toast (e.g. as `within` of clickText). */
async function waitForToast(page, text, { kind = null, timeout = 10000 } = {}) {
    const selector = kind ? `[data-toast="${kind}"]` : '[data-toast]';
    const id = `toast-${++toastSeq}`;
    try {
        await page.waitForFunction(tagToast, { timeout }, selector, text, id);
    } catch (e) {
        throw new Error(`No ${kind ? `${kind} ` : ''}toast with text "${text}"`);
    }
    return `[data-e2e-toast="${id}"]`;
}

/** Polls `fn` until it returns a truthy value; throws `message` on timeout. */
async function waitUntil(fn, { timeout = 10000, interval = 150, message = 'condition not met' } = {}) {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
        last = await fn();
        if (last) return last;
        if (Date.now() > end) throw new Error(`Timed out: ${message}`);
        await sleep(interval);
    }
}

/** Clicks a visible, enabled element of `selector` whose text contains `text` (optionally inside `within`). */
async function clickText(page, text, { selector = 'button', within = null, timeout = 10000 } = {}) {
    let handle;
    try {
        handle = await page.waitForFunction((sel, txt, scope) => {
            const root = scope ? document.querySelector(scope) : document;
            if (!root) return null;
            return Array.from(root.querySelectorAll(sel))
                .find(el => el.offsetParent !== null && !el.disabled && (el.innerText || '').includes(txt)) || null;
        }, { timeout }, selector, text, within);
    } catch (e) {
        throw new Error(`No visible ${selector} with text "${text}"${within ? ` inside ${within}` : ''}`);
    }
    await handle.asElement().evaluate(el => el.click());
}

/** Waits for a visible element and clicks it. */
async function clickSelector(page, selector, { timeout = 10000 } = {}) {
    const el = await page.waitForSelector(selector, { visible: true, timeout }).catch(() => null);
    if (!el) throw new Error(`No visible element ${selector}`);
    await el.evaluate(node => node.click());
}

/** Replaces the value of an input/textarea with real key strokes (React sees every change). */
async function typeInto(page, selectorOrHandle, value, { timeout = 10000 } = {}) {
    const el = typeof selectorOrHandle === 'string'
        ? await page.waitForSelector(selectorOrHandle, { visible: true, timeout }).catch(() => null)
        : selectorOrHandle;
    if (!el) throw new Error(`No visible input ${selectorOrHandle}`);
    await el.evaluate(node => {
        const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, '');
        node.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (value !== '') await el.type(String(value));
}

/** Resolves with the next response whose path matches and whose method is `method`. Start it before the click. */
function waitForApi(page, method, pathPattern, { timeout = 15000 } = {}) {
    return page.waitForResponse(res => {
        if (res.request().method() !== method) return false;
        let pathname;
        try { pathname = new URL(res.url()).pathname; } catch (e) { return false; }
        return typeof pathPattern === 'string' ? pathname === pathPattern : pathPattern.test(pathname);
    }, { timeout });
}

/** Runs fetch inside the page (session cookie included) and returns { status, data }. */
async function api(page, method, path, body) {
    return page.evaluate(async (m, p, b) => {
        const res = await fetch(p, {
            method: m,
            headers: b === undefined ? {} : { 'Content-Type': 'application/json' },
            body: b === undefined ? undefined : JSON.stringify(b)
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
        return { status: res.status, data };
    }, method, path, body);
}

async function apiOk(page, method, path, body) {
    const res = await api(page, method, path, body);
    assert.ok(res.status >= 200 && res.status < 300, `${method} ${path} answered ${res.status}: ${JSON.stringify(res.data)}`);
    return res.data;
}

/** Creates a series (and optionally volumes from..to) through the API; returns its id. */
async function seedSeries(page, { title, publisher = null, author = null, total_volumes = null, volumes = null }) {
    const manga = await apiOk(page, 'POST', '/api/mangas', { title, publisher, author, total_volumes });
    assert.ok(manga && manga.id, `creating "${title}" returned no id`);
    if (volumes) {
        await apiOk(page, 'POST', '/api/volumes/batch', { manga_id: manga.id, from: volumes.from, to: volumes.to, status: volumes.status || 'Vorhanden' });
    }
    return manga.id;
}

async function getVolumes(page, mangaId) {
    const manga = await apiOk(page, 'GET', `/api/mangas/${mangaId}`);
    return manga.volumes || [];
}

/** Logs in through the login form and fails unless the app leaves /login. */
async function loginViaUi(page, baseUrl, user, password) {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle0' });
    await typeInto(page, 'input[type="text"]', user);
    await typeInto(page, 'input[type="password"]', password);
    await clickSelector(page, 'button[type="submit"]');
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 })
        .catch(() => { throw new Error('login failed: still on the login page'); });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 15000 }).catch(() => {});
}

/** Fails when the page scrolls sideways (1px tolerance for rounding); names the widest element. */
async function assertNoHorizontalOverflow(page, label) {
    const info = await page.evaluate(() => {
        const width = window.innerWidth;
        let widest = null;
        for (const el of document.querySelectorAll('body *')) {
            const r = el.getBoundingClientRect();
            if (r.right > width + 1 && (!widest || r.right > widest.right)) {
                widest = { right: Math.round(r.right), tag: el.tagName.toLowerCase(), id: el.id, cls: String(el.className).slice(0, 80) };
            }
        }
        return { scrollWidth: document.documentElement.scrollWidth, width, widest };
    });
    assert.ok(info.scrollWidth <= info.width + 1,
        `${label}: horizontal overflow (scrollWidth ${info.scrollWidth} > ${info.width}); widest: ${JSON.stringify(info.widest)}`);
}

/** Ids of the series links currently visible, in document order. */
async function visibleSeriesIds(page) {
    return page.evaluate(() => {
        const ids = [];
        for (const a of document.querySelectorAll('a[href^="/manga/"]')) {
            if (a.offsetParent === null) continue;
            const m = /^\/manga\/(\d+)/.exec(a.getAttribute('href'));
            if (m && !ids.includes(Number(m[1]))) ids.push(Number(m[1]));
        }
        return ids;
    });
}

/** One GET with the session cookie; status is the numeric HTTP status. */
function requestApi(baseUrl, path, cookieHeader) {
    const url = new URL(path, baseUrl);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const start = process.hrtime.bigint();
        const req = client.request(url, { method: 'GET', headers: cookieHeader ? { Cookie: cookieHeader } : {} }, res => {
            let bytes = 0;
            res.on('data', chunk => { bytes += chunk.length; });
            res.on('end', () => resolve({ status: res.statusCode, latencyMs: Number(process.hrtime.bigint() - start) / 1e6, bytes }));
        });
        req.on('error', reject);
        req.end();
    });
}

function latencyStats(latencies) {
    const sorted = [...latencies].sort((a, b) => a - b);
    const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const round = n => parseFloat(n.toFixed(2));
    return {
        minMs: round(sorted[0]),
        maxMs: round(sorted[sorted.length - 1]),
        meanMs: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        p50Ms: round(pick(0.5)),
        p95Ms: round(pick(0.95)),
        p99Ms: round(pick(0.99))
    };
}

/** Times `iterations` GETs; throws when any answer is not 2xx, so 401/404 timings never end up in a report. */
async function benchmarkEndpoint(baseUrl, path, cookieHeader, iterations = 50) {
    const latencies = [];
    let bytes = 0;
    for (let i = 0; i < iterations; i++) {
        const res = await requestApi(baseUrl, path, cookieHeader);
        if (res.status < 200 || res.status >= 300) throw new Error(`GET ${path} answered ${res.status} (iteration ${i + 1})`);
        latencies.push(res.latencyMs);
        bytes = res.bytes;
    }
    return { endpoint: path, iterations, responseSizeBytes: bytes, ...latencyStats(latencies) };
}

module.exports = {
    sleep, suiteEnv, watchPage, waitForToast, tagToast, waitUntil, clickText, clickSelector, typeInto, waitForApi, api, apiOk, seedSeries,
    getVolumes, loginViaUi, assertNoHorizontalOverflow, visibleSeriesIds, requestApi, latencyStats, benchmarkEndpoint,
    EXTERNAL_API
};
