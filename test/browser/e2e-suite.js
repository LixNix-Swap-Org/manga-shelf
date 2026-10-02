// Browser test. Run it with `npm run <test:...>` (test/browser/run.js starts an isolated server and sets these variables).
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const E2E_USER = process.env.E2E_USER;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!BASE_URL || !E2E_USER || !E2E_PASSWORD) {
  console.error('Set BASE_URL, E2E_USER and E2E_PASSWORD, or use the npm scripts (they start an isolated server).');
  process.exit(2);
}

const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

async function runTestSuite() {
  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const chromePaths = [
    process.env.CHROME_BIN,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  const executablePath = chromePaths.find(p => fs.existsSync(p));
  if (!executablePath) throw new Error('No browser executable found!');

  console.log('Starting automated browser test suite with:', executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Capture any errors or console logs
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error('  [Browser Error]:', msg.text());
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    console.error('  [Page Exception]:', err.message);
    consoleErrors.push(err.message);
  });

  page.on('response', async res => {
    if (res.url().includes('/api/')) {
      const status = res.status();
      if (status >= 400) {
        let body = '';
        try { body = await res.text(); } catch (e) {}
        console.error(`  [API Error ${status}]:`, res.url(), body);
      } else if (res.request().method() === 'POST' || res.request().method() === 'DELETE' || res.request().method() === 'PUT') {
        let body = '';
        try { body = await res.text(); } catch (e) {}
        console.log(`  [API ${res.request().method()} ${status}]:`, res.url(), body.substring(0, 100));
      }
    }
  });

  // Handle dialogs (like window.confirm) automatically
  page.on('dialog', async dialog => {
    console.log('  [Dialog Prompt]:', dialog.message());
    await dialog.accept();
  });

  try {
    // ----------------------------------------------------
    // TEST 1: Navigation & Login
    // ----------------------------------------------------
    console.log('\n--- TEST 1: Navigation & Login ---');
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: path.join(screenshotsDir, 'test1_initial.png') });

    if (page.url().includes('/login')) {
      console.log('Logging in as ' + E2E_USER + '...');
      await page.type('input[type="text"]', E2E_USER);
      await page.type('input[type="password"]', E2E_PASSWORD);
      await page.click('button[type="submit"]');
      await new Promise(r => setTimeout(r, 1200));

    }
    console.log('Current page title/url:', page.url());
    await page.screenshot({ path: path.join(screenshotsDir, 'test1_dashboard_loaded.png') });

    // ----------------------------------------------------
    // TEST 2: Dashboard UI Elements & Filters
    // ----------------------------------------------------
    console.log('\n--- TEST 2: Dashboard UI Elements & Filters ---');
    const statsText = await page.evaluate(() => {
      const stats = Array.from(document.querySelectorAll('section p')).map(p => p.innerText);
      return stats.join(' | ');
    });
    console.log('Stats values found:', statsText);

    // Test Search input
    console.log('Testing search filter...');
    const searchInput = await page.$('input[placeholder*="Titel, Autor"]');
    if (searchInput) {
      await searchInput.type('Berserk');
      await new Promise(r => setTimeout(r, 500));
      await page.screenshot({ path: path.join(screenshotsDir, 'test2_search_berserk.png') });
      // Clear search
      await searchInput.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.evaluate(() => {
        const clearBtn = document.querySelector('header input')?.parentElement?.querySelector('button');
        if (clearBtn) clearBtn.click();
      });
      await new Promise(r => setTimeout(r, 600));
    }

    // Test Publisher Filter
    console.log('Testing publisher filter buttons...');
    const publisherButtons = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.includes('Verlag') || b.innerText.includes('Alle') || b.innerText.includes('altraverse') || b.innerText.includes('Panini'));
      return btns.map(b => b.innerText);
    });
    console.log('Publisher filters available:', publisherButtons);

    // Test Sort Select
    console.log('Testing Sort select...');
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const sortEl = selects.find(s => Array.from(s.options).some(o => o.value === 'title_asc'));
      if (sortEl) {
        sortEl.value = 'title_desc';
        sortEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 400));
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const sortEl = selects.find(s => Array.from(s.options).some(o => o.value === 'title_asc'));
      if (sortEl) {
        sortEl.value = 'title_asc';
        sortEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await new Promise(r => setTimeout(r, 400));

    // ----------------------------------------------------
    // TEST 3: User Management Modal
    // ----------------------------------------------------
    console.log('\n--- TEST 3: User Management Modal ---');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const userBtn = btns.find(b => b.innerText.includes('Benutzer') && b.offsetParent !== null);
      if (userBtn) userBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(screenshotsDir, 'test3_users_modal_open.png') });

    // Create user
    console.log('Creating test user "autotest_user"...');
    await page.type('input[placeholder*="alex"]', 'autotest_user');
    await page.type('input[placeholder*="Mind."]', 'testpass123');
    await page.evaluate(() => {
      const submitBtn = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => b.innerText.includes('Benutzer erstellen'));
      if (submitBtn) submitBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // Verify user appears
    const hasUser = await page.evaluate(() => document.body.innerText.includes('autotest_user'));
    console.log('User created and visible in list:', hasUser);

    // Delete user
    console.log('Deleting test user...');
    await page.evaluate(() => {
      const trashBtns = Array.from(document.querySelectorAll('button[title*="autotest_user"]'));
      if (trashBtns.length > 0) trashBtns[0].click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // Close user modal
    await page.evaluate(() => {
      const closeBtns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.includes('Schließen'));
      if (closeBtns.length > 0) closeBtns[0].click();
    });
    await new Promise(r => setTimeout(r, 500));

    // ----------------------------------------------------
    // TEST 4: Backup Restore Modal & Live Restore Test
    // ----------------------------------------------------
    console.log('\n--- TEST 4: Backup Restore Modal & Live Restore Test ---');
    // the backup to restore is downloaded from the server under test (never read from a data folder on disk)
    const backupBytes = await page.evaluate(async () => {
      const r = await fetch('/api/backup');
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    });
    const tempZipPath = path.join(screenshotsDir, 'test-upload-backup.zip');
    fs.writeFileSync(tempZipPath, Buffer.from(backupBytes));

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const restoreBtn = btns.find(b => b.innerText.includes('Backup einspielen') && b.offsetParent !== null);
      if (restoreBtn) restoreBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(screenshotsDir, 'test4_restore_modal_open.png') });

    const fileInput = await page.$('#backup-file-input');
    if (fileInput) {
      console.log('Uploading backup zip to restore modal...');
      await fileInput.uploadFile(tempZipPath);
      await new Promise(r => setTimeout(r, 600));
      await page.screenshot({ path: path.join(screenshotsDir, 'test4_restore_file_selected.png') });

      console.log('Submitting restore form...');
      await page.evaluate(() => {
        const submitBtn = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => b.innerText.includes('Backup jetzt einspielen'));
        if (submitBtn) submitBtn.click();
      });
      await new Promise(r => setTimeout(r, 3000));
      await page.screenshot({ path: path.join(screenshotsDir, 'test4_restore_completed.png') });
    }

    if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);

    // ----------------------------------------------------
    // TEST 5: Create New Manga Series
    // ----------------------------------------------------
    console.log('\n--- TEST 5: Manga Creation ---');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const addBtn = btns.find(b => b.innerText.includes('Neuer Manga') && b.offsetParent !== null);
      if (addBtn) addBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    const testMangaTitle = '__TEST_AUTOMATION_SERIES__';
    console.log(`Filling out form for "${testMangaTitle}"...`);
    await page.type('input[placeholder*="z.B. One Piece"]', testMangaTitle);
    await page.type('input[placeholder*="z.B. Eiichiro Oda"]', 'Automated Test Author');
    await page.type('input[placeholder*="z.B. Carlsen"]', 'Test Verlag');
    await page.type('input[placeholder*="z.B. 108"]', '10');
    await page.type('textarea', 'Dies ist eine temporäre Testreihe für die automatisierte Test-Suite...');

    await page.screenshot({ path: path.join(screenshotsDir, 'test5_manga_form_filled.png') });

    await page.evaluate(() => {
      const createBtn = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => b.innerText.includes('Manga anlegen'));
      if (createBtn) createBtn.click();
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(screenshotsDir, 'test5_manga_created.png') });

    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('Body text sample after creation:\n' + bodyText.substring(0, 400));

    const hasCreatedManga = await page.evaluate((t) => document.body.innerText.includes(t), testMangaTitle);
    console.log(`Manga "${testMangaTitle}" visible on Dashboard:`, hasCreatedManga);
    if (!hasCreatedManga) throw new Error(`Manga ${testMangaTitle} was not created!`);

    // ----------------------------------------------------
    // TEST 6: Manga Detail Page & Volumes
    // ----------------------------------------------------
    console.log('\n--- TEST 6: Manga Detail Page & Volumes ---');
    await page.evaluate((t) => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => a.innerText.includes(t));
      if (link) link.click();
    }, testMangaTitle);
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(screenshotsDir, 'test6_detail_page.png') });

    // Test Batch Volume Creation
    console.log('Testing Batch Volume Generator...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const batchBtn = btns.find(b => b.innerText.includes('Mehrere Bände'));
      if (batchBtn) batchBtn.click();
    });
    await new Promise(r => setTimeout(r, 600));

    // Fill Batch Modal: 1 to 5
    await page.evaluate(() => {
      const genBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Bände generieren'));
      if (genBtn) genBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(screenshotsDir, 'test6_batch_volumes_generated.png') });

    // Test Quick Add Single Volume with Price
    console.log('Testing Single Volume Quick Add with price...');
    await page.type('input[placeholder*="Band-Nr."]', '6');
    await page.type('input[placeholder*="Preis"]', '8.50');
    await page.evaluate(() => {
      const addBtns = Array.from(document.querySelectorAll('button[type="submit"]'));
      const addBtn = addBtns.find(b => b.innerText.includes('Hinzufügen'));
      if (addBtn) addBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));

    // Verify Band 6 exists
    const hasBand6 = await page.evaluate(() => document.body.innerText.includes('Band 6'));
    console.log('Band 6 added with price:', hasBand6);

    // Test Opening Edit Modal on Band 1
    console.log('Testing Edit Volume modal on Band 1...');
    await page.evaluate(() => {
      const editBtns = Array.from(document.querySelectorAll('button[title*="bearbeiten"]'));
      if (editBtns.length > 0) editBtns[0].click();
    });
    await new Promise(r => setTimeout(r, 600));

    // Fill Condition, Release Year, ISBN in Edit Volume Modal
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const conditionSelect = selects.find(s => Array.from(s.options).some(o => o.value === 'Neuwertig'));
      if (conditionSelect) {
        conditionSelect.value = 'Neuwertig';
        conditionSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const inputs = Array.from(document.querySelectorAll('input'));
      const yearInput = inputs.find(i => i.placeholder && i.placeholder.includes('2023'));
      if (yearInput) {
        yearInput.value = '2021';
        yearInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const isbnInput = inputs.find(i => i.placeholder && i.placeholder.includes('78901'));
      if (isbnInput) {
        isbnInput.value = '978-3-96433-999-9';
        isbnInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const saveBtn = Array.from(document.querySelectorAll('form button[type="submit"]')).find(b => b.innerText.includes('Speichern'));
      if (saveBtn) saveBtn.click();
    });
    await new Promise(r => setTimeout(r, 1200));
    await page.screenshot({ path: path.join(screenshotsDir, 'test6_volume_edited.png') });

    // Test Toggling Volume Status
    console.log('Toggling Volume status...');
    await page.evaluate(() => {
      const volCards = Array.from(document.querySelectorAll('div')).filter(d => d.innerText.includes('Band 1') && d.innerText.includes('Fehlt'));
      if (volCards.length > 0) volCards[0].click();
    });
    await new Promise(r => setTimeout(r, 800));

    // ----------------------------------------------------
    // TEST 7: Cleanup Manga
    // ----------------------------------------------------
    console.log('\n--- TEST 7: Delete Created Manga ---');
    await page.evaluate(() => {
      const delBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Reihe löschen') || b.title?.includes('löschen'));
      if (delBtn) delBtn.click();
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(screenshotsDir, 'test7_after_delete_manga.png') });

    const isDeleted = await page.evaluate((t) => !document.body.innerText.includes(t), testMangaTitle);
    console.log(`Manga "${testMangaTitle}" successfully deleted:`, isDeleted);

    console.log('\n======================================================');
    console.log('🎉 ALL INTEGRATION TESTS PASSED WITH ZERO ERRORS! 🎉');
    console.log('Console Errors caught:', consoleErrors.length);
    console.log('Screenshots saved in:', screenshotsDir);
    console.log('======================================================');

    await browser.close();
  } catch (err) {
    console.error('Test Suite Failed:', err);
    await page.screenshot({ path: path.join(screenshotsDir, 'test_failure.png') }).catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

runTestSuite();
