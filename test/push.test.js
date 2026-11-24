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
    const prefs = { hour: 9, mode: 'day', volumes: true, episodes: true, loans: true };
    assert.deepEqual((await admin('POST', '/push/subscriptions/status', { endpoint: b.json.endpoint })).body, { subscribed: true, ...prefs });
    // the hour: set with the PUT, kept by a PUT without it, checked
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, hour: 24 })).status, 400);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, hour: 7.5 })).status, 400);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, texts, hour: 20 })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, texts })).status, 200);
    assert.deepEqual((await admin('POST', '/push/subscriptions/status', { endpoint: b.json.endpoint })).body, { subscribed: true, ...prefs, hour: 20 });
    // when and what: checked, left out = kept
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, mode: 'month' })).status, 400);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, loans: 'no' })).status, 400);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, texts, mode: 'week', loans: false })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...b.json, texts })).status, 200);
    assert.deepEqual((await admin('POST', '/push/subscriptions/status', { endpoint: b.json.endpoint })).body, { subscribed: true, ...prefs, hour: 20, mode: 'week', loans: false });

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

test('daily run: today\'s radar volumes and followed episodes, once per day, from each browser\'s hour; gone subscriptions are deleted', async () => {
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
    const late = browser('https://fcm.googleapis.com/fcm/send/late');
    assert.equal((await admin('PUT', '/push/subscriptions', { ...live.json, texts: { title: 'New today', volume: 'Vol. {num}', episode: '{title} ep. {episode}' } })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', dead.json)).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...late.json, hour: 18 })).status, 200);

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
    assert.equal(sent.some(s => s.url.includes('late')), false, 'the 18:00 browser waits');
    assert.equal(db.prepare('SELECT count(*) AS c FROM push_subscriptions').get().c, 2, 'the 410 one is gone');
    assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(push.DAY_KEY), undefined, 'one browser still open');
    assert.equal(await push.runPushRemindersIfDue({ db, createCtx, now: at(10), timeZone: tz, fetchImpl }), null, 'once a day, the late one not yet due');
    assert.deepEqual(await push.runPushRemindersIfDue({ db, createCtx, now: at(18), timeZone: tz, fetchImpl }), { sent: 1, gone: 0, skipped: 0 });
    assert.equal(sent.filter(s => s.url.includes('late')).length, 1);
    assert.equal(sent.filter(s => s.url.includes('live')).length, 1, 'the 9:00 browser only once');
    assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(push.DAY_KEY).value, day);
    assert.equal(await push.runPushRemindersIfDue({ db, createCtx, now: at(19), timeZone: tz, fetchImpl }), null);
});

test('modes: the day before, once a week, and overdue lendings', async () => {
    db.exec('DELETE FROM push_subscriptions');
    const tz = 'Europe/Berlin';
    const { createCtx } = require('../db');
    const add = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    // a release day 10–16 days ahead whose Monday is still in the future (the radar shows upcoming volumes)
    let release = add(today, 10);
    while (new Date(`${release}T12:00:00Z`).getUTCDay() !== 3) release = add(release, 1); // a Wednesday
    const monday = add(release, -2);
    const atDay = (day, hour) => {
        const probe = new Date(`${day}T${String(hour).padStart(2, '0')}:30:00Z`);
        const offset = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(probe)) - hour;
        return new Date(probe.getTime() - offset * 3600 * 1000);
    };
    const series = (await admin('POST', '/mangas', { title: 'Modusreihe' })).body.id;
    assert.equal((await admin('POST', '/volumes', { manga_id: series, volume_number: '2', status: 'Vorbestellt', release_date: release })).status, 200);
    const owned = (await admin('POST', '/volumes', { manga_id: series, volume_number: '1', status: 'Vorhanden' })).body.id;
    // lent 90 days (the default loan period) before the release day: overdue from that day on
    db.prepare("UPDATE volume_copies SET lent_to_name = 'Oma', lent_at = ? WHERE volume_id = ?").run(add(release, -90), owned);

    const eve = browser('https://fcm.googleapis.com/fcm/send/eve');
    const week = browser('https://fcm.googleapis.com/fcm/send/week');
    const day = browser('https://fcm.googleapis.com/fcm/send/day');
    const loansOnly = browser('https://fcm.googleapis.com/fcm/send/loans');
    assert.equal((await admin('PUT', '/push/subscriptions', { ...eve.json, mode: 'eve', loans: false })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...week.json, mode: 'week' })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...day.json, loans: false })).status, 200);
    assert.equal((await admin('PUT', '/push/subscriptions', { ...loansOnly.json, volumes: false, episodes: false })).status, 200);

    let sent = [];
    const fetchImpl = async (url, init) => { sent.push({ url, body: init.body }); return new Response(null, { status: 201 }); };
    const runAt = async (d) => {
        sent = [];
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(push.DAY_KEY);
        await push.runPushRemindersIfDue({ db, createCtx, now: atDay(d, 10), timeZone: tz, fetchImpl });
        const got = {};
        for (const [name, b] of Object.entries({ eve, week, day, loansOnly })) {
            const hit = sent.find(s => s.url.endsWith(`/${name === 'loansOnly' ? 'loans' : name}`));
            if (hit) got[name] = JSON.parse(decrypt(b, hit.body));
        }
        return got;
    };

    let got = await runAt(monday);
    assert.deepEqual(Object.keys(got), ['week'], 'Monday: only the weekly one');
    assert.equal(got.week.title, 'Diese Woche');
    assert.equal(got.week.body, 'Mi Modusreihe – Band 2');

    got = await runAt(add(release, -1));
    assert.deepEqual(Object.keys(got), ['eve'], 'the day before: only the evening one; the weekly one waits for next Monday');
    assert.equal(got.eve.title, 'Morgen erscheint');
    assert.equal(got.eve.body, 'Modusreihe – Band 2');

    got = await runAt(release);
    assert.deepEqual(Object.keys(got).sort(), ['day', 'loansOnly']);
    assert.equal(got.day.title, 'Heute neu erschienen');
    assert.equal(got.day.body, 'Modusreihe – Band 2');
    assert.equal(got.loansOnly.title, 'Ausleihe überfällig');
    assert.equal(got.loansOnly.body, 'Modusreihe Band 1 – seit 90 Tagen bei Oma');

    got = await runAt(add(release, 1));
    assert.deepEqual(got, {}, 'an overdue lending is reported once, not every day');

    got = await runAt(add(monday, 7));
    assert.deepEqual(Object.keys(got), ['week'], 'next Monday: the weekly one again');
    assert.equal(got.week.title, 'Ausleihe überfällig');
    assert.equal(got.week.body, 'Modusreihe Band 1 – seit 95 Tagen bei Oma', 'weekly lists every overdue lending');
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

test('an episode that aired before the reminder hour still counts (anime_airings), without doubles', async () => {
    const tz = 'Europe/Berlin';
    const { createCtx } = require('../db');
    const me = db.prepare("SELECT id, username, role FROM users WHERE username = 'admin'").get();
    const day = '2031-03-12';
    // 03:00 Berlin (CET, UTC+1): aired and moved to anime_airings by the refresh before the 9:00 reminder
    const early = Math.floor(Date.parse(`${day}T02:00:00Z`) / 1000);
    const late = Math.floor(Date.parse(`${day}T17:00:00Z`) / 1000);
    const nextWeek = Math.floor(Date.parse('2031-03-19T02:00:00Z') / 1000);
    const yesterday = Math.floor(Date.parse('2031-03-11T02:00:00Z') / 1000);
    const a = db.prepare("INSERT INTO animes (title, next_airing_episode, next_airing_at) VALUES ('Fruehaus', 4, ?)").run(nextWeek).lastInsertRowid;
    const b = db.prepare("INSERT INTO animes (title, next_airing_episode, next_airing_at) VALUES ('Abendserie', 9, ?)").run(late).lastInsertRowid;
    const c = db.prepare("INSERT INTO animes (title) VALUES ('Nicht verfolgt')").run().lastInsertRowid;
    db.prepare('INSERT INTO anime_airings (anime_id, episode, at) VALUES (?, 2, ?), (?, 3, ?), (?, 9, ?), (?, 1, ?)').run(a, yesterday, a, early, b, late, c, early);
    for (const id of [a, b]) db.prepare("INSERT INTO anime_progress (anime_id, user_id, status) VALUES (?, ?, 'Schaue')").run(id, me.id);
    const actx = createCtx({ user: me });
    actx.config.appTimeZone = tz;
    const { episodes } = push.releasesBetween(actx, day, day);
    assert.deepEqual(episodes.map(e => `${e.title} ${e.episode}`), ['Fruehaus 3', 'Abendserie 9']);
});

test('a browser switched on after today\'s run still gets today\'s reminder; demoted accounts get none and can still switch off', async () => {
    db.exec('DELETE FROM push_subscriptions');
    const tz = 'Europe/Berlin';
    const now = new Date();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const series = (await admin('POST', '/mangas', { title: 'Spätreihe' })).body.id;
    assert.equal((await admin('POST', '/volumes', { manga_id: series, volume_number: '2', status: 'Vorbestellt', release_date: day })).status, 200);
    const { createCtx } = require('../db');
    const at = (hour) => {
        const probe = new Date(`${day}T${String(hour).padStart(2, '0')}:30:00Z`);
        const offset = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(probe)) - hour;
        return new Date(probe.getTime() - offset * 3600 * 1000);
    };
    const sent = [];
    const fetchImpl = async (url) => { sent.push(String(url)); return new Response(null, { status: 201 }); };
    const run = (hour) => push.runPushRemindersIfDue({ db, createCtx, now: at(hour), timeZone: tz, fetchImpl });

    const first = browser('https://fcm.googleapis.com/fcm/send/first');
    assert.equal((await admin('PUT', '/push/subscriptions', first.json)).status, 200);
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(push.DAY_KEY);
    assert.deepEqual(await run(9), { sent: 1, gone: 0, skipped: 0 });
    assert.equal(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(push.DAY_KEY).value, day, 'the day is done');

    // switched on at noon for 12:00: the next hourly check sends it the same day
    const later = browser('https://fcm.googleapis.com/fcm/send/later');
    assert.equal((await admin('PUT', '/push/subscriptions', { ...later.json, hour: 12 })).status, 200);
    assert.deepEqual(await run(13), { sent: 1, gone: 0, skipped: 0 });
    assert.equal(sent.filter((u) => u.includes('later')).length, 1);
    assert.equal(sent.filter((u) => u.includes('first')).length, 1, 'the 9:00 browser only once');

    // an editor demoted to guest: no reminder, and the day is not kept open for them
    assert.equal((await admin('POST', '/users', { username: 'herab', password: 'password123', role: 'editor' })).status, 200);
    const demoted = ctx.client();
    assert.equal((await demoted('POST', '/auth/login', { username: 'herab', password: 'password123' })).status, 200);
    const theirs = browser('https://fcm.googleapis.com/fcm/send/demoted');
    assert.equal((await demoted('PUT', '/push/subscriptions', theirs.json)).status, 200);
    db.prepare("UPDATE users SET role = 'guest' WHERE username = 'herab'").run();
    assert.equal(await run(14), null, 'nothing due for admins and editors');
    assert.equal(sent.some((u) => u.includes('demoted')), false);
    // the guest still sees and ends the subscription (switch, logout)
    assert.deepEqual((await demoted('POST', '/push/subscriptions/status', { endpoint: theirs.json.endpoint })).body.subscribed, true);
    assert.deepEqual((await demoted('DELETE', '/push/subscriptions', { endpoint: theirs.json.endpoint })).body, { success: true, removed: 1 });
    assert.equal((await demoted('PUT', '/push/subscriptions', theirs.json)).status, 403, 'switching on stays for editors');
});
