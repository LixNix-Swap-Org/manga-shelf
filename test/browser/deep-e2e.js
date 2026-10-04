// Browser tour with screenshots of every view and modal; fails on page exceptions, failed API calls, missing
// controls and horizontal scrolling on a phone. Run it with `npm run test:deep` (test/browser/run.js).
const {
  suiteEnv, watchPage, waitUntil, clickText, clickSelector, typeInto, waitForApi, apiOk, seedSeries, getVolumes,
  loginViaUi, visibleSeriesIds
} = require('./helpers');
const { baseUrl: BASE_URL, user: E2E_USER, password: E2E_PASSWORD } = suiteEnv();

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { findChrome } = require('./chrome');

async function horizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

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
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const watcher = watchPage(page);
  const snap = async (name) => {
    await page.screenshot({ path: path.join(artifactScreenshotsDir, `${name}.png`), fullPage: false });
    console.log(`  📸 Screenshot saved: ${name}.png`);
  };
  const overflow = { dashboard: null, detail: null };

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

    // STEP 9: Phone viewport
    console.log('\n--- Step 9: Mobile Viewport Emulation (390 x 844) ---');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await page.waitForSelector(`a[href="/manga/${onePieceId}"]`, { timeout: 10000 });
    await snap('16_mobile_dashboard_shelf');
    await clickSelector(page, '#btn-mobile-menu-toggle');
    await snap('16d_mobile_menu_drawer');
    await clickSelector(page, '#btn-mobile-menu-toggle');
    overflow.dashboard = await horizontalOverflow(page);

    await clickSelector(page, '#btn-mobile-shopping');
    await page.waitForSelector('#btn-shop-priority-sort', { timeout: 10000 });
    await snap('16b_mobile_shopping_list');

    await page.goto(`${BASE_URL}/manga/${onePieceId}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('button[title="Reihe löschen"]', { timeout: 10000 });
    await snap('16c_mobile_manga_detail');
    overflow.detail = await horizontalOverflow(page);
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
  console.log('🎯 DEEP E2E RUN PASSED');
  console.log('======================================================');
}

runDeepTestSuite().catch(err => {
  console.error('💥 Test suite failed:', err);
  process.exitCode = 1;
});
