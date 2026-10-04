// Performance benchmark. Run it with `npm run test:perf` (test/browser/run.js starts an isolated server; `-- --db <file>`
// benchmarks a copy of a real database, PERF_MANGA_ID picks the series for the detail page).
const { suiteEnv, loginViaUi, seedSeries, apiOk, api, benchmarkEndpoint } = require('./helpers');
const { baseUrl: BASE_URL, user: E2E_USER, password: E2E_PASSWORD } = suiteEnv();

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { findChrome, CHROME_ARGS } = require('./chrome');

async function runPerformanceSuite() {
  const artifactDir = process.env.REPORT_DIR || path.join(__dirname, 'reports');
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  const reportPath = path.join(artifactDir, 'performance_report.json');

  console.log('⚡ Starting MangaShelf Performance Benchmark Suite...');

  const executablePath = findChrome();

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: CHROME_ARGS
  });

  const page = await browser.newPage();

  // --- PART 1: Authenticate ---
  console.log('1. Authenticating as admin...');
  await loginViaUi(page, BASE_URL, E2E_USER, E2E_PASSWORD);
  const me = await api(page, 'GET', '/api/auth/me');
  if (me.status !== 200) throw new Error(`login check failed: /api/auth/me answered ${me.status}`);

  // the detail page needs a real series: PERF_MANGA_ID must exist, otherwise the first series (or a seeded one) is used
  let detailManga;
  if (process.env.PERF_MANGA_ID) {
    const res = await api(page, 'GET', `/api/mangas/${encodeURIComponent(process.env.PERF_MANGA_ID)}`);
    if (res.status !== 200) throw new Error(`PERF_MANGA_ID=${process.env.PERF_MANGA_ID}: /api/mangas answered ${res.status}`);
    detailManga = res.data;
  } else {
    const list = await apiOk(page, 'GET', '/api/mangas');
    const id = list.length ? list[0].id : await seedSeries(page, {
      title: 'Benchmark Reihe', publisher: 'Carlsen Manga', total_volumes: 30, volumes: { from: 1, to: 30, status: 'Vorhanden' }
    });
    detailManga = await apiOk(page, 'GET', `/api/mangas/${id}`);
  }

  // Helper to extract Performance & Web Vitals
  async function measurePagePerformance(url, pageName, readySelector) {
    console.log(`Measuring performance for: ${pageName} (${url})...`);
    
    // Hard reload with cache disabled
    await page.setCacheEnabled(false);
    const startNav = Date.now();
    await page.goto(url, { waitUntil: 'networkidle0' });
    // networkidle alone does not prove that the view rendered (the SPA answers every path with 200)
    await page.waitForSelector(readySelector, { timeout: 15000 })
      .catch(() => { throw new Error(`${pageName}: ${readySelector} did not render`); });
    const navDuration = Date.now() - startNav;

    // Collect Navigation Timing & Web Vitals from browser
    const metrics = await page.evaluate(async () => {
      const navEntry = performance.getEntriesByType('navigation')[0] || {};
      const paintEntries = performance.getEntriesByType('paint') || [];
      const fcpEntry = paintEntries.find(p => p.name === 'first-contentful-paint');

      // Largest Contentful Paint (LCP)
      let lcp = 0;
      try {
        const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
        if (lcpEntries.length > 0) {
          lcp = lcpEntries[lcpEntries.length - 1].startTime;
        }
      } catch (e) {}

      // Layout Shifts (CLS)
      let cls = 0;
      try {
        const clsEntries = performance.getEntriesByType('layout-shift');
        for (const entry of clsEntries) {
          if (!entry.hadRecentInput) {
            cls += entry.value;
          }
        }
      } catch (e) {}

      // Memory (if available in Chrome)
      const memory = performance.memory ? {
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        usedJSHeapSize: performance.memory.usedJSHeapSize
      } : null;

      // DOM stats
      const domElementsCount = document.querySelectorAll('*').length;

      return {
        ttfb: navEntry.responseStart ? Math.round(navEntry.responseStart - navEntry.requestStart) : 0,
        domInteractive: navEntry.domInteractive ? Math.round(navEntry.domInteractive) : 0,
        domContentLoaded: navEntry.domContentLoadedEventEnd ? Math.round(navEntry.domContentLoadedEventEnd) : 0,
        windowLoad: navEntry.loadEventEnd ? Math.round(navEntry.loadEventEnd) : 0,
        fcp: fcpEntry ? Math.round(fcpEntry.startTime) : 0,
        lcp: Math.round(lcp),
        cls: parseFloat(cls.toFixed(4)),
        domElementsCount,
        memory
      };
    });

    return {
      pageName,
      url,
      navDuration,
      ...metrics
    };
  }

  // --- PART 2: Measure Pages ---
  const dashboardPerf = await measurePagePerformance(`${BASE_URL}/`, 'Dashboard (Shelf)', '#btn-view-grid');
  // the main view comes from ?view=, a click followed by a reload would measure the shelf again
  const shoppingPerf = await measurePagePerformance(`${BASE_URL}/?view=shopping`, 'Shopping List', '#btn-shop-priority-sort');
  const detailPerf = await measurePagePerformance(`${BASE_URL}/manga/${detailManga.id}`, `Manga Detail (${detailManga.title})`, 'button[title="Reihe löschen"]');

  // Get Cookies for API benchmarking
  const cookies = await page.cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  await browser.close();

  // --- PART 3: API Benchmark (Express + SQLite WAL) ---
  console.log('\n2. Benchmarking Backend API Latency (50 iterations each)...');

  async function benchmark(endpointPath, iterations = 50) {
    process.stdout.write(`  Benchmarking ${endpointPath} (${iterations} reqs)... `);
    const result = await benchmarkEndpoint(BASE_URL, endpointPath, cookieHeader, iterations);
    console.log(`avg: ${result.meanMs.toFixed(2)}ms | p95: ${result.p95Ms.toFixed(2)}ms | min: ${result.minMs.toFixed(2)}ms`);
    return result;
  }

  const apiBenchmarks = {
    authMe: await benchmark('/api/auth/me'),
    mangasOverview: await benchmark('/api/mangas'),
    statsFull: await benchmark('/api/stats'),
    shoppingList: await benchmark('/api/shopping-list'),
    mangaDetailWithVolumes: await benchmark(`/api/mangas/${detailManga.id}`)
  };

  // --- PART 4: Asset Bundle Breakdown ---
  console.log('\n3. Analyzing Frontend Bundle Sizes in frontend/dist...');
  const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
  let bundleAssets = [];
  if (fs.existsSync(distDir)) {
    const files = fs.readdirSync(path.join(distDir, 'assets'));
    bundleAssets = files.map(file => {
      const stat = fs.statSync(path.join(distDir, 'assets', file));
      return {
        file,
        sizeBytes: stat.size,
        sizeKb: parseFloat((stat.size / 1024).toFixed(2))
      };
    });
  }

  const finalReport = {
    timestamp: new Date().toISOString(),
    hardwareAndRuntime: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      database: 'SQLite 3 (WAL Mode)',
      // numbers from an empty test database and from a copy of a real one are not comparable
      databaseSource: process.env.E2E_DB_SOURCE || 'unknown',
      detailManga: { id: detailManga.id, title: detailManga.title, volumes: (detailManga.volumes || []).length }
    },
    webVitals: [dashboardPerf, shoppingPerf, detailPerf],
    apiBenchmarks,
    bundleAssets
  };

  fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), 'utf8');
  console.log(`\n🎉 Performance report successfully saved to:\n${reportPath}`);
}

runPerformanceSuite().catch(err => {
  console.error('Performance suite failed:', err);
  process.exit(1);
});
