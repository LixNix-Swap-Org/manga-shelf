const puppeteer = require('puppeteer-core');

async function test() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    defaultViewport: { width: 1000, height: 700 }
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/login', { waitUntil: 'networkidle0' });
  await page.type('input[type="text"]', 'Moltres');
  await page.type('input[type="password"]', 'supersecret123');
  await page.screenshot({ path: 'screenshots/verify_fixed_inputs.png' });
  await browser.close();
  console.log('Verification screenshot saved: screenshots/verify_fixed_inputs.png');
}
test().catch(console.error);
