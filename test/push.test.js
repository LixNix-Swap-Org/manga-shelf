// Web Push of the release-day reminders (services/push.js, routes/push.js): encryption (RFC 8291) checked by decrypting
// as the browser would, the VAPID signature, the subscription routes and the daily run.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let guest;
let db;
let push;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'gast', password: 'password123', role: 'guest' })).status, 200);
    guest = ctx.client();
    assert.equal((await guest('POST', '/auth/login', { username: 'gast', password: 'password123' })).status, 200);
    db = require('../db').db;
    push = require('../services/push');
});

test.after(async () => { await ctx.close(); });

/** A browser's side: its key pair and auth secret, and the subscription JSON it would send. */
function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    return {
        ecdh,
        auth,
        json: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
    };
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 8291 decryption as the browser does it. */
function decrypt(b, body) {
    const salt = body.subarray(0, 16);
    const rs = body.readUInt32BE(16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const cipher = body.subarray(21 + idlen);
    assert.equal(rs, 4096);
    const uaPublic = b.ecdh.getPublicKey();
    const shared = b.ecdh.computeSecret(asPublic);
    const prkKey = hmac(b.auth, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(cipher.subarray(cipher.length - 16));
    const plain = Buffer.concat([decipher.update(cipher.subarray(0, cipher.length - 16)), decipher.final()]);
    assert.equal(plain[plain.length - 1], 2, 'last record delimiter');
    return plain.subarray(0, plain.length - 1).toString();
}

test('encryption: the browser decrypts what the server encrypts', () => {
    const b = browser();
    const body = push.encryptPayload({ p256dh: b.json.keys.p256dh, auth: b.json.keys.auth }, JSON.stringify({ title: 'Hallo', body: 'Welt' }));
    assert.deepEqual(JSON.parse(decrypt(b, body)), { title: 'Hallo', body: 'Welt' });
    assert.throws(() => push.encryptPayload({ p256dh: 'AAAA', auth: b.json.keys.auth }, 'x'));
});

test('VAPID: one key pair per server, the JWT is signed for the endpoint origin', () => {
    const keys = push.vapidKeys(db);
    assert.equal(push.vapidKeys(db).publicKey, keys.publicKey, 'kept in app_settings');
    const header = push.vapidAuthorization('https://fcm.googleapis.com/fcm/send/x', keys, Date.UTC(2026, 0, 1));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    assert.ok(m, header);
    assert.equal(m[4], keys.publicKey);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.exp, Date.UTC(2026, 0, 1) / 1000 + 12 * 3600);
    const raw = Buffer.from(keys.publicKey, 'base64url');
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')));
});

test('only https endpoints of the known push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/1', 'https://updates.push.services.mozilla.com/wpush/v2/x',
        'https://web.push.apple.com/abc', 'https://jmt17.google.com/fcm/send/x', 'https://wns2-par02p.notify.windows.com/w/?token=1']) assert.ok(push.isPushEndpoint(ok), ok);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x',
        'https://127.0.0.1/x', 'https://google.com/x', 'https://evil.google.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'nonsense', '']) assert.ok(!push.isPushEndpoint(bad), bad);
});

test('routes: key, subscribe, status, test message, unsubscribe; guests and foreign endpoints are refused', async () => {
    const b = browser('https://fcm.googleapis.com/fcm/send/route-test');
    const key = await admin('GET', '/push/key');
    assert.equal(key.status, 200);
    assert.equal(Buffer.from(key.body.publicKey, 'base64url').length, 65);
    assert.equal((await guest('GET', '/push/key')).status, 403);
    assert.equal((await guest('PUT', '/push/subscriptions', b.json)).status, 403);

    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, endpoint: 'https://example.com/x' })).status, 400);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, keys: { p256dh: 'abc', auth: 'abc' } })).status, 400);
    const texts = { title: 'New today', volume: 'Vol. {num}', bogus: 'x', episode: 'y'.repeat(500) };
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, texts })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, texts })).status, 200, 'again: one row');
    const rows = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all(b.json.endpoint);
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].texts), { title: 'New today', volume: 'Vol. {num}' });
    assert.deepEqual((await admin('POST', '/push/subscriptions/status', { endpoint: b.json.endpoint })).body, { subscribed: true });

    // the test message goes to the real push service in production; here the endpoint is unreachable, so it fails softly
    const realFetch = globalThis.fetch;
    let sent = null;
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith('https://fcm.googleapis.com/')) { sent = { url, init }; return new Response(null, { status: 201 }); }
        return realFetch(url, init);
    };
    try {
        const res = await admin('POST', '/push/test', { endpoint: b.json.endpoint });
        assert.deepEqual(res.body, { success: true, gone: false });
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(sent.init.headers['Content-Encoding'], 'aes128gcm');
    assert.match(sent.init.headers.Authorization, /^vapid t=/);
    assert.equal(JSON.parse(decrypt(b, sent.init.body)).title, push.DEFAULT_TEXTS.test);
    assert.equal((await admin('POST', '/push/test', { endpoint: 'https://fcm.googleapis.com/fcm/send/other' })).status, 404);

    assert.deepEqual((await admin('DELETE', '/push/subscriptions', { endpoint: b.json.endpoint })).body, { success: true, removed: 1 });
    assert.deepEqual((await admin('POST', '/push/subscriptions/status', { endpoint: b.json.endpoint })).body, { subscribed: false });
});

test('daily run: today\'s radar volumes and followed episodes, once per day, from 9:00; gone subscriptions are deleted', async () => {
    db.exec('DELETE FROM push_subscriptions');
    const tz = 'Europe/Berlin';
    const now = new Date();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const series = (await admin('POST', '/mangas', { title: 'Pushreihe' })).body.id;
    assert.equal((await admin('POST', '/volumes', { manga_id: series, volume_number: '4', status: 'Vorbestellt', release_date: day })).status, 200);
    assert.equal((await admin('POST', '/volumes', { manga_id: series, volume_number: '5', status: 'Vorbestellt', release_date: '2999-01-01' })).status, 200);
    const me = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
    const airing = Math.floor(now.getTime() / 1000);
    const animeId = db.prepare("INSERT INTO animes (title, title_de, next_airing_episode, next_airing_at) VALUES ('Frieren', 'Frieren DE', 7, ?)").run(airing).lastInsertRowid;
    db.prepare("INSERT INTO anime_progress (anime_id, user_id, status) VALUES (?, ?, 'Schaue')").run(animeId, me);

    const live = browser('https://fcm.googleapis.com/fcm/send/live');
    const dead = browser('https://updates.push.services.mozilla.com/wpush/v2/dead');
    assert.equal((await admin('PUT', '/push/subscriptions', { ...live.json, texts: { title: 'New today', volume: 'Vol. {num}', episode: '{title} ep. {episode}' } })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', dead.json)).status, 200);

    const sent = [];
    const fetchImpl = async (url, init) => {
        sent.push({ url, body: init.body });
        return new Response(null, { status: String(url).includes('dead') ? 410 : 201 });
    };
    const { createCtx } = require('../db');
    const at = (hour) => {
        // `hour`:30 Berlin time today
        const probe = new Date(`${day}T${String(hour).padStart(2, '0')}:30:00Z`);
        const offset = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(probe)) - hour;
        return new Date(probe.getTime() - offset * 3600 * 1000);
    };
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(push.DAY_KEY);

    assert.equal(await push.runPushRemindersIfDue({ db, createCtx, now: at(8), timeZone: tz, fetchImpl }), null, 'before 9:00');
    const report = await push.runPushRemindersIfDue({ db, createCtx, now: at(9), timeZone: tz, fetchImpl });
    assert.deepEqual(report, { sent: 1, gone: 1, skipped: 0 });
    const message = JSON.parse(decrypt(live, sent.find(s => s.url.includes('live')).body));
    assert.equal(message.title, 'New today');
    assert.equal(message.body, 'Pushreihe – Vol. 4\nFrieren DE ep. 7');
    assert.equal(message.url, '/?view=radar');
    assert.equal(message.tag, `release-day-${day}`);
    assert.equal(db.prepare('SELECT count(*) AS c FROM push_subscriptions').get().c, 1, 'the 410 one is gone');
    assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(push.DAY_KEY).value, day);
    assert.equal(await push.runPushRemindersIfDue({ db, createCtx, now: at(10), timeZone: tz, fetchImpl }), null, 'once a day');
});

test('buildMessage: no message without releases, more than six lines are folded', () => {
    const texts = push.textsOf(null);
    assert.equal(push.buildMessage({ volumes: [], episodes: [] }, texts, '2026-01-01'), null);
    const volumes = Array.from({ length: 8 }, (_, i) => ({ manga_title: 'Reihe', volume_number: String(i + 1) }));
    const msg = push.buildMessage({ volumes, episodes: [] }, texts, '2026-01-01');
    assert.equal(msg.body.split('\n').length, 6);
    assert.equal(msg.body.split('\n').at(-1), '+ 3 weitere');
    const box = push.buildMessage({ volumes: [{ manga_title: 'R', volume_number: '2', type: 'schuber' }, { manga_title: 'R', volume_number: 'Vollschuber 1-5' }], episodes: [] }, texts, 'd');
    assert.equal(box.body, 'R – Schuber 2\nR – Vollschuber 1-5');
});
