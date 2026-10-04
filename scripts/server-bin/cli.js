// Command line of the headless server binary (manga-shelf-server): flags, subcommands and default folders.
const path = require('path');

const SERVICE_COMMANDS = new Set(['install-service', 'uninstall-service']);
const VALUE_FLAGS = new Set(['--port', '--host', '--data-dir', '--account']);
const BOOL_FLAGS = new Set(['--user', '--no-console', '--log-file']);

const HELP = `Manga Shelf Server – Web-Portal und API ohne grafische Oberfläche

Aufruf:
  manga-shelf-server [--port 3000] [--host 0.0.0.0] [--data-dir <pfad>] [--log-file] [--no-console]
  manga-shelf-server <befehl> [argumente] [--data-dir <pfad>]

Optionen:
  --port <zahl>        Port (Standard: PORT aus der Umgebung bzw. <datenordner>/.env, sonst 3000)
  --host <adresse>     Adresse, auf der der Server lauscht (Standard 0.0.0.0 = alle)
  --data-dir <pfad>    Datenordner für Datenbank, Bilder, Backups und .env
  --log-file           Logs zusätzlich nach <datenordner>/logs/manga-shelf.log (mit Rotation)
  --no-console         keine Admin-Konsole auf der Standardeingabe (für Dienste)
  -v, --version        Version anzeigen
  -h, --help           diese Hilfe

Befehle der Server-Konsole (wie im Pterodactyl-Panel):
  status, backup, benutzer, passwort-reset <name>, rollback-aufraeumen, quellen …, hilfe

Dienst einrichten:
  install-service [--user] [--port …] [--host …] [--data-dir …] [--account <konto>]
      Linux: systemd (ohne --user als System-Dienst, Benutzer manga-shelf, Daten in /var/lib/manga-shelf; braucht root)
      macOS: LaunchAgent ~/Library/LaunchAgents/de.manga-shelf.server.plist
      Windows: geplante Aufgabe „Manga Shelf Server“ beim Systemstart als LOCAL SERVICE (anderes Konto mit --account),
               Datenordner nur für dieses Konto, SYSTEM und die Administratoren (Eingabeaufforderung als Administrator)
  uninstall-service [--user]   Dienst entfernen; der Datenordner bleibt erhalten`;

class UsageError extends Error {}

function parsePort(value) {
    const text = String(value).trim();
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`Ungültiger Port "${value}" (erlaubt: 0 bis 65535)`);
    return n;
}

/**
 * argv without node/binary -> { command, args, options }. command: start | help | version | install-service |
 * uninstall-service | console (args = the console line; it swallows every later argument).
 */
function parseArgs(argv) {
    const options = { port: null, host: null, dataDir: null, user: false, noConsole: false, logFile: false, account: null };
    let command = null;
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
        const flag = eq === -1 ? raw : raw.slice(0, eq);
        const inline = eq === -1 ? null : raw.slice(eq + 1);
        const takeValue = () => {
            if (inline !== null) return inline;
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} braucht einen Wert`);
            i++;
            return next;
        };
        if (flag === '--data-dir') {
            const value = takeValue();
            if (!value.trim()) throw new UsageError('--data-dir braucht einen Pfad');
            options.dataDir = path.resolve(value);
            continue;
        }
        if (command === 'console') {
            args.push(raw);
            continue;
        }
        if (raw === '-h' || raw === '--help') { command = command || 'help'; continue; }
        if (raw === '-v' || raw === '--version') { command = command || 'version'; continue; }
        if (VALUE_FLAGS.has(flag)) {
            const value = takeValue();
            if (flag === '--port') options.port = parsePort(value);
            else if (flag === '--account') options.account = value.trim();
            else options.host = value.trim();
            continue;
        }
        if (BOOL_FLAGS.has(flag)) {
            if (inline !== null) throw new UsageError(`${flag} hat keinen Wert`);
            options[{ '--user': 'user', '--no-console': 'noConsole', '--log-file': 'logFile' }[flag]] = true;
            continue;
        }
        if (raw.startsWith('-')) throw new UsageError(`Unbekannte Option ${raw} (Hilfe: manga-shelf-server --help)`);
        if (command) throw new UsageError(`Unerwartetes Argument "${raw}"`);
        if (SERVICE_COMMANDS.has(raw)) command = raw;
        else if (raw === 'start' || raw === 'serve') command = 'start';
        else {
            command = 'console';
            args.push(raw);
        }
    }
    if (options.user && !SERVICE_COMMANDS.has(command)) throw new UsageError('--user gilt nur für install-service und uninstall-service');
    if (options.account && command !== 'install-service') throw new UsageError('--account gilt nur für install-service');
    return { command: command || 'start', args, options };
}

const homeOf = (env, home) => home || env.HOME || env.USERPROFILE || '.';

/** Per-user data folder when neither --data-dir nor DATA_DIR is given. */
function defaultDataDir(platform = process.platform, env = process.env, home) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(homeOf(env, home), 'AppData', 'Local'), 'manga-shelf', 'data');
    if (platform === 'darwin') return p.join(homeOf(env, home), 'Library', 'Application Support', 'manga-shelf');
    return p.join(env.XDG_DATA_HOME || p.join(homeOf(env, home), '.local', 'share'), 'manga-shelf');
}

/** Where the embedded web portal is unpacked; never inside the data folder (index.js refuses to serve from there). */
function defaultCacheDir(platform = process.platform, env = process.env, home) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    if (env.MANGA_SHELF_CACHE_DIR) return p.resolve(env.MANGA_SHELF_CACHE_DIR);
    // systemd CacheDirectory= (the packaged unit)
    if (platform !== 'win32' && env.CACHE_DIRECTORY) return env.CACHE_DIRECTORY.split(':')[0];
    if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(homeOf(env, home), 'AppData', 'Local'), 'manga-shelf', 'cache');
    if (platform === 'darwin') return p.join(homeOf(env, home), 'Library', 'Caches', 'manga-shelf');
    return p.join(env.XDG_CACHE_HOME || p.join(homeOf(env, home), '.cache'), 'manga-shelf');
}

module.exports = { parseArgs, parsePort, defaultDataDir, defaultCacheDir, UsageError, HELP };
