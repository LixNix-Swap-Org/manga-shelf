// Web Push of the release-day reminders (services/push.js), server-only: the apps plan their reminders on the device.
// GET /push/key gives the VAPID public key, PUT/DELETE /push/subscriptions switch one browser on or off, POST /push/test
// sends a test message to it. Editors and admins only, like the reminder switch of the apps.
const express = require('express');
const { db } = require('../db');
const { requireEditor } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');
const { badRequest, notFound } = require('../utils/httpError');
const push = require('../services/push');

const router = express.Router();
// a browser keeps one subscription; more per account only from many browsers
const MAX_PER_USER = 20;

const testLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 5,
    keyFn: (req) => 'user:' + req.user?.id,
    message: 'Zu viele Test-Mitteilungen. Bitte später erneut versuchen.'
});

/** { endpoint, p256dh, auth } of a PushSubscription JSON, or a 400. */
function readSubscription(body) {
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint || endpoint.length > 2048 || !push.isPushEndpoint(endpoint)) throw badRequest('Unbekannter Push-Dienst', 'PUSH_ENDPOINT');
    const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh.trim() : '';
    const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth.trim() : '';
    const key = Buffer.from(p256dh, 'base64url');
    const secret = Buffer.from(auth, 'base64url');
    if (key.length !== 65 || key[0] !== 4 || secret.length !== 16) throw badRequest('Ungültiges Push-Abo', 'PUSH_KEYS');
    return { endpoint, p256dh, auth };
}

const endpointOf = (body) => (typeof body?.endpoint === 'string' ? body.endpoint.trim() : '');

router.get('/push/key', requireEditor, (req, res) => {
    res.json({ publicKey: push.vapidKeys(db).publicKey });
});

// on: stores the subscription for the caller (a browser that was subscribed for another account moves over)
router.put('/push/subscriptions', requireEditor, (req, res) => {
    const sub = readSubscription(req.body);
    const texts = push.cleanTexts(req.body?.texts);
    db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, texts) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
            texts = excluded.texts, last_day = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.last_day END
    `).run(req.user.id, sub.endpoint, sub.p256dh, sub.auth, texts);
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
        SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ?)`).run(req.user.id, req.user.id, MAX_PER_USER);
    res.json({ success: true });
});

// is this browser subscribed for the caller? (the switch shows the server's view, not only the browser's)
router.post('/push/subscriptions/status', requireEditor, (req, res) => {
    const row = db.prepare('SELECT 1 AS ok FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpointOf(req.body), req.user.id);
    res.json({ subscribed: Boolean(row) });
});

// off (switch, logout): only the caller's own row
router.delete('/push/subscriptions', requireEditor, (req, res) => {
    const endpoint = endpointOf(req.body);
    if (!endpoint) throw badRequest('Push-Abo fehlt', 'PUSH_ENDPOINT');
    const removed = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id).changes;
    res.json({ success: true, removed });
});

router.post('/push/test', requireEditor, testLimiter, async (req, res) => {
    const row = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').get(endpointOf(req.body), req.user.id);
    if (!row) throw notFound('Push-Abo');
    const texts = push.textsOf(row.texts);
    const result = await push.sendPush(row, { title: texts.test, body: '', url: '/', tag: 'push-test' }, { db });
    if (result.gone) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    res.json({ success: result.ok, gone: Boolean(result.gone) });
});

module.exports = router;
