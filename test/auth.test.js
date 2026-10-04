const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { startTestServer } = require('./helpers');
const { resetRateLimits } = require('../middleware/rateLimit');
const pkg = require('../package.json');

let ctx;
let admin;
const ids = {};

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
});

test.after(async () => { await ctx.close(); });
test.beforeEach(() => resetRateLimits());

const loggedIn = async (username, password = 'password123') => {
    const client = ctx.client();
    assert.equal((await client('POST', '/auth/login', { username, password })).status, 200, username);
    return client;
};
const createUser = async (username, role) => {
    const res = await admin('POST', '/users', { username, password: 'password123', role });
    assert.equal(res.status, 200, username);
    ids[username] = res.body.user.id;
    return res.body.user.id;
};

test('setup needs the first-run code: generated and printed when SETUP_TOKEN is unset, compared loosely', async () => {
    const auth = require('../routes/auth');
    const anon = ctx.client();
    const configured = process.env.SETUP_TOKEN;
    delete process.env.SETUP_TOKEN;
    try {
        const notice = auth.setupNotice();
        const code = /Einrichtungscode für das erste Admin-Konto: ([A-Z2-9]{4}(?:-[A-Z2-9]{4}){3})$/.exec(notice)?.[1];
        assert.ok(code, notice);
        assert.equal(auth.setupNotice(), notice, 'the code stays the same until an admin exists');
        const body = (setupToken) => ({ username: 'admin', password: 'password123', setup_token: setupToken });
        for (const wrong of [undefined, '', 'test-setup-token', code.slice(0, -1), 12345]) {
            const res = await anon('POST', '/setup', body(wrong));
            assert.equal(res.status, 403, String(wrong));
            assert.equal(res.body.code, 'SETUP_TOKEN_INVALID');
            assert.match(res.body.error, /Einrichtungscode/);
        }
        assert.equal((await anon('GET', '/setup/status')).body.needsSetup, true);
        assert.equal(auth.setupTokenMatches(` ${code.toLowerCase().replace(/-/g, ' ')} `), true);
    } finally {
        process.env.SETUP_TOKEN = configured;
    }
    assert.match(auth.setupNotice(), /SETUP_TOKEN/);
    assert.equal(auth.setupTokenMatches('TEST-SETUP-TOKEN'), true);
    assert.equal((await anon('POST', '/setup', { username: 'admin', password: 'password123', setup_token: 'nope' })).status, 403);
});

test('SETUP_TOKEN: too short or only separators falls back to the generated code; empty candidates never match', () => {
    const auth = require('../routes/auth');
    const configured = process.env.SETUP_TOKEN;
    try {
        for (const weak of ['--', ' - - ', 'abc', 'short-token']) {
            process.env.SETUP_TOKEN = weak;
            const code = /Einrichtungscode für das erste Admin-Konto: (\S+)$/.exec(auth.setupNotice())?.[1];
            assert.ok(code, `generated code expected for ${JSON.stringify(weak)}`);
            for (const candidate of ['-', ' - ', '', '  ', weak]) {
                assert.equal(auth.setupTokenMatches(candidate), false, `${JSON.stringify(weak)} / ${JSON.stringify(candidate)}`);
            }
            assert.equal(auth.setupTokenMatches(code), true);
        }
        process.env.SETUP_TOKEN = ' abcd-efgh ijkl ';
        assert.equal(auth.setupTokenMatches('ABCDEFGHIJKL'), true);
        assert.equal(auth.setupTokenMatches('abcd efgh-ijk'), false);
    } finally {
        process.env.SETUP_TOKEN = configured;
    }
});

test('setup status and version before and after the first admin', async () => {
    const anon = ctx.client();
    const before = await anon('GET', '/setup/status');
    assert.equal(before.status, 200);
    assert.equal(before.body.needsSetup, true);
    assert.equal(before.body.version, pkg.version);
    assert.equal((await anon('GET', '/version')).body.version, pkg.version);

    const setup = await admin('POST', '/setup', { username: 'admin', password: 'password123' }, { 'X-Client': 'app' });
    assert.equal(setup.status, 200);
    ids.admin = setup.body.user.id;
    assert.equal(setup.body.token, admin.cookie.slice('token='.length), 'an app client gets the session token in the body');
    assert.equal((await anon('GET', '/setup/status')).body.needsSetup, false);
    assert.equal(require('../routes/auth').setupNotice(), null);

    const again = await anon('POST', '/setup', { username: 'late', password: 'password123' });
    assert.equal(again.status, 400);
    assert.equal(again.body.code, 'ADMIN_EXISTS');
    assert.match(again.body.error, /bereits einen Administrator/);

    await createUser('ed', 'editor');
    await createUser('vis', 'visitor');
    await createUser('gast', 'guest');
});

test('auth and permission errors are German and carry a code', async () => {
    const anon = ctx.client();
    const none = await anon('GET', '/mangas');
    assert.deepEqual([none.status, none.body.code, none.body.error], [401, 'AUTH_REQUIRED', 'Nicht angemeldet']);
    const bogus = await ctx.client('token=abc')('GET', '/mangas');
    assert.deepEqual([bogus.status, bogus.body.code], [401, 'SESSION_INVALID']);
    assert.match(bogus.body.error, /bitte neu anmelden/);
    const editor = await loggedIn('ed');
    const forbidden = await editor('GET', '/users');
    assert.deepEqual([forbidden.status, forbidden.body.code], [403, 'FORBIDDEN']);
    assert.match(forbidden.body.error, /Keine Berechtigung/);
    const visitor = await loggedIn('vis');
    const readOnly = await visitor('POST', '/mangas', { title: 'X' });
    assert.deepEqual([readOnly.status, readOnly.body.code], [403, 'READ_ONLY']);
});

test('the last admin can be neither demoted nor deleted; with two admins both work', async () => {
    const demote = await admin('PUT', '/users/' + ids.admin, { role: 'editor' });
    assert.equal(demote.status, 400);
    assert.equal((await admin('GET', '/auth/me')).body.user.role, 'admin');
    assert.equal((await admin('DELETE', '/users/' + ids.admin)).status, 400);

    const second = await createUser('second-admin', 'admin');
    assert.equal((await admin('PUT', '/users/' + second, { role: 'editor' })).status, 200);
    assert.equal((await admin('PUT', '/users/' + second, { role: 'admin' })).status, 200);
    assert.equal((await admin('DELETE', '/users/' + second)).status, 200);
});

test('two admins demoting each other at the same time leave one admin and keep setup closed', async () => {
    const bobId = await createUser('bob', 'admin');
    const bob = await loggedIn('bob');
    // a slow hash keeps both requests in flight between their checks and their writes
    const hash = bcrypt.hash;
    bcrypt.hash = async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return hash(...args);
    };
    let results;
    try {
        results = await Promise.all([
            admin('PUT', '/users/' + bobId, { role: 'editor', password: 'newpassword1' }),
            bob('PUT', '/users/' + ids.admin, { role: 'editor', password: 'newpassword2' })
        ]);
    } finally {
        bcrypt.hash = hash;
    }
    const statuses = results.map(r => r.status);
    assert.equal(statuses.filter(s => s === 200).length, 1, String(statuses));
    assert.ok(statuses.some(s => s === 400 || s === 403), String(statuses));
    assert.equal((await ctx.client()('GET', '/setup/status')).body.needsSetup, false);

    // put things back for the following tests
    if (results[0].status === 200) {
        assert.equal((await admin('PUT', '/users/' + bobId, { role: 'admin' })).status, 200);
    } else {
        assert.equal((await bob('PUT', '/users/' + ids.admin, { role: 'admin', password: 'password123' })).status, 200);
        admin = await loggedIn('admin');
    }
    const roles = (await admin('GET', '/users')).body.filter(u => u.role === 'admin').map(u => u.username).sort();
    assert.deepEqual(roles, ['admin', 'bob']);
});

test('parallel creates of the same name (any case) give one user and a 400, never a 500', async () => {
    const mixed = await Promise.all([
        admin('POST', '/users', { username: 'Race', password: 'password123' }),
        admin('POST', '/users', { username: 'race', password: 'password123' })
    ]);
    assert.deepEqual(mixed.map(r => r.status).sort(), [200, 400]);
    const same = await Promise.all([
        admin('POST', '/users', { username: 'dup', password: 'password123' }),
        admin('POST', '/users', { username: 'dup', password: 'password123' })
    ]);
    assert.deepEqual(same.map(r => r.status).sort(), [200, 400]);
    const users = (await admin('GET', '/users')).body.map(u => u.username.toLowerCase());
    assert.equal(users.filter(u => u === 'race').length, 1);
    assert.equal(users.filter(u => u === 'dup').length, 1);
});

test('logout clears the cookie and ends the token, also for a copy of it', async () => {
    const res = await fetch(ctx.base + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ed', password: 'password123' })
    });
    const token = res.headers.get('set-cookie').split(';')[0].slice('token='.length);
    const session = ctx.client('token=' + token);
    assert.equal((await session('GET', '/auth/me')).status, 200);

    const out = await fetch(ctx.base + '/auth/logout', { method: 'POST', headers: { Cookie: 'token=' + token } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /^token=;.*Expires=Thu, 01 Jan 1970/);

    assert.equal((await ctx.client('token=' + token)('GET', '/auth/me')).status, 401);
    assert.equal((await ctx.client()('GET', '/auth/me', undefined, { Authorization: 'Bearer ' + token })).status, 401);
    // a new login right away (same second) works, and logout without a session still answers 200
    const again = await loggedIn('ed');
    assert.equal((await again('GET', '/auth/me')).status, 200);
    assert.equal((await ctx.client()('POST', '/auth/logout')).status, 200);
});

test('per-user reading stats: shape, 404, owned volumes only, distinct editions and UTC times', async () => {
    assert.equal((await admin('GET', '/users/987654/stats')).status, 404);
    assert.equal((await admin('GET', '/users/abc/stats')).status, 404);

    const reader = await loggedIn('ed');
    const manga = (await admin('POST', '/mangas', { title: 'Lese Reihe' })).body.id;
    const regular = (await admin('POST', '/volumes', { manga_id: manga, volume_number: '1', status: 'Vorhanden' })).body.id;
    const special = (await admin('POST', '/volumes', { manga_id: manga, volume_number: '1', type: 'special_edition', status: 'Vorhanden' })).body.id;
    const missing = (await admin('POST', '/volumes', { manga_id: manga, volume_number: '2', status: 'Fehlt' })).body.id;
    for (const id of [regular, special, missing]) {
        assert.equal((await reader('POST', `/volumes/${id}/read`, { read: true })).status, 200);
    }

    const res = await reader('GET', `/users/${ids.ed}/stats`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user, { id: ids.ed, username: 'ed' });
    const { stats } = res.body;
    const overview = (await admin('GET', '/stats')).body;
    const readerRow = (overview.user_reading_stats || overview.userReadingStats).find(u => u.user_id === ids.ed);
    assert.equal(stats.totalVolumes, readerRow.read_count);
    assert.equal(stats.totalVolumes, 2);
    assert.ok(stats.recentVolumes.length <= 10);
    const series = stats.readMangas.find(m => m.id === manga);
    assert.deepEqual(series.volumes.map(v => v.id).sort(), [regular, special].sort());
    assert.deepEqual(series.volumes.map(v => v.type).sort(), ['special_edition', 'volume']);
    for (const v of series.volumes) {
        assert.match(v.read_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        assert.ok(Math.abs(Date.parse(v.read_at) - Date.now()) < 5 * 60 * 1000);
    }
});

test('the signing key lives in DATA_DIR/secret.key, never in the database', () => {
    const file = path.join(ctx.dataDir, 'secret.key');
    assert.equal(fs.readFileSync(file, 'utf8').trim(), require('../middleware/auth').JWT_SECRET);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(require('../db').db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get(), undefined);
});

test('tokens without a session version or with an iat in the future are refused', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    const claims = { id: ids.admin, username: 'admin', role: 'admin' };
    const forever = jwt.sign({ ...claims, iat: 4102444800 }, JWT_SECRET);
    const noPv = jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });
    for (const token of [forever, noPv]) {
        const res = await ctx.client('token=' + token)('GET', '/auth/me');
        assert.deepEqual([res.status, res.body.code], [401, 'SESSION_INVALID']);
    }
});

function protectedRoutes() {
    const routesDir = path.join(__dirname, '..', 'routes');
    const found = [];
    for (const file of fs.readdirSync(routesDir).filter(f => f.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
        const re = /router\.(get|post|put|delete|patch)\(\s*'([^']+)'\s*,\s*(requireEditor|requireAdmin)\b/g;
        let m;
        while ((m = re.exec(source))) {
            found.push({ method: m[1].toUpperCase(), path: m[2].replace(/:[A-Za-z_]+/g, '1'), guard: m[3] });
        }
    }
    // the endpoints of core/routes.js, mounted with the same guards by routes/core.js
    const guards = { editor: 'requireEditor', admin: 'requireAdmin' };
    for (const row of require('../core/routes').routes.filter(r => guards[r.role])) {
        found.push({ method: row.method, path: row.path.replace(/:[A-Za-z_]+/g, '1'), guard: guards[row.role] });
    }
    return found;
}

test('role matrix: visitors and guests get 403 on every write route, editors on every admin route', async () => {
    const routes = protectedRoutes();
    assert.ok(routes.length >= 30, `found only ${routes.length} protected routes`);
    const clients = { vis: await loggedIn('vis'), gast: await loggedIn('gast'), ed: await loggedIn('ed') };
    for (const { method, path: url, guard } of routes) {
        for (const name of ['vis', 'gast', 'ed']) {
            if (name === 'ed' && guard !== 'requireAdmin') continue;
            const res = await clients[name](method, url, method === 'GET' ? undefined : {});
            assert.equal(res.status, 403, `${name} ${method} ${url}`);
        }
    }
});

test('connect-info: editors get the address, name, instance id and the app link; visitors and guests do not', async () => {
    const ed = await loggedIn('ed');
    const res = await ed('GET', '/auth/connect-info', undefined, { 'X-Forwarded-Proto': 'https' });
    assert.equal(res.status, 200);
    const host = new URL(ctx.base).host;
    const health = await (await fetch(ctx.base + '/health')).json();
    assert.equal(res.body.url, `https://${host}`);
    assert.equal(res.body.name, 'Manga Shelf');
    assert.equal(res.body.instance_id, health.instance_id);
    const link = new URL(res.body.link);
    assert.equal(link.protocol, 'manga-shelf:');
    assert.equal(link.searchParams.get('url'), `https://${host}`);
    assert.equal(link.searchParams.get('name'), 'Manga Shelf');
    assert.equal(link.searchParams.get('id'), health.instance_id);
    const raw = await fetch(ctx.base + '/auth/connect-info', { headers: { Cookie: ed.cookie } });
    assert.equal(raw.headers.get('cache-control'), 'no-store');

    assert.equal((await ctx.client()('GET', '/auth/connect-info')).status, 401);
    assert.equal((await (await loggedIn('vis'))('GET', '/auth/connect-info')).status, 403);
    assert.equal((await (await loggedIn('gast'))('GET', '/auth/connect-info')).status, 403);
    assert.equal((await admin('GET', '/auth/connect-info')).status, 200);
});

const jsonPost = (url, body, headers = {}) => fetch(ctx.base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
});
// a fresh client per request: the cookie a response sets must not ride along
const withBearer = (token) => (method, url, body, headers = {}) => ctx.client()(method, url, body, { Authorization: 'Bearer ' + token, ...headers });
const appLogin = async (username, password = 'password123') => {
    const res = await jsonPost('/auth/login', { username, password }, { 'X-Client': 'app' });
    assert.equal(res.status, 200);
    return (await res.json()).token;
};

test('app login: X-Client: app or client: app add the token, other clients get the unchanged body', async () => {
    const plain = await jsonPost('/auth/login', { username: 'ed', password: 'password123' });
    assert.deepEqual(Object.keys(await plain.json()).sort(), ['success', 'user']);

    for (const [headers, body] of [[{ 'X-Client': 'app' }, {}], [{ 'X-Client': ' App ' }, {}], [{}, { client: 'app' }]]) {
        const res = await jsonPost('/auth/login', { username: 'ed', password: 'password123', ...body }, headers);
        assert.equal(res.status, 200);
        const json = await res.json();
        assert.deepEqual(json.user, { id: ids.ed, username: 'ed', role: 'editor' });
        assert.match(json.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
        assert.equal(res.headers.get('set-cookie').split(';')[0], 'token=' + json.token, 'the cookie carries the same token');
    }
    const wrong = await jsonPost('/auth/login', { username: 'ed', password: 'wrong-password' }, { 'X-Client': 'app' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).token, undefined);
});

test('bearer: an Authorization header authenticates reads and writes like the cookie', async () => {
    const token = await appLogin('ed');
    const app = withBearer(token);
    assert.deepEqual((await app('GET', '/auth/me')).body.user, { id: ids.ed, username: 'ed', role: 'editor' });
    const created = await app('POST', '/mangas', { title: 'Bearer Reihe' });
    assert.equal(created.status, 200);
    assert.equal((await withBearer(await appLogin('vis'))('POST', '/mangas', { title: 'X' })).body.code, 'READ_ONLY');
    assert.equal((await withBearer(token)('GET', '/users')).body.code, 'FORBIDDEN');

    for (const header of ['Basic ' + Buffer.from('ed:password123').toString('base64'), token, 'Bearer', 'Bearer not-a-jwt', `Bearer ${token} extra`]) {
        const res = await ctx.client()('GET', '/auth/me', undefined, { Authorization: header });
        assert.deepEqual([res.status, res.body.code], [401, 'AUTH_REQUIRED'], header);
    }
    const lower = await ctx.client()('GET', '/auth/me', undefined, { Authorization: 'bearer ' + token });
    assert.equal(lower.status, 200, 'the scheme is case-insensitive');
});

test('bearer: the cookie wins when both are sent', async () => {
    const token = await appLogin('ed');
    const res = await ctx.client('token=abc')('GET', '/auth/me', undefined, { Authorization: 'Bearer ' + token });
    assert.deepEqual([res.status, res.body.code], [401, 'SESSION_INVALID']);
    const vis = await loggedIn('vis');
    const both = await vis('GET', '/auth/me', undefined, { Authorization: 'Bearer ' + token });
    assert.equal(both.body.user.username, 'vis');
});

test('bearer: expired, foreign, future and stale tokens are refused', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    const user = require('../db').db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(ids.ed);
    const claims = { id: ids.ed, username: 'ed', role: 'editor', pv: user.password_changed_at || 0 };
    const now = Math.floor(Date.now() / 1000);
    const valid = jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });
    assert.equal((await withBearer(valid)('GET', '/auth/me')).status, 200, 'the hand-made token is otherwise valid');
    const tokens = {
        expired: jwt.sign({ ...claims, iat: now - 7200, exp: now - 60 }, JWT_SECRET),
        foreign: jwt.sign(claims, 'x'.repeat(48), { expiresIn: '1h' }),
        future: jwt.sign({ ...claims, iat: now + 3600 }, JWT_SECRET, { expiresIn: '2h' }),
        stalePv: jwt.sign({ ...claims, pv: claims.pv + 1 }, JWT_SECRET, { expiresIn: '1h' }),
        otherName: jwt.sign({ ...claims, username: 'vis' }, JWT_SECRET, { expiresIn: '1h' })
    };
    for (const [name, token] of Object.entries(tokens)) {
        const res = await withBearer(token)('GET', '/auth/me');
        assert.deepEqual([res.status, res.body.code], [401, 'SESSION_INVALID'], name);
    }
});

test('bearer: logout revokes the token, also a cookie copy of it; a password reset ends it', async () => {
    const token = await appLogin('ed');
    const app = withBearer(token);
    assert.equal((await app('GET', '/auth/me')).status, 200);
    const out = await app('POST', '/auth/logout');
    assert.equal(out.status, 200);
    assert.deepEqual([(await app('GET', '/auth/me')).status, (await ctx.client('token=' + token)('GET', '/auth/me')).status], [401, 401]);

    const other = withBearer(await appLogin('vis'));
    assert.equal((await other('GET', '/auth/me')).status, 200);
    assert.equal((await admin('PUT', '/users/' + ids.vis, { password: 'password123' })).status, 200);
    assert.deepEqual([(await other('GET', '/auth/me')).status], [401]);
});

test('bearer: an own password change answers with the new token; cookie clients get none', async () => {
    const tmpId = await createUser('pwapp', 'editor');
    const app = withBearer(await appLogin('pwapp'));
    const changed = await app('PUT', '/auth/password', { current_password: 'password123', new_password: 'password456' });
    assert.equal(changed.status, 200);
    assert.match(changed.body.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal((await app('GET', '/auth/me')).status, 401, 'the old token ended with the change');
    assert.equal((await withBearer(changed.body.token)('GET', '/auth/me')).body.user.id, tmpId);

    const web = await loggedIn('pwapp', 'password456');
    const viaCookie = await web('PUT', '/auth/password', { current_password: 'password456', new_password: 'password123' });
    assert.deepEqual(Object.keys(viaCookie.body), ['success']);
    assert.equal((await web('GET', '/auth/me')).status, 200);
});

test('bearer: an admin resetting their own password via user management gets the new token', async () => {
    const id = await createUser('selfreset', 'admin');
    const app = withBearer(await appLogin('selfreset'));
    const res = await app('PUT', '/users/' + id, { password: 'password789' });
    assert.equal(res.status, 200);
    assert.equal((await withBearer(res.body.token)('GET', '/auth/me')).body.user.id, id);
    const other = await admin('PUT', '/users/' + id, { password: 'password123' });
    assert.equal(other.body.token, undefined, 'resetting someone else returns no token');
});

// Restores end every session, so these come last.
async function snapshot() {
    const created = await admin('POST', '/backups/create');
    assert.equal(created.status, 200);
    return created.body.snapshot.filename;
}
async function restore(filename) {
    const res = await admin('POST', `/backups/${filename}/restore`);
    assert.equal(res.status, 200);
    // the restoring admin keeps working right away (same second as the restore)
    assert.equal((await admin('GET', '/users')).status, 200);
}

test('restore: a token whose user id now belongs to someone else stops working', async () => {
    const s0 = await snapshot();
    const bossId = await createUser('boss', 'admin');
    const s1 = await snapshot();
    await restore(s0);
    const gastId = await createUser('gast2', 'guest');
    assert.equal(gastId, bossId, 'the id is reused after restoring the older snapshot');
    const gast = await loggedIn('gast2');
    assert.equal((await gast('GET', '/users')).status, 403);

    await restore(s1);
    assert.equal((await gast('GET', '/auth/me')).status, 401);
    assert.equal((await gast('GET', '/users')).status, 401);
});

test('restore: sessions issued before it end even when the username still exists with another role', async () => {
    const alexId = await createUser('alex', 'admin');
    const asAdmin = await snapshot();
    assert.equal((await admin('PUT', '/users/' + alexId, { role: 'guest' })).status, 200);
    const alex = await loggedIn('alex');
    assert.equal((await alex('GET', '/users')).status, 403);
    await restore(asAdmin);
    assert.equal((await alex('GET', '/auth/me')).status, 401);
    assert.equal((await alex('GET', '/users')).status, 401);
    const fresh = await loggedIn('alex');
    assert.equal((await fresh('GET', '/auth/me')).body.user.role, 'admin');
});
