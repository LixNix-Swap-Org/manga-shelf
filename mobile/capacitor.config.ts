import type { CapacitorConfig } from '@capacitor/cli';

// www/ is assembled by scripts/prepare-web.js: the frontend's app build (vite --mode app) plus native-bridge.js
const config: CapacitorConfig = {
  appId: 'de.mangashelf.app',
  appName: 'Manga Shelf',
  webDir: 'www',
  // the WebView is dark before the first paint (no white flash at a cold start)
  backgroundColor: '#0b0f19',
  // debug builds would otherwise print plugin calls and results (Crunchyroll cookie, bearer tokens) to Xcode and logcat
  loggingBehavior: 'none',
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
    CapacitorHttp: { enabled: true },
    // release-day reminders (Android): the monochrome book of res/drawable/ic_stat_manga_shelf.xml in the status bar,
    // tinted in the brand colour; without it Android shows the plugin's generic info icon
    LocalNotifications: { smallIcon: 'ic_stat_manga_shelf', iconColor: '#0ea5e9' }
  }
};

export default config;
