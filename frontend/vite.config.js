// Vite config for the web build and `--mode app` (shell build); stamps the service worker and precompresses assets.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { precompressDir } from './precompress.js'
import { appCspPlugin } from './src/app/csp.js'

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8'))

/** Every build file under dist/assets as a URL path (the .br/.gz variants are served for these, not fetched). */
export function precacheList(outDir) {
  const assetsDir = path.join(outDir, 'assets')
  if (!fs.existsSync(assetsDir)) return []
  return fs.readdirSync(assetsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.(br|gz)$/.test(entry.name))
    .map((entry) => `/${path.relative(outDir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join('/')}`)
    .sort()
}

/** Short id of a build: its hashed file names and the shell. Two builds of the same version never share a cache. */
export function buildId(files, shell = '') {
  return createHash('sha256').update(files.join('\n')).update('\0').update(shell).digest('hex').slice(0, 12)
}

export function stampServiceWorker(source, { version, files, build = '' }) {
  return source
    .replaceAll('__APP_VERSION__', version)
    .replaceAll('__BUILD_ID__', build)
    .replace('/*__PRECACHE__*/', files.map((file) => JSON.stringify(file)).join(', '))
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
          const shellPath = path.join(outDir, 'index.html')
          const shell = fs.existsSync(shellPath) ? fs.readFileSync(shellPath, 'utf-8') : ''
          fs.writeFileSync(swPath, stampServiceWorker(source, { version: pkg.version, files, build: buildId(files, shell) }))
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
