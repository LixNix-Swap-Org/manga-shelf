// Browser test of the anime tab without external APIs: manual entry, +1, status, "Link einfügen", detail, delete; four tabs at 375 px.
// Run it with `npm run test:anime` (test/browser/run.js starts an isolated server and sets the variables).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const { findChrome } = require('./chrome');
const {
    suiteEnv, watchPage, clickSelector, clickText, typeInto, waitForApi, waitForToast, waitUntil, apiOk, loginViaUi, assertNoHorizontalOverflow
} = require('./helpers');

const { baseUrl, user, password } = suiteEnv();
const TITLE = '__ANIME_TEST__ Heimvideo';

const cardSelector = async (page) => {
    const id = await waitUntil(() => page.evaluate((title) => {
        const card = Array.from(document.querySelectorAll('[data-anime-id]')).find((el) => el.innerText.includes(title));
        return card ? card.getAttribute('data-anime-id') : null;
    }, TITLE), { message: `card "${TITLE}" not shown` });
    return `[data-anime-id="${id}"]`;
};

(async () => {
    console.log('--- TESTING ANIME TAB ---');
    const browser = await puppeteer.launch({ headless: 'new', executablePath: findChrome(), args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const watcher = watchPage(page);
    let failed = false;
    try {
        await loginViaUi(page, baseUrl, user, password);
        watcher.reset();

        console.log('Step 1: open the anime tab (empty state)');
        const listLoaded = waitForApi(page, 'GET', '/api/anime');
        await clickSelector(page, '#btn-nav-anime');
        await listLoaded;
        await page.waitForFunction(() => location.search.includes('view=anime'));
        await page.waitForFunction(() => document.body.innerText.includes('Noch keine Anime in der Liste'), { timeout: 10000 });

        console.log('Step 2: manual entry with 3 episodes');
        await clickSelector(page, '#btn-add-anime');
        await page.waitForSelector('[role="dialog"]', { visible: true });
        await clickText(page, 'Manuell', { selector: '[role="tab"]' });
        await typeInto(page, '[role="dialog"] input[maxlength="200"]', TITLE);
        await typeInto(page, '[role="dialog"] input[type="number"]', '3');
        const created = waitForApi(page, 'POST', '/api/anime');
        await clickText(page, 'Anlegen', { within: '[role="dialog"]' });
        assert.equal((await created).status(), 201);
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
        const card = await cardSelector(page);

        console.log('Step 3: +1 twice, then "Gesehen" fills the counter');
        for (let i = 1; i <= 2; i++) {
            const saved = waitForApi(page, 'PUT', /^\/api\/anime\/\d+\/progress$/);
            await clickSelector(page, `${card} button[aria-label$="eine Folge mehr gesehen"]`);
            assert.equal((await saved).status(), 200);
            await page.waitForFunction((sel, n) => document.querySelector(sel)?.innerText.includes(`${n} / 3`), { timeout: 5000 }, card, i);
        }
        assert.match(await page.$eval(card, (el) => el.innerText), /Schaue/);
        const statusSaved = waitForApi(page, 'PUT', /^\/api\/anime\/\d+\/progress$/);
        await page.select(`${card} select`, 'Gesehen');
        await statusSaved;
        await page.waitForFunction((sel) => document.querySelector(sel)?.innerText.includes('3 / 3'), { timeout: 5000 }, card);
        assert.equal(await page.$eval(`${card} button[aria-label$="eine Folge mehr gesehen"]`, (b) => b.disabled), true, '+1 is off once watched');
        const id = Number(card.match(/\d+/)[0]);
        const stored = await apiOk(page, 'GET', `/api/anime/${id}`);
        assert.equal(stored.my_progress.status, 'Gesehen');
        assert.equal(stored.my_progress.episodes_watched, 3);

        console.log('Step 4: filter "Gesehen" shows it, "Geplant" does not');
        await clickText(page, 'Geplant', { selector: '[aria-label="Nach meinem Status filtern"] button' });
        await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, card);
        await clickText(page, 'Gesehen', { selector: '[aria-label="Nach meinem Status filtern"] button' });
        await page.waitForSelector(card, { visible: true });

        console.log('Step 5: reload keeps the view; four tabs fit 375 px');
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-anime-id]', { visible: true });
        await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
        await page.waitForSelector('#btn-nav-anime', { visible: true });
        await assertNoHorizontalOverflow(page, 'anime tab at 375 px');

        console.log('Step 5b: "Link einfügen" without clipboard access opens the paste field; a shared title is found');
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => Promise.reject(new Error('denied')) } }));
        await clickSelector(page, '#btn-anime-paste-link');
        const pasteField = '[role="dialog"] input[type="url"]';
        await page.waitForSelector(pasteField, { visible: true });
        await assertNoHorizontalOverflow(page, 'paste dialog at 375 px');
        await typeInto(page, pasteField, 'https://example.com/watch/1');
        await clickText(page, 'Link prüfen', { within: '[role="dialog"]' });
        await page.waitForFunction(() => document.querySelector('[role="dialog"] [role="alert"]')?.textContent === 'Das ist kein Crunchyroll-Link.', { timeout: 5000 });
        assert.equal(await page.$eval(pasteField, (el) => el.getAttribute('aria-invalid')), 'true');
        // series title and episode come from the text, so the server reads no page
        await typeInto(page, pasteField, `${TITLE} Folge 3 https://www.crunchyroll.com/de/watch/GG1U2Q5MW/heimvideo`);
        const resolved = waitForApi(page, 'POST', '/api/anime/resolve-link');
        await clickText(page, 'Link prüfen', { within: '[role="dialog"]' });
        const answer = await (await resolved).json();
        assert.equal(answer.episode, 3);
        assert.equal(answer.anime_id, id, 'the shared title matches the entry');
        await page.waitForFunction((title) => document.querySelector('[role="dialog"] h2')?.textContent === `${title}, Folge 3 gesehen?`, { timeout: 5000 }, TITLE);
        await clickText(page, 'Link merken', { within: '[role="dialog"]' });
        await waitForToast(page, `${TITLE}: Link für „Weiter“ gemerkt`, { kind: 'success' });
        const kept = await apiOk(page, 'GET', `/api/anime/${id}`);
        assert.equal(kept.my_progress.episodes_watched, 3);
        assert.equal(kept.my_progress.resume_episode, 3);
        await page.setViewport({ width: 1400, height: 900 });

        console.log('Step 6: detail dialog, then delete for everybody');
        await clickSelector(page, `${card} h3 button`);
        await page.waitForSelector('[role="dialog"]', { visible: true });
        await page.waitForFunction((title) => document.querySelector('[role="dialog"]')?.innerText.includes(title), { timeout: 5000 }, TITLE);
        const removed = waitForApi(page, 'DELETE', `/api/anime/${id}`);
        await clickText(page, 'Für alle löschen', { within: '[role="dialog"]' });
        assert.equal((await removed).status(), 200);
        await waitForToast(page, 'Anime gelöscht', { kind: 'success' });
        await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, card);
        const list = await apiOk(page, 'GET', '/api/anime');
        assert.ok(!list.some((a) => a.title === TITLE));

        watcher.assertClean('anime tab');
        console.log('\n✅ ANIME TAB TEST PASSED');
    } catch (err) {
        failed = true;
        console.error('\n❌ ANIME TAB TEST FAILED:', err.message);
        try { await page.screenshot({ path: 'test/browser/screenshots/anime-failure.png', fullPage: true }); } catch (e) { /* no screenshot */ }
    } finally {
        await browser.close();
    }
    process.exit(failed ? 1 : 0);
})();
