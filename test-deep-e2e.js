const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

async function runDeepTestSuite() {
  const artifactScreenshotsDir = path.resolve('C:\\Users\\Test1\\.gemini\\antigravity-ide\\brain\\94e0ebeb-6e7c-4efd-9e23-e0f71c0c962a\\test_screenshots');
  if (!fs.existsSync(artifactScreenshotsDir)) {
    fs.mkdirSync(artifactScreenshotsDir, { recursive: true });
  }

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const executablePath = chromePaths.find(p => fs.existsSync(p));
  if (!executablePath) throw new Error('No browser executable found!');

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

  const collectedErrors = [];
  const networkErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.error('  ⚠️ [Browser Console Error]:', msg.text());
      collectedErrors.push({ type: 'console', text: msg.text() });
    }
  });

  page.on('pageerror', err => {
    console.error('  💥 [Browser Uncaught Exception]:', err.message);
    collectedErrors.push({ type: 'exception', text: err.message });
  });

  page.on('response', async res => {
    if (res.url().includes('/api/') && res.status() >= 400) {
      let body = '';
      try { body = await res.text(); } catch (e) {}
      console.error(`  ❌ [API Error ${res.status()}]:`, res.url(), body);
      networkErrors.push({ status: res.status(), url: res.url(), body });
    }
  });

  page.on('dialog', async dialog => {
    console.log('  💬 [Dialog Detected]:', dialog.message());
    await dialog.accept();
  });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const snap = async (name) => {
    const fullPath = path.join(artifactScreenshotsDir, `${name}.png`);
    await page.screenshot({ path: fullPath, fullPage: false });
    console.log(`  📸 Screenshot saved: ${name}.png`);
  };

  try {
    // ----------------------------------------------------
    // STEP 1: Login & Auth Flow
    // ----------------------------------------------------
    console.log('\n--- Step 1: Testing Login Page & Validation ---');
    await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle0' });
    await snap('01_login_page');

    // Test invalid credentials
    console.log('  Testing invalid password rejection...');
    const userInputs = await page.$$('input[type="text"], input[name="username"]');
    if (userInputs.length > 0) {
      await userInputs[0].type('admin');
      const passInput = await page.$('input[type="password"]');
      if (passInput) await passInput.type('wrongpassword_test');
      const submitBtn = await page.$('button[type="submit"]');
      if (submitBtn) await submitBtn.click();
      await sleep(1000);
      await snap('01b_login_invalid_password');
    }

    // Reload page to reset form state cleanly
    console.log('  Reloading and logging in with valid admin credentials...');
    await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle0' });
    await page.type('input[type="text"], input[name="username"]', 'admin');
    await page.type('input[type="password"]', 'password123');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
    ]);
    await sleep(1500);

    // ----------------------------------------------------
    // STEP 2: Dashboard Shelf View
    // ----------------------------------------------------
    console.log('\n--- Step 2: Dashboard Overview & Shelf View ---');
    await snap('02_dashboard_shelf_view');

    // Test switching views: Grid vs List
    console.log('  Testing View Mode switches (Grid & List)...');
    
    // Switch to List view
    const listBtn = await page.$('#btn-view-list');
    if (listBtn) {
      await listBtn.click();
      await sleep(600);
      await snap('03b_dashboard_list_view');
    }

    // Switch back to Grid view
    const gridBtn = await page.$('#btn-view-grid');
    if (gridBtn) {
      await gridBtn.click();
      await sleep(600);
      await snap('03_dashboard_grid_view');
    }

    // ----------------------------------------------------
    // STEP 3: Search & Filtering
    // ----------------------------------------------------
    console.log('\n--- Step 3: Search & Filters ---');
    const searchInput = await page.$('#main-search-input, input[placeholder*="Titel, Autor"]');
    if (searchInput) {
      await searchInput.type('Piece');
      await sleep(600);
      await snap('04_search_onepiece');
      // Clear
      await page.evaluate(() => {
        const input = document.querySelector('#main-search-input') || document.querySelector('input[placeholder*="Titel, Autor"]');
        if (input) {
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await sleep(500);
    }

    // Filter by publisher
    console.log('  Filtering by publisher chip...');
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const pubSelect = selects.find(s => Array.from(s.options).some(o => o.value === 'altraverse' || o.value === 'Panini Manga'));
      if (pubSelect) {
        pubSelect.value = 'altraverse';
        pubSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await sleep(600);
    await snap('04b_filter_publisher');

    // Reset publisher filter
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('select'));
      const pubSelect = selects.find(s => Array.from(s.options).some(o => o.value === 'altraverse' || o.value === 'Panini Manga'));
      if (pubSelect) {
        pubSelect.value = 'ALL';
        pubSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await sleep(500);

    // ----------------------------------------------------
    // STEP 4: Statistics Modal & Tabs
    // ----------------------------------------------------
    console.log('\n--- Step 4: Statistics Modal & Subtabs ---');
    const openStatsBtn = await page.$('#btn-open-stats');
    if (openStatsBtn) await openStatsBtn.click();
    await sleep(1000);
    await snap('05_stats_overview');

    // Switch to Publishers tab in stats
    console.log('  Viewing Stats: Verlage Tab...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const pubTab = btns.find(b => b.innerText.includes('Verlagsdiagramm') && b.offsetParent !== null);
      if (pubTab) pubTab.click();
    });
    await sleep(600);
    await snap('05b_stats_publishers');

    // Switch to Reading tab in stats
    console.log('  Viewing Stats: Lese-Statistik Tab...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const readTab = btns.find(b => b.innerText.includes('Lese-Tracking') && b.offsetParent !== null);
      if (readTab) readTab.click();
    });
    await sleep(600);
    await snap('05c_stats_reading');

    // Close stats modal reliably using ID
    console.log('  Closing stats modal...');
    const closeStatsBtn = await page.$('#btn-close-stats-modal');
    if (closeStatsBtn) {
      await closeStatsBtn.click();
    } else {
      await page.click('#btn-close-stats-modal-x').catch(() => {});
    }
    await sleep(700);

    // ----------------------------------------------------
    // STEP 5: Shopping List / Buchladen-Modus
    // ----------------------------------------------------
    console.log('\n--- Step 5: Shopping List / Buchladen-Modus ---');
    const navShoppingBtn = await page.$('#btn-nav-shopping');
    if (navShoppingBtn) await navShoppingBtn.click();
    await sleep(1000);
    await snap('06_shopping_list_view');

    // Test Quick Buy toggle in shopping list
    console.log('  Testing Quick Buy action in shopping list...');
    await page.evaluate(() => {
      const buyBtns = Array.from(document.querySelectorAll('button')).filter(b => b.innerText.includes('Gekauft') && b.offsetParent !== null);
      if (buyBtns.length > 0) buyBtns[0].click();
    });
    await sleep(1200);
    await snap('06b_shopping_after_quick_buy');

    // Switch back to Regal view
    const navShelfBtn = await page.$('#btn-nav-shelf');
    if (navShelfBtn) await navShelfBtn.click();
    await sleep(800);

    // ----------------------------------------------------
    // STEP 6: ISBN & Barcode Scanner Modal
    // ----------------------------------------------------
    console.log('\n--- Step 6: ISBN & Barcode Scanner Modal ---');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const scanBtn = btns.find(b => b.innerText.includes('Scanner') || b.title?.includes('Scanner'));
      if (scanBtn) scanBtn.click();
    });
    await sleep(1000);
    await snap('07_scanner_modal_open');

    // Switch to Manual ISBN Mode
    console.log('  Testing Manual ISBN lookup with German DNB API...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const manualBtn = btns.find(b => b.innerText.includes('Manuell') || b.innerText.includes('ISBN'));
      if (manualBtn) manualBtn.click();
    });
    await sleep(500);

    // Type a real German manga ISBN (One Piece Band 1: 9783551779830)
    const isbnInput = await page.$('input[placeholder*="978-"]');
    if (isbnInput) {
      await isbnInput.type('9783551779830');
      await snap('07b_scanner_manual_isbn_typed');
      
      // Click Search button
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const searchBtn = btns.find(b => b.innerText.includes('Suchen') && b.offsetParent !== null);
        if (searchBtn) searchBtn.click();
      });
      await sleep(2500);
      await snap('07c_scanner_dnb_lookup_result');
    }

    // Close scanner modal
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const closeBtn = btns.find(b => b.innerText.includes('Schließen') || b.title?.includes('Schließen') || b.querySelector('svg.lucide-x'));
      if (closeBtn) closeBtn.click();
    });
    await sleep(600);

    // ----------------------------------------------------
    // STEP 7: Manga Detail View & Volume Management
    // ----------------------------------------------------
    console.log('\n--- Step 7: Manga Detail View & Volumes ---');
    // Click on One Piece
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => a.innerText.includes('One Piece'));
      if (link) link.click();
    });
    await sleep(1200);
    await snap('08_manga_detail_header');

    // Scroll down to volume list
    await page.evaluate(() => window.scrollBy(0, 450));
    await sleep(500);
    await snap('08b_manga_detail_volumes');

    // Test Adding a Single Volume with Price
    console.log('  Testing Single Volume Quick-Add with price...');
    const volNumInput = await page.$('input[placeholder*="Band-Nr."]');
    const volPriceInput = await page.$('input[placeholder*="Preis"]');
    if (volNumInput && volPriceInput) {
      await volNumInput.type('6');
      await volPriceInput.type('7.00');
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button[type="submit"]'));
        const addBtn = btns.find(b => b.innerText.includes('Hinzufügen'));
        if (addBtn) addBtn.click();
      });
      await sleep(1200);
      await snap('09_volume_single_added');
    }

    // Test Batch Volume Generator
    console.log('  Testing Batch Volume Generator modal...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const batchBtn = btns.find(b => b.innerText.includes('Mehrere Bände'));
      if (batchBtn) batchBtn.click();
    });
    await sleep(800);
    await snap('10_batch_volume_modal');

    // Close batch modal
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancelBtn = btns.find(b => b.innerText.includes('Abbrechen') && b.offsetParent !== null);
      if (cancelBtn) cancelBtn.click();
    });
    await sleep(500);

    // Test Edit Volume Modal
    console.log('  Testing Edit Volume modal...');
    await page.evaluate(() => {
      const editBtns = Array.from(document.querySelectorAll('button[title*="bearbeiten"]'));
      if (editBtns.length > 0) editBtns[0].click();
    });
    await sleep(800);
    await snap('11_edit_volume_modal');

    // Close edit volume modal
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancelBtn = btns.find(b => b.innerText.includes('Abbrechen') && b.offsetParent !== null);
      if (cancelBtn) cancelBtn.click();
    });
    await sleep(500);

    // Test Batch Read Modal
    console.log('  Testing Batch Read ("Bände 1 bis X gelesen") modal...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const batchReadBtn = btns.find(b => b.innerText.includes('als gelesen markieren') || b.innerText.includes('Bis Band'));
      if (batchReadBtn) batchReadBtn.click();
    });
    await sleep(800);
    await snap('12_batch_read_modal');

    // Close batch read modal
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancelBtn = btns.find(b => b.innerText.includes('Abbrechen') && b.offsetParent !== null);
      if (cancelBtn) cancelBtn.click();
    });
    await sleep(500);

    // Test Edit Manga Modal (AniList Lookup)
    console.log('  Testing Manga Edit & AniList lookup modal...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const editMangaBtn = btns.find(b => b.innerText.includes('Reihe bearbeiten') || b.title?.includes('Reihe bearbeiten'));
      if (editMangaBtn) editMangaBtn.click();
    });
    await sleep(800);
    await snap('13_manga_edit_modal');

    // Close edit manga modal
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const cancelBtn = btns.find(b => b.innerText.includes('Abbrechen') && b.offsetParent !== null);
      if (cancelBtn) cancelBtn.click();
    });
    await sleep(600);

    // Navigate back to Dashboard
    await page.evaluate(() => {
      const backLink = document.querySelector('a[href="/"]');
      if (backLink) backLink.click();
    });
    await sleep(1000);

    // ----------------------------------------------------
    // STEP 8: User Management Modal
    // ----------------------------------------------------
    console.log('\n--- Step 8: User Management Modal ---');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const userBtn = btns.find(b => b.innerText.includes('Benutzer') && b.offsetParent !== null);
      if (userBtn) userBtn.click();
    });
    await sleep(1000);
    await snap('14_user_management_modal');

    // Close user modal
    await page.evaluate(() => {
      const closeBtn = document.querySelector('#btn-close-users-modal') || document.querySelector('#btn-close-users-modal-x');
      if (closeBtn) {
        closeBtn.click();
        return;
      }
      const btns = Array.from(document.querySelectorAll('button'));
      const found = btns.find(b => b.innerText.includes('Schließen') && b.offsetParent !== null);
      if (found) found.click();
    });
    await sleep(600);

    // ----------------------------------------------------
    // STEP 9: Backup Snapshots & Restore Modal
    // ----------------------------------------------------
    console.log('\n--- Step 9: Backup & Snapshot Management ---');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const backupBtn = btns.find(b => b.innerText.includes('Backup einspielen') || b.innerText.includes('Backup') || b.id === 'btn-open-backups');
      if (backupBtn) backupBtn.click();
    });
    await sleep(1000);
    await snap('15_backup_snapshots_modal');

    // Switch to Upload ZIP tab
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const uploadTab = btns.find(b => b.innerText.includes('ZIP hochladen') && b.offsetParent !== null);
      if (uploadTab) uploadTab.click();
    });
    await sleep(600);
    await snap('15b_backup_upload_tab');

    // Close backup modal
    await page.evaluate(() => {
      const closeBtn = document.querySelector('#btn-close-restore-modal') || document.querySelector('#btn-close-restore-modal-x');
      if (closeBtn) {
        closeBtn.click();
        return;
      }
      const btns = Array.from(document.querySelectorAll('button'));
      const found = btns.find(b => b.innerText.includes('Schließen') && b.offsetParent !== null);
      if (found) found.click();
    });
    await sleep(600);

    // ----------------------------------------------------
    // STEP 10: Mobile Responsive Viewport (390 x 844)
    // ----------------------------------------------------
    console.log('\n--- Step 10: Mobile Viewport Emulation (390 x 844) ---');
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await sleep(600);
    await snap('16_mobile_dashboard_shelf');

    // Test Mobile Menu Drawer
    console.log('  Testing Mobile Navigation Drawer toggle...');
    const mobileMenuBtn = await page.$('#btn-mobile-menu-toggle');
    if (mobileMenuBtn) {
      await mobileMenuBtn.click();
      await sleep(600);
      await snap('16d_mobile_menu_drawer');
      // Close drawer
      await mobileMenuBtn.click();
      await sleep(400);
    }

    // Check if horizontal scrolling happens
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    console.log('  Mobile Horizontal Overflow detected:', hasHorizontalOverflow);

    // Mobile Shopping List
    await page.evaluate(() => {
      const shopBtn = document.querySelector('#btn-mobile-shopping') || document.querySelector('#btn-nav-shopping');
      if (shopBtn) shopBtn.click();
    });
    await sleep(800);
    await snap('16b_mobile_shopping_list');

    // Mobile Manga Detail
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const shelfTab = btns.find(b => b.innerText.includes('Mein Regal') || b.innerText.includes('Regal'));
      if (shelfTab) shelfTab.click();
    });
    await sleep(600);

    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const link = links.find(a => a.innerText.includes('One Piece'));
      if (link) link.click();
    });
    await sleep(1000);
    await snap('16c_mobile_manga_detail');

    // Check Detail horizontal overflow
    const detailOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    console.log('  Mobile Detail Horizontal Overflow detected:', detailOverflow);

    // Reset viewport to desktop
    await page.setViewport({ width: 1440, height: 900 });

    console.log('\n======================================================');
    console.log('🎯 COMPREHENSIVE E2E & SCREENSHOT RUN COMPLETE');
    console.log(`Total Console Errors: ${collectedErrors.length}`);
    console.log(`Total API/Network Errors: ${networkErrors.length}`);
    console.log('======================================================');

    fs.writeFileSync(
      path.join(artifactScreenshotsDir, 'test_report.json'),
      JSON.stringify({ collectedErrors, networkErrors, timestamp: new Date().toISOString() }, null, 2)
    );

    await browser.close();
  } catch (err) {
    console.error('💥 Test suite crashed:', err);
    await page.screenshot({ path: path.join(artifactScreenshotsDir, 'error_crash.png') }).catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

runDeepTestSuite();
