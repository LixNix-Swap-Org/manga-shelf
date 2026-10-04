// @vitest-environment node
// Build-time stamping of the service worker (version and precache list).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildId, catalogFiles, precacheList, stampServiceWorker } from '../../vite.config.js';

const swSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../public/sw.js'), 'utf8');

describe('service worker build stamping', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists every build file under assets, without the precompressed variants', () => {
    fs.mkdirSync(path.join(dir, 'assets', 'nested'), { recursive: true });
    for (const name of ['index-A.js', 'index-A.js.br', 'index-A.js.gz', 'font.woff2', 'nested/x.css']) {
      fs.writeFileSync(path.join(dir, 'assets', name), 'x');
    }
    expect(precacheList(dir)).toEqual(['/assets/font.woff2', '/assets/index-A.js', '/assets/nested/x.css']);
    expect(precacheList(path.join(dir, 'missing'))).toEqual([]);
  });

  it('leaves the translation catalogs out of the precache and maps them per language (Vite manifest)', () => {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.vite'), { recursive: true });
    for (const name of ['index-A.js', 'en-B.js', 'zh-Hans-C.js', 'Dashboard-D.js']) fs.writeFileSync(path.join(dir, 'assets', name), 'x');
    fs.writeFileSync(path.join(dir, '.vite', 'manifest.json'), JSON.stringify({
      'index.html': { file: 'assets/index-A.js', isEntry: true },
      'src/i18n/locales/en.json': { file: 'assets/en-B.js' },
      'src/i18n/locales/zh-Hans.json': { file: 'assets/zh-Hans-C.js' },
      'src/Dashboard.jsx': { file: 'assets/Dashboard-D.js' }
    }));
    expect(catalogFiles(dir)).toEqual({ en: '/assets/en-B.js', 'zh-Hans': '/assets/zh-Hans-C.js' });
    expect(precacheList(dir)).toEqual(['/assets/Dashboard-D.js', '/assets/index-A.js']);
    const source = stampServiceWorker(swSource, { version: '1', files: precacheList(dir), catalogs: catalogFiles(dir) });
    expect(source).toContain('const CATALOGS = {"en": "/assets/en-B.js", "zh-Hans": "/assets/zh-Hans-C.js"};');
    expect(source).not.toContain('/manifest.json\',\n');
    expect(() => new Function('self', source)({ addEventListener: () => {} })).not.toThrow();
  });

  const cacheNameOf = (source) => {
    let opened = null;
    const listeners = {};
    const caches = { open: async (name) => { opened = name; return { addAll: async () => {}, match: async () => undefined }; } };
    new Function('self', 'caches', source)({ addEventListener: (type, fn) => { listeners[type] = fn; } }, caches);
    let pending;
    listeners.install({ waitUntil: (p) => { pending = p; } });
    return pending.then(() => opened);
  };

  it('stamps the version, the build id and the file list; the unstamped worker still parses', async () => {
    const source = stampServiceWorker(swSource, { version: '9.9.9', files: ['/assets/a.js', '/assets/b.css'], build: 'abc123def456' });
    expect(source).not.toContain('__APP_VERSION__');
    expect(source).not.toContain('__BUILD_ID__');
    expect(source).toContain('const BUILD_FILES = ["/assets/a.js", "/assets/b.css"];');
    expect(await cacheNameOf(source)).toBe('mangashelf-app-9.9.9-abc123def456');
    expect(await cacheNameOf(stampServiceWorker(swSource, { version: '9.9.9', files: [] }))).toBe('mangashelf-app-9.9.9');
    expect(() => new Function('self', swSource)({ addEventListener: () => {} })).not.toThrow();
  });

  it('two builds of the same version get different caches; the same build keeps its name', async () => {
    const one = ['/assets/index-A.js', '/assets/index-A.css'];
    const two = ['/assets/index-B.js', '/assets/index-A.css'];
    expect(buildId(one, '<html>A</html>')).toMatch(/^[0-9a-f]{12}$/);
    expect(buildId(one, '<html>A</html>')).toBe(buildId([...one], '<html>A</html>'));
    expect(buildId(one, '<html>A</html>')).not.toBe(buildId(two, '<html>A</html>'));
    expect(buildId(one, '<html>A</html>')).not.toBe(buildId(one, '<html>B</html>'));
    const name = (files, shell) => cacheNameOf(stampServiceWorker(swSource, { version: '2.19.1', files, build: buildId(files, shell) }));
    expect(await name(one, 'x')).not.toBe(await name(two, 'x'));
    expect(await name(one, 'x')).toMatch(/^mangashelf-app-2\.19\.1-[0-9a-f]{12}$/);
  });
});
