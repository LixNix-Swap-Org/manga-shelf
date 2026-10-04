// app:// protocol of the client mode: serves the bundled app build from a folder, with path-traversal protection.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_SCHEME = 'app';
const APP_HOST = 'manga-shelf';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_START_URL = `${APP_ORIGIN}/`;

// privileges of app://: a standard secure origin so fetch, IndexedDB, localStorage and CORS to the server work
const APP_SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true });

/**
 * Origin of a URL as Chromium sees it. Node's URL answers 'null' for schemes it does not know (app:, file:, data:),
 * so app:// gets scheme + host here and the others stay null (never equal to an allowed origin).
 */
function originOf(url) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    if (parsed.origin !== 'null') return parsed.origin;
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
}

const isFile = (file) => {
    try { return fs.statSync(file).isFile(); } catch (_) { return false; }
};

/**
 * The file of the app build for an app:// path: the file itself, an asset requested relative to a deeper route
 * (/manga/12/assets/x.js -> /assets/x.js), or index.html for SPA routes. null outside the root or for missing files.
 */
function resolveAppFile(root, pathname, exists = isFile) {
    let decoded;
    try { decoded = decodeURIComponent(pathname || '/'); } catch (_) { return null; }
    if (decoded.includes('\0')) return null;
    const base = path.resolve(root);
    const inside = (rel) => {
        const file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
        return file === base || file.startsWith(base + path.sep) ? file : null;
    };
    const direct = inside(decoded);
    if (!direct) return null;
    if (direct !== base && exists(direct)) return direct;
    const assetAt = decoded.lastIndexOf('/assets/');
    if (assetAt > 0) {
        const asset = inside(decoded.slice(assetAt));
        if (asset && exists(asset)) return asset;
    }
    if (path.posix.extname(decoded) && !decoded.endsWith('.html')) return null;
    return path.join(base, 'index.html');
}

/** Serves app:// from `root`; only the host manga-shelf exists. */
function registerAppProtocol({ protocol, net }, root) {
    protocol.handle(APP_SCHEME, (request) => {
        const url = new URL(request.url);
        if (url.host !== APP_HOST) return new Response('Nicht gefunden', { status: 404 });
        const file = resolveAppFile(root, url.pathname);
        if (!file) return new Response('Nicht gefunden', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });
}

module.exports = { originOf, APP_SCHEME, APP_HOST, APP_ORIGIN, APP_START_URL, APP_SCHEME_PRIVILEGES, resolveAppFile, registerAppProtocol };
