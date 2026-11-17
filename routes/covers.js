// GET /api/covers?url=<foreign cover URL>: the cover from the server's cache (services/coverCache.js), so the browser
// and the apps never contact the cover host themselves. Server-only; public like /uploads (an <img> sends no bearer
// token). A URL no row names, or one that cannot be fetched right now, answers 404: the frontend then loads that one
// image from its host (utils/coverFallback.js), so search results and a cover host that is down look as before. No
// redirect: the server never sends anybody to an address taken from the request.
const express = require('express');
const router = express.Router();
const coverCache = require('../services/coverCache');
const { sendError } = require('../utils/httpError');

const COVER_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

router.get('/covers', async (req, res) => {
    res.setHeader('Content-Security-Policy', COVER_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const result = await coverCache.coverFile(typeof req.query.url === 'string' ? req.query.url : null);
    if (result.status !== 'ok') {
        res.setHeader('Cache-Control', 'no-store');
        return sendError(res, 404, 'Nicht gefunden', 'NOT_FOUND');
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type(result.contentType);
    return res.sendFile(result.file);
});

module.exports = router;
