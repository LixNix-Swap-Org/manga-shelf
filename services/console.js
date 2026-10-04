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
    out('Snapshot wird erstellt ...');
    const snapshot = await createBackupSnapshot('manual');
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

const COMMANDS = [
    { names: ['hilfe', 'help', '?'], usage: 'hilfe', text: 'Zeigt diese Liste', run: cmdHelp },
    { names: ['status'], usage: 'status', text: 'Version, Datenordner, Datenbank, Speicherplatz, letztes Backup', run: cmdStatus },
    { names: ['backup', 'sichern'], usage: 'backup', text: 'Erstellt jetzt einen Snapshot (wie „Snapshot erstellen“)', run: cmdBackup },
    { names: ['benutzer', 'users'], usage: 'benutzer', text: 'Listet alle Benutzer mit Rolle', run: cmdUsers },
    { names: ['passwort-reset', 'reset-password'], usage: 'passwort-reset <name>', text: 'Setzt ein zufälliges Passwort (im Terminal angezeigt, sonst als Datei im Datenordner)', run: cmdPasswordReset },
    { names: ['admin', 'promote'], usage: 'admin <name>', text: 'Macht <name> zum Administrator, nur wenn es keinen gibt', run: cmdPromote },
    { names: ['rollback-aufraeumen', 'rollback-cleanup'], usage: 'rollback-aufraeumen [bestaetigen]', text: 'Prüft manga.db und löscht danach eine liegengebliebene manga.db.bak', run: cmdRollbackCleanup }
];

/**
 * Runs one console line ("passwort-reset Kim"). `out` receives the answer lines. A generated password is only
 * passed to `out` with revealSecrets (default: stdout is a terminal, e.g. `docker exec -it`); otherwise it goes to
 * a 0600 file in DATA_DIR, since console output usually ends up in the container log. Resolves to { ok, command }.
 */
async function runCommand(line, out = (text) => process.stdout.write(text + '\n'), { revealSecrets = process.stdout.isTTY === true } = {}) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return { ok: true, command: null };
    const space = trimmed.search(/\s/);
    const word = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const arg = space < 0 ? '' : trimmed.slice(space + 1).trim();
    const command = COMMANDS.find(c => c.names.includes(word));
    if (!command) {
        out(`Unbekannter Befehl „${word}“. "hilfe" zeigt alle Befehle.`);
        return { ok: false, command: null };
    }
    log.info(`Console command: ${command.names[0]}${arg ? ` ${arg}` : ''}`);
    try {
        return { ok: await command.run(arg, out, { revealSecrets }), command: command.names[0] };
    } catch (err) {
        log.error(`Console command ${command.names[0]} failed:`, err);
        out(`Fehler: ${err.status ? err.message : 'Befehl fehlgeschlagen (Details im Log)'}`);
        return { ok: false, command: command.names[0] };
    }
}

/**
 * Reads commands line by line from stdin (the Pterodactyl console forwards its input there). Without a usable
 * stdin (closed, /dev/null, ADMIN_CONSOLE=false) nothing happens. terminal: false leaves Ctrl+C to the shell.
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
    let queue = Promise.resolve();
    rl.on('line', (line) => {
        queue = queue.then(() => runCommand(line, out, { revealSecrets: false }));
    });
    return {
        close: () => rl.close(),
        idle: () => queue
    };
}

module.exports = { runCommand, startConsole, statusLines, generatePassword, COMMANDS };
