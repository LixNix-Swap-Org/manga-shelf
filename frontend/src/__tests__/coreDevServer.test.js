// @vitest-environment node
// The Vite dev server serves the CommonJS core the main bundle imports (core/watch/links.js) as ESM.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { createServer } from 'vite';
import { cjsToEsm, isCoreCommonjs } from '../../vite.config.js';

const frontendDir = path.resolve(import.meta.dirname, '../..');
const coreDir = path.resolve(frontendDir, '../core');
const requireCjs = createRequire(import.meta.url);

/** Imports the files with Node's own ESM loader (no Vite, no Vitest) and prints each module's export names. */
function importInNode(files) {
  const script = `const out = {};
for (const f of ${JSON.stringify(files)}) { const m = await import(f); out[f] = { named: Object.keys(m).filter((k) => k !== 'default' && k !== '__cjsModule').sort(), defaultKeys: Object.keys(m.default).sort() }; }
console.log(JSON.stringify(out));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout);
}

/** The core files written as transformed ESM into dir/core (same layout, so relative imports resolve). */
function writeTransformed(dir, relFiles) {
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  return relFiles.map((rel) => {
    const source = path.join(coreDir, rel);
    const target = path.join(dir, 'core', rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, cjsToEsm(fs.readFileSync(source, 'utf8'), source));
    return target;
  });
}

describe('CommonJS core in the dev server', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-esm-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('turns links.js and the core/lib files of takeover.js into ESM with the same exports, run by Node itself', () => {
    const rels = ['watch/links.js', 'lib/imageCheck.js', 'lib/owners.js'];
    const files = writeTransformed(dir, rels);
    const result = importInNode(files);
    rels.forEach((rel, i) => {
      const expected = Object.keys(requireCjs(path.join(coreDir, rel))).sort();
      expect(result[files[i]].defaultKeys).toEqual(expected);
      expect(result[files[i]].named).toEqual(expected);
    });
    const links = fs.readFileSync(files[0], 'utf8');
    expect(links).not.toMatch(/\brequire\(/);
    // lines stay in place (stack traces and breakpoints)
    const original = fs.readFileSync(path.join(coreDir, 'watch/links.js'), 'utf8').split('\n');
    expect(links.split('\n')[original.length - 2]).toBe(original[original.length - 2]);
  });

  it('every core module loads as ESM; requires become imports with their .js ending and a cycle sees partial exports as in Node', () => {
    const rels = fs.readdirSync(coreDir, { recursive: true }).filter((rel) => rel.endsWith('.js'));
    const files = writeTransformed(dir, rels);
    expect(cjsToEsm("const errors = require('../errors');\nmodule.exports = { errors };", path.join(coreDir, 'lib/x.js')))
      .toContain('from "../errors.js"');
    const result = importInNode(files);
    rels.forEach((rel, i) => expect(result[files[i]].defaultKeys).toEqual(Object.keys(requireCjs(path.join(coreDir, rel))).sort()));

    const cycle = path.join(dir, 'cycle');
    fs.mkdirSync(cycle);
    fs.writeFileSync(path.join(cycle, 'a.js'), "const b = require('./b');\nmodule.exports = { a: 1, fromB: () => b.b, seenByB: () => b.seen() };");
    fs.writeFileSync(path.join(cycle, 'b.js'), "const a = require('./a');\nmodule.exports = { b: 2, seen: () => Object.keys(a).length };");
    for (const name of ['a.js', 'b.js']) {
      const file = path.join(cycle, name);
      fs.writeFileSync(file, cjsToEsm(fs.readFileSync(file, 'utf8'), file));
    }
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(path.join(cycle, 'a.js'))}); console.log(m.default.fromB(), m.default.seenByB());`], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.stdout.trim()).toBe('2 0');
  });

  it('only touches CommonJS files inside core/', () => {
    expect(isCoreCommonjs(path.join(coreDir, 'watch/links.js'), 'module.exports = {}')).toBe(true);
    expect(isCoreCommonjs(path.join(coreDir, 'watch/links.js'), 'export default 1')).toBe(false);
    expect(isCoreCommonjs(path.join(frontendDir, 'src/app/deepLink.js'), 'module.exports = {}')).toBe(false);
    expect(isCoreCommonjs(path.join(coreDir, '../core-copy/x.js'), 'module.exports = {}')).toBe(false);
  });

  it('a dev server started from vite.config.js serves deepLink.js and the core module it imports as ESM', async () => {
    const server = await createServer({
      configFile: path.join(frontendDir, 'vite.config.js'),
      root: frontendDir,
      mode: 'development',
      cacheDir: path.join(dir, 'vite-cache'),
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { port: 0, host: '127.0.0.1', hmr: false, watch: null }
    });
    try {
      const transformed = await server.transformRequest('/src/app/deepLink.js');
      expect(transformed.code).toMatch(/core\/watch\/links\.js/);
      await server.listen();
      const { port } = server.httpServer.address();
      const base = `http://127.0.0.1:${port}`;
      const page = await fetch(`${base}/src/app/deepLink.js`);
      expect(page.status).toBe(200);
      const code = await page.text();
      const coreUrl = /from "([^"]*core\/watch\/links\.js[^"]*)"/.exec(code)?.[1];
      expect(coreUrl).toBeTruthy();
      const core = await fetch(new URL(coreUrl, base));
      expect(core.status).toBe(200);
      const coreCode = await core.text();
      expect(coreCode).toContain('export default module.exports');
      expect(coreCode).toMatch(/export \{ __cjs_named\d+ as detectLink \}/);
    } finally {
      await server.close();
    }
  }, 30000);
});
