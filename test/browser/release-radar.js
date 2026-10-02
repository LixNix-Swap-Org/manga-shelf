// Browser test. Run it with `npm run <test:...>` (test/browser/run.js starts an isolated server and sets these variables).
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const E2E_USER = process.env.E2E_USER;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!BASE_URL || !E2E_USER || !E2E_PASSWORD) {
  console.error('Set BASE_URL, E2E_USER and E2E_PASSWORD, or use the npm scripts (they start an isolated server).');
  process.exit(2);
}

const puppeteer = require('puppeteer-core');
const { findChrome } = require('./chrome');
const fs = require('fs');
const path = require('path');

(async () => {
    console.log('--- TESTING RELEASE-RADAR FEATURE ---');
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: findChrome(),
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    try {
        // Step 1: Login
        console.log('Navigating to ' + BASE_URL + '...');
        await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });

        if (page.url().includes('/login')) {
            console.log('Logging in as ' + E2E_USER + '...');
            await page.type('input[type="text"]', E2E_USER);
            await page.type('input[type="password"]', E2E_PASSWORD);
            await page.click('button[type="submit"]');
            await new Promise(r => setTimeout(r, 1500));
        }
        console.log('Logged in! URL is:', page.url());

        // Step 2: Create a test series with an upcoming release
        console.log('Creating test manga with Vorbestellt volume...');
        const createRes = await page.evaluate(async () => {
            const res = await fetch('/api/mangas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: '__RADAR_TEST_SERIES__',
                    publisher: 'Carlsen Manga',
                    status: 'Laufend'
                })
            });
            return await res.json();
        });
        const mangaId = createRes.id;
        console.log('Test Manga created with ID:', mangaId);

        // Add Volume 1 with Vorbestellt and date
        await page.evaluate(async (mId) => {
            await fetch('/api/volumes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    manga_id: mId,
                    volume_number: '1',
                    status: 'Vorbestellt',
                    price: 8.50,
                    release_date: '2026-10-25'
                })
            });
        }, mangaId);
        console.log('Volume 1 added as Vorbestellt (2026-10-25, 8.50€)');

        // Step 3: Switch to Release-Radar tab on Dashboard
        await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 1000));
        
        // Click the Release-Radar tab button
        const clicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const b = buttons.find(btn => btn.textContent.includes('Release-Radar'));
            if (b) {
                b.click();
                return true;
            }
            return false;
        });
        console.log('Clicked Release-Radar tab button:', clicked);
        await new Promise(r => setTimeout(r, 1500));

        // Switch to "Meine Vorbestellungen & Budget" tab
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const tab = buttons.find(b => b.textContent.includes('Meine Vorbestellungen'));
            if (tab) tab.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        // Take a screenshot of the Release-Radar
        const scDir = path.join(__dirname, 'screenshots');
        if (!fs.existsSync(scDir)) fs.mkdirSync(scDir, { recursive: true });
        const scPath = path.join(scDir, 'release_radar_view.png');
        await page.screenshot({ path: scPath, fullPage: true });
        console.log('Screenshot saved to:', scPath);

        // Verify content on page
        const bodyText = await page.evaluate(() => document.body.innerText);
        const hasSeries = bodyText.includes('__RADAR_TEST_SERIES__');
        const hasBudget = bodyText.includes('8,50');
        const hasDate = bodyText.includes('Oktober 2026') || bodyText.includes('25.10.2026') || bodyText.includes('2026-10-25');
        console.log('Radar contains test series:', hasSeries);
        console.log('Radar shows 8,50 € budget:', hasBudget);
        console.log('Radar shows release date/group:', hasDate);

        if (!hasSeries || !hasBudget) {
            throw new Error('Release Radar failed to display test item or budget');
        }

        // Step 4: Click "Geliefert" button
        console.log('Clicking "Geliefert" button...');
        await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const deliveredBtn = buttons.find(b => b.textContent.includes('Geliefert'));
            if (deliveredBtn) deliveredBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        // Verify it was marked as delivered and removed from radar
        const bodyTextAfter = await page.evaluate(() => document.body.innerText);
        const hasSeriesAfter = bodyTextAfter.includes('__RADAR_TEST_SERIES__');
        console.log('Item removed from radar after Geliefert click:', !hasSeriesAfter);

        // Step 5: Clean up test manga
        await page.evaluate(async (mId) => {
            await fetch(`/api/mangas/${mId}`, { method: 'DELETE' });
        }, mangaId);
        console.log('Test series cleaned up successfully.');

        console.log('🎉 RELEASE RADAR TEST PASSED COMPLETELY! 🎉');
    } catch (e) {
        console.error('Error during test:', e);
        process.exit(1);
    } finally {
        await browser.close();
    }
})();
