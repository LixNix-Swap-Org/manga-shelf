// @vitest-environment node
// The vite plugin that stubs the local core in web builds, and the built output when WEB_BUILD_DIR is set.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import viteConfig, { webBuildWithoutLocalCore, APP_ONLY_MODULES } from '../../vite.config.js';

const root = path.resolve(import.meta.dirname, '../..');
const plugin = webBuildWithoutLocalCore();
// the plugin context of Rollup: resolve() finds the file next to the importer
const context = {
  async resolve(source, importer) {
    const base = path.resolve(path.dirname(importer), source);
    const file = [base, `${base}.jsx`, `${base}.js`].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    return file ? { id: file } : null;
  }
};
const resolve = (source, importer) => plugin.resolveId.call(context, source, path.join(root, importer), {});

describe('web build without the standalone modules', () => {
  it('resolves the app-only screens and dialogs to an empty component, everything else stays', async () => {
    const stub = await resolve('./LocalOffer', 'src/app/ServerScreen.jsx');
    expect(stub).toMatch(/^\0app-only-stub/);
    expect(await resolve('./TakeoverDialog', 'src/app/ServerScreen.jsx')).toBe(stub);
    expect(await resolve('./app/LocalScreen', 'src/App.jsx')).toBe(stub);
    expect(await resolve('./app/LocalSetup', 'src/App.jsx')).toBe(stub);
    expect(await resolve('../modals/BackupExportModal', 'src/components/dashboard/DashboardHeader.jsx')).toBe(stub);
    expect(await resolve('./app/ServerScreen', 'src/App.jsx')).toBeNull();
    expect(await resolve('./SourcesPanel', 'src/app/LocalScreen.jsx')).toBeNull();
    expect(await resolve('./boot.js', 'src/local/localTransport.js')).toBe('\0local-boot-stub');
    expect(plugin.load(stub)).toBe('export default function AppOnly() { return null }');
    expect(APP_ONLY_MODULES.every((file) => fs.existsSync(path.join(root, file)))).toBe(true);
  });

  // run against a scratch build: WEB_BUILD_DIR=<outDir of `vite build`> npx vitest run src/__tests__/webBuildStub.test.js
  it.skipIf(!process.env.WEB_BUILD_DIR)('a web build has no bcryptjs, fflate, sql.js or takeover chunk and does not precache them', () => {
    const dir = process.env.WEB_BUILD_DIR;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.vite', 'manifest.json'), 'utf8'));
    const sources = Object.keys(manifest);
    expect(sources.filter((s) => /bcryptjs|fflate|sql\.js|takeover|backupZip|LocalOffer|LocalScreen|LocalSetup|TakeoverDialog|BackupExportModal|SourcesPanel/.test(s))).toEqual([]);
    const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
    expect(sw).not.toMatch(/bcrypt|fflate|sql-wasm|TakeoverDialog|LocalScreen/);
  });
});

describe('service worker stamping after the build', () => {
  const plugins = viteConfig({ mode: 'production', command: 'build' }).plugins.flat();
  const plugin = (name) => plugins.find((p) => p?.name === name);

  it('stamps dist/sw.js in place and does nothing when the build has no worker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-stamp-'));
    try {
      plugin('build-out-dir').configResolved({ root: dir, build: { outDir: 'dist' } });
      expect(() => plugin('stamp-sw-version').closeBundle()).not.toThrow();
      expect(fs.readdirSync(dir)).toEqual([]);
      fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'assets', 'index-A.js'), 'x');
      fs.writeFileSync(path.join(dir, 'dist', 'sw.js'), "const BUILD_ID = '__BUILD_ID__';\nconst BUILD_FILES = [/*__PRECACHE__*/];\n");
      plugin('stamp-sw-version').closeBundle();
      const stamped = fs.readFileSync(path.join(dir, 'dist', 'sw.js'), 'utf8');
      expect(stamped).toMatch(/^const BUILD_ID = '[0-9a-f]{12}';$/m);
      expect(stamped).toContain('const BUILD_FILES = ["/assets/index-A.js"];');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
