// Response headers for static files (express.static `setHeaders`).
const path = require('path');

/**
 * index.html, the service worker and the manifest are revalidated on every load. index.html names the hashed asset
 * files of exactly one build: a cached copy would, after an update, point at files that no longer exist (blank page).
 */
function setStaticHeaders(res, filePath) {
    if (/(^|[\\/])(sw\.js|manifest\.json|index\.html)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
    }
}

// Uploads are served from the app's own origin: nothing in them may run as a page, and anything that is not an
// image (planted earlier or copied in by hand) is offered as a download only.
const UPLOADS_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

/** setHeaders for /uploads: file names are unique and never rewritten, so they are cached as immutable. */
function createUploadHeaders(imageExts) {
    return (res, filePath) => {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        res.setHeader('Content-Security-Policy', UPLOADS_CSP);
        if (!imageExts.has(path.extname(filePath).toLowerCase())) res.setHeader('Content-Disposition', 'attachment');
    };
}

module.exports = { setStaticHeaders, createUploadHeaders };
