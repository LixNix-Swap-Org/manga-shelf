// The app build is loaded by the shells without the server's CSP header, while it keeps the bearer token in storage.
// connect-src cannot name the user's server, but script-src 'self' still blocks injected scripts. 'wasm-unsafe-eval'
// lets the standalone mode compile sql.js (WebAssembly only, no eval of scripts); connect-src 'self' loads its wasm file.
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

/** Vite plugin of the app build: the CSP as the first <meta> of index.html. */
export const appCspPlugin = () => ({
  name: 'app-csp',
  // the dev server injects inline scripts (React refresh)
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: APP_CSP }, injectTo: 'head-prepend' }
  ]
});
