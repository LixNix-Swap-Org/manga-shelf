import type { CapacitorConfig } from '@capacitor/cli';

// www/ is assembled by scripts/prepare-web.js: the frontend's app build (vite --mode app) plus native-bridge.js
const config: CapacitorConfig = {
  appId: 'de.mangashelf.app',
  appName: 'Manga Shelf',
  webDir: 'www',
  // the WebView is dark before the first paint (no white flash at a cold start)
  backgroundColor: '#0b0f19',
  server: {
    androidScheme: 'https'
  },
  android: {
    // Android 15 (targetSdk 35) enforces edge-to-edge: the WebView keeps clear of the system bars
    adjustMarginsForEdgeToEdge: 'auto'
  },
  plugins: {
    // native requests: no CORS limits for DNB/Manga Passion in the standalone mode, no mixed-content block for http
    // servers in the home network (the only http addresses the app accepts, app/serverStore.js isSecureEnough)
    CapacitorHttp: { enabled: true }
  }
};

export default config;
