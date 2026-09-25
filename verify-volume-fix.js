const puppeteer = require('puppeteer-core');

async function test() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    defaultViewport: { width: 1200, height: 800 }
  });
  const page = await browser.newPage();
  
  // Login first
  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle0' });
  await page.type('input[type="text"]', 'admin');
  await page.type('input[type="password"]', 'password123');
  await page.click('button[type="submit"]');
  await new Promise(r => setTimeout(r, 1000));

  // Find and click Frieren
  await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    const link = links.find(a => a.innerText.includes('Frieren'));
    if (link) link.click();
  });
  await new Promise(r => setTimeout(r, 1000));

  // Type a number into the single volume input
  await page.type('input[placeholder*="Band-Nr"]', '14');
  await page.screenshot({ path: 'screenshots/verify_volume_input_fixed.png' });
  await browser.close();
  console.log('Saved screenshot to screenshots/verify_volume_input_fixed.png');
}
test().catch(console.error);
