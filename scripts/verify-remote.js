// Screenshots of a running instance (dashboard and one series) with a local Chrome/Edge (puppeteer-core).
//   node scripts/verify-remote.js https://manga.example.com
//   node scripts/verify-remote.js <host> [port]          (plain http, only for this machine unless REMOTE_ALLOW_HTTP=1)
// Without arguments: REMOTE_URL, then REMOTE_HOST/REMOTE_PORT. Credentials: REMOTE_USER/REMOTE_PASS (or ADMIN_USER/ADMIN_PASS).
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const { resolveTarget, assertSecureTarget, credentials, redactUrl } = require('./lib/remote');

const SERIES_TITLE = 'One Piece';

/** Target and credentials after the remote-script rules; throws before any browser starts. */
function prepare(argv = process.argv.slice(2), env = process.env) {
  const target = resolveTarget(argv, env);
  assertSecureTarget(target, env);
  return { target, ...credentials(env) };
}

function findBrowser(env = process.env) {
  return [
    env.CHROME_BIN,
    env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean).find(p => fs.existsSync(p));
}

async function verify() {
  const { target, username, password } = prepare();
  console.log(`Ziel: ${redactUrl(target.baseUrl)} (aus ${target.source}), Benutzer "${username}"`);
  if (!password) console.warn('Hinweis: Kein Passwort angegeben. Setze REMOTE_PASS (oder ADMIN_PASS).');

  const screenshotsDir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    // German UI whatever the machine's language (test/browser/chrome.js CHROME_ARGS)
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=de-DE', '--accept-lang=de-DE']
  });
  try {
    const page = await browser.newPage();
    await page.goto(target.baseUrl, { waitUntil: 'networkidle0' });

    if (page.url().includes('/login')) {
      if (new URL(page.url()).origin !== new URL(target.baseUrl).origin) {
        throw new Error(`Login-Seite auf einem anderen Ursprung (${redactUrl(page.url())}): kein Passwort gesendet`);
      }
      console.log(`Anmeldung als "${username}" ...`);
      await page.type('input[type="text"]', username);
      await page.type('input[type="password"]', password);
      await Promise.all([
        page.click('button[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
      ]);
      await new Promise(r => setTimeout(r, 1500));
    }

    await page.screenshot({ path: path.join(screenshotsDir, 'remote_dashboard.png') });

    console.log(`Öffne „${SERIES_TITLE}“ ...`);
    await page.evaluate((title) => {
      const link = Array.from(document.querySelectorAll('a')).find(a => a.innerText.includes(title));
      if (link) link.click();
    }, SERIES_TITLE);
    await new Promise(r => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(screenshotsDir, 'remote_manga_detail.png') });
    console.log(`Fertig: Screenshots in ${screenshotsDir} (remote_dashboard.png, remote_manga_detail.png)`);
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  verify().catch((e) => {
    console.error(`Fehler: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  });
}

module.exports = { prepare };
