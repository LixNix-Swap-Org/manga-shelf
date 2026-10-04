import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
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

export function stampServiceWorker(source, { version, files }) {
  return source
    .replaceAll('__APP_VERSION__', version)
    .replace('/*__PRECACHE__*/', files.map((file) => JSON.stringify(file)).join(', '))
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `vite build --mode app`: bundle for the Electron/Capacitor shells (server address and bearer token, see src/utils/api.js)
  const appMode = mode === 'app'
  let outDir = path.resolve(import.meta.dirname, appMode ? 'dist-app' : 'dist')
  return {
    base: appMode ? './' : '/',
    plugins: [
      react(),
      ...(appMode ? [appCspPlugin()] : []),
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
          fs.writeFileSync(swPath, stampServiceWorker(source, { version: pkg.version, files: precacheList(outDir) }))
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
