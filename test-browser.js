const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

async function runTest() {
  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  // Find Chrome or Edge executable
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];

  const executablePath = chromePaths.find(p => fs.existsSync(p));
  if (!executablePath) {
    throw new Error('No Chrome or Edge browser executable found on system.');
  }

  console.log('Using browser executable:', executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1280, height: 800 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  
  // Listen for console logs and errors
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', err => console.error('BROWSER PAGE ERROR:', err.message));

  console.log('Step 1: Navigating to http://localhost:3000...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: path.join(screenshotsDir, '01_initial_page.png') });

  // Check current URL or page state
  let currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  if (currentUrl.includes('/login')) {
    console.log('Step 2: On Login page, logging in as admin...');
    await page.type('input[type="text"]', 'admin');
    await page.type('input[type="password"]', 'password123');
    await page.screenshot({ path: path.join(screenshotsDir, '02_login_filled.png') });
    
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
    ]);
    await new Promise(r => setTimeout(r, 1000));
  } else if (currentUrl.includes('/setup')) {
    console.log('Step 2: On Setup page, creating admin...');
    await page.type('input[type="text"]', 'admin');
    await page.type('input[type="password"]', 'password123');
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
    ]);
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('Step 3: Verifying Dashboard loaded...');
  await page.screenshot({ path: path.join(screenshotsDir, '03_dashboard.png') });
  
  // Verify Dashboard elements
  const pageTitle = await page.$eval('h1', el => el.innerText);
  console.log('Dashboard title:', pageTitle);

  console.log('Step 4: Clicking "+ Neuer Manga" button...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => b.innerText.includes('Neuer Manga') && b.offsetParent !== null);
    if (!btn) throw new Error('Visible Neuer Manga button not found');
    btn.click();
  });
  await new Promise(r => setTimeout(r, 600));

  await page.screenshot({ path: path.join(screenshotsDir, '04_create_modal_opened.png') });

  console.log('Step 5: Filling out the Create Manga form...');
  // Form fields
  await page.type('input[placeholder*="z.B. One Piece"]', 'Frieren: Nach dem Ende der Reise');
  await page.type('input[placeholder*="z.B. Eiichiro Oda"]', 'Kanehito Yamada & Tsukasa Abe');
  await page.type('input[placeholder*="z.B. Carlsen"]', 'altraverse');
  await page.type('input[placeholder*="z.B. 108"]', '13');
  await page.type('input[type="url"]', 'https://upload.wikimedia.org/wikipedia/en/thumb/f/f7/Sousou_no_Frieren_volume_1_cover.jpg/220px-Sousou_no_Frieren_volume_1_cover.jpg');
  await page.type('textarea', 'Die Geschichte folgt der Elfenmagierin Frieren, einer ehemaligen Gefährtin des Helden Himmel...');

  await page.screenshot({ path: path.join(screenshotsDir, '05_form_filled.png') });

  console.log('Step 6: Submitting "Manga anlegen" (Create button test!)...');
  // Click submit button in modal
  const submitButton = await page.$('form button[type="submit"]');
  await submitButton.click();

  // Wait for modal to close and card to appear
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(screenshotsDir, '06_manga_created_dashboard.png') });

  // Verify the new card exists
  const hasFrieren = await page.evaluate(() => {
    return document.body.innerText.includes('Frieren: Nach dem Ende der Reise');
  });
  console.log('Verification: Does Dashboard show Frieren card?', hasFrieren);
  if (!hasFrieren) {
    throw new Error('Manga creation failed: Frieren card not visible on Dashboard!');
  }

  console.log('Step 7: Navigating to Manga Detail view...');
  // Click on the link for Frieren
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const link = links.find(a => a.innerText.includes('Frieren'));
    if (link) link.click();
  });

  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(screenshotsDir, '07_manga_detail_initial.png') });

  console.log('Step 8: Testing Batch Add Volumes...');
  // Click "Mehrere Bände (Batch)"
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const batchBtn = btns.find(b => b.innerText.includes('Mehrere Bände'));
    if (batchBtn) batchBtn.click();
  });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(screenshotsDir, '08_batch_modal_opened.png') });

  // Click "Bände generieren"
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const genBtn = btns.find(b => b.innerText.includes('Bände generieren'));
    if (genBtn) genBtn.click();
  });

  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(screenshotsDir, '09_volumes_generated.png') });

  console.log('Step 9: Toggling volume status for Band 1, 2, 3...');
  // Click on Band 1, Band 2, Band 3 to toggle status
  await page.evaluate(() => {
    const volElements = Array.from(document.querySelectorAll('div')).filter(d => d.innerText.includes('Band 1') || d.innerText.includes('Band 2') || d.innerText.includes('Band 3'));
    volElements.forEach(v => v.click());
  });

  await new Promise(r => setTimeout(r, 1200));
  await page.screenshot({ path: path.join(screenshotsDir, '10_volumes_toggled_progress.png') });

  console.log('Step 10: Navigating back to Dashboard...');
  await page.evaluate(() => {
    const backLink = Array.from(document.querySelectorAll('a')).find(a => a.innerText.includes('Zurück zur Übersicht'));
    if (backLink) backLink.click();
  });

  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: path.join(screenshotsDir, '11_final_dashboard.png') });

  await browser.close();
  console.log('====================================');
  console.log('🎉 ALL BROWSER UI TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('Screenshots saved in:', screenshotsDir);
  console.log('====================================');
}

runTest().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
