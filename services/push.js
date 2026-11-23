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
    test: 'Erinnerungen sind eingeschaltet',
    tomorrow: 'Morgen erscheint',
    week: 'Diese Woche',
    loanTitle: 'Ausleihe überfällig',
    loan: '{title} {volumes} – seit {days} Tagen bei {name}',
    weekdays: 'Mo,Di,Mi,Do,Fr,Sa,So'
});
// when a subscription gets its reminder: on the release day, the day before, or once a week (Monday) for the week
const MODES = ['day', 'eve', 'week'];
// what it reports; each a 0/1 column of push_subscriptions
const KINDS = ['volumes', 'episodes', 'loans'];

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

/** Calendar arithmetic on YYYY-MM-DD strings (UTC noon, so no time zone or DST shifts a day). */
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const weekdayIndex = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
const mondayOf = (day) => addDays(day, -weekdayIndex(day));
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

/** The days a subscription's reminder covers on `day`: { from, to } (inclusive). */
function windowOf(mode, day) {
    if (mode === 'eve') return { from: addDays(day, 1), to: addDays(day, 1) };
    if (mode === 'week') return { from: day, to: addDays(mondayOf(day), 6) };
    return { from: day, to: day };
}

/**
 * What one account has between `from` and `to` (local days, inclusive): radar volumes with an exact date in the window
 * (all of its shelves, as the release radar shows them) and confirmed next episodes of its "Schaue"/"Geplant" anime
 * airing in it. { volumes, episodes }, each with its `day`.
 */
function releasesBetween(ctx, from, to) {
    const { releaseRadar } = require('../core/handlers/radar');
    const volumes = [];
    for (const group of releaseRadar(ctx, { query: {} }).body?.groups || []) {
        for (const item of group?.items || []) {
            if (!item || item.date_precision === 'month') continue;
            const day = String(item.release_date ?? '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < from || day > to) continue;
            volumes.push({ ...item, day });
        }
    }
    volumes.sort((a, b) => a.day.localeCompare(b.day));
    const episodes = [];
    const rows = ctx.db.prepare(`
        SELECT a.title AS title, a.title_de AS title_de, a.next_airing_episode AS episode, a.next_airing_at AS at
        FROM anime_progress p JOIN animes a ON a.id = p.anime_id
        WHERE p.user_id = ? AND p.status IN (${FOLLOWED.map(() => '?').join(', ')})
          AND a.next_airing_at IS NOT NULL AND a.next_airing_episode > 0 AND COALESCE(a.next_airing_estimated, 0) = 0
        ORDER BY a.next_airing_at, a.id
    `).all(ctx.user.id, ...FOLLOWED);
    for (const r of rows) {
        const day = dayOf(new Date(Number(r.at) * 1000), ctx.config.appTimeZone);
        if (day < from || day > to) continue;
        episodes.push({ title: String(r.title_de || r.title || '').trim(), episode: Number(r.episode), day });
    }
    return { volumes, episodes };
}

/** The releases of `day` only (the release-day reminder). */
function releasesToday(ctx, day) {
    return releasesBetween(ctx, day, day);
}

/**
 * The account's lent copies (its own and the household's, like "Zu erledigen") that have been away for its loan
 * period (users.lent_reminder_days) on `day`, per series and borrower: [{ title, numbers, name, days, overdueOn }].
 */
function overdueLoans(ctx, day) {
    const access = require('../core/lib/access');
    const { readProfile } = require('../core/lib/locales');
    const { volumeOrderSql } = require('../core/lib/volumeNumber');
    const scope = access.inShelves('m.shelf_id', access.requestedShelfIds(ctx, null));
    const period = readProfile(ctx.db, ctx.user.id).lent_reminder_days;
    const rows = ctx.db.prepare(`
        SELECT v.manga_id, m.title, v.volume_number, COALESCE(b.username, c.lent_to_name) AS name, SUBSTR(c.lent_at, 1, 10) AS lent_at
        FROM volume_copies c
        JOIN volumes v ON v.id = c.volume_id
        JOIN mangas m ON m.id = v.manga_id
        LEFT JOIN users b ON b.id = c.lent_to_user_id
        WHERE (c.owner_user_id = ? OR c.owner_user_id IS NULL) AND (c.lent_to_user_id IS NOT NULL OR c.lent_to_name IS NOT NULL)
          AND c.lent_at IS NOT NULL AND julianday(?) - julianday(SUBSTR(c.lent_at, 1, 10)) >= ? AND ${scope.sql}
        ORDER BY m.title COLLATE NOCASE, m.id, ${volumeOrderSql('v')}
    `).all(ctx.user.id, day, period, ...scope.params);
    const groups = new Map();
    for (const r of rows) {
        const key = `${r.manga_id}\u0000${r.name}`;
        const days = daysBetween(r.lent_at, day);
        const entry = groups.get(key) || { title: String(r.title || '').trim(), numbers: [], name: String(r.name || '').trim(), days, overdueOn: addDays(r.lent_at, period) };
        entry.numbers.push(String(r.volume_number ?? '').trim());
        // the newest lending of the group says when the group became overdue (a reminder per newly overdue copy)
        if (days < entry.days) Object.assign(entry, { days, overdueOn: addDays(r.lent_at, period) });
        groups.set(key, entry);
    }
    return [...groups.values()];
}

/**
 * The notification for one subscription, or null when there is nothing to say: { title, body, url, tag }.
 * `found` = { volumes, episodes, loans }; `mode` picks the title (today, tomorrow, this week; the week lists the weekday).
 */
function buildMessage(found, texts, day, mode = 'day') {
    const volumes = found.volumes || [];
    const episodes = found.episodes || [];
    const loans = found.loans || [];
    const weekdays = String(texts.weekdays || DEFAULT_TEXTS.weekdays).split(',');
    const dated = (line, d) => (mode === 'week' && d ? `${weekdays[weekdayIndex(d)] || d} ${line}` : line);
    const lines = [];
    const add = (line) => { if (!lines.includes(line)) lines.push(line); };
    for (const v of volumes) {
        const title = String(v.manga_title ?? '').trim();
        const label = volumeLabel(v, texts);
        add(dated(title ? `${title} – ${label}` : label, v.day));
    }
    for (const e of episodes) add(dated(fill(texts.episode, { title: e.title, episode: e.episode }), e.day));
    for (const l of loans) {
        const numbers = l.numbers.filter(Boolean);
        const label = numbers.length && numbers.every(n => /^\d+(\.\d+)?$/.test(n)) ? fill(texts.volume, { num: numbers.join(', ') }) : numbers.join(', ');
        add(fill(texts.loan, { title: l.title, volumes: label, days: l.days, name: l.name }).replace(/\s+–/, ' –').trim());
    }
    if (!lines.length) return null;
    const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES - 1) : lines;
    const rest = lines.length - shown.length;
    const body = [...shown, ...(rest ? [fill(texts.more, { n: rest })] : [])].join('\n');
    const releases = volumes.length + episodes.length;
    const title = !releases ? texts.loanTitle : mode === 'eve' ? texts.tomorrow : mode === 'week' ? texts.week : texts.title;
    const url = volumes.length ? '/?view=radar' : episodes.length ? '/?view=anime' : '/';
    return { title, body, url, tag: `release-${mode}-${day}` };
}

/** What a subscription row reports on `day`, by its mode and kinds. */
function findFor(ctx, sub, day) {
    const mode = MODES.includes(sub.mode) ? sub.mode : 'day';
    const { from, to } = windowOf(mode, day);
    const found = { volumes: [], episodes: [], loans: [] };
    if (sub.volumes || sub.episodes) {
        const r = releasesBetween(ctx, from, to);
        if (sub.volumes) found.volumes = r.volumes;
        if (sub.episodes) found.episodes = r.episodes;
    }
    if (sub.loans) {
        const loans = overdueLoans(ctx, day);
        // weekly: every overdue lending; daily: the ones that became overdue since the last reminder (or today)
        found.loans = mode === 'week' ? loans : loans.filter(l => l.overdueOn <= day && l.overdueOn > (sub.last_day && sub.last_day < day ? sub.last_day : addDays(day, -1)));
    }
    return { mode, found };
}

let run = null;

/**
 * The reminder run (hourly scheduler check): once per local day (APP_TIME_ZONE), from each subscription's own hour,
 * every subscription that is due gets what its account has in its window (weekly ones once per week, on Monday or the
 * first check after). Subscriptions the push service forgot are deleted. Concurrent calls share one run. Resolves
 * { sent, gone, skipped } or null when nothing is due.
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
    const monday = mondayOf(day);
    const due = `(s.last_day IS NULL OR s.last_day <> ?) AND (s.mode <> 'week' OR s.last_day IS NULL OR s.last_day < ?)`;
    // each browser from its own hour on (the hourly check sends within that hour; a missed hour is caught up later that day)
    const subs = db.prepare(`
        SELECT s.id, s.user_id, s.endpoint, s.p256dh, s.auth, s.texts, s.mode, s.volumes, s.episodes, s.loans, s.last_day, u.username, u.role
        FROM push_subscriptions s JOIN users u ON u.id = s.user_id
        WHERE ${due} AND s.hour <= ?
        ORDER BY s.user_id, s.id
    `).all(day, monday, hour);
    if (!subs.length) return Promise.resolve(null);
    run = (async () => {
        const report = { sent: 0, gone: 0, skipped: 0 };
        const ctxs = new Map();
        for (const sub of subs) {
            if (shouldStop()) return report;
            if (!ctxs.has(sub.user_id)) ctxs.set(sub.user_id, createCtx({ user: { id: sub.user_id, username: sub.username, role: sub.role } }));
            let message = null;
            try {
                const { mode, found } = findFor(ctxs.get(sub.user_id), sub, day);
                message = buildMessage(found, textsOf(sub.texts), day, mode);
            } catch (e) {
                log.warn(`[Push] Erinnerung nicht lesbar: ${e?.message || e}`);
            }
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
        const open = db.prepare(`SELECT count(*) AS c FROM push_subscriptions s WHERE ${due}`).get(day, monday).c;
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
    MODES,
    KINDS,
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
    releasesBetween,
    overdueLoans,
    windowOf,
    runPushRemindersIfDue
};
