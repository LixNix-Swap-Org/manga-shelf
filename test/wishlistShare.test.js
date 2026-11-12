// "Wunschliste teilen" (migration 58): a read-only link to the own wishlist for people without an account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');

let ctx;
let admin;
let lena;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    lena = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'Lena', password: 'password123', role: 'editor' })).status, 200);
    assert.equal((await lena('POST', '/auth/login', { username: 'Lena', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

const page = (token) => fetch(`${ctx.base}/wishlist/shared?token=${encodeURIComponent(token)}`);
const tokenOf = (state) => new URL(state.url).searchParams.get('token');

test('the link shows only the own wishes, read-only, without a session', async () => {
    const wish = async (client, title, priority, extra = {}) => {
        const { id } = (await client('POST', '/mangas', { title, publisher: 'Carlsen', ...extra })).body;
        assert.equal((await client('PUT', `/mangas/${id}/wish`, { priority })).status, 200);
        return id;
    };
    const mine = await wish(lena, 'Frieren <Sonderband>', 3);
    await lena('POST', '/volumes', { manga_id: mine, volume_number: '1', status: 'Fehlt', price: 7 });
    await wish(admin, 'Nur Admin wünscht', 2);
    const owned = await wish(lena, 'Schon gekauft', 1);
    await lena('POST', '/volumes', { manga_id: owned, volume_number: '1', status: 'Vorhanden' });

    assert.equal((await lena('GET', '/wishlist/share-token')).body.active, false);
    const made = await lena('POST', '/wishlist/share-token');
    assert.equal(made.status, 200);
    assert.match(made.body.path, /^\/api\/wishlist\/shared\?token=[A-Za-z0-9_-]{43}$/);

    const res = await page(tokenOf(made.body));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = await res.text();
    assert.match(text, /Wunschliste von Lena/);
    assert.match(text, /Frieren &lt;Sonderband&gt;/, 'titles are escaped');
    assert.match(text, /★★★ hoch/);
    assert.match(text, /1 Band bekannt/);
    assert.ok(!text.includes('Nur Admin wünscht'), 'other people\'s wishes stay out');
    assert.ok(!text.includes('Schon gekauft'), 'a series with an owned volume is no wish');
    assert.ok(!/7[,.]00/.test(text), 'no prices');
});

test('a wrong token, a calendar token, a renewed or revoked link answer 404', async () => {
    assert.equal((await page('x'.repeat(43))).status, 404);
    const radar = await lena('POST', '/radar/feed-token');
    assert.equal((await page(tokenOf(radar.body))).status, 404, 'a calendar token opens only its calendar');

    const first = tokenOf((await lena('GET', '/wishlist/share-token')).body);
    const renewed = tokenOf((await lena('POST', '/wishlist/share-token')).body);
    assert.equal((await page(first)).status, 404);
    const notFound = await page(first);
    assert.match(await notFound.text(), /Wunschliste nicht gefunden/);
    assert.equal((await page(renewed)).status, 200);

    assert.equal((await lena('DELETE', '/wishlist/share-token')).status, 200);
    assert.equal((await page(renewed)).status, 404);
});

test('a password change ends the link, like a calendar address', async () => {
    const made = await lena('POST', '/wishlist/share-token');
    assert.equal((await page(tokenOf(made.body))).status, 200);
    assert.equal((await lena('PUT', '/auth/password', { current_password: 'password123', new_password: 'password1234' })).status, 200);
    assert.equal((await page(tokenOf(made.body))).status, 404);
});
