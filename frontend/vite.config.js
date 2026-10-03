import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      // the service worker is a plain file in public/: stamp the app version into its cache name
      name: 'stamp-sw-version',
      closeBundle() {
        const swPath = path.resolve(__dirname, 'dist', 'sw.js')
        if (!fs.existsSync(swPath)) return
        fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf-8').replaceAll('__APP_VERSION__', pkg.version))
      }
    }
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000'
    }
  }
})
