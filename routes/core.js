// Express adapter of core/routes.js: auth middleware by role, ETag/304 and per-account limits as declared, then
// parse -> handler(ctx, input) -> JSON (or the text body with its headers).
const express = require('express');
const { createCtx } = require('../db');
const { requireAuth, requireEditor, requireAdmin } = require('../middleware/auth');
const { lookupLimiter, remoteImageLimiter } = require('../middleware/userLimits');
const { conditional } = require('../utils/dataVersion');
const { routes, defaultParse } = require('../core/routes');
const { ANSWERED } = require('../core/ctx');

const GUARDS = { public: [], auth: [requireAuth], editor: [requireEditor], admin: [requireAdmin] };
const LIMITERS = { lookup: lookupLimiter, remoteImage: remoteImageLimiter };

function send(res, result) {
    for (const [name, value] of Object.entries(result.headers || {})) res.setHeader(name, value);
    if (result.status) res.status(result.status);
    if (typeof result.body === 'string') res.send(result.body);
    else res.json(result.body);
}

function adapt(row) {
    return async function coreHandler(req, res) {
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });
        const ctx = createCtx({
            user: req.user || null,
            signal: ac.signal,
            // a limit applied inside the handler (e.g. only when the collection cannot answer): 429 is sent here
            limit: (name, { soft = false } = {}) => {
                if (soft) return LIMITERS[name].tryConsume(req);
                if (LIMITERS[name].consume(req, res)) throw ANSWERED;
                return true;
            }
        });
        let result;
        try {
            const input = (row.parse || defaultParse)({ params: req.params, query: req.query, body: req.body });
            result = await row.handler(ctx, input);
        } catch (err) {
            if (err === ANSWERED) return;
            throw err;
        }
        send(res, result);
    };
}

function createCoreRouter(rows = routes) {
    const router = express.Router();
    for (const row of rows) {
        if (!GUARDS[row.role]) throw new Error(`core/routes.js: unbekannte Rolle "${row.role}" bei ${row.method} ${row.path}`);
        const chain = [...GUARDS[row.role]];
        if (row.conditional) chain.push(conditional(row.conditional === true ? {} : row.conditional));
        if (row.limit) chain.push(LIMITERS[row.limit]);
        chain.push(adapt(row));
        router[row.method.toLowerCase()](row.path, ...chain);
    }
    return router;
}

const coreRouter = createCoreRouter();

module.exports = coreRouter;
module.exports.createCoreRouter = createCoreRouter;
