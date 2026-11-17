// GET /api/covers?url=<foreign cover URL>: the cover from the server's cache (services/coverCache.js), so the browser
// and the apps never contact the cover host themselves. Server-only; public like /uploads (an <img> sends no bearer
// token). A URL no row names, or one that cannot be fetched right now, is redirected to its host (image loads only),
// so search results and a cover host that is down look as before.
const express = require('express');
const router = express.Router();
const coverCache = require('../services/coverCache');
const { sendError } = require('../utils/httpError');

const COVER_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

// A top-level navigation sends Sec-Fetch-Dest: document; only image loads (or clients without the header) follow
// the redirect, so the route is no open redirect for links.
const mayRedirect = (req) => {
    const dest = req.headers['sec-fetch-dest'];
    return dest === undefined || dest === 'image' || dest === 'empty';
};

router.get('/covers', async (req, res) => {
    const raw = typeof req.query.url === 'string' ? req.query.url : null;
    const url = coverCache.cacheableUrl(raw);
    if (!url) return sendError(res, 404, 'Nicht gefunden', 'NOT_FOUND');
    const result = await coverCache.coverFile(url);
    res.setHeader('Content-Security-Policy', COVER_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (result.status === 'ok') {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'public, max-age=604800');
        res.type(result.contentType);
        return res.sendFile(result.file);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!mayRedirect(req)) return sendError(res, 404, 'Nicht gefunden', 'NOT_FOUND');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, url);
});

module.exports = router;
