// Web Push of the release-day reminders (services/push.js), server-only: the apps plan their reminders on the device.
// GET /push/key gives the VAPID public key, PUT/DELETE /push/subscriptions switch one browser on or off, POST /push/test
// sends a test message to it. Editors and admins only, like the reminder switch of the apps; checking and switching off
// a browser works for every signed-in account, so an account demoted to guest still gets rid of its subscription.
const express = require('express');
const { db } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
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
    if (key.length !== 65 || key[0] !== 4 || secret.length !== 16 || !push.isValidPushKey(p256dh)) throw badRequest('Ungültiges Push-Abo', 'PUSH_KEYS');
    return { endpoint, p256dh, auth };
}

/**
 * The browser's choices sent along: `hour` (0–23), `mode` (day, eve, week), `weekend` (same, late, off) and
 * `volumes`/`episodes`/`loans`/`announced`/`preorders` (booleans).
 * Only the given ones, as column values; a field left out keeps the stored value.
 */
function readPrefs(body) {
    const prefs = {};
    if (body?.hour !== undefined && body?.hour !== null) {
        // a number or a string of digits only: Number('') / Number(true) / Number([]) / Number('0x10') would pass as hours
        const raw = body.hour;
        const hour = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d{1,2}$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw badRequest('Ungültige Uhrzeit', 'PUSH_HOUR');
        prefs.hour = hour;
    }
    if (body?.mode !== undefined && body?.mode !== null) {
        if (!push.MODES.includes(body.mode)) throw badRequest('Ungültige Auswahl', 'PUSH_MODE');
        prefs.mode = body.mode;
    }
    if (body?.weekend !== undefined && body?.weekend !== null) {
        if (!push.WEEKEND.includes(body.weekend)) throw badRequest('Ungültige Auswahl', 'PUSH_WEEKEND');
        prefs.weekend = body.weekend;
    }
    for (const kind of push.KINDS) {
        if (body?.[kind] === undefined || body?.[kind] === null) continue;
        if (typeof body[kind] !== 'boolean') throw badRequest('Ungültige Auswahl', 'PUSH_KIND');
        prefs[kind] = body[kind] ? 1 : 0;
    }
    return prefs;
}

const PREF_COLUMNS = ['hour', 'mode', 'weekend', ...push.KINDS];

const endpointOf = (body) => (typeof body?.endpoint === 'string' ? body.endpoint.trim() : '');

router.get('/push/key', requireEditor, (req, res) => {
    res.json({ publicKey: push.vapidKeys(db).publicKey });
});

// on: stores the subscription for the caller (a browser that was subscribed for another account moves over); `hour`
// (0–23, local server time, default 9), `mode` (day, eve, week), `weekend` (same, late, off; default same) and
// `volumes`/`episodes`/`loans`/`announced`/`preorders` (default on) set when and about what it wants a reminder; a field
// left out keeps the stored value
router.put('/push/subscriptions', requireEditor, (req, res) => {
    const sub = readSubscription(req.body);
    const texts = push.cleanTexts(req.body?.texts);
    const prefs = readPrefs(req.body);
    const given = PREF_COLUMNS.filter((c) => c in prefs);
    // a browser that moves to another account starts its "Neu angekündigt" from scratch (what that account's radar has)
    db.prepare('DELETE FROM push_announced WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE endpoint = ? AND user_id <> ?)').run(sub.endpoint, req.user.id);
    db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, texts${given.map((c) => `, ${c}`).join('')})
        VALUES (?, ?, ?, ?, ?${given.map(() => ', ?').join('')})
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
            texts = excluded.texts${given.map((c) => `, ${c} = excluded.${c}`).join('')},
            last_day = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.last_day END,
            announced_from = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.announced_from END
    `).run(req.user.id, sub.endpoint, sub.p256dh, sub.auth, texts, ...given.map((c) => prefs[c]));
    // a browser switched on (or moved to a later hour) after today's run finished still gets today's reminder
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(push.DAY_KEY);
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
        SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT ?)`).run(req.user.id, req.user.id, MAX_PER_USER);
    res.json({ success: true });
});

// is this browser subscribed for the caller? (the switch shows the server's view, not only the browser's)
router.post('/push/subscriptions/status', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT hour, mode, weekend, ${push.KINDS.join(', ')} FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`).get(endpointOf(req.body), req.user.id);
    if (!row) return res.json({ subscribed: false });
    const body = { subscribed: true, hour: row.hour, mode: row.mode, weekend: row.weekend };
    for (const kind of push.KINDS) body[kind] = Boolean(row[kind]);
    res.json(body);
});

// off (switch, logout): only the caller's own row
router.delete('/push/subscriptions', requireAuth, (req, res) => {
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
