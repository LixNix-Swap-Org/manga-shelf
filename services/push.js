// Web Push of the release-day reminders in the browser (U7): the VAPID key pair of this server, the encryption of a
// message for one subscription (RFC 8291, aes128gcm) and the daily run that tells every subscribed browser in the morning
// which volumes from the release radar and which episodes of the followed anime come out today. Node's crypto only, no
// push library. The push services (Google, Mozilla, Apple, Microsoft) only ever see the encrypted message.
const crypto = require('crypto');
const log = require('../utils/logger').child('push');

const VAPID_KEY = 'push_vapid';
const DAY_KEY = 'push_reminder_day';
const REMINDER_HOUR = 9; // default hour of a new subscription (push_subscriptions.hour)
const MAX_LINES = 6;
const TTL_SECONDS = 20 * 60 * 60;
const SEND_TIMEOUT_MS = 10000;
const RECORD_SIZE = 4096;
// i18n-ignore: stored anime status values
const FOLLOWED = ['Schaue', 'Geplant'];
// the push services of the browsers (jmt17.google.com: Chromium builds without Google keys); any other endpoint is refused (the server would otherwise post to any URL it is given)
const PUSH_HOSTS = [
    'fcm.googleapis.com', 'android.googleapis.com', 'jmt17.google.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com',
    'web.push.apple.com', 'push.apple.com', 'notify.windows.com'
];
const MAX_TEXT = 200;
// the texts a browser sends along (its UI language); German when one is missing
const DEFAULT_TEXTS = Object.freeze({
    title: 'Heute neu erschienen',
    volume: 'Band {num}',
    box: 'Schuber {num}',
    episode: '{title} – Folge {episode}',
    more: '+ {n} weitere',
    test: 'Erinnerungen sind eingeschaltet'
});

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (text) => Buffer.from(String(text || ''), 'base64url');

/** True for an https URL of a known push service (exact host or a subdomain of one). */
function isPushEndpoint(endpoint) {
    let url;
    try {
        url = new URL(String(endpoint || ''));
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase();
    return PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The server's VAPID key pair, made on first use and kept in app_settings: { publicKey (base64url, raw), privateKey (KeyObject) }. */
function vapidKeys(db) {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(VAPID_KEY);
    let stored;
    try { stored = row ? JSON.parse(row.value) : null; } catch { stored = null; }
    if (!stored?.jwk?.d) {
        const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        stored = { jwk: privateKey.export({ format: 'jwk' }) };
        db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(VAPID_KEY, JSON.stringify(stored));
    }
    const privateKey = crypto.createPrivateKey({ key: stored.jwk, format: 'jwk' });
    const publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(stored.jwk.x), fromB64url(stored.jwk.y)]));
    return { publicKey, privateKey };
}

/** The Authorization header for one endpoint (RFC 8292): a JWT for the endpoint's origin, signed with ES256. */
function vapidAuthorization(endpoint, keys, now = Date.now()) {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: 'https://github.com/LixNix-Swap-Org/manga-shelf'
    }));
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Encrypts `payload` for a subscription (RFC 8291 with RFC 8188 aes128gcm, one record): salt, record size, the
 * server's one-time public key, then the ciphertext. `salt` and `serverKey` only for tests.
 */
function encryptPayload(subscription, payload, { salt = crypto.randomBytes(16), serverKey = crypto.createECDH('prime256v1') } = {}) {
    const uaPublic = fromB64url(subscription.p256dh);
    const authSecret = fromB64url(subscription.auth);
    if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('invalid subscription keys');
    if (!serverKey.getPublicKey) throw new Error('serverKey must be an ECDH object');
    try { serverKey.getPrivateKey(); } catch { serverKey.generateKeys(); }
    const asPublic = serverKey.getPublicKey();
    const shared = serverKey.computeSecret(uaPublic);
    const prkKey = hmac(authSecret, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(RECORD_SIZE);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Sends one message. Resolves { ok, gone } where `gone` means the push service forgot the subscription (404/410):
 * the caller deletes it. Network errors resolve { ok: false, gone: false }.
 */
async function sendPush(subscription, message, { db, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    if (!isPushEndpoint(subscription.endpoint)) return { ok: false, gone: true };
    const keys = vapidKeys(db);
    const body = encryptPayload(subscription, JSON.stringify(message));
    try {
        const res = await fetchImpl(subscription.endpoint, {
            method: 'POST',
            headers: {
                TTL: String(TTL_SECONDS),
                Urgency: 'normal',
                'Content-Encoding': 'aes128gcm',
                'Content-Type': 'application/octet-stream',
                Authorization: vapidAuthorization(subscription.endpoint, keys, now)
            },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
        });
        if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status };
        if (!res.ok) log.warn(`[Push] Push-Dienst antwortet ${res.status}`);
        return { ok: res.ok, gone: false, status: res.status };
    } catch (e) {
        log.warn(`[Push] Senden fehlgeschlagen: ${e?.message || e}`);
        return { ok: false, gone: false };
    }
}

const fill = (template, vars) => String(template).replace(/\{(\w+)\}/g, (all, key) => (key in vars ? String(vars[key]) : all));

/** The texts of a subscription row: its stored strings where valid, the German defaults for the rest. */
function textsOf(raw) {
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    const out = { ...DEFAULT_TEXTS };
    for (const key of Object.keys(DEFAULT_TEXTS)) {
        const value = parsed?.[key];
        if (typeof value === 'string' && value.trim() && value.length <= MAX_TEXT) out[key] = value;
    }
    return out;
}

/** The texts a client may send: known keys, strings up to 200 characters. Returns a JSON string or null. */
function cleanTexts(texts) {
    if (!texts || typeof texts !== 'object' || Array.isArray(texts)) return null;
    const out = {};
    for (const key of Object.keys(DEFAULT_TEXTS)) {
        const value = texts[key];
        if (typeof value === 'string' && value.trim() && value.length <= MAX_TEXT) out[key] = value;
    }
    return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** "Band 3", "Schuber 2" or the number as typed ("Vollschuber 1-5", "Special 2") in the subscription's language. */
function volumeLabel(item, texts) {
    const num = String(item.volume_number ?? '').trim();
    if (/^\d+(\.\d+)?$/.test(num)) return fill(item.type === 'schuber' ? texts.box : texts.volume, { num });
    return num || fill(texts.volume, { num: '?' });
}

const dayOf = (date, timeZone) => {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    }
};

/**
 * What comes out today for one account: radar volumes with today's exact date (all of its shelves, as the release
 * radar shows them) and confirmed next episodes of its "Schaue"/"Geplant" anime airing today. { volumes, episodes }.
 */
function releasesToday(ctx, day) {
    const { releaseRadar } = require('../core/handlers/radar');
    const volumes = [];
    for (const group of releaseRadar(ctx, { query: {} }).body?.groups || []) {
        for (const item of group?.items || []) {
            if (!item || item.date_precision === 'month') continue;
            if (String(item.release_date ?? '').trim() !== day) continue;
            volumes.push(item);
        }
    }
    const episodes = [];
    const rows = ctx.db.prepare(`
        SELECT a.title AS title, a.title_de AS title_de, a.next_airing_episode AS episode, a.next_airing_at AS at
        FROM anime_progress p JOIN animes a ON a.id = p.anime_id
        WHERE p.user_id = ? AND p.status IN (${FOLLOWED.map(() => '?').join(', ')})
          AND a.next_airing_at IS NOT NULL AND a.next_airing_episode > 0 AND COALESCE(a.next_airing_estimated, 0) = 0
        ORDER BY a.next_airing_at, a.id
    `).all(ctx.user.id, ...FOLLOWED);
    for (const r of rows) {
        if (dayOf(new Date(Number(r.at) * 1000), ctx.config.appTimeZone) !== day) continue;
        episodes.push({ title: String(r.title_de || r.title || '').trim(), episode: Number(r.episode) });
    }
    return { volumes, episodes };
}

/** The notification for one subscription, or null when nothing comes out: { title, body, url, tag }. */
function buildMessage({ volumes, episodes }, texts, day) {
    const lines = [];
    for (const v of volumes) {
        const title = String(v.manga_title ?? '').trim();
        const label = volumeLabel(v, texts);
        const line = title ? `${title} – ${label}` : label;
        if (!lines.includes(line)) lines.push(line);
    }
    for (const e of episodes) {
        const line = fill(texts.episode, { title: e.title, episode: e.episode });
        if (!lines.includes(line)) lines.push(line);
    }
    if (!lines.length) return null;
    const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES - 1) : lines;
    const rest = lines.length - shown.length;
    const body = [...shown, ...(rest ? [fill(texts.more, { n: rest })] : [])].join('\n');
    return { title: texts.title, body, url: volumes.length ? '/?view=radar' : '/?view=anime', tag: `release-day-${day}` };
}

let run = null;

/**
 * The morning reminder: once per local day (APP_TIME_ZONE) from 9:00, every subscription that has not had today's
 * run gets the releases of its account, if any. Subscriptions the push service forgot are deleted. Concurrent calls
 * share one run. Resolves { sent, gone, skipped } or null when not due.
 */
function runPushRemindersIfDue({ db, createCtx, now = new Date(), timeZone, fetchImpl, shouldStop = () => false } = {}) {
    if (run) return run;
    const parts = {};
    try {
        for (const p of new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)) parts[p.type] = p.value;
    } catch {
        return Promise.resolve(null);
    }
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = Number(parts.hour);
    const done = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DAY_KEY);
    if (done && done.value === day) return Promise.resolve(null);
    // each browser from its own hour on (the hourly check sends within that hour; a missed hour is caught up later that day)
    const subs = db.prepare(`
        SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth, s.texts, u.username, u.role
        FROM push_subscriptions s JOIN users u ON u.id = s.user_id
        WHERE (s.last_day IS NULL OR s.last_day <> ?) AND s.hour <= ?
        ORDER BY s.user_id, s.id
    `).all(day, hour);
    if (!subs.length) return Promise.resolve(null);
    run = (async () => {
        const report = { sent: 0, gone: 0, skipped: 0 };
        const perUser = new Map();
        for (const sub of subs) {
            if (shouldStop()) return report;
            if (!perUser.has(sub.user_id)) {
                const ctx = createCtx({ user: { id: sub.user_id, username: sub.username, role: sub.role } });
                let found = { volumes: [], episodes: [] };
                try { found = releasesToday(ctx, day); } catch (e) { log.warn(`[Push] Neuerscheinungen nicht lesbar: ${e?.message || e}`); }
                perUser.set(sub.user_id, found);
            }
            const message = buildMessage(perUser.get(sub.user_id), textsOf(sub.texts), day);
            if (message) {
                const result = await sendPush(sub, message, { db, fetchImpl });
                if (result.gone) {
                    db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
                    report.gone++;
                    continue;
                }
                if (!result.ok) continue; // tried again at the next hourly check
                report.sent++;
            } else {
                report.skipped++;
            }
            db.prepare('UPDATE push_subscriptions SET last_day = ? WHERE id = ?').run(day, sub.id);
        }
        const open = db.prepare('SELECT count(*) AS c FROM push_subscriptions WHERE last_day IS NULL OR last_day <> ?').get(day).c;
        if (!open) db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(DAY_KEY, day);
        if (report.sent || report.gone) log.info(`[Push] ${report.sent} Erinnerung${report.sent === 1 ? '' : 'en'} gesendet${report.gone ? `, ${report.gone} abgelaufene Abos entfernt` : ''}`);
        return report;
    })().finally(() => { run = null; });
    return run;
}

module.exports = {
    VAPID_KEY,
    DAY_KEY,
    REMINDER_HOUR,
    DEFAULT_TEXTS,
    isPushEndpoint,
    vapidKeys,
    vapidAuthorization,
    encryptPayload,
    sendPush,
    textsOf,
    cleanTexts,
    buildMessage,
    releasesToday,
    runPushRemindersIfDue
};
