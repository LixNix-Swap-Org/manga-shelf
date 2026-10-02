// Browser test. Run it with `npm run <test:...>` (test/browser/run.js starts an isolated server and sets these variables).
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const E2E_USER = process.env.E2E_USER;
const E2E_PASSWORD = process.env.E2E_PASSWORD;
if (!BASE_URL || !E2E_USER || !E2E_PASSWORD) {
  console.error('Set BASE_URL, E2E_USER and E2E_PASSWORD, or use the npm scripts (they start an isolated server).');
  process.exit(2);
}

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

async function runPerformanceSuite() {
  const artifactDir = process.env.REPORT_DIR || path.join(__dirname, 'reports');
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  const reportPath = path.join(artifactDir, 'performance_report.json');

  console.log('⚡ Starting MangaShelf Performance Benchmark Suite...');

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

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // --- PART 1: Authenticate ---
  console.log('1. Authenticating as admin...');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle0' });
  await page.type('input[type="text"]', E2E_USER);
  await page.type('input[type="password"]', E2E_PASSWORD);
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle0' }).catch(() => {})
  ]);
  await sleep(1000);

  // Helper to extract Performance & Web Vitals
  async function measurePagePerformance(url, pageName) {
    console.log(`Measuring performance for: ${pageName} (${url})...`);
    
    // Hard reload with cache disabled
    await page.setCacheEnabled(false);
    const startNav = Date.now();
    await page.goto(url, { waitUntil: 'networkidle0' });
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
  const dashboardPerf = await measurePagePerformance(`${BASE_URL}/`, 'Dashboard (Shelf)');
  
  // Shopping list
  await page.evaluate(() => {
    const shopBtn = document.querySelector('#btn-nav-shopping');
    if (shopBtn) shopBtn.click();
  });
  await sleep(800);
  const shoppingPerf = await measurePagePerformance(`${BASE_URL}/`, 'Shopping List');

  // Detail page
  const detailPerf = await measurePagePerformance(`${BASE_URL}/manga/${process.env.PERF_MANGA_ID || 4}`, 'Manga Detail (One Piece)');

  // Get Cookies for API benchmarking
  const cookies = await page.cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  await browser.close();

  // --- PART 3: API Benchmark (Express + SQLite WAL) ---
  console.log('\n2. Benchmarking Backend API Latency (50 iterations each)...');

  function requestApi(path) {
    return new Promise((resolve, reject) => {
      const start = process.hrtime.bigint();
      const req = http.request({
        hostname: new URL(BASE_URL).hostname,
        port: new URL(BASE_URL).port || 80,
        path,
        method: 'GET',
        headers: {
          'Cookie': cookieHeader
        }
      }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const end = process.hrtime.bigint();
          const latencyMs = Number(end - start) / 1e6;
          resolve({ status: res.statusMessage, latencyMs, bytes: Buffer.byteLength(data) });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function benchmarkEndpoint(endpointPath, iterations = 50) {
    process.stdout.write(`  Benchmarking ${endpointPath} (${iterations} reqs)... `);
    const latencies = [];
    let bytesReceived = 0;

    for (let i = 0; i < iterations; i++) {
      const res = await requestApi(endpointPath);
      latencies.push(res.latencyMs);
      bytesReceived = res.bytes;
    }

    latencies.sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];

    console.log(`avg: ${mean.toFixed(2)}ms | p95: ${p95.toFixed(2)}ms | min: ${min.toFixed(2)}ms`);

    return {
      endpoint: endpointPath,
      iterations,
      responseSizeBytes: bytesReceived,
      minMs: parseFloat(min.toFixed(2)),
      maxMs: parseFloat(max.toFixed(2)),
      meanMs: parseFloat(mean.toFixed(2)),
      p50Ms: parseFloat(p50.toFixed(2)),
      p95Ms: parseFloat(p95.toFixed(2)),
      p99Ms: parseFloat(p99.toFixed(2))
    };
  }

  const apiBenchmarks = {
    authMe: await benchmarkEndpoint('/api/auth/me'),
    mangasOverview: await benchmarkEndpoint('/api/mangas'),
    statsFull: await benchmarkEndpoint('/api/stats'),
    shoppingList: await benchmarkEndpoint('/api/shopping-list'),
    mangaDetailWithVolumes: await benchmarkEndpoint('/api/mangas/' + (process.env.PERF_MANGA_ID || 4))
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
      database: 'SQLite 3 (WAL Mode)'
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
