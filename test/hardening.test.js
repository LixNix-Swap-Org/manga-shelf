const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('./helpers');
const { parseTrustProxy } = require('../utils/trustProxy');

let ctx;
let admin;
let editor;
let editorId;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    editor = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    const created = await admin('POST', '/users', { username: 'ed', password: 'password123', role: 'editor' });
    editorId = created.body.user.id;
    assert.equal((await editor('POST', '/auth/login', { username: 'ed', password: 'password123' })).status, 200);
});

test.after(async () => { await ctx.close(); });

test('a user who created or edited a series can still be deleted', async () => {
    const manga = await editor('POST', '/mangas', { title: 'Von Editor' });
    assert.equal(manga.status, 200);
    const del = await admin('DELETE', '/users/' + editorId);
    assert.equal(del.status, 200);
    const detail = await admin('GET', '/mangas/' + manga.body.id);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.updated_by, null);
});

test('unknown roles are rejected instead of becoming editor', async () => {
    assert.equal((await admin('POST', '/users', { username: 'typo', password: 'password123', role: 'viewer' })).status, 400);
    const ok = await admin('POST', '/users', { username: 'v1', password: 'password123', role: 'visitor' });
    assert.equal(ok.status, 200);
    assert.equal((await admin('PUT', '/users/' + ok.body.user.id, { role: 'viewer' })).status, 400);
    assert.equal((await admin('PUT', '/users/' + ok.body.user.id, { role: 'editor' })).status, 200);
});

test('login: repeated failures lock the username even when the client IP changes', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
        const r = await ctx.client()('POST', '/auth/login', { username: 'Admin', password: 'wrongwrong' }, { 'X-Forwarded-For': `10.1.0.${i}` });
        statuses.push(r.status);
    }
    assert.equal(statuses[0], 401);
    assert.equal(statuses[11], 429);
    // even the right password is refused while locked
    assert.equal((await ctx.client()('POST', '/auth/login', { username: 'admin', password: 'password123' }, { 'X-Forwarded-For': '10.1.9.9' })).status, 429);
});

test('volumes: status is validated, renumbering to an existing number is a 409, read flags parse strings', async () => {
    const manga = (await admin('POST', '/mangas', { title: 'Validierung' })).body.id;
    const v1 = (await admin('POST', '/volumes', { manga_id: manga, volume_number: '1' })).body.id;
    const v2 = (await admin('POST', '/volumes', { manga_id: manga, volume_number: '2' })).body.id;
    assert.equal((await admin('POST', '/volumes', { manga_id: manga, volume_number: '3', status: 'Quatsch' })).status, 400);
    assert.equal((await admin('PUT', '/volumes/' + v2, { status: 'Quatsch' })).status, 400);
    assert.equal((await admin('PUT', '/volumes/' + v2, { volume_number: '1' })).status, 409);
    assert.equal((await admin('PUT', '/volumes/' + v2, { volume_number: '1', type: 'special_edition' })).status, 200);

    assert.equal((await admin('POST', '/volumes/batch-read', { manga_id: manga, up_to_volume: 2 })).body.count, 2);
    await admin('POST', '/volumes/batch-read', { manga_id: manga, up_to_volume: 2, read: 'false' });
    const detail = await admin('GET', '/mangas/' + manga);
    assert.equal(detail.body.volumes.filter(v => v.is_read).length, 0);
    assert.equal((await admin('POST', `/volumes/${v1}/read`, { user_id: 9999 })).status, 404);
});

test('manga update rejects a non-string title instead of crashing', async () => {
    const id = (await admin('POST', '/mangas', { title: 'Titel' })).body.id;
    assert.equal((await admin('PUT', '/mangas/' + id, { title: 123 })).status, 400);
    assert.equal((await admin('PUT', '/mangas/' + id, { title: 'x'.repeat(301) })).status, 400);
    assert.equal((await admin('PUT', '/mangas/' + id, { title: 'Neu' })).status, 200);
});

test('TRUST_PROXY values map to Express settings (unset keeps the old default)', () => {
    assert.equal(parseTrustProxy(undefined), true);
    assert.equal(parseTrustProxy(''), true);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
});

test('a password reset ends older sessions of that user, a new login works', async () => {
    const created = await admin('POST', '/users', { username: 'reset-me', password: 'password123', role: 'editor' });
    const session = ctx.client();
    assert.equal((await session('POST', '/auth/login', { username: 'reset-me', password: 'password123' })).status, 200);
    assert.equal((await session('GET', '/auth/me')).status, 200);

    await new Promise(resolve => setTimeout(resolve, 1100)); // JWT iat has second resolution
    assert.equal((await admin('PUT', '/users/' + created.body.user.id, { password: 'newpassword123' })).status, 200);

    assert.equal((await session('GET', '/auth/me')).status, 401);
    const fresh = ctx.client();
    assert.equal((await fresh('POST', '/auth/login', { username: 'reset-me', password: 'newpassword123' })).status, 200);
    assert.equal((await fresh('GET', '/auth/me')).status, 200);
});

test('responses carry hardening headers and no blanket CORS', async () => {
    const res = await fetch(ctx.base + '/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('server snapshots use a consistent database copy and leave no temp files behind', async () => {
    const fs = require('fs');
    const path = require('path');
    const AdmZip = require('adm-zip');
    const snap = await admin('POST', '/backups/create');
    assert.equal(snap.status, 200);
    const file = path.join(ctx.dataDir, 'backups', snap.body.snapshot.filename);
    assert.ok(new AdmZip(file).getEntry('manga.db'), 'manga.db is in the snapshot');
    assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'temp')).filter(f => f.startsWith('backup-db-')), []);
});

test('own password: needs the current one, ends other sessions, keeps the current one', async () => {
    const created = await admin('POST', '/users', { username: 'self-change', password: 'password123', role: 'visitor' });
    assert.equal(created.status, 200);
    const phone = ctx.client();
    const laptop = ctx.client();
    assert.equal((await phone('POST', '/auth/login', { username: 'self-change', password: 'password123' })).status, 200);
    assert.equal((await laptop('POST', '/auth/login', { username: 'self-change', password: 'password123' })).status, 200);

    assert.equal((await laptop('PUT', '/auth/password', { current_password: 'falsch-falsch', new_password: 'brandnew123' })).status, 403);
    assert.equal((await laptop('PUT', '/auth/password', { current_password: 'password123', new_password: 'short' })).status, 400);

    await new Promise(resolve => setTimeout(resolve, 1100)); // JWT iat has second resolution
    assert.equal((await laptop('PUT', '/auth/password', { current_password: 'password123', new_password: 'brandnew123' })).status, 200);
    assert.equal((await laptop('GET', '/auth/me')).status, 200);
    assert.equal((await phone('GET', '/auth/me')).status, 401);
    assert.equal((await ctx.client()('POST', '/auth/login', { username: 'self-change', password: 'brandnew123' })).status, 200);
});

test('usernames are unique and log in regardless of case', async () => {
    assert.equal((await admin('POST', '/users', { username: 'CaseUser', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'caseuser', password: 'password123' })).status, 400);
    assert.equal((await ctx.client()('POST', '/auth/login', { username: 'CASEUSER', password: 'password123' })).status, 200);
});

test('responses carry a Content-Security-Policy without inline scripts', async () => {
    const res = await fetch(ctx.base.replace(/\/api$/, '') + '/api/health');
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
});
