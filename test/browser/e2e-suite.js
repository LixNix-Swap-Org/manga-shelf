// Browser test. Run it with `npm run test:e2e` (test/browser/run.js starts an isolated server and sets the variables).
const {
  suiteEnv, watchPage, waitForToast, waitUntil, clickText, clickSelector, typeInto, waitForApi, api, apiOk, seedSeries, getVolumes,
  loginViaUi, assertNoHorizontalOverflow, visibleSeriesIds
} = require('./helpers');
const { baseUrl: BASE_URL, user: E2E_USER, password: E2E_PASSWORD } = suiteEnv();

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { findChrome, CHROME_ARGS } = require('./chrome');

const EDIT_BUTTON = 'button[title="Band-Details & Fotos bearbeiten"]';

/** Marks the card of the volume shown as `label` (e.g. "Band 1") with data-e2e and returns that selector. */
async function markVolumeCard(page, label) {
  const marker = `vol-${label.replace(/\W+/g, '-')}`;
  const found = await page.evaluate((lbl, mark, editSel) => {
    for (const el of document.querySelectorAll(`[title="${lbl}"]`)) {
      let node = el.parentElement;
      while (node && !node.querySelector(editSel)) node = node.parentElement;
      if (node) {
        node.setAttribute('data-e2e', mark);
        return true;
      }
    }
    return false;
  }, label, marker, EDIT_BUTTON);
  assert.ok(found, `no volume card for "${label}"`);
  return `[data-e2e="${marker}"]`;
}

async function runTestSuite() {
  const screenshotsDir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const executablePath = findChrome();
  console.log('Starting automated browser test suite with:', executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: CHROME_ARGS
  });
  const page = await browser.newPage();
  const watcher = watchPage(page);
  const snap = name => page.screenshot({ path: path.join(screenshotsDir, `${name}.png`) });

  try {
    // TEST 1: Login
    console.log('\n--- TEST 1: Navigation & Login ---');
    await loginViaUi(page, BASE_URL, E2E_USER, E2E_PASSWORD);
    // the 401 probes before the login are expected
    watcher.reset();
    await snap('test1_dashboard_loaded');

    const alphaTitle = 'Alpha E2E Reihe';
    const zetaTitle = 'Zeta E2E Reihe';
    const alphaId = await seedSeries(page, { title: alphaTitle, publisher: 'Carlsen Manga', author: 'E2E Autor' });
    const zetaId = await seedSeries(page, { title: zetaTitle, publisher: 'Panini Manga', author: 'E2E Autor' });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await waitUntil(async () => {
      const ids = await visibleSeriesIds(page);
      return ids.includes(alphaId) && ids.includes(zetaId);
    }, { message: 'seeded series are not listed on the dashboard' });

    // TEST 2: Search, sort, publisher filter
    console.log('\n--- TEST 2: Dashboard Search, Sort & Filter ---');
    await typeInto(page, '#main-search-input', 'Zeta E2E');
    await waitUntil(async () => JSON.stringify(await visibleSeriesIds(page)) === JSON.stringify([zetaId]),
      { message: 'search "Zeta E2E" should show only the Zeta series' });
    await snap('test2_search');
    await typeInto(page, '#main-search-input', '');
    await waitUntil(async () => (await visibleSeriesIds(page)).length === 2, { message: 'clearing the search should show both series' });

    const sortMarked = await page.evaluate(() => {
      const sel = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'title_desc'));
      if (sel) sel.setAttribute('data-e2e', 'sort');
      return Boolean(sel);
    });
    assert.ok(sortMarked, 'sort select not found');
    const orderOf = async () => {
      const ids = await visibleSeriesIds(page);
      return ids.indexOf(alphaId) - ids.indexOf(zetaId);
    };
    await page.select('[data-e2e="sort"]', 'title_desc');
    await waitUntil(async () => (await orderOf()) > 0, { message: 'Z → A sort should list Zeta before Alpha' });
    await page.select('[data-e2e="sort"]', 'title_asc');
    await waitUntil(async () => (await orderOf()) < 0, { message: 'A → Z sort should list Alpha before Zeta' });

    const carlsenValue = await page.evaluate(() => {
      const opt = Array.from(document.querySelectorAll('#filter-publisher-select option')).find(o => o.value.includes('Carlsen'));
      return opt ? opt.value : null;
    });
    assert.ok(carlsenValue, 'publisher filter has no Carlsen option');
    await page.select('#filter-publisher-select', carlsenValue);
    await waitUntil(async () => JSON.stringify(await visibleSeriesIds(page)) === JSON.stringify([alphaId]),
      { message: 'publisher filter Carlsen should show only the Alpha series' });
    await page.select('#filter-publisher-select', 'ALL');
    await waitUntil(async () => (await visibleSeriesIds(page)).length === 2, { message: 'publisher filter reset' });

    // TEST 3: User management
    console.log('\n--- TEST 3: User Management Modal ---');
    await clickSelector(page, '#btn-open-users');
    await typeInto(page, 'input[placeholder*="alex"]', 'autotest_user');
    await typeInto(page, 'input[placeholder*="Mind."]', 'testpass123');
    const created = waitForApi(page, 'POST', '/api/users');
    await clickText(page, 'Benutzer erstellen', { selector: 'button[type="submit"]' });
    assert.ok((await created).ok(), 'creating the user failed');
    await page.waitForSelector('button[title*="autotest_user"]', { visible: true, timeout: 10000 });
    await snap('test3_user_created');

    const deleted = waitForApi(page, 'DELETE', /^\/api\/users\/\d+$/);
    await clickSelector(page, 'button[title*="autotest_user"]');
    assert.ok((await deleted).ok(), 'deleting the user failed');
    await page.waitForFunction(() => !document.querySelector('button[title*="autotest_user"]'), { timeout: 10000 });
    const users = await apiOk(page, 'GET', '/api/users');
    assert.ok(!users.some(u => u.username === 'autotest_user'), 'the deleted user is still returned by /api/users');
    await clickSelector(page, '#btn-close-users-modal');

    // TEST 3b: Own password dialog (dialog semantics, focus, Escape)
    console.log('\n--- TEST 3b: Change Password Dialog ---');
    await clickSelector(page, '#btn-change-password');
    await page.waitForSelector('[role="dialog"][aria-label="Passwort ändern"]', { timeout: 5000 });
    const dialogInfo = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-label="Passwort ändern"]');
      return { modal: dlg?.getAttribute('aria-modal'), focusInside: Boolean(dlg && dlg.contains(document.activeElement)) };
    });
    assert.equal(dialogInfo.modal, 'true');
    assert.ok(dialogInfo.focusInside, 'focus did not move into the dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Passwort ändern"]'), { timeout: 5000 })
      .catch(() => { throw new Error('Escape did not close the password dialog'); });

    // TEST 4: Restore undoes changes made after the backup
    console.log('\n--- TEST 4: Backup & Restore ---');
    const backupBytes = await page.evaluate(async () => {
      const r = await fetch('/api/backup');
      return { status: r.status, bytes: Array.from(new Uint8Array(await r.arrayBuffer())) };
    });
    assert.equal(backupBytes.status, 200, 'downloading the backup failed');
    assert.ok(backupBytes.bytes.length > 100, 'the backup ZIP is empty');
    const tempZipPath = path.join(screenshotsDir, 'test-upload-backup.zip');
    fs.writeFileSync(tempZipPath, Buffer.from(backupBytes.bytes));
    const sentinelId = await seedSeries(page, { title: '__E2E_RESTORE_SENTINEL__' });

    await clickSelector(page, '#btn-open-backups');
    await clickText(page, 'ZIP-Datei hochladen');
    const fileInput = await page.waitForSelector('#backup-file-input', { timeout: 10000 });
    await fileInput.uploadFile(tempZipPath);
    await snap('test4_restore_file_selected');
    const inspected = waitForApi(page, 'POST', '/api/backup/inspect', { timeout: 60000 });
    await clickSelector(page, '#btn-inspect-backup');
    const inspectRes = await inspected;
    const inspectBody = await inspectRes.json();
    assert.equal(inspectRes.status(), 200, `inspect failed: ${JSON.stringify(inspectBody)}`);
    assert.equal(inspectBody.counts.mangas, 2, 'the inspection should report the two seeded series');
    assert.equal(inspectBody.relogin, false, 'the admin is in the backup and should stay signed in');
    await snap('test4_restore_confirm');
    await typeInto(page, '[role="dialog"] input[autocomplete="current-password"]', E2E_PASSWORD);
    const restored = waitForApi(page, 'POST', `/api/backup/restore/${inspectBody.staging_id}`, { timeout: 60000 });
    await clickSelector(page, '#btn-confirm-restore');
    const restoreRes = await restored;
    const restoreBody = await restoreRes.json();
    assert.equal(restoreRes.status(), 200, `restore failed: ${JSON.stringify(restoreBody)}`);
    assert.equal(restoreBody.success, true);
    assert.equal(restoreBody.mangaCount, 2, 'the backup should contain exactly the two seeded series');
    fs.rmSync(tempZipPath, { force: true });

    const afterRestore = await apiOk(page, 'GET', '/api/mangas');
    const restoredIds = afterRestore.map(m => m.id);
    assert.ok(!restoredIds.includes(sentinelId), 'the series created after the backup survived the restore');
    assert.ok(restoredIds.includes(alphaId) && restoredIds.includes(zetaId), 'series from the backup are missing after the restore');
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    assert.ok(!page.url().includes('/login'), 'the admin was signed out by the restore');
    await snap('test4_restore_completed');

    // TEST 5: Create a series through the UI
    console.log('\n--- TEST 5: Manga Creation ---');
    const testMangaTitle = '__TEST_AUTOMATION_SERIES__';
    await clickSelector(page, '#btn-open-add-manga');
    await typeInto(page, 'input[placeholder*="z.B. One Piece"]', testMangaTitle);
    await typeInto(page, 'input[placeholder*="z.B. Eiichiro Oda"]', 'Automated Test Author');
    await typeInto(page, 'input[placeholder*="z.B. Carlsen"]', 'Test Verlag');
    await typeInto(page, 'input[placeholder*="z.B. 108"]', '10');
    await typeInto(page, 'textarea', 'Dies ist eine temporäre Testreihe für die automatisierte Test-Suite...');
    await snap('test5_manga_form_filled');
    const createdManga = waitForApi(page, 'POST', '/api/mangas');
    await clickText(page, 'Manga anlegen', { selector: 'button[type="submit"]' });
    const createdRes = await createdManga;
    assert.ok(createdRes.ok(), 'creating the series failed');
    const mangaId = (await createdRes.json()).id;
    assert.ok(mangaId, 'POST /api/mangas returned no id');
    await waitUntil(async () => (await visibleSeriesIds(page)).includes(mangaId), { message: 'the new series is not listed' });
    await snap('test5_manga_created');

    // TEST 6: Detail page, volumes
    console.log('\n--- TEST 6: Manga Detail Page & Volumes ---');
    await clickSelector(page, `a[href="/manga/${mangaId}"]`);
    await page.waitForFunction(id => location.pathname === `/manga/${id}`, { timeout: 10000 }, mangaId);
    await clickText(page, 'Mehrere Bände');
    const batchDialog = '[role="dialog"][aria-label="Bände hinzufügen"]';
    await page.waitForSelector(batchDialog, { visible: true, timeout: 5000 });
    const [fromInput, toInput] = await page.$$(`${batchDialog} input[type="number"]`);
    assert.ok(fromInput && toInput, 'batch range inputs not found');
    await typeInto(page, fromInput, '1');
    await typeInto(page, toInput, '5');
    await clickText(page, 'Fehlt noch', { within: batchDialog });
    const batch = waitForApi(page, 'POST', '/api/volumes/batch');
    await clickText(page, 'Bände generieren', { selector: 'button[type="submit"]', within: batchDialog });
    assert.ok((await batch).ok(), 'batch volume creation failed');
    let volumes = await getVolumes(page, mangaId);
    assert.deepEqual(volumes.map(v => String(v.volume_number)).sort((a, b) => a - b), ['1', '2', '3', '4', '5']);
    assert.ok(volumes.every(v => v.status === 'Fehlt'), 'batch volumes should start as "Fehlt"');
    await snap('test6_batch_volumes_generated');

    console.log('Testing Single Volume Quick Add with price...');
    await typeInto(page, 'input[placeholder*="Band-Nr."]', '99');
    await typeInto(page, 'input[placeholder*="Preis"]', '8.50');
    const quickAdd = waitForApi(page, 'POST', '/api/volumes');
    await clickText(page, 'Hinzufügen', { selector: 'button[type="submit"]' });
    assert.ok((await quickAdd).ok(), 'quick add failed');
    await page.waitForFunction(() => document.body.innerText.includes('Band 99'), { timeout: 10000 });
    volumes = await getVolumes(page, mangaId);
    const band99 = volumes.find(v => String(v.volume_number) === '99');
    assert.ok(band99, 'Band 99 is missing in the API');
    assert.equal(Number(band99.price), 8.5);

    console.log('Testing Edit Volume modal on Band 1...');
    const band1 = volumes.find(v => String(v.volume_number) === '1');
    let card = await markVolumeCard(page, 'Band 1');
    await clickSelector(page, `${card} ${EDIT_BUTTON}`);
    const editDialog = '[role="dialog"][aria-label="Band bearbeiten"]';
    await page.waitForSelector(editDialog, { visible: true, timeout: 5000 });
    const conditionMarked = await page.evaluate(dlg => {
      const sel = Array.from(document.querySelectorAll(`${dlg} select`)).find(s => Array.from(s.options).some(o => o.value === 'Neuwertig'));
      if (sel) sel.setAttribute('data-e2e', 'condition');
      return Boolean(sel);
    }, editDialog);
    assert.ok(conditionMarked, 'condition select not found');
    await page.select('[data-e2e="condition"]', 'Neuwertig');
    await typeInto(page, `${editDialog} input[placeholder*="2023"]`, '2021');
    await typeInto(page, `${editDialog} input[placeholder*="78901"]`, '978-3-551-77983-0');
    const saved = waitForApi(page, 'PUT', `/api/volumes/${band1.id}`);
    await clickText(page, 'Speichern', { selector: 'button[type="submit"]', within: editDialog });
    assert.ok((await saved).ok(), 'saving the volume failed');
    await page.waitForFunction(dlg => !document.querySelector(dlg), { timeout: 10000 }, editDialog);
    volumes = await getVolumes(page, mangaId);
    const edited = volumes.find(v => v.id === band1.id);
    assert.equal(edited.condition, 'Neuwertig');
    assert.equal(Number(edited.release_year), 2021);
    assert.equal(edited.isbn, '9783551779830');
    await snap('test6_volume_edited');

    console.log('Toggling Volume status...');
    card = await markVolumeCard(page, 'Band 1');
    // a missing volume becomes owned through the owners route (per-user ownership), not a status PUT
    const toggled = waitForApi(page, 'POST', `/api/volumes/${band1.id}/owners`);
    await clickSelector(page, `${card} button[title^="Status: "]`);
    assert.ok((await toggled).ok(), 'status toggle failed');
    volumes = await getVolumes(page, mangaId);
    assert.equal(volumes.find(v => v.id === band1.id).status, 'Vorhanden', 'the status toggle did not mark Band 1 as owned');

    console.log('Marking Band 1 as read and undoing it from the toast...');
    const READ_BUTTON = 'button[title="Lesestatus umschalten (Gelesen / Ungelesen)"]';
    // the read toggle appears once the refetch shows Band 1 as owned
    await waitUntil(() => page.evaluate(readSel => {
      for (const el of document.querySelectorAll('[title="Band 1"]')) {
        let node = el.parentElement;
        while (node && !node.querySelector(readSel)) node = node.parentElement;
        if (node && node.querySelectorAll(readSel).length === 1) {
          node.querySelector(readSel).setAttribute('data-e2e', 'read-band-1');
          return true;
        }
      }
      return false;
    }, READ_BUTTON), { message: 'Band 1 shows no read toggle after becoming owned' });
    const readOn = waitForApi(page, 'POST', `/api/volumes/${band1.id}/read`);
    await clickSelector(page, '[data-e2e="read-band-1"]');
    assert.ok((await readOn).ok(), 'read toggle failed');
    const readToast = await waitForToast(page, '„Band 1“ als gelesen markiert', { kind: 'success' });
    const readOff = waitForApi(page, 'POST', `/api/volumes/${band1.id}/read`);
    await clickText(page, 'Rückgängig', { within: readToast });
    assert.ok((await readOff).ok(), 'undoing the read toggle failed');
    volumes = await getVolumes(page, mangaId);
    assert.deepEqual(volumes.find(v => v.id === band1.id).read_by || [], [], 'the undo left Band 1 marked as read');

    // TEST 6b: Bulk edit (selection mode, one request, undo from the toast, bulk delete)
    console.log('\n--- TEST 6b: Bulk Edit ---');
    const byNumber = (list, n) => list.find(v => String(v.volume_number) === n);
    await clickSelector(page, '#btn-volume-select-mode');
    await page.waitForSelector('#bulk-action-bar', { visible: true, timeout: 5000 });
    await clickSelector(page, 'input[type="checkbox"][aria-label="Band 2 auswählen"]');
    await clickSelector(page, 'input[type="checkbox"][aria-label="Band 3 auswählen"]');
    await page.waitForFunction(() => document.querySelector('#bulk-action-bar')?.innerText.includes('2 Bände ausgewählt'), { timeout: 5000 });
    const bulkOwned = waitForApi(page, 'POST', '/api/volumes/bulk');
    await clickSelector(page, '#btn-bulk-owned');
    assert.ok((await bulkOwned).ok(), 'bulk "Als vorhanden (mir)" failed');
    volumes = await getVolumes(page, mangaId);
    assert.deepEqual(['2', '3', '4'].map(n => byNumber(volumes, n).status), ['Vorhanden', 'Vorhanden', 'Fehlt'], 'bulk owned changed the wrong volumes');
    await snap('test6b_bulk_owned');
    const bulkToast = await waitForToast(page, '2 Bände als vorhanden (mir) markiert', { kind: 'success' });
    const bulkUndo = waitForApi(page, 'POST', '/api/volumes/bulk');
    await clickText(page, 'Rückgängig', { within: bulkToast });
    const bulkUndoRes = await bulkUndo;
    assert.ok(bulkUndoRes.ok(), 'undoing the bulk edit failed');
    assert.equal(typeof JSON.parse(bulkUndoRes.request().postData() || '{}').revert, 'string', 'the undo must send the server token, not a snapshot');
    volumes = await getVolumes(page, mangaId);
    assert.deepEqual(['2', '3'].map(n => byNumber(volumes, n).status), ['Fehlt', 'Fehlt'], 'the undo did not restore "Fehlt"');
    assert.deepEqual(['2', '3'].map(n => (byNumber(volumes, n).owners || []).length), [0, 0], 'the undo left owners behind');

    // owners and reads must come back with the undo of a delete
    await apiOk(page, 'POST', `/api/volumes/${byNumber(volumes, '2').id}/owners`, { owned: true, purchase_date: '2024-05-05' });
    await apiOk(page, 'POST', `/api/volumes/${byNumber(volumes, '2').id}/read`, { read: true, read_at: '2024-05-06 10:00:00' });
    const ownedBefore = byNumber(await getVolumes(page, mangaId), '2');
    const bulkDelete = waitForApi(page, 'POST', '/api/volumes/bulk');
    await clickSelector(page, '#btn-bulk-delete');
    assert.ok((await bulkDelete).ok(), 'bulk delete failed');
    volumes = await getVolumes(page, mangaId);
    assert.equal(byNumber(volumes, '2'), undefined, 'Band 2 survived the bulk delete');
    assert.equal(byNumber(volumes, '3'), undefined, 'Band 3 survived the bulk delete');
    const deleteToast = await waitForToast(page, '2 Bände gelöscht', { kind: 'success' });
    const deleteUndo = waitForApi(page, 'POST', '/api/volumes/bulk');
    await clickText(page, 'Rückgängig', { within: deleteToast });
    assert.ok((await deleteUndo).ok(), 'undoing the bulk delete failed');
    volumes = await getVolumes(page, mangaId);
    const restoredTwo = byNumber(volumes, '2');
    assert.ok(restoredTwo && byNumber(volumes, '3'), 'the undo did not bring Band 2/3 back');
    assert.equal(restoredTwo.id, ownedBefore.id, 'a restored volume keeps its id');
    assert.deepEqual((restoredTwo.owners || []).map(o => [o.username, o.purchase_date]), (ownedBefore.owners || []).map(o => [o.username, o.purchase_date]),
      'the undo of the delete lost the owners');
    assert.equal(restoredTwo.is_read, ownedBefore.is_read, 'the undo of the delete lost the read state');
    await clickSelector(page, '#btn-volume-select-mode');
    await page.waitForFunction(() => !document.querySelector('#bulk-action-bar'), { timeout: 5000 });

    // TEST 7: Delete the series
    console.log('\n--- TEST 7: Delete Created Manga ---');
    const removed = waitForApi(page, 'DELETE', `/api/mangas/${mangaId}`);
    await clickSelector(page, 'button[title="Reihe löschen"]');
    assert.ok((await removed).ok(), 'deleting the series failed');
    await page.waitForFunction(() => location.pathname === '/', { timeout: 10000 });
    assert.equal((await api(page, 'GET', `/api/mangas/${mangaId}`)).status, 404, 'the deleted series is still served');
    await watcher.expectApiError(`GET /api/mangas/${mangaId} -> 404`);
    await waitUntil(async () => !(await visibleSeriesIds(page)).includes(mangaId), { message: 'the deleted series is still listed' });
    await snap('test7_after_delete_manga');

    // TEST 7b: Series wishlist (chip, shopping list section, ends with the first owned volume)
    console.log('\n--- TEST 7b: Series Wishlist ---');
    const wishTitle = '__TEST_WISH_SERIES__';
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await clickSelector(page, '#btn-open-add-manga');
    await typeInto(page, 'input[placeholder*="z.B. One Piece"]', wishTitle);
    await clickText(page, 'Auf die Wunschliste', { selector: 'label' });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('label')).some(l => l.innerText.includes('Priorität') && l.querySelector('select')),
      { timeout: 10000 });
    const createdWish = waitForApi(page, 'POST', '/api/mangas');
    await clickText(page, 'Manga anlegen', { selector: 'button[type="submit"]' });
    const wishRes = await createdWish;
    assert.ok(wishRes.ok(), 'creating the wished series failed');
    const wishId = (await wishRes.json()).id;
    assert.equal((await apiOk(page, 'GET', `/api/mangas/${wishId}`)).wish_priority, 2, 'the default wish priority is "mittel"');
    const wishChipCount = () => page.evaluate(() => {
      const chip = Array.from(document.querySelectorAll('[aria-label="Status-Filter"] button')).find(b => b.innerText.includes('Wunschliste'));
      return chip ? chip.innerText.replace(/\D+/g, '') : null;
    });
    await waitUntil(async () => (await wishChipCount()) === '1', { message: 'the "Wunschliste" chip does not count the wished series' });
    await snap('test7b_wish_chip');

    await page.goto(`${BASE_URL}/?view=shopping`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#shop-wished-series', { timeout: 10000 })
      .catch(() => { throw new Error('the shopping list shows no "Gewünschte Reihen" section'); });
    const wishedTitles = await page.$$eval('#shop-wished-series li', items => items.map(li => li.innerText));
    assert.equal(wishedTitles.length, 1, 'exactly one wished series is expected');
    assert.ok(wishedTitles[0].includes(wishTitle), 'the wished series is not in the section');
    await snap('test7b_wish_section');

    await apiOk(page, 'POST', '/api/volumes', { manga_id: wishId, volume_number: '1', status: 'Vorhanden' });
    await page.goto(`${BASE_URL}/?view=shopping`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#btn-shop-priority-sort', { timeout: 10000 });
    assert.equal(await page.$('#shop-wished-series'), null, 'an owned volume must end the wish (section still shown)');
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await waitUntil(async () => (await wishChipCount()) === null, { message: 'the "Wunschliste" chip is still shown' });
    await apiOk(page, 'DELETE', `/api/mangas/${wishId}`);

    // TEST 8: No horizontal scrolling on a phone
    console.log('\n--- TEST 8: Mobile viewport 390 x 844 ---');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    const mobilePages = [
      { url: `${BASE_URL}/`, ready: `a[href="/manga/${alphaId}"]`, label: 'dashboard' },
      { url: `${BASE_URL}/?view=shopping`, ready: '#btn-shop-priority-sort', label: 'shopping list' },
      { url: `${BASE_URL}/manga/${alphaId}`, ready: 'button[title="Reihe löschen"]', label: 'series detail' }
    ];
    for (const { url, ready, label } of mobilePages) {
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.waitForSelector(ready, { timeout: 10000 }).catch(() => { throw new Error(`mobile ${label} did not render (${ready})`); });
      await snap(`test8_mobile_${label.replace(/\W+/g, '_')}`);
      await assertNoHorizontalOverflow(page, `mobile ${label}`);
    }
    await page.setViewport({ width: 1440, height: 900 });

    watcher.assertClean();

    console.log('\n======================================================');
    console.log('🎉 ALL INTEGRATION TESTS PASSED 🎉');
    console.log('Screenshots saved in:', screenshotsDir);
    console.log('======================================================');
    await browser.close();
  } catch (err) {
    console.error('Test Suite Failed:', err);
    await page.screenshot({ path: path.join(screenshotsDir, 'test_failure.png') }).catch(() => {});
    await browser.close().catch(() => {});
    process.exitCode = 1;
  }
}

runTestSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exitCode = 1;
});
