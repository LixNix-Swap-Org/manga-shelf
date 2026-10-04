// Admin console of the server (stdin, the headless binary, scripts/admin.js): German commands for passwords, roles,
// sources and status. Secrets never go to the log; generated passwords only reach a terminal or a 0600 file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { db, dataDir, dbPath } = require('../db');
const disk = require('../utils/disk');
const pkg = require('../package.json');
const log = require('../utils/logger').child('console');
const { config } = require('../utils/config');

const ROLE_NAMES = { admin: 'Administrator', editor: 'Bearbeiter', visitor: 'Besucher', guest: 'Gast' };
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 16;
const CONFIRM_WORDS = new Set(['bestaetigen', 'bestätigen', 'ja', '--yes', 'yes', 'confirm']);

const bakPath = dbPath + '.bak';

function generatePassword() {
    let out = '';
    for (let i = 0; i < PASSWORD_LENGTH; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
    return out;
}

function findUser(name) {
    return db.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ? COLLATE NOCASE').get(name);
}

function relativeAge(ms) {
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 60) return `vor ${Math.max(minutes, 0)} Min.`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `vor ${hours} Std.` : `vor ${Math.round(hours / 24)} Tagen`;
}

/** German summary of the instance (also usable as a startup line). */
function statusLines() {
    const { listUploads } = require('./backupArchive');
    const { lastVerifiedSnapshot, listSnapshots } = require('./scheduler');
    const count = (table) => db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
    const schema = db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v;
    const uploads = listUploads();
    const uploadBytes = uploads.reduce((sum, u) => sum + u.size, 0);
    const free = disk.freeBytes(dataDir);
    const newest = listSnapshots()[0];
    const verified = lastVerifiedSnapshot();
    const lines = [
        `Manga Shelf v${pkg.version}`,
        `Datenordner: ${dataDir}`,
        `Datenbank: ${disk.formatMb(disk.fileSize(dbPath) + disk.fileSize(dbPath + '-wal'))}, Schema v${schema}, ${count('mangas')} Reihen, ${count('volumes')} Bände, ${count('users')} Benutzer`,
        `Uploads: ${uploads.length} Dateien, ${disk.formatMb(uploadBytes)}`,
        `Freier Speicher: ${free === null ? 'unbekannt' : disk.formatMb(free)}`,
        `Letztes geprüftes Backup: ${verified ? `${verified.filename} (${relativeAge(verified.time)})` : 'keins'}`
    ];
    if (newest && newest.verified === false) {
        lines.push(`Warnung: Neuester Snapshot ${newest.filename} hat die Prüfung nicht bestanden (${newest.verify_error || 'unbekannter Fehler'})`);
    }
    if (fs.existsSync(bakPath)) {
        lines.push('Warnung: manga.db.bak existiert (abgebrochene Wiederherstellung); Wiederherstellungen sind gesperrt, siehe "rollback-aufraeumen".');
    }
    return lines;
}

async function cmdHelp(arg, out) {
    out('Befehle der Server-Konsole (wer die Konsole bedienen kann, hat Administratorrechte):');
    for (const c of COMMANDS) out(`  ${c.usage.padEnd(34)} ${c.text}`);
    return true;
}

async function cmdStatus(arg, out) {
    for (const line of statusLines()) out(line);
    return true;
}

async function cmdBackup(arg, out) {
    const { createBackupSnapshot } = require('./scheduler');
    const { trackJob } = require('./lifecycle');
    out('Snapshot wird erstellt ...');
    // tracked so shutdown and the desktop restart guard wait for it
    const snapshot = await trackJob('Snapshot', createBackupSnapshot('manual'));
    out(`Snapshot ${snapshot.filename} erstellt (${disk.formatMb(snapshot.size)}), ${snapshot.verified ? 'geprüft' : `Prüfung fehlgeschlagen: ${snapshot.verify_error}`}`);
    return snapshot.verified;
}

async function cmdUsers(arg, out) {
    const users = db.prepare('SELECT username, role FROM users ORDER BY username COLLATE NOCASE').all();
    if (!users.length) out('Keine Benutzer vorhanden.');
    for (const u of users) out(`  ${u.username} (${ROLE_NAMES[u.role] || u.role})`);
    return true;
}

/** Writes the password to <DATA_DIR>/reset-<user>.txt, readable only by the server user, and returns the path. */
function writeResetFile(username, password) {
    const file = path.join(dataDir, `reset-${username.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.writeFileSync(file, `Neues Passwort für „${username}“: ${password}\nBitte nach dem Login ändern und diese Datei löschen.\n`, { mode: 0o600, flag: 'wx' });
    return file;
}

async function cmdPasswordReset(name, out, { revealSecrets } = {}) {
    if (!name) {
        out('Aufruf: passwort-reset <Benutzername>');
        return false;
    }
    const user = findUser(name);
    if (!user) {
        out(`Benutzer „${name}“ nicht gefunden ("benutzer" listet alle).`);
        return false;
    }
    const password = generatePassword();
    const hash = await bcrypt.hash(password, 10);
    const { bumpSessionVersion } = require('../middleware/auth');
    const version = bumpSessionVersion(user.id, hash, { username: user.username, passwordHash: user.password_hash });
    if (version === null) {
        out('Der Benutzer wurde gerade geändert. Bitte den Befehl erneut ausführen.');
        return false;
    }
    require('../core/handlers/radar').revokeFeedTokens(db, user.id);
    log.info(`Password of user "${user.username}" reset from the console; all of their sessions ended`);
    if (revealSecrets) {
        out(`Neues Passwort für „${user.username}“: ${password}`);
        out('Es wird nur dieses eine Mal angezeigt. Bitte direkt nach dem Login ändern; alle Sitzungen dieses Benutzers wurden beendet.');
        return true;
    }
    const file = writeResetFile(user.username, password);
    out(`Neues Passwort für „${user.username}“ steht in ${file} (nur für den Server-Benutzer lesbar, z. B. per SFTP abholen).`);
    out('Bitte direkt nach dem Login ändern und die Datei löschen; alle Sitzungen dieses Benutzers wurden beendet.');
    return true;
}

async function cmdPromote(name, out) {
    if (!name) {
        out('Aufruf: admin <Benutzername>');
        return false;
    }
    const admins = db.prepare("SELECT username FROM users WHERE role = 'admin' ORDER BY username").all();
    if (admins.length) {
        out(`Es gibt bereits einen Administrator (${admins.map(a => a.username).join(', ')}). Rollen ändert ein Administrator in der Benutzerverwaltung; bei vergessenem Passwort hilft "passwort-reset <name>".`);
        return false;
    }
    const user = findUser(name);
    if (!user) {
        out(`Benutzer „${name}“ nicht gefunden ("benutzer" listet alle).`);
        return false;
    }
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    log.info(`User "${user.username}" promoted to admin from the console`);
    out(`„${user.username}“ ist jetzt Administrator.`);
    return true;
}

function describeDb(file) {
    const { readDbFacts } = require('./backupArchive');
    const facts = readDbFacts(file);
    if (facts.counts.mangas === null) return { facts, text: 'keine Manga-Shelf-Datenbank' };
    return { facts, text: `${facts.counts.mangas} Reihen, ${facts.counts.volumes} Bände, ${facts.counts.users} Benutzer, Schema v${facts.schema_version}` };
}

async function cmdRollbackCleanup(arg, out) {
    if (!fs.existsSync(bakPath)) {
        out('Keine manga.db.bak vorhanden, es gibt nichts aufzuräumen.');
        return true;
    }
    let live;
    try {
        const check = db.prepare('PRAGMA quick_check').get();
        const result = check ? String(Object.values(check)[0]) : 'unbekannt';
        if (result !== 'ok') throw new Error('quick_check: ' + result);
        const admins = db.prepare("SELECT count(*) AS c FROM users WHERE role = 'admin'").get().c;
        if (admins < 1) throw new Error('kein Administrator');
        live = `${db.prepare('SELECT count(*) AS c FROM mangas').get().c} Reihen, ${db.prepare('SELECT count(*) AS c FROM volumes').get().c} Bände`;
    } catch (err) {
        out(`Die aktuelle manga.db ist nicht in Ordnung (${err.message}). manga.db.bak bleibt erhalten: Server stoppen, manga.db.bak nach manga.db kopieren und neu starten.`);
        return false;
    }
    out(`Aktuelle manga.db: in Ordnung (${live}).`);
    try {
        const stat = fs.statSync(bakPath);
        out(`manga.db.bak: ${describeDb(bakPath).text}, Stand ${stat.mtime.toISOString()}.`);
    } catch (e) {
        out(`manga.db.bak lässt sich nicht lesen (${e.message}).`);
    }
    if (!CONFIRM_WORDS.has(String(arg || '').trim().toLowerCase())) {
        out('Wenn die aktuelle Datenbank stimmt, löscht "rollback-aufraeumen bestaetigen" die Kopie. Sonst: Server stoppen und manga.db.bak nach manga.db kopieren.');
        return true;
    }
    for (const file of [bakPath, bakPath + '-wal', bakPath + '-shm']) {
        try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    log.info('manga.db.bak deleted from the console after checking the live database');
    out('manga.db.bak gelöscht. Wiederherstellungen sind wieder möglich.');
    return true;
}

const PROVIDER_ALIASES = {
    anilist: 'anilist', mal: 'mal', myanimelist: 'mal', google_books: 'google_books', 'google-books': 'google_books', googlebooks: 'google_books', google: 'google_books'
};
const SOURCES_NOTICE_KEY = 'sources_notice_shown';

/** "setzen mal --benutzer Kim --aus-datei /x" -> { words: ['setzen', 'mal'], options: { benutzer: 'Kim', 'aus-datei': '/x' } } */
function parseSourceArgs(arg) {
    const tokens = String(arg || '').match(/"[^"]*"|\S+/g) || [];
    const words = [];
    const options = {};
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].replace(/^"|"$/g, '');
        if (token.startsWith('--')) {
            const name = token.slice(2).toLowerCase();
            const next = tokens[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                options[name] = next.replace(/^"|"$/g, '');
                i++;
            } else {
                options[name] = true;
            }
        } else {
            words.push(token);
        }
    }
    return { words, options };
}

const sourcesApi = () => {
    const apiKeys = require('../routes/apiKeys');
    apiKeys.registerServerSources();
    return apiKeys;
};

function formatAge(ms) {
    return ms ? relativeAge(ms) : '–';
}

/** One line per provider and level: state, last successful use, pool use of the last hour (running server only). */
function sourcesTable() {
    const { guideFor } = require('../core/sources/guides');
    const apiKeys = sourcesApi();
    const gateway = require('../core/anime/gateway');
    const nowMs = Date.now();
    const lines = [];
    const row = (name, level, stateText, lastOk, pool) => lines.push(`  ${name.padEnd(13)} ${level.padEnd(9)} ${stateText.padEnd(34)} ${lastOk.padEnd(14)} ${pool}`);
    lines.push(`  ${'Anbieter'.padEnd(13)} ${'Ebene'.padEnd(9)} ${'Zustand'.padEnd(34)} ${'zuletzt ok'.padEnd(14)} Pool (letzte Stunde)`);
    const budget = gateway.state().budget;
    const poolUse = (provider) => {
        const st = budget.state(`shared:${provider}`, nowMs);
        return st ? `${st.used_last_hour} Anfragen${st.paused_until ? ', pausiert' : ''}${st.circuit !== 'closed' ? `, ${st.circuit}` : ''}` : '–';
    };
    const describe = (entry) => {
        if (!entry.configured) return 'nicht hinterlegt';
        if (entry.from_env) return 'aus der Umgebung gesetzt';
        if (entry.last_error) return `Fehler: ${entry.last_error}`;
        return `hinterlegt als ${entry.label || (entry.last4 ? `…${entry.last4}` : 'Schlüssel')}`;
    };
    for (const entry of apiKeys.listInstance()) {
        row(guideFor(entry.provider).name, 'Instanz', describe(entry), formatAge(entry.last_ok_at), entry.provider === 'mal' ? poolUse('mal') : '–');
    }
    for (const provider of ['anilist', 'mal']) {
        const counts = db.prepare('SELECT count(*) AS n, count(CASE WHEN last_error IS NOT NULL THEN 1 END) AS failed, max(last_ok_at) AS last_ok FROM user_api_credentials WHERE provider = ? AND user_id IS NOT NULL').get(provider);
        const text = counts.n ? `${counts.n} Benutzer mit eigenem Schlüssel${counts.failed ? ` (${counts.failed} mit Fehler)` : ''}` : 'kein Benutzer-Schlüssel';
        row(guideFor(provider).name, 'Nutzer', text, formatAge(counts.last_ok), provider === 'anilist' ? poolUse('anilist') : poolUse('jikan'));
    }
    return lines;
}

function resolveProvider(word, out) {
    const provider = PROVIDER_ALIASES[String(word || '').toLowerCase()];
    if (!provider) out(`Unbekannter Anbieter „${word || ''}“ (anilist, mal, google_books).`);
    return provider || null;
}

/** null for the instance, the user's id for --benutzer, undefined after an error message. */
function targetFor(provider, options, out) {
    const { guideFor } = require('../core/sources/guides');
    const scope = guideFor(provider).scope;
    if (options.benutzer && options.benutzer !== true) {
        if (scope === 'instance') {
            out(`${guideFor(provider).name}-Schlüssel gelten für die ganze Instanz; --benutzer gibt es dafür nicht.`);
            return undefined;
        }
        const user = findUser(options.benutzer);
        if (!user) {
            out(`Benutzer „${options.benutzer}“ nicht gefunden ("benutzer" listet alle).`);
            return undefined;
        }
        return user;
    }
    if (scope === 'user') {
        out(`${guideFor(provider).name}-Schlüssel gehören zu einem Benutzer: --benutzer <Name> angeben (die Konsole setzt und entfernt sie nur, sie zeigt sie nie an).`);
        return undefined;
    }
    return null;
}

async function cmdSources(arg, out, { readSecret, readLine, visibleInput = false } = {}) {
    const { guideLines, formatError, guideFor } = require('../core/sources/guides');
    const { words, options } = parseSourceArgs(arg);
    const action = (words[0] || '').toLowerCase();
    if (!action) {
        for (const line of sourcesTable()) out(line);
        out('Schritte zum Schlüssel: "quellen anleitung <anilist|mal|google_books>", eintragen: "quellen setzen <anbieter>".');
        return true;
    }
    if (action === 'anleitung' || action === 'guide') {
        const provider = resolveProvider(words[1], out);
        if (!provider) return false;
        let fields = {};
        if (provider === 'anilist' && readLine) {
            const clientId = String(await readLine('AniList-Client-ID (aus Schritt 3, leer lassen zum Überspringen): ') || '').trim();
            if (clientId) fields = { client_id: clientId };
        }
        for (const line of guideLines(provider, fields)) out(line);
        return true;
    }
    if (action === 'setzen' || action === 'set') {
        const provider = resolveProvider(words[1], out);
        if (!provider) return false;
        if (words.length > 2) {
            out('Den Schlüssel nie in die Befehlszeile schreiben (er landet sonst in Verlauf und Log). "quellen setzen <anbieter>" fragt ihn verdeckt ab, Skripte nutzen --aus-datei <pfad> oder stdin.');
            return false;
        }
        const target = targetFor(provider, options, out);
        if (target === undefined) return false;
        let secret;
        if (options['aus-datei'] && options['aus-datei'] !== true) {
            try {
                secret = fs.readFileSync(options['aus-datei'], 'utf8');
            } catch (err) {
                out(`Datei nicht lesbar: ${err.code || err.message}`);
                return false;
            }
        } else if (readSecret) {
            const label = `${guideFor(provider).name} ${guideFor(provider).secretLabel}`;
            secret = await readSecret(visibleInput
                ? `${label} eingeben. Achtung: die Eingabe ist in dieser Konsole sichtbar und kann im Konsolenverlauf bleiben; verdeckt geht es im Terminal mit "node scripts/admin.js quellen setzen ${provider}${target ? ` --benutzer ${target.username}` : ''}" oder mit --aus-datei <pfad>: `
                : `${label} (Eingabe bleibt unsichtbar): `);
        } else {
            out('Keine Eingabe möglich: --aus-datei <pfad> verwenden.');
            return false;
        }
        secret = String(secret || '').trim();
        const wrong = formatError(provider, secret);
        if (wrong) {
            out(wrong);
            return false;
        }
        out(`Prüfe den Schlüssel bei ${guideFor(provider).name} ...`);
        try {
            const saved = await sourcesApi().saveCredential(target ? target.id : null, provider, secret, { allowBackground: options.hintergrund === true });
            out(`Gespeichert${target ? ` für „${target.username}“` : ' für die Instanz'}: ${saved.label || `…${saved.last4}`}.`);
            return true;
        } catch (err) {
            out(`Nicht gespeichert: ${err.status ? err.message : 'Fehler beim Speichern (Details im Log)'}`);
            if (!err.status) log.error('Saving an API key from the console failed:', err.message);
            return false;
        }
    }
    if (action === 'entfernen' || action === 'remove') {
        const provider = resolveProvider(words[1], out);
        if (!provider) return false;
        const target = targetFor(provider, options, out);
        if (target === undefined) return false;
        const removed = sourcesApi().removeCredential(target ? target.id : null, provider);
        out(removed ? `${guideFor(provider).name}-Schlüssel${target ? ` von „${target.username}“` : ' der Instanz'} entfernt.` : 'Es war kein Schlüssel hinterlegt.');
        return true;
    }
    out('Aufruf: quellen | quellen anleitung <anbieter> | quellen setzen <anbieter> [--benutzer Name] [--aus-datei pfad] | quellen entfernen <anbieter> [--benutzer Name]');
    return false;
}

/** The one-time startup line while no instance key exists (null when not needed or already shown). */
function sourcesNoticeOnce() {
    const apiKeys = sourcesApi();
    if (apiKeys.listInstance().some((k) => k.configured)) return null;
    if (db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(SOURCES_NOTICE_KEY)) return null;
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(SOURCES_NOTICE_KEY, new Date().toISOString());
    return 'Quellen: kein eigener API-Schlüssel hinterlegt, Suche läuft mit dem gemeinsamen Limit — "quellen anleitung" zeigt die Schritte.';
}

const COMMANDS = [
    { names: ['hilfe', 'help', '?'], usage: 'hilfe', text: 'Zeigt diese Liste', run: cmdHelp },
    { names: ['status'], usage: 'status', text: 'Version, Datenordner, Datenbank, Speicherplatz, letztes Backup', run: cmdStatus },
    { names: ['backup', 'sichern'], usage: 'backup', text: 'Erstellt jetzt einen Snapshot (wie „Snapshot erstellen“)', run: cmdBackup },
    { names: ['benutzer', 'users'], usage: 'benutzer', text: 'Listet alle Benutzer mit Rolle', run: cmdUsers },
    { names: ['passwort-reset', 'reset-password'], usage: 'passwort-reset <name>', text: 'Setzt ein zufälliges Passwort (im Terminal angezeigt, sonst als Datei im Datenordner)', run: cmdPasswordReset },
    { names: ['admin', 'promote'], usage: 'admin <name>', text: 'Macht <name> zum Administrator, nur wenn es keinen gibt', run: cmdPromote },
    { names: ['rollback-aufraeumen', 'rollback-cleanup'], usage: 'rollback-aufraeumen [bestaetigen]', text: 'Prüft manga.db und löscht danach eine liegengebliebene manga.db.bak', run: cmdRollbackCleanup },
    { names: ['quellen', 'sources'], usage: 'quellen [anleitung|setzen|entfernen]', text: 'API-Schlüssel für AniList, MyAnimeList, Google Books: Zustand, Anleitung, setzen (verdeckt), entfernen', run: cmdSources, quietArgs: true }
];

// an unknown "command" may be a key typed at the wrong moment: never echo it in full
const shortEcho = (word) => (word.length > 8 ? `${word.slice(0, 8)}…` : word);

/** True for "quellen setzen …" that will ask for the key (no --aus-datei). */
function asksForSecret(line) {
    const trimmed = String(line || '').trim();
    const space = trimmed.search(/\s/);
    if (space < 0 || !['quellen', 'sources'].includes(trimmed.slice(0, space).toLowerCase())) return false;
    const { words, options } = parseSourceArgs(trimmed.slice(space + 1));
    return ['setzen', 'set'].includes((words[0] || '').toLowerCase()) && !(options['aus-datei'] && options['aus-datei'] !== true);
}

/**
 * Runs one console line ("passwort-reset Kim"); `out` receives the answer lines. A generated password goes to `out`
 * only with revealSecrets (default: stdout is a terminal), else to a 0600 file in DATA_DIR. Resolves { ok, command }.
 */
async function runCommand(line, out = (text) => process.stdout.write(text + '\n'), { revealSecrets = process.stdout.isTTY === true, readSecret, readLine, visibleInput = false } = {}) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return { ok: true, command: null };
    const space = trimmed.search(/\s/);
    const word = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const arg = space < 0 ? '' : trimmed.slice(space + 1).trim();
    const command = COMMANDS.find(c => c.names.includes(word));
    if (!command) {
        out(`Unbekannter Befehl „${shortEcho(word)}“. "hilfe" zeigt alle Befehle.`);
        return { ok: false, command: null };
    }
    // "quellen" logs only its sub-command: anything after it could be a key typed by mistake
    const shownArg = command.quietArgs ? (arg.split(/\s+/)[0] || '') : arg;
    log.info(`Console command: ${command.names[0]}${shownArg ? ` ${shownArg}` : ''}`);
    try {
        return { ok: await command.run(arg, out, { revealSecrets, readSecret, readLine, visibleInput }), command: command.names[0] };
    } catch (err) {
        log.error(`Console command ${command.names[0]} failed:`, err);
        out(`Fehler: ${err.status ? err.message : 'Befehl fehlgeschlagen (Details im Log)'}`);
        return { ok: false, command: command.names[0] };
    }
}

/**
 * Reads console commands from stdin (the Pterodactyl console forwards input there); no-op without usable stdin.
 * Lines are buffered and run in turn; a prompt takes the next line, so a pasted key never reaches the command parser.
 */
function startConsole({ input, output } = {}) {
    if (!config.adminConsole) return null;
    let stream = input;
    if (!stream) {
        try { stream = process.stdin; } catch (e) { return null; }
    }
    if (!stream || stream.destroyed || stream.readable === false) return null;
    const target = output || process.stdout;
    const out = (text) => { try { target.write(text + '\n'); } catch (e) { /* output gone */ } };
    stream.on('error', (err) => log.debug('Console input error:', err.message));
    const rl = readline.createInterface({ input: stream, terminal: false });
    const buffered = [];
    let waiting = null;
    let closed = false;
    let running = null;
    const ask = (prompt) => {
        out(prompt);
        if (buffered.length) return Promise.resolve(buffered.shift());
        if (closed) return Promise.resolve('');
        return new Promise((resolve) => { waiting = resolve; });
    };
    async function pump() {
        while (buffered.length) {
            const line = buffered.shift();
            const secretLine = asksForSecret(line);
            let asked = false;
            const readSecret = (prompt) => {
                asked = true;
                return ask(prompt);
            };
            await runCommand(line, out, { revealSecrets: false, readSecret, readLine: ask, visibleInput: true });
            if (secretLine && !asked && buffered.length) {
                buffered.shift();
                out('Die nächste Zeile wurde verworfen (sie war als Schlüssel gedacht).');
            }
        }
        running = null;
    }
    rl.on('line', (line) => {
        if (waiting) {
            const resolve = waiting;
            waiting = null;
            resolve(line);
            return;
        }
        buffered.push(line);
        if (!running) running = pump();
    });
    rl.on('close', () => {
        closed = true;
        if (waiting) waiting('');
        waiting = null;
    });
    return {
        close: () => rl.close(),
        idle: async () => {
            while (running) await running;
        }
    };
}

module.exports = { runCommand, startConsole, statusLines, generatePassword, sourcesNoticeOnce, parseSourceArgs, COMMANDS };
