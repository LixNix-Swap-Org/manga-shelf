// Start at login for the server mode: login item on macOS/Windows, an XDG autostart entry on Linux.
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTOSTART_ARG = '--hidden';
const LINUX_FILE = 'manga-shelf.desktop';

const quoteExec = (value) => (/[\s"'\\$`]/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value);

/** XDG autostart entry (Linux has no login item API in Electron). */
function linuxAutostartEntry(exec) {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Manga Shelf',
        'Comment=Manga Shelf im Hintergrund starten',
        `Exec=${quoteExec(exec)} ${AUTOSTART_ARG}`,
        'X-GNOME-Autostart-enabled=true',
        'Terminal=false',
        ''
    ].join('\n');
}

const linuxAutostartFile = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', LINUX_FILE);

/** Turns "Beim Anmelden starten" on or off. The AppImage path wins over the mounted executable on Linux. */
function setAutostart(app, enabled, { platform = process.platform, env = process.env } = {}) {
    if (platform === 'linux') {
        const file = linuxAutostartFile(env);
        if (enabled) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, linuxAutostartEntry(env.APPIMAGE || process.execPath));
        } else {
            fs.rmSync(file, { force: true });
        }
        return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? [AUTOSTART_ARG] : [] });
}

/** True when this start came from the login item (then the window stays hidden in tray mode). */
function startedAtLogin(app, argv, platform = process.platform) {
    if (argv.includes(AUTOSTART_ARG)) return true;
    if (platform !== 'darwin') return false;
    try { return Boolean(app.getLoginItemSettings().wasOpenedAtLogin); } catch (_) { return false; }
}

module.exports = { AUTOSTART_ARG, linuxAutostartEntry, linuxAutostartFile, setAutostart, startedAtLogin };
