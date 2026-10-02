require('dotenv').config();
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const REMOTE_HOST = process.env.REMOTE_HOST || process.argv[2] || 'localhost';
const REMOTE_PORT = parseInt(process.env.REMOTE_PORT || process.argv[3] || '3000', 10);
const USERNAME = process.env.ADMIN_USER || process.env.REMOTE_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASS || process.env.REMOTE_PASS || '';

async function testRemote() {
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

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const remoteUrl = `http://${REMOTE_HOST}:${REMOTE_PORT}`;
  console.log(`Navigating to ${remoteUrl}...`);
  await page.goto(remoteUrl, { waitUntil: 'networkidle0' });

  if (page.url().includes('/login')) {
    console.log(`Logging in as ${USERNAME}...`);
    await page.type('input[type="text"]', USERNAME);
    await page.type('input[type="password"]', PASSWORD);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
    ]);
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('Taking screenshot of remote dashboard...');
  await page.screenshot({ path: path.join(screenshotsDir, 'remote_dashboard.png') });

  // Click on One Piece
  console.log('Opening One Piece detail...');
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const link = links.find(a => a.innerText.includes('One Piece'));
    if (link) link.click();
  });
  await new Promise(r => setTimeout(r, 1500));
  await page.screenshot({ path: path.join(screenshotsDir, 'remote_manga_detail.png') });

  await browser.close();
  console.log('Done! Screenshots saved to screenshots/remote_dashboard.png and remote_manga_detail.png');
}

testRemote().catch(console.error);
