// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { precacheList, stampServiceWorker } from '../../vite.config.js';

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

  it('stamps the version and the file list; the unstamped worker still parses', () => {
    const source = stampServiceWorker(swSource, { version: '9.9.9', files: ['/assets/a.js', '/assets/b.css'] });
    expect(source).toContain("const CACHE_NAME = 'mangashelf-app-9.9.9'");
    expect(source).toContain('const BUILD_FILES = ["/assets/a.js", "/assets/b.css"];');
    expect(() => new Function('self', source)({ addEventListener: () => {} })).not.toThrow();
    expect(() => new Function('self', swSource)({ addEventListener: () => {} })).not.toThrow();
  });
});
