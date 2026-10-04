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

// --- quellen (API keys) ---

const MAL_ID = '0123456789abcdef0123456789abcdef';
const ANILIST_TOKEN = `eyJ0eXAiOiJKV1QifQ.${'a'.repeat(80)}.${'b'.repeat(30)}`;

/** global.fetch for the providers: MAL accepts MAL_ID, AniList ANILIST_TOKEN; counts the requests. */
function fakeProviders(t) {
    const realFetch = global.fetch;
    const calls = [];
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    global.fetch = async (url, init = {}) => {
        calls.push(String(url));
        if (String(url).startsWith('https://api.myanimelist.net/v2')) return init.headers['X-MAL-CLIENT-ID'] === MAL_ID ? reply(200, { data: [] }) : reply(401, {});
        if (String(url).startsWith('https://graphql.anilist.co')) {
            return init.headers.Authorization === `Bearer ${ANILIST_TOKEN}` ? reply(200, { data: { Viewer: { id: 1, name: 'kim-al' } } }) : reply(401, { errors: [{ status: 401 }] });
        }
        throw new TypeError('offline in tests');
    };
    t.after(() => { global.fetch = realFetch; });
    return calls;
}

test('quellen: table without keys, guide with links, the AniList link from the client id', async () => {
    const table = await run('quellen');
    assert.equal(table.ok, true);
    assert.match(table.text, /MyAnimeList\s+Instanz\s+nicht hinterlegt/);
    assert.match(table.text, /Google Books\s+Instanz\s+nicht hinterlegt/);
    assert.match(table.text, /AniList\s+Nutzer\s+kein Benutzer-Schlüssel/);

    const mal = await run('quellen anleitung mal');
    assert.match(mal.text, /1\. Bei MyAnimeList anmelden/);
    assert.match(mal.text, /https:\/\/myanimelist\.net\/apiconfig/);
    assert.ok(mal.lines.every((l) => l.length <= 80), 'wrapped to 80 columns');

    const lines = [];
    await runCommand('quellen anleitung anilist', (text) => lines.push(text), { readLine: async () => '4242' });
    assert.ok(lines.includes('   https://anilist.co/api/v2/oauth/authorize?client_id=4242&response_type=token'));
    assert.equal((await run('quellen anleitung kitsu')).ok, false);
    assert.match((await run('hilfe')).text, /quellen/);
});

test('quellen setzen: hidden input, format check before any request, live check, masked confirmation, secret never printed or logged', async (t) => {
    const calls = fakeProviders(t);
    const lines = [];
    const prompts = [];
    const { result, logged } = await captureLogs(t, () => runCommand('quellen setzen mal', (text) => lines.push(text), {
        readSecret: async (prompt) => { prompts.push(prompt); return `${MAL_ID}\n`; }
    }));
    assert.equal(result.ok, true, lines.join('\n'));
    assert.match(prompts[0], /Client-ID \(Eingabe bleibt unsichtbar\)/);
    assert.match(lines.join('\n'), new RegExp(`Gespeichert für die Instanz: Client-ID …${MAL_ID.slice(-4)}`));
    assert.ok(!lines.join('\n').includes(MAL_ID), 'not in the output');
    assert.ok(!logged.includes(MAL_ID), 'not in the log');
    assert.equal(calls.length, 1);
    assert.match((await run('quellen')).text, /MyAnimeList\s+Instanz\s+hinterlegt als Client-ID …cdef/);

    const wrong = [];
    const bad = await runCommand('quellen setzen mal', (text) => wrong.push(text), { readSecret: async () => 'kein-schluessel' });
    assert.equal(bad.ok, false);
    assert.match(wrong.join('\n'), /genau 32 Zeichen/);
    assert.equal(calls.length, 1, 'no request for a malformed key');

    const inline = await captureLogs(t, () => run(`quellen setzen mal ${MAL_ID}`));
    assert.equal(inline.result.ok, false);
    assert.match(inline.result.text, /nie in die Befehlszeile/);
    assert.ok(!inline.logged.includes(MAL_ID));

    assert.match((await run('quellen entfernen mal')).text, /MyAnimeList-Schlüssel der Instanz entfernt/);
});

test('quellen setzen anilist needs --benutzer; keys from a file; admins never see them', async (t) => {
    fakeProviders(t);
    const noUser = await run('quellen setzen anilist');
    assert.equal(noUser.ok, false);
    assert.match(noUser.text, /--benutzer <Name>/);
    const file = path.join(dataDir, 'token.txt');
    fs.writeFileSync(file, ANILIST_TOKEN + '\n');
    const saved = await run(`quellen setzen anilist --benutzer KIM --aus-datei ${file}`);
    assert.equal(saved.ok, true, saved.text);
    assert.match(saved.text, /Gespeichert für „kim“: kim-al\./);
    assert.ok(!saved.text.includes(ANILIST_TOKEN));
    assert.match((await run('quellen')).text, /AniList\s+Nutzer\s+1 Benutzer mit eigenem Schlüssel/);
    assert.equal((await run('quellen setzen google_books --benutzer kim')).ok, false, 'instance-only provider');
    assert.match((await run('quellen entfernen anilist --benutzer kim')).text, /AniList-Schlüssel von „kim“ entfernt/);
});

test('the stdin console hands the line after "quellen setzen" to the prompt, not to the command parser', async (t) => {
    fakeProviders(t);
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (chunk) => { printed += chunk; });
    const { logged } = await captureLogs(t, async () => {
        const handle = startConsole({ input, output });
        input.write('quellen setzen mal\n');
        await new Promise((r) => setTimeout(r, 20));
        input.write(`${MAL_ID}\n`);
        input.end();
        await new Promise((r) => setTimeout(r, 50));
        await handle.idle();
    });
    assert.match(printed, /Gespeichert für die Instanz/);
    assert.doesNotMatch(printed, /Unbekannter Befehl/);
    assert.ok(!printed.includes(MAL_ID) && !logged.includes(MAL_ID));
    await run('quellen entfernen mal');
});

/** Runs the stdin console with `feed(input)` and returns everything printed and logged. */
async function consoleSession(t, feed) {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (chunk) => { printed += chunk; });
    const { logged } = await captureLogs(t, async () => {
        const handle = startConsole({ input, output });
        await feed(input);
        input.end();
        await new Promise((r) => setTimeout(r, 50));
        await handle.idle();
    });
    return { printed, logged };
}

test('the stdin console: a key pasted together with "quellen setzen" goes to the prompt and is never printed', async (t) => {
    fakeProviders(t);
    const { printed, logged } = await consoleSession(t, async (input) => {
        input.write(`quellen setzen mal\n${MAL_ID}\n`);
    });
    assert.match(printed, /Gespeichert für die Instanz/);
    assert.doesNotMatch(printed, /Unbekannter Befehl/);
    assert.ok(!printed.includes(MAL_ID) && !logged.includes(MAL_ID));
    assert.match(printed, /Eingabe ist in dieser Konsole sichtbar/);
    assert.match(printed, /node scripts\/admin\.js quellen setzen mal/);
    assert.match(printed, /--aus-datei/);
    assert.doesNotMatch(printed, /unsichtbar/);
    await run('quellen entfernen mal');
});

test('the stdin console: a key typed again while the live check runs is not echoed', async (t) => {
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    global.fetch = async (url) => {
        if (!String(url).startsWith('https://api.myanimelist.net/v2')) throw new TypeError('offline in tests');
        await new Promise((r) => setTimeout(r, 150));
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { printed, logged } = await consoleSession(t, async (input) => {
        input.write('benutzer\nquellen setzen mal\n');
        await new Promise((r) => setTimeout(r, 30));
        input.write(`${MAL_ID}\n`);
        await new Promise((r) => setTimeout(r, 30));
        input.write(`${MAL_ID}\n`);
        await new Promise((r) => setTimeout(r, 250));
    });
    assert.match(printed, /Gespeichert für die Instanz/);
    assert.match(printed, /Unbekannter Befehl „01234567…“/);
    assert.ok(!printed.includes(MAL_ID) && !logged.includes(MAL_ID));
    await run('quellen entfernen mal');
});

test('the stdin console drops the line meant as a key when "quellen setzen" ends without asking', async (t) => {
    fakeProviders(t);
    const { printed, logged } = await consoleSession(t, async (input) => {
        input.write(`quellen setzen anilist\n${ANILIST_TOKEN}\n`);
        await new Promise((r) => setTimeout(r, 30));
        input.write('benutzer\n');
    });
    assert.match(printed, /--benutzer <Name>/);
    assert.match(printed, /nächste Zeile wurde verworfen/);
    assert.doesNotMatch(printed, /Unbekannter Befehl/);
    assert.match(printed, /Chefin \(Administrator\)/, 'a later line is a command again');
    assert.ok(!printed.includes(ANILIST_TOKEN) && !logged.includes(ANILIST_TOKEN));
});

test('unknown commands are echoed with at most 8 characters', async () => {
    assert.match((await run('abcdefghijkl')).text, /Unbekannter Befehl „abcdefgh…“/);
    assert.match((await run('kurz')).text, /Unbekannter Befehl „kurz“/);
});

test('the first-start hint about API keys appears once per database and never with an instance key', () => {
    const { sourcesNoticeOnce } = require('../services/console');
    db.prepare("DELETE FROM app_settings WHERE key = 'sources_notice_shown'").run();
    assert.match(sourcesNoticeOnce(), /kein eigener API-Schlüssel hinterlegt.*quellen anleitung/);
    assert.equal(sourcesNoticeOnce(), null);
    db.prepare("DELETE FROM app_settings WHERE key = 'sources_notice_shown'").run();
    process.env.GOOGLE_BOOKS_KEY = 'AIza' + 'x'.repeat(35);
    try {
        assert.equal(sourcesNoticeOnce(), null);
    } finally {
        delete process.env.GOOGLE_BOOKS_KEY;
    }
});
