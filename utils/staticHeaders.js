// Cache headers for the built frontend (express.static `setHeaders`).

/**
 * index.html, the service worker and the manifest are revalidated on every load. index.html names the hashed asset
 * files of exactly one build: a cached copy would, after an update, point at files that no longer exist (blank page).
 */
function setStaticHeaders(res, filePath) {
    if (/(^|[\\/])(sw\.js|manifest\.json|index\.html)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
    }
}

module.exports = { setStaticHeaders };
