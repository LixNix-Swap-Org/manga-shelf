// Browser tour with screenshots of every view and modal; fails on page exceptions, failed API calls, missing
// controls, horizontal scrolling on a phone, clipped series actions on a landscape phone or tablet, an unreachable
// add-series header on a landscape phone, author buttons outside their card, a crowded desktop header, keyboard focus
// under the sticky header and shelf spines cut off on a narrow phone. Run it with `npm run test:deep` (test/browser/run.js).
const {
  suiteEnv, watchPage, waitUntil, clickText, clickSelector, typeInto, waitForApi, apiOk, seedSeries, getVolumes,
  loginViaUi, visibleSeriesIds
} = require('./helpers');
const { baseUrl: BASE_URL, user: E2E_USER, password: E2E_PASSWORD } = suiteEnv();

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { findChrome, CHROME_ARGS } = require('./chrome');

async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

const TOOLBAR_SELECTS = ['Verlag filtern', 'Sammelstand filtern', 'Genre filtern', 'Sortierung', 'Gruppieren']
  .map((label) => `select[aria-label="${label}"]`).join(', ');

// shelf toolbar chips: no two labels intersect and every select stays inside its own label
async function toolbarOverlaps(page) {
  return page.evaluate((selector) => {
    const chips = Array.from(document.querySelectorAll(selector)).map((select) => ({
      name: select.getAttribute('aria-label'),
      select: select.getBoundingClientRect(),
      label: select.closest('label').getBoundingClientRect()
    }));
    const problems = [];
    if (chips.length < 4) problems.push(`only ${chips.length} toolbar selects`);
    const cut = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    chips.forEach((a, i) => {
      if (a.select.left < a.label.left - 0.5 || a.select.right > a.label.right + 0.5) problems.push(`${a.name} overflows its chip`);
      chips.slice(i + 1).forEach((b) => {
        if (cut(a.label, b.label)) problems.push(`${a.name} overlaps ${b.name}`);
      });
    });
    return problems;
  }, TOOLBAR_SELECTS);
}

const LANDSCAPE_PHONE = { width: 844, height: 390, isMobile: true, hasTouch: true };
const TABLET_PORTRAIT = { width: 820, height: 1180, isMobile: true, hasTouch: true };
const HERO_ACTIONS = ['#btn-edit-manga', '#btn-delete-manga', '#btn-anime-adaption'];

// series hero: the action buttons lie inside the card and the viewport, the title does not run out of its box
async function heroProblems(page) {
  return page.evaluate((selectors) => {
    const problems = [];
    const h1 = document.querySelector('h1');
    const card = h1 && h1.closest('.glass-panel');
    if (!card) return ['hero card not found'];
    const box = card.getBoundingClientRect();
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) { problems.push(`${sel} missing`); continue; }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.left < Math.max(0, box.left) - 0.5 || r.right > Math.min(innerWidth, box.right) + 0.5) {
        problems.push(`${sel} outside (${Math.round(r.left)}-${Math.round(r.right)}, card ${Math.round(box.left)}-${Math.round(box.right)}, viewport ${innerWidth})`);
      }
    }
    const range = document.createRange();
    range.selectNodeContents(h1);
    if (range.getBoundingClientRect().right > h1.getBoundingClientRect().right + 1) problems.push('title runs out of the h1');
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('page scrolls sideways');
    return problems;
  }, HERO_ACTIONS);
}

// a dialog on a landscape phone: header and close button reachable at the scroll top, the overlay itself scrolls
async function dialogProblems(page, dialogSelector, heading) {
  return page.evaluate((sel, title) => {
    const overlay = document.querySelector(sel);
    if (!overlay) return ['dialog not found'];
    overlay.scrollTop = 0;
    const problems = [];
    const h2 = Array.from(overlay.querySelectorAll('h2')).find((h) => h.textContent.trim() === title);
    const close = overlay.querySelector('button[aria-label="Schließen"]');
    for (const [name, el] of [['heading', h2], ['close button', close]]) {
      if (!el) { problems.push(`${name} missing`); continue; }
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) problems.push(`${name} outside the viewport (${Math.round(r.top)}-${Math.round(r.bottom)} of ${innerHeight})`);
    }
    if (!(overlay.scrollHeight > overlay.clientHeight)) problems.push('the overlay does not scroll');
    return problems;
  }, dialogSelector, heading);
}

const AUTHOR_BUTTON = 'button[title^="Alle Reihen von "]';

// grid cards on a phone: every author button lies inside its card (1 px tolerance), the long-author card has two
async function authorProblems(page, longAuthorId) {
  return page.evaluate(async (selector, id) => {
    const problems = [];
    const cards = Array.from(document.querySelectorAll('a[href^="/manga/"]')).map((a) => a.parentElement)
      .filter((el) => el && el.classList.contains('rounded-2xl') && el.classList.contains('[content-visibility:auto]'));
    if (cards.length === 0) return ['no grid cards'];
    for (const card of cards) {
      card.scrollIntoView({ block: 'center' });
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const box = card.getBoundingClientRect();
      for (const button of card.querySelectorAll(selector)) {
        const r = button.getBoundingClientRect();
        if (r.width <= 0 || r.left < box.left - 1 || r.top < box.top - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1) {
          problems.push(`${button.title} outside its card (${Math.round(r.left)}-${Math.round(r.right)} x ${Math.round(r.top)}-${Math.round(r.bottom)}, card ${Math.round(box.left)}-${Math.round(box.right)} x ${Math.round(box.top)}-${Math.round(box.bottom)})`);
        }
      }
    }
    const long = document.querySelector(`a[href="/manga/${id}"]`)?.parentElement;
    const count = long ? long.querySelectorAll(selector).length : 0;
    if (count !== 2) problems.push(`the long-author card shows ${count} author buttons`);
    window.scrollTo(0, 0);
    return problems;
  }, AUTHOR_BUTTON, longAuthorId);
}

// desktop header with the install button: nothing overflows, logout stays in the viewport
async function headerProblems(page) {
  return page.evaluate(() => {
    const header = document.querySelector('header[data-sticky-header]');
    if (!header) return ['header not found'];
    const problems = [];
    if (header.scrollWidth > header.clientWidth) problems.push(`header overflows (${header.scrollWidth} > ${header.clientWidth})`);
    const logout = document.querySelector('#btn-logout');
    const r = logout && logout.getBoundingClientRect();
    if (!r || r.width === 0) problems.push('#btn-logout not visible');
    else if (r.right > innerWidth) problems.push(`#btn-logout ends at ${Math.round(r.right)} of ${innerWidth}`);
    return problems;
  });
}

// tablet header: the version badge and "Neuer Manga" do not intersect
async function badgeProblems(page) {
  return page.evaluate(() => {
    const badge = document.querySelector('#app-version-badge');
    const add = document.querySelector('#btn-header-add-manga');
    if (!badge || !add) return [`${badge ? '#btn-header-add-manga' : '#app-version-badge'} missing`];
    const a = badge.getBoundingClientRect();
    const b = add.getBoundingClientRect();
    if (a.width === 0 || b.width === 0) return ['badge or add button not visible'];
    const cut = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return cut ? [`version badge (${Math.round(a.left)}-${Math.round(a.right)}) overlaps the add button (${Math.round(b.left)}-${Math.round(b.right)})`] : [];
  });
}

// keyboard focus never lands under the sticky dashboard header (WCAG 2.4.11): Tab through the first stops from the top;
// fixed layers (skip link, bottom navigation) lie above the header anyway
async function focusUnderHeader(page, stops = 25) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
  });
  const problems = [];
  let position = null;
  for (let i = 0; i < stops; i++) {
    await page.keyboard.press('Tab');
    const result = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const header = document.querySelector('header[data-sticky-header]');
      if (!header) return { problem: 'header not found' };
      const headerPosition = getComputedStyle(header).position;
      const el = document.activeElement;
      if (!el || el === document.body || header.contains(el)) return { headerPosition };
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === 'fixed') return { headerPosition };
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return { headerPosition };
      const bottom = header.getBoundingClientRect().bottom;
      if (r.top >= bottom - 1) return { headerPosition };
      const name = el.id ? `#${el.id}` : (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40) || el.tagName);
      return { headerPosition, problem: `${name} at ${Math.round(r.top)} under the header (bottom ${Math.round(bottom)})` };
    });
    position = result.headerPosition || position;
    if (result.problem) problems.push(result.problem);
  }
  // a focused text field hides the bottom navigation; leave a neutral state for the next step
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => !document.querySelector('#bottom-nav[data-keyboard="open"]'), { timeout: 5000 }).catch(() => {});
  return { problems, position };
}

// shelf view on a narrow phone: every spine and gap lies inside the viewport, the page does not scroll sideways
async function shelfProblems(page, minEntries = 26) {
  return page.evaluate((min) => {
    const entries = Array.from(document.querySelectorAll('.manga-spine, .manga-spine-ghost'));
    if (entries.length < min) return [`only ${entries.length} shelf entries`];
    const problems = [];
    for (const el of entries) {
      const r = el.getBoundingClientRect();
      if (r.left < -0.5 || r.right > innerWidth + 0.5) {
        problems.push(`${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || 'spine'} at ${Math.round(r.left)}-${Math.round(r.right)} of ${innerWidth}`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    return problems;
  }, minEntries);
}

/**
 * Account dialog, tab "Sprache": English (PUT /auth/profile, remount, the dialog reopens in English, survives a
 * reload), then back to the device language (--lang=de-DE). Ends with the dialog closed on the German shelf.
 */
async function languageSwitch(page, snap = async () => {}) {
    await clickSelector(page, '#btn-change-password');
    await clickSelector(page, '#account-tab-language');
    const languageSelect = '[role="dialog"] [role="tabpanel"] select';
    await page.waitForSelector(languageSelect, { visible: true, timeout: 5000 });
    const toEnglish = waitForApi(page, 'PUT', '/api/auth/profile');
    await page.select(languageSelect, 'en');
    assert.ok((await toEnglish).ok(), 'PUT /api/auth/profile (en) failed');
    // the switch remounts the page; the account dialog comes back on its language tab, now English
    await page.waitForSelector('[role="dialog"][aria-label="Language"]', { visible: true, timeout: 10000 });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.evaluate(() => localStorage.getItem('mangashelf_locale')), 'en');
    assert.equal((await apiOk(page, 'GET', '/api/auth/me')).user.locale, 'en');
    const englishLabel = await page.$eval(languageSelect, (el) => document.querySelector(`label[for="${el.id}"]`)?.textContent);
    assert.equal(englishLabel, 'Language');
    await snap('15c_language_english');
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en', 'the choice survives a reload');
    await clickSelector(page, '#btn-change-password');
    await clickSelector(page, '#account-tab-language');
    await page.waitForSelector(languageSelect, { visible: true, timeout: 5000 });
    const toDevice = waitForApi(page, 'PUT', '/api/auth/profile');
    await page.select(languageSelect, '');
    assert.ok((await toDevice).ok(), 'PUT /api/auth/profile (device) failed');
    await page.waitForSelector('[role="dialog"][aria-label="Sprache"]', { visible: true, timeout: 10000 });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'de', 'back to the device language (--lang=de-DE)');
    assert.equal((await apiOk(page, 'GET', '/api/auth/me')).user.locale, null);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
}

// Editions: "+ Ausgabe" on Frieren creates an English (US) edition and opens it; the switcher links both, hero and shelf card
// carry the EN pill, the shelf's 'Sprache' filter shows only it (URL ?lang=en). The edition goes to the trash afterwards, so
// the later steps see the two seeded series again.
async function editionTour(page, frierenId, snap = async () => {}) {
    await page.goto(`${BASE_URL}/manga/${frierenId}`, { waitUntil: 'networkidle0' });
    await clickSelector(page, '#btn-add-edition');
    const languageSelect = '#edition-dialog select[id$="-language"]';
    await page.waitForSelector(languageSelect, { visible: true, timeout: 5000 });
    assert.equal(await page.$eval(languageSelect, (el) => el.value), 'en', 'a German series suggests an English edition');
    await page.select('#edition-dialog select[id$="-region"]', 'US');
    assert.equal(await page.$eval('#edition-dialog select[id$="-currency"]', (el) => el.value), 'USD', 'the region picks its currency');
    const created = waitForApi(page, 'POST', `/api/mangas/${frierenId}/editions`);
    await clickSelector(page, '#btn-create-edition');
    const answer = await created;
    assert.ok(answer.ok(), `POST /api/mangas/${frierenId}/editions answered ${answer.status()}`);
    const englishId = (await answer.json()).id;
    await page.waitForFunction((id) => window.location.pathname === `/manga/${id}`, { timeout: 10000 }, englishId);
    await page.waitForSelector(`#edition-switcher a[href="/manga/${frierenId}"]`, { visible: true, timeout: 10000 });
    assert.ok((await page.$eval('#edition-switcher [aria-current="page"]', (el) => el.textContent)).startsWith('EN-US'));
    assert.ok(await page.$('.language-pill[data-language="en"]'), 'no language pill in the hero of the English edition');
    await snap('04c_edition_switcher');

    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#filter-language-select', { visible: true, timeout: 10000 });
    assert.ok(await page.$('.language-pill[data-language="en"]'), 'no language pill on the shelf');
    await page.select('#filter-language-select', 'en');
    await waitUntil(async () => JSON.stringify(await visibleSeriesIds(page)) === JSON.stringify([englishId]),
      { message: 'the language filter should show only the English edition' });
    assert.ok(page.url().includes('lang=en'), 'the language filter is kept in the URL');
    await snap('04d_filter_language');
    await page.select('#filter-language-select', 'ALL');
    await apiOk(page, 'DELETE', `/api/mangas/${englishId}`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await waitUntil(async () => (await visibleSeriesIds(page)).length === 2, { message: 'the edition did not leave the shelf' });
}

const NARROW_PHONE = { width: 360, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHELF_LAYOUTS = [['rows', 'm'], ['fit', 'm'], ['rows', 'l']];

async function runDeepTestSuite() {
  const artifactScreenshotsDir = process.env.SCREENSHOTS_DIR || path.join(__dirname, 'test_screenshots');
  fs.mkdirSync(artifactScreenshotsDir, { recursive: true });
  const executablePath = findChrome();

  console.log('🚀 Starting Deep E2E & Visual Testing Suite...');
  console.log('Browser:', executablePath);
  console.log('Screenshots Target:', artifactScreenshotsDir);

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: CHROME_ARGS
  });
  const page = await browser.newPage();
  const watcher = watchPage(page);
  const snap = async (name) => {
    await page.screenshot({ path: path.join(artifactScreenshotsDir, `${name}.png`), fullPage: false });
    console.log(`  📸 Screenshot saved: ${name}.png`);
  };
  const overflow = {
    dashboard: null, detail: null, toolbar: null, hero: {}, addDialog: null, authors: null, header: null, badge: null,
    focus: {}, shelf: {}
  };

  try {
    // STEP 1: Login validation and login
    console.log('\n--- Step 1: Login Page & Validation ---');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle0' });
    await snap('01_login_page');
    await typeInto(page, 'input[type="text"]', E2E_USER);
    await typeInto(page, 'input[type="password"]', 'wrongpassword_test');
    const rejected = waitForApi(page, 'POST', '/api/auth/login');
    await clickSelector(page, 'button[type="submit"]');
    assert.equal((await rejected).status(), 401, 'a wrong password must be rejected');
    assert.ok(page.url().includes('/login'), 'a wrong password must keep the login page');
    await snap('01b_login_invalid_password');

    await loginViaUi(page, BASE_URL, E2E_USER, E2E_PASSWORD);
    // the 401 of the wrong password and the probes before the login are expected
    watcher.reset();

    const onePieceId = await seedSeries(page, {
      title: 'One Piece', publisher: 'Carlsen Manga', author: 'Eiichiro Oda', total_volumes: 108,
      volumes: { from: 1, to: 5, status: 'Vorhanden' }
    });
    await apiOk(page, 'POST', '/api/volumes/batch', { manga_id: onePieceId, from: 6, to: 8, status: 'Fehlt' });
    const frierenId = await seedSeries(page, {
      title: 'Frieren', publisher: 'Egmont Manga', author: 'Kanehito Yamada', total_volumes: 13,
      volumes: { from: 1, to: 3, status: 'Vorhanden' }
    });

    // STEP 2: Dashboard views
    console.log('\n--- Step 2: Dashboard Overview & View Modes ---');
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await waitUntil(async () => (await visibleSeriesIds(page)).length === 2, { message: 'seeded series are not listed' });
    await snap('02_dashboard_shelf_view');
    await clickSelector(page, '#btn-view-list');
    await snap('03b_dashboard_list_view');
    await clickSelector(page, '#btn-view-grid');
    await snap('03_dashboard_grid_view');

    // STEP 3: Search & publisher filter
    console.log('\n--- Step 3: Search & Filters ---');
    await typeInto(page, '#main-search-input', 'Piece');
    await waitUntil(async () => JSON.stringify(await visibleSeriesIds(page)) === JSON.stringify([onePieceId]),
      { message: 'search "Piece" should show only One Piece' });
    await snap('04_search_onepiece');
    await typeInto(page, '#main-search-input', '');
    const egmont = await page.evaluate(() => {
      const opt = Array.from(document.querySelectorAll('#filter-publisher-select option')).find(o => o.value.includes('Egmont'));
      return opt ? opt.value : null;
    });
    assert.ok(egmont, 'publisher filter has no Egmont option');
    await page.select('#filter-publisher-select', egmont);
    await waitUntil(async () => JSON.stringify(await visibleSeriesIds(page)) === JSON.stringify([frierenId]),
      { message: 'publisher filter should show only Frieren' });
    await snap('04b_filter_publisher');
    await page.select('#filter-publisher-select', 'ALL');

    // STEP 3b: Editions in other languages
    console.log('\n--- Step 3b: Editions (Switcher, Language Pill, Sprache Filter) ---');
    await editionTour(page, frierenId, snap);

    // STEP 4: Statistics
    console.log('\n--- Step 4: Statistics Modal & Tabs ---');
    await clickSelector(page, '#btn-open-stats');
    await snap('05_stats_overview');
    await clickText(page, 'Verlagsdiagramm');
    await snap('05b_stats_publishers');
    await clickText(page, 'Lese-Tracking');
    await snap('05c_stats_reading');
    await clickSelector(page, '#btn-close-stats-modal');

    // STEP 5: Shopping list
    console.log('\n--- Step 5: Shopping List / Buchladen-Modus ---');
    await clickSelector(page, '#btn-nav-shopping');
    await page.waitForSelector('#btn-shop-priority-sort', { visible: true, timeout: 10000 });
    await snap('06_shopping_list_view');
    const missingBefore = (await getVolumes(page, onePieceId)).filter(v => v.status === 'Fehlt').length;
    await clickText(page, 'Gekauft');
    await waitUntil(async () => (await getVolumes(page, onePieceId)).filter(v => v.status === 'Fehlt').length === missingBefore - 1,
      { message: 'quick buy did not move a volume into the shelf' });
    await snap('06b_shopping_after_quick_buy');
    await clickSelector(page, '#btn-nav-shelf');

    // STEP 6: Series detail and its modals
    console.log('\n--- Step 6: Manga Detail View & Volumes ---');
    await clickSelector(page, `a[href="/manga/${onePieceId}"]`);
    await page.waitForFunction(id => location.pathname === `/manga/${id}`, { timeout: 10000 }, onePieceId);
    await page.waitForSelector('button[title="Reihe löschen"]', { visible: true, timeout: 10000 });
    await snap('08_manga_detail_header');
    await page.evaluate(() => window.scrollBy(0, 450));
    await snap('08b_manga_detail_volumes');

    await typeInto(page, 'input[placeholder*="Band-Nr."]', '9');
    await typeInto(page, 'input[placeholder*="Preis"]', '7.00');
    const added = waitForApi(page, 'POST', '/api/volumes');
    await clickText(page, 'Hinzufügen', { selector: 'button[type="submit"]' });
    assert.ok((await added).ok(), 'quick add failed');
    assert.ok((await getVolumes(page, onePieceId)).some(v => String(v.volume_number) === '9'), 'Band 9 is missing');
    await snap('09_volume_single_added');

    const batchDialog = '[role="dialog"][aria-label="Bände hinzufügen"]';
    await clickText(page, 'Mehrere Bände');
    await page.waitForSelector(batchDialog, { visible: true, timeout: 5000 });
    await snap('10_batch_volume_modal');
    await clickText(page, 'Abbrechen', { within: batchDialog });
    await page.waitForFunction(sel => !document.querySelector(sel), { timeout: 5000 }, batchDialog);

    const editDialog = '[role="dialog"][aria-label="Band bearbeiten"]';
    await clickSelector(page, 'button[title="Band-Details & Fotos bearbeiten"]');
    await page.waitForSelector(editDialog, { visible: true, timeout: 5000 });
    await snap('11_edit_volume_modal');
    await clickText(page, 'Abbrechen', { within: editDialog });
    await page.waitForFunction(sel => !document.querySelector(sel), { timeout: 5000 }, editDialog);

    const readDialog = '[role="dialog"][aria-label="Lesestatus setzen"]';
    await clickText(page, 'als gelesen');
    await page.waitForSelector(readDialog, { visible: true, timeout: 5000 });
    await snap('12_batch_read_modal');
    await clickText(page, 'Abbrechen', { within: readDialog });
    await page.waitForFunction(sel => !document.querySelector(sel), { timeout: 5000 }, readDialog);

    await clickText(page, 'Bearbeiten');
    await page.waitForFunction(() => document.body.innerText.includes('Manga bearbeiten'), { timeout: 5000 });
    await snap('13_manga_edit_modal');
    await clickText(page, 'Abbrechen');
    await page.waitForFunction(() => !document.body.innerText.includes('Manga bearbeiten'), { timeout: 5000 });

    await clickSelector(page, 'a[href="/"]');
    await page.waitForFunction(() => location.pathname === '/', { timeout: 10000 });

    // STEP 7: User management
    console.log('\n--- Step 7: User Management Modal ---');
    await clickSelector(page, '#btn-open-users');
    await snap('14_user_management_modal');
    await clickSelector(page, '#btn-close-users-modal');

    // STEP 8: Backups
    console.log('\n--- Step 8: Backup & Snapshot Management ---');
    await clickSelector(page, '#btn-open-backups');
    await snap('15_backup_snapshots_modal');
    await clickText(page, 'ZIP-Datei hochladen');
    await page.waitForSelector('#backup-file-input', { timeout: 5000 });
    await snap('15b_backup_upload_tab');
    await clickSelector(page, '#btn-close-restore-modal');

    // STEP 8b: UI language through the account dialog (tab "Sprache"): English and back to the device language
    console.log('\n--- Step 8b: Language Switch (Account → Sprache) ---');
    await languageSwitch(page, snap);

    // STEP 9: Phone viewport
    console.log('\n--- Step 9: Mobile Viewport Emulation (390 x 844) ---');
    const longAuthorId = await seedSeries(page, {
      title: 'Lange Autorenzeile', publisher: 'Carlsen Manga', author: 'Hans-Peter Müller-Lüdenscheidt, Eiichirō Oda',
      total_volumes: 3, volumes: { from: 1, to: 1, status: 'Vorhanden' }
    });
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`a[href="/manga/${onePieceId}"]`, { timeout: 10000 });
    await snap('16_mobile_dashboard_shelf');
    overflow.toolbar = await toolbarOverlaps(page);
    await clickSelector(page, '#btn-mobile-menu-toggle');
    await snap('16d_mobile_menu_drawer');
    await clickSelector(page, '#btn-mobile-menu-toggle');
    overflow.dashboard = await horizontalOverflow(page);
    await clickSelector(page, '#btn-view-grid');
    await page.waitForSelector(`a[href="/manga/${longAuthorId}"]`, { timeout: 10000 });
    overflow.authors = await authorProblems(page, longAuthorId);
    await snap('16e_mobile_grid_authors');
    overflow.focus['390x844'] = await focusUnderHeader(page);
    await snap('16f_mobile_keyboard_focus');

    await clickSelector(page, '#btn-mobile-shopping');
    await page.waitForSelector('#btn-shop-priority-sort', { timeout: 10000 });
    await snap('16b_mobile_shopping_list');

    await page.goto(`${BASE_URL}/manga/${onePieceId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('button[title="Reihe löschen"]', { timeout: 10000 });
    await snap('16c_mobile_manga_detail');
    overflow.detail = await horizontalOverflow(page);

    // STEP 10: landscape phone and tablet portrait
    console.log('\n--- Step 10: Landscape Phone (844 x 390) & Tablet (820 x 1180) ---');
    const longTitleId = await seedSeries(page, {
      title: 'Mein Nachbar ist ein Drache und ich bin zufällig Bürgermeisterin von Hinterwaldhausen',
      publisher: 'Altraverse', author: 'Kriminalhauptkommissarin Schneider-Wohlgemuth', total_volumes: 12,
      volumes: { from: 1, to: 2, status: 'Vorhanden' }
    });
    for (const [label, viewport] of [['844x390', LANDSCAPE_PHONE], ['820x1180', TABLET_PORTRAIT]]) {
      await page.setViewport(viewport);
      await page.goto(`${BASE_URL}/manga/${longTitleId}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('#btn-edit-manga', { timeout: 10000 });
      await snap(`17_detail_hero_${label}`);
      overflow.hero[label] = await heroProblems(page);
    }

    await page.setViewport(LANDSCAPE_PHONE);
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await clickSelector(page, '#btn-mobile-menu-toggle');
    await clickSelector(page, '#btn-mobile-menu-add');
    const addDialog = '[role="dialog"][aria-label="Neuen Manga anlegen"]';
    await page.waitForSelector(addDialog, { visible: true, timeout: 5000 });
    overflow.addDialog = await dialogProblems(page, addDialog, 'Neuen Manga anlegen');
    await snap('17b_add_series_dialog_844x390');
    await page.keyboard.press('Escape');
    await page.waitForFunction(sel => !document.querySelector(sel), { timeout: 5000 }, addDialog);

    console.log('\n--- Step 10b: Shelf View on a Narrow Phone (360 x 800) ---');
    const shelfId = await seedSeries(page, {
      title: 'Die unglaublich lange Regalreihe der Bürgermeisterin von Hinterwaldhausen', publisher: 'Carlsen Manga',
      total_volumes: 30, volumes: { from: 1, to: 10, status: 'Vorhanden' }
    });
    await apiOk(page, 'POST', '/api/volumes/batch', { manga_id: shelfId, from: 13, to: 26, status: 'Vorhanden' });
    await apiOk(page, 'POST', '/api/volumes', { manga_id: shelfId, volume_number: '27', type: 'schuber', status: 'Vorhanden' });
    await apiOk(page, 'POST', '/api/volumes', { manga_id: shelfId, volume_number: '1', type: 'special_edition', status: 'Vorhanden' });
    await page.setViewport(NARROW_PHONE);
    for (const [mode, scale] of SHELF_LAYOUTS) {
      await page.evaluate((m, sc) => {
        localStorage.setItem('mangashelf_volume_view_mode', 'spine');
        localStorage.setItem('mangashelf_shelf_mode', m);
        localStorage.setItem('mangashelf_shelf_scale', sc);
      }, mode, scale);
      await page.goto(`${BASE_URL}/manga/${shelfId}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.manga-spine', { timeout: 10000 });
      await page.evaluate(() => document.querySelector('.manga-spine').scrollIntoView({ block: 'center' }));
      await snap(`17c_shelf_360_${mode}_${scale}`);
      overflow.shelf[`${mode}/${scale}`] = await shelfProblems(page);
    }
    await page.evaluate(() => ['mangashelf_volume_view_mode', 'mangashelf_shelf_mode', 'mangashelf_shelf_scale'].forEach((k) => localStorage.removeItem(k)));

    // STEP 11: desktop header with the install button, tablet header with the version badge
    console.log('\n--- Step 11: Desktop Header (1280 x 800) & Version Badge (640 x 400) ---');
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#btn-logout', { timeout: 10000 });
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt');
      e.prompt = () => {};
      e.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.dispatchEvent(e);
    });
    await page.waitForSelector('#btn-install-pwa', { visible: true, timeout: 5000 });
    overflow.header = await headerProblems(page);
    await snap('18_desktop_header_1280');
    await page.setViewport({ width: 640, height: 400 });
    await page.waitForSelector('#btn-header-add-manga', { visible: true, timeout: 5000 });
    overflow.badge = await badgeProblems(page);
    await snap('18b_header_badge_640');
    overflow.focus['640x400'] = await focusUnderHeader(page);
    await snap('18c_keyboard_focus_640x400');
    await page.setViewport({ width: 1440, height: 900 });
  } catch (err) {
    console.error('💥 Test suite failed:', err);
    await page.screenshot({ path: path.join(artifactScreenshotsDir, 'error_crash.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    // the report is written before the final checks so it survives a failure
    fs.writeFileSync(
      path.join(artifactScreenshotsDir, 'test_report.json'),
      JSON.stringify({ ...watcher.state, overflow, timestamp: new Date().toISOString() }, null, 2)
    );
    await browser.close().catch(() => {});
  }
  if (process.exitCode) return;

  console.log('\n======================================================');
  console.log('Mobile horizontal overflow:', overflow);
  watcher.assertClean();
  assert.equal(overflow.dashboard, false, 'mobile dashboard scrolls horizontally');
  assert.equal(overflow.detail, false, 'mobile detail page scrolls horizontally');
  assert.deepEqual(overflow.toolbar, [], 'mobile shelf toolbar chips overlap');
  assert.deepEqual(overflow.hero['844x390'], [], 'series hero on a landscape phone (844 x 390)');
  assert.deepEqual(overflow.hero['820x1180'], [], 'series hero on a tablet (820 x 1180)');
  assert.deepEqual(overflow.addDialog, [], 'add-series dialog on a landscape phone (844 x 390)');
  assert.deepEqual(overflow.authors, [], 'author buttons inside their grid card (390 x 844)');
  assert.deepEqual(overflow.header, [], 'desktop header with the install button (1280 x 800)');
  assert.deepEqual(overflow.badge, [], 'version badge clear of the add button (640 x 400)');
  assert.deepEqual(overflow.focus['390x844'].problems, [], 'keyboard focus under the sticky header (390 x 844)');
  assert.equal(overflow.focus['390x844'].position, 'sticky', 'the dashboard header is sticky on a phone (390 x 844)');
  assert.deepEqual(overflow.focus['640x400'].problems, [], 'keyboard focus under the header (640 x 400)');
  assert.equal(overflow.focus['640x400'].position, 'static', 'the header scrolls with the page on a short screen (640 x 400)');
  for (const [mode, scale] of SHELF_LAYOUTS) {
    assert.deepEqual(overflow.shelf[`${mode}/${scale}`], [], `shelf spines inside a 360 px phone (${mode}, scale ${scale})`);
  }
  console.log('🎯 DEEP E2E RUN PASSED');
  console.log('======================================================');
}

if (require.main === module) {
  runDeepTestSuite().catch(err => {
    console.error('💥 Test suite failed:', err);
    process.exitCode = 1;
  });
}

module.exports = { focusUnderHeader, shelfProblems, languageSwitch };
