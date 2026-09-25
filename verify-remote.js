const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

async function testRemote() {
  const screenshotsDir = path.join(__dirname, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  const executablePath = chromePaths.find(p => fs.existsSync(p));

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  console.log('Navigating to http://159.195.49.57:25502...');
  await page.goto('http://159.195.49.57:25502', { waitUntil: 'networkidle0' });

  if (page.url().includes('/login')) {
    console.log('Logging in as Moltres...');
    await page.type('input[type="text"]', 'Moltres');
    await page.type('input[type="password"]', 'Start1234!');
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
