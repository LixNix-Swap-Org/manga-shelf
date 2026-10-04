const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { execFileSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-console-'));
process.env.DATA_DIR = dataDir;
const bcrypt = require('bcryptjs');
const { db, dbPath, closeDb } = require('../db');
const { runCommand, startConsole, generatePassword } = require('../services/console');

test.after(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const hash = bcrypt.hashSync('altes-passwort', 4);
db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('Chefin', ?, 'admin'), ('kim', ?, 'editor'), ('gast', ?, 'guest')").run(hash, hash, hash);

async function run(line) {
    const lines = [];
    const result = await runCommand(line, (text) => lines.push(text));
    return { ...result, lines, text: lines.join('\n') };
}

/** Captures everything the logger prints while fn runs. */
async function captureLogs(t, fn) {
    const logged = [];
    for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => { logged.push(args.join(' ')); });
    try {
        return { result: await fn(), logged: logged.join('\n') };
    } finally {
        t.mock.restoreAll();
    }
}

test('hilfe lists every command; unknown commands and empty lines are handled', async () => {
    const help = await run('hilfe');
    assert.equal(help.ok, true);
    for (const word of ['status', 'backup', 'benutzer', 'passwort-reset <name>', 'admin <name>', 'rollback-aufraeumen']) {
        assert.ok(help.text.includes(word), word);
    }
    assert.equal((await run('HELP')).command, 'hilfe', 'English alias, any case');
    const unknown = await run('format c:');
    assert.equal(unknown.ok, false);
    assert.match(unknown.text, /Unbekannter Befehl „format“/);
    assert.deepEqual((await run('   ')).lines, []);
});

test('status and benutzer describe the instance and its users', async () => {
    const status = await run('status');
    assert.equal(status.ok, true);
    assert.match(status.text, new RegExp(`Manga Shelf v${require('../package.json').version.replace(/\./g, '\\.')}`));
    assert.match(status.text, /Schema v\d+, 0 Reihen, 0 Bände, 3 Benutzer/);
    assert.match(status.text, /Freier Speicher: /);
    assert.match(status.text, /Letztes geprüftes Backup: keins/);

    const users = await run('benutzer');
    assert.deepEqual(users.lines, ['  Chefin (Administrator)', '  gast (Gast)', '  kim (Bearbeiter)']);
});

test('passwort-reset on a terminal prints a new password once, never logs it and ends the sessions', async (t) => {
    const before = db.prepare("SELECT password_changed_at FROM users WHERE username = 'kim'").get().password_changed_at;
    const lines = [];
    const { result, logged } = await captureLogs(t, () => runCommand('passwort-reset KIM', (text) => lines.push(text), { revealSecrets: true }));
    const text = lines.join('\n');
    assert.equal(result.ok, true);
    const match = /Neues Passwort für „kim“: (\S+)/.exec(text);
    assert.ok(match, text);
    const password = match[1];
    assert.equal(password.length, 16);
    assert.equal(text.split(password).length - 1, 1, 'shown exactly once');
    assert.ok(!logged.includes(password), 'the password never reaches the log');
    assert.match(text, /nach dem Login ändern/);
    assert.equal(fs.existsSync(path.join(dataDir, 'reset-kim.txt')), false);

    const row = db.prepare("SELECT password_hash, password_changed_at FROM users WHERE username = 'kim'").get();
    assert.ok(await bcrypt.compare(password, row.password_hash));
    assert.ok(row.password_changed_at > (before || 0), 'older sessions of kim end');

    const missing = await run('passwort-reset niemand');
    assert.equal(missing.ok, false);
    assert.match(missing.text, /nicht gefunden/);
    assert.equal((await run('passwort-reset')).ok, false);
});

/** Password from a reset file, after checking that only the owner can read it. */
function readResetFile(file) {
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const content = fs.readFileSync(file, 'utf8');
    fs.unlinkSync(file);
    return /: (\S+)\n/.exec(content)[1];
}

test('passwort-reset without a terminal writes the password to a 0600 file and prints only its path', async (t) => {
    const file = path.join(dataDir, 'reset-kim.txt');
    fs.writeFileSync(file, 'stale', { mode: 0o644 });
    const { result, logged } = await captureLogs(t, () => run('passwort-reset kim'));
    assert.equal(result.ok, true);
    assert.ok(result.text.includes(file), result.text);
    const password = readResetFile(file);
    assert.ok(!result.text.includes(password) && !logged.includes(password));
    assert.ok(await bcrypt.compare(password, db.prepare("SELECT password_hash FROM users WHERE username = 'kim'").get().password_hash));
});

test('the stdin console never prints a password, even when stdout is a terminal', async (t) => {
    const hadTty = Object.prototype.hasOwnProperty.call(process.stdout, 'isTTY');
    const tty = process.stdout.isTTY;
    process.stdout.isTTY = true;
    t.after(() => { if (hadTty) process.stdout.isTTY = tty; else delete process.stdout.isTTY; });
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (chunk) => { printed += chunk; });
    const consoleHandle = startConsole({ input, output });
    input.write('passwort-reset kim\n');
    input.end();
    await new Promise(r => setImmediate(r));
    await consoleHandle.idle();
    const file = path.join(dataDir, 'reset-kim.txt');
    assert.ok(printed.includes(file), printed);
    const password = readResetFile(file);
    assert.ok(!printed.includes(password));
    assert.ok(await bcrypt.compare(password, db.prepare("SELECT password_hash FROM users WHERE username = 'kim'").get().password_hash));
});

test('generated passwords use the full length and an unambiguous alphabet', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
        const p = generatePassword();
        assert.match(p, /^[A-HJ-NP-Za-km-z2-9]{16}$/);
        seen.add(p);
    }
    assert.equal(seen.size, 50);
});

test('admin <name> only promotes while no administrator exists', async () => {
    const refused = await run('admin kim');
    assert.equal(refused.ok, false);
    assert.match(refused.text, /bereits einen Administrator \(Chefin\)/);
    assert.equal(db.prepare("SELECT role FROM users WHERE username = 'kim'").get().role, 'editor');

    db.prepare("UPDATE users SET role = 'editor' WHERE username = 'Chefin'").run();
    try {
        assert.equal((await run('admin niemand')).ok, false);
        const promoted = await run('promote Kim');
        assert.equal(promoted.ok, true);
        assert.equal(db.prepare("SELECT role FROM users WHERE username = 'kim'").get().role, 'admin');
    } finally {
        db.prepare("UPDATE users SET role = 'admin' WHERE username = 'Chefin'").run();
        db.prepare("UPDATE users SET role = 'editor' WHERE username = 'kim'").run();
    }
});

test('backup creates a verified manual snapshot', async () => {
    const res = await run('backup');
    assert.equal(res.ok, true, res.text);
    assert.match(res.text, /Snapshot manual-.*\.zip erstellt .*geprüft/);
    assert.match((await run('status')).text, /Letztes geprüftes Backup: manual-/);
});

test('rollback-aufraeumen checks the live database and deletes manga.db.bak only when confirmed', async () => {
    const bak = dbPath + '.bak';
    assert.match((await run('rollback-aufraeumen')).text, /nichts aufzuräumen/);

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, bak);
    try {
        const dry = await run('rollback-aufraeumen');
        assert.equal(dry.ok, true);
        assert.match(dry.text, /Aktuelle manga\.db: in Ordnung/);
        assert.match(dry.text, /manga\.db\.bak: \d+ Reihen/);
        assert.match(dry.text, /rollback-aufraeumen bestaetigen/);
        assert.ok(fs.existsSync(bak), 'nothing is deleted without confirmation');
        assert.match((await run('status')).text, /manga\.db\.bak existiert/);

        const done = await run('rollback-aufraeumen bestaetigen');
        assert.equal(done.ok, true);
        assert.match(done.text, /gelöscht/);
        assert.ok(!fs.existsSync(bak));
    } finally {
        fs.rmSync(bak, { force: true });
    }
});

test('startConsole reads commands line by line and stays off without input or when disabled', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (chunk) => { printed += chunk; });
    const consoleHandle = startConsole({ input, output });
    input.write('benutzer\nstatus\n');
    input.end();
    await new Promise(r => setImmediate(r));
    await consoleHandle.idle();
    assert.match(printed, /Chefin \(Administrator\)[\s\S]*Manga Shelf v/);

    const closed = new PassThrough();
    closed.destroy();
    assert.equal(startConsole({ input: closed, output }), null);
    try {
        // the same values the startup check accepts as "off" (config.js), padded ones included
        for (const off of ['false', 'nein', ' false', 'FALSE ', 'Off', '0']) {
            process.env.ADMIN_CONSOLE = off;
            assert.equal(startConsole({ input: new PassThrough(), output }), null, JSON.stringify(off));
        }
        for (const on of ['ja', ' true ']) {
            process.env.ADMIN_CONSOLE = on;
            const handle = startConsole({ input: new PassThrough(), output });
            assert.ok(handle, JSON.stringify(on));
            handle.close();
        }
    } finally {
        delete process.env.ADMIN_CONSOLE;
    }
});

test('scripts/admin.js runs one command and exits with its result', () => {
    const script = path.join(__dirname, '..', 'scripts', 'admin.js');
    const env = { ...process.env, DATA_DIR: dataDir, MANGA_SHELF_NO_LISTEN: '1', LOG_LEVEL: 'silent' };
    const out = execFileSync(process.execPath, [script, 'passwort-reset', 'gast'], { env, encoding: 'utf8' });
    const file = path.join(dataDir, 'reset-gast.txt');
    assert.ok(out.includes(file), 'stdout is a pipe here, so the password goes to the file');
    const password = readResetFile(file);
    assert.ok(!out.includes(password));
    assert.ok(bcrypt.compareSync(password, db.prepare("SELECT password_hash FROM users WHERE username = 'gast'").get().password_hash));

    assert.match(execFileSync(process.execPath, [script], { env, encoding: 'utf8' }), /Befehle der Server-Konsole/);
    assert.throws(() => execFileSync(process.execPath, [script, 'passwort-reset', 'niemand'], { env, encoding: 'utf8', stdio: 'pipe' }), (err) => err.status === 1 && /nicht gefunden/.test(err.stdout));
});
