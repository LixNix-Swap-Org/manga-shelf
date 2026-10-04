// Where the JWT secret comes from (env, key file, legacy database row) and how session versions and the logout list survive restarts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-secret-'));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'info';
process.env.LOG_FORMAT = 'text';
delete process.env.JWT_SECRET;

const jwt = require('jsonwebtoken');
const dbm = require('../db');
const { db } = dbm;

const AUTH_PATH = require.resolve('../middleware/auth');
const secretFile = path.join(dataDir, 'secret.key');
const OLD_SECRET = 'a'.repeat(20) + crypto.randomBytes(24).toString('hex');

/** Loads middleware/auth.js afresh (as a process start would) and returns it with the info lines it logged. */
function loadAuth() {
    delete require.cache[AUTH_PATH];
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
        return { auth: require('../middleware/auth'), lines };
    } finally {
        console.log = original;
    }
}

const legacyRow = () => db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get();
const revokedRow = () => db.prepare("SELECT value FROM app_settings WHERE key = 'revoked_sessions'").get();

function callRequireAuth(auth, token) {
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    let passed = false;
    auth.requireAuth({ cookies: { token }, headers: {} }, res, () => { passed = true; });
    return passed ? 200 : status;
}

let userId;

test.before(() => {
    userId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', 'x', 'admin')").run().lastInsertRowid);
});

test.after(() => {
    dbm.closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('upgrade: the secret from the database is not reused, a new one goes into secret.key (0600)', () => {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(OLD_SECRET);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('revoked_sessions', '{}')").run();
    const oldToken = jwt.sign({ id: userId, username: 'admin', role: 'admin', pv: 0 }, OLD_SECRET, { expiresIn: '7d' });

    const { auth, lines } = loadAuth();
    assert.notEqual(auth.JWT_SECRET, OLD_SECRET);
    assert.ok(auth.JWT_SECRET.length >= 32);
    assert.equal(auth.SECRET_FILE, secretFile);
    assert.equal(fs.readFileSync(secretFile, 'utf8').trim(), auth.JWT_SECRET);
    if (process.platform !== 'win32') assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
    assert.equal(legacyRow(), undefined);
    assert.equal(revokedRow(), undefined);
    assert.ok(lines.some(l => l.includes('Signatur-Schlüssel erneuert, alle Sitzungen wurden beendet')), lines.join('\n'));

    assert.equal(callRequireAuth(auth, oldToken), 401);
    const fresh = auth.signSessionToken({ id: userId, username: 'admin', role: 'admin', password_changed_at: null });
    assert.equal(callRequireAuth(auth, fresh), 200);
});

test('a restart keeps the secret from the file and logs nothing about it', () => {
    const before = fs.readFileSync(secretFile, 'utf8').trim();
    const { auth, lines } = loadAuth();
    assert.equal(auth.JWT_SECRET, before);
    assert.ok(!lines.some(l => l.includes('Signatur-Schlüssel')), lines.join('\n'));
});

test('a fresh install creates the key file and logs its creation', () => {
    fs.rmSync(secretFile);
    const { auth, lines } = loadAuth();
    assert.equal(fs.readFileSync(secretFile, 'utf8').trim(), auth.JWT_SECRET);
    assert.ok(lines.some(l => l.includes('Signatur-Schlüssel erzeugt')), lines.join('\n'));
    assert.ok(!lines.some(l => l.includes('erneuert')));
});

test('a valid JWT_SECRET wins, a placeholder is ignored; the legacy row goes either way', (t) => {
    t.after(() => { delete process.env.JWT_SECRET; });
    const fromFile = fs.readFileSync(secretFile, 'utf8').trim();

    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(OLD_SECRET);
    assert.equal(loadAuth().auth.JWT_SECRET, process.env.JWT_SECRET);
    assert.equal(legacyRow(), undefined);

    process.env.JWT_SECRET = 'change-this-to-a-long-random-string-please';
    assert.equal(loadAuth().auth.JWT_SECRET, fromFile);
});

test('persistJwtSecret after a restore removes a secret the backup carried and ends all sessions', () => {
    const { auth } = loadAuth();
    const token = auth.signSessionToken(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
    assert.equal(callRequireAuth(auth, token), 200);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(OLD_SECRET);
    auth.persistJwtSecret();
    assert.equal(legacyRow(), undefined);
    assert.equal(callRequireAuth(auth, token), 401);
});

test('tokens without pv, without exp or with an iat in the future are rejected', () => {
    const { auth } = loadAuth();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const pv = user.password_changed_at || 0;
    const base = { id: userId, username: 'admin', role: 'admin' };
    assert.equal(callRequireAuth(auth, jwt.sign({ ...base, pv }, auth.JWT_SECRET, { expiresIn: '1h' })), 200);
    assert.equal(callRequireAuth(auth, jwt.sign({ ...base, iat: 4102444800 }, auth.JWT_SECRET)), 401);
    assert.equal(callRequireAuth(auth, jwt.sign({ ...base, pv, iat: 4102444800 }, auth.JWT_SECRET)), 401);
    assert.equal(callRequireAuth(auth, jwt.sign(base, auth.JWT_SECRET, { expiresIn: '1h' })), 401);
    assert.equal(callRequireAuth(auth, jwt.sign({ ...base, pv: String(pv) }, auth.JWT_SECRET, { expiresIn: '1h' })), 401);
    assert.equal(callRequireAuth(auth, jwt.sign({ ...base, pv }, auth.JWT_SECRET)), 401, 'no exp');
});

test('a rolled-back restore reloads the logout list of the database that is back', () => {
    const { auth } = loadAuth();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const token = auth.signSessionToken(user);
    auth.endSession(token);
    assert.equal(callRequireAuth(auth, token), 401);
    const savedList = revokedRow().value;

    auth.persistJwtSecret();
    // the old database comes back: its own session versions and logout list
    db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run(user.password_changed_at, userId);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('revoked_sessions', ?)").run(savedList);
    assert.equal(callRequireAuth(auth, token), 401);
});

test('logout of an already revoked or stale token does not rewrite the list', () => {
    const { auth } = loadAuth();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const token = auth.signSessionToken(user);
    const digest = crypto.createHash('sha256').update(token).digest('base64url');
    const stored = JSON.stringify({ [digest]: Math.floor(Date.now() / 1000) + 3600, expired: 1 });
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('revoked_sessions', ?)").run(stored);
    auth.endSession(token);
    assert.equal(revokedRow().value, stored, 'no sweep and no write for a token already on the list');

    const stale = auth.signSessionToken(user);
    db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run((user.password_changed_at || 0) + 10, userId);
    auth.endSession(stale);
    assert.equal(revokedRow().value, stored, 'a token whose session already ended is ignored');

    const before = db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(userId).password_changed_at;
    const otherName = jwt.sign({ id: userId, username: 'someone-else', role: 'admin', pv: before }, auth.JWT_SECRET, { expiresIn: '1h' });
    auth.endSession(otherName);
    assert.equal(revokedRow().value, stored);
    assert.equal(db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(userId).password_changed_at, before);
});
