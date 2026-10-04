// Vite config for the web build and `--mode app` (shell build); stamps the service worker and precompresses assets.
import { defineConfig, parseAst } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { precompressDir } from './precompress.js'
import { appCspPlugin } from './src/app/csp.js'

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8'))

/** Language code -> URL of its catalog chunk (src/i18n/locales/<code>.json in dist/.vite/manifest.json). */
export function catalogFiles(outDir) {
  const manifestPath = path.join(outDir, '.vite', 'manifest.json')
  if (!fs.existsSync(manifestPath)) return {}
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const out = {}
  for (const [key, chunk] of Object.entries(manifest)) {
    const match = /^src\/i18n\/locales\/([A-Za-z-]+)\.json$/.exec(key)
    if (match && chunk?.file) out[match[1]] = `/${chunk.file}`
  }
  return out
}

/**
 * Every build file under dist/assets as a URL path (the .br/.gz variants are served for these, not fetched), without
 * the translation catalogs: the worker caches those on first use and warms only the active language.
 */
export function precacheList(outDir) {
  const assetsDir = path.join(outDir, 'assets')
  if (!fs.existsSync(assetsDir)) return []
  const catalogs = new Set(Object.values(catalogFiles(outDir)))
  return fs.readdirSync(assetsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.(br|gz)$/.test(entry.name))
    .map((entry) => `/${path.relative(outDir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/')}`)
    .filter((file) => !catalogs.has(file))
    .sort()
}

/** Short id of a build: its hashed file names and the shell. Two builds of the same version never share a cache. */
export function buildId(files, shell = '') {
  return createHash('sha256').update(files.join('\n')).update('\0').update(shell).digest('hex').slice(0, 12)
}

export function stampServiceWorker(source, { version, files, build = '', catalogs = {} }) {
  return source
    .replaceAll('__APP_VERSION__', version)
    .replaceAll('__BUILD_ID__', build)
    .replace('/*__PRECACHE__*/', files.map((file) => JSON.stringify(file)).join(', '))
    .replace('/*__CATALOGS__*/', Object.keys(catalogs).sort().map((code) => `${JSON.stringify(code)}: ${JSON.stringify(catalogs[code])}`).join(', '))
}

const LOCAL_BOOT_STUB = '\0local-boot-stub'
const APP_ONLY_STUB = '\0app-only-stub'

// the standalone screens and dialogs are only mounted in the app build; in the web build they become an empty component
// (with them bcryptjs, fflate and the takeover code stay out of dist/ and the service worker's precache)
export const APP_ONLY_MODULES = [
  'src/app/LocalOffer.jsx',
  'src/app/LocalScreen.jsx',
  'src/app/LocalSetup.jsx',
  'src/app/TakeoverDialog.jsx',
  'src/components/modals/BackupExportModal.jsx'
]

const appOnlyFiles = new Set(APP_ONLY_MODULES.map((file) => path.resolve(import.meta.dirname, file)))

/**
 * The standalone core (src/local/boot.js: sql.js, its wasm file and ../core) only belongs to the app build. Rollup emits
 * the wasm asset as soon as it loads the module, so the web build never resolves it (the service worker would precache it).
 */
export const webBuildWithoutLocalCore = () => ({
  name: 'web-build-without-local-core',
  apply: 'build',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (source === './boot.js' && /[\\/]src[\\/]local[\\/]localTransport\.js$/.test(importer || '')) return LOCAL_BOOT_STUB
    if (!importer || source.startsWith('\0') || !/(LocalOffer|LocalScreen|LocalSetup|TakeoverDialog|BackupExportModal)(\.jsx)?$/.test(source)) return null
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    return resolved && appOnlyFiles.has(resolved.id) ? APP_ONLY_STUB : null
  },
  load(id) {
    if (id === LOCAL_BOOT_STUB) return "export function bootLocalRuntime() { throw new Error('Der Modus ohne Server gibt es nur in der App') }"
    return id === APP_ONLY_STUB ? 'export default function AppOnly() { return null }' : null
  }
})

const CORE_DIR = path.resolve(import.meta.dirname, '../core')

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walkAst(child, visit))
    else if (value && typeof value.type === 'string') walkAst(value, visit)
  }
}

const isModuleExports = (node) => node?.type === 'MemberExpression' && !node.computed &&
  node.object.type === 'Identifier' && node.object.name === 'module' && node.property.name === 'exports'

/** A relative require of a core file as a path the browser and Node's ESM loader both find (with its .js ending). */
function esmSpecifier(spec, file) {
  if (!file || !spec.startsWith('.')) return spec
  const base = path.resolve(path.dirname(file), spec)
  for (const [candidate, suffix] of [[base, ''], [`${base}.js`, '.js'], [path.join(base, 'index.js'), '/index.js']]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return spec + suffix
  }
  return spec
}

/**
 * A CommonJS core module as ESM: `require('./x')` becomes an import, `export default` is module.exports, and the keys
 * of a literal `module.exports = { … }` become named exports. Every module hands out its `module` object through a
 * hoisted function, so a require cycle sees the partly filled exports as in Node. Lines stay where they were.
 */
export function cjsToEsm(code, file = null) {
  const ast = parseAst(code)
  const requires = []
  walkAst(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'require') return
    const [arg] = node.arguments
    if (node.arguments.length === 1 && arg.type === 'Literal' && typeof arg.value === 'string') requires.push({ start: node.start, end: node.end, spec: arg.value })
  })
  let names = []
  for (const statement of ast.body) {
    const expr = statement.type === 'ExpressionStatement' ? statement.expression : null
    if (expr?.type !== 'AssignmentExpression' || !isModuleExports(expr.left) || expr.right.type !== 'ObjectExpression') continue
    names = expr.right.properties
      .filter((p) => p.type === 'Property' && !p.computed)
      .map((p) => (p.key.type === 'Identifier' ? p.key.name : String(p.key.value)))
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default')
  }
  const specs = [...new Set(requires.map((r) => r.spec))]
  const local = new Map(specs.map((spec, i) => [spec, `__cjs_dep${i}`]))
  let body = code
  for (const r of [...requires].sort((a, b) => b.start - a.start)) body = `${body.slice(0, r.start)}${local.get(r.spec)}().exports${body.slice(r.end)}`
  const head = specs.map((spec) => `import { __cjsModule as ${local.get(spec)} } from ${JSON.stringify(esmSpecifier(spec, file))};`)
  const tail = [
    'var __cjs_m;',
    'export function __cjsModule() { return __cjs_m || (__cjs_m = { exports: {} }); }',
    'export default module.exports;',
    ...names.map((name, i) => `const __cjs_named${i} = module.exports[${JSON.stringify(name)}]; export { __cjs_named${i} as ${name} };`)
  ]
  return `${head.join(' ')} var module = __cjsModule(), exports = module.exports; ${body}\n${tail.join('\n')}\n`
}

export const isCoreCommonjs = (file, code) => path.resolve(file).startsWith(CORE_DIR + path.sep) && file.endsWith('.js') &&
  /\b(?:module\.exports|require\s*\()/.test(code)

/**
 * `vite` (dev server) serves files unbundled, so the CommonJS core the main bundle imports (core/watch/links.js) would
 * fail to link in the browser; builds convert it through build.commonjsOptions instead.
 */
export const coreCommonjsInDev = () => ({
  name: 'core-commonjs-in-dev',
  apply: 'serve',
  enforce: 'pre',
  transform(code, id) {
    const file = id.split('?')[0]
    return isCoreCommonjs(file, code) ? { code: cjsToEsm(code, file), map: null } : null
  }
})

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `vite build --mode app`: bundle for the Electron/Capacitor shells (server address and bearer token, see src/utils/api.js)
  const appMode = mode === 'app'
  let outDir = path.resolve(import.meta.dirname, appMode ? 'dist-app' : 'dist')
  return {
    base: appMode ? './' : '/',
    plugins: [
      react(),
      ...(appMode ? [appCspPlugin()] : [webBuildWithoutLocalCore()]),
      // Vitest runs the core as CommonJS itself
      ...(mode === 'test' ? [] : [coreCommonjsInDev()]),
      {
        name: 'build-out-dir',
        apply: 'build',
        configResolved(config) {
          outDir = path.resolve(config.root, config.build.outDir)
        }
      },
      {
        // the service worker is a plain file in public/: stamp the app version and the files to precache into it
        name: 'stamp-sw-version',
        apply: 'build',
        closeBundle() {
          const swPath = path.join(outDir, 'sw.js')
          if (!fs.existsSync(swPath)) return
          const source = fs.readFileSync(swPath, 'utf-8')
          const files = precacheList(outDir)
          const catalogs = catalogFiles(outDir)
          const shellPath = path.join(outDir, 'index.html')
          const shell = fs.existsSync(shellPath) ? fs.readFileSync(shellPath, 'utf-8') : ''
          // the catalogs count for the build id: a changed translation is a new cache
          const build = buildId([...files, ...Object.values(catalogs).sort()], shell)
          fs.writeFileSync(swPath, stampServiceWorker(source, { version: pkg.version, files, build, catalogs }))
        }
      },
      {
        name: 'precompress-assets',
        apply: 'build',
        closeBundle() {
          precompressDir(path.join(outDir, 'assets'))
        }
      }
    ],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      ...(appMode ? { 'import.meta.env.VITE_APP_MODE': JSON.stringify('app') } : {})
    },
    build: {
      outDir: appMode ? 'dist-app' : 'dist',
      emptyOutDir: true,
      // dist/.vite/manifest.json feeds the bundle size budget (scripts/check-bundle-size.js); express.static skips dot folders
      manifest: true,
      // Vite 5 browser floor; Vite 7's default (Safari 16 / Chrome 107) would drop older iPhones and iPads running the PWA
      target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
      // the domain core (../core, CommonJS) runs in the app build's standalone mode (src/local/runtime.js)
      commonjsOptions: { include: [/node_modules/, /[\\/]core[\\/]/] },
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{js,jsx}'],
      setupFiles: ['./src/__tests__/setup.js'],
      restoreMocks: true,
      unstubGlobals: true
    },
    server: {
      proxy: {
        '/api': 'http://localhost:3000',
        '/uploads': 'http://localhost:3000'
      }
    }
  }
})
