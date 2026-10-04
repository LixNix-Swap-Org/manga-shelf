// Operating modes of the desktop app: pure functions, no Electron API.
//   local  - "Nur auf diesem Gerät": server on 127.0.0.1, the window shows it (same origin, cookie session)
//   client - "Mit Server verbinden": no local server, the window runs the bundled app build (app://manga-shelf/)
//   server - "Dieses Gerät ist Server": server on 0.0.0.0, the window shows it (or another server), tray, autostart

const MODES = Object.freeze(['local', 'client', 'server']);
const MODE_LABELS = Object.freeze({
    local: 'Nur auf diesem Gerät',
    client: 'Mit Server verbinden',
    server: 'Dieses Gerät ist Server'
});
const MODE_DETAILS = Object.freeze({
    local: 'Deine Sammlung liegt auf diesem Computer. Kein anderes Gerät greift darauf zu.',
    client: 'Die Sammlung liegt auf einem Server (z. B. Docker oder Pterodactyl zu Hause); diese App verbindet sich damit.',
    server: 'Dieser Computer stellt die Sammlung im Heimnetz bereit: Handys und andere PCs verbinden sich mit ihm.'
});

const DEFAULT_SERVER_PORT = 3000;
const DEFAULT_LOCAL_PORT = 37210;
const LOOPBACK = '127.0.0.1';
const ALL_INTERFACES = '0.0.0.0';

const DEFAULT_SETTINGS = Object.freeze({
    mode: null,
    localPort: DEFAULT_LOCAL_PORT,
    serverPort: DEFAULT_SERVER_PORT,
    serverHost: ALL_INTERFACES,
    serverView: 'local',
    tray: true,
    autostart: false,
    setupToken: null
});

const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

function parsePort(raw) {
    const text = String(raw ?? '').trim();
    if (!/^\d{1,5}$/.test(text)) return null;
    const port = Number(text);
    return validPort(port) ? port : null;
}

/** Settings from disk with every unknown or broken value replaced by its default. */
function normalizeSettings(raw) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = { ...DEFAULT_SETTINGS };
    if (MODES.includes(input.mode)) out.mode = input.mode;
    if (validPort(input.localPort)) out.localPort = input.localPort;
    if (validPort(input.serverPort)) out.serverPort = input.serverPort;
    if (typeof input.serverHost === 'string' && input.serverHost.trim()) out.serverHost = input.serverHost.trim();
    if (input.serverView === 'remote') out.serverView = 'remote';
    if (typeof input.tray === 'boolean') out.tray = input.tray;
    if (typeof input.autostart === 'boolean') out.autostart = input.autostart;
    if (typeof input.setupToken === 'string' && input.setupToken) out.setupToken = input.setupToken;
    return out;
}

const DEEP_LINK = /^manga-shelf:\/\//i;

/**
 * Parses the command line (--server-only, --port, --host, --data-dir, --connect, --hidden, --user-data-dir, also
 * --flag=value, plus a manga-shelf:// link on Windows/Linux). Unknown arguments (Chromium, macOS -psn_) are ignored.
 */
function parseArgs(argv) {
    const args = { serverOnly: false, port: null, host: null, dataDir: null, userDataDir: null, connect: null, deepLink: null, hidden: false, errors: [] };
    const list = Array.isArray(argv) ? argv.map(String) : [];
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (DEEP_LINK.test(item)) {
            args.deepLink = item;
            continue;
        }
        const match = /^--([a-z-]+)(?:=(.*))?$/.exec(item);
        if (!match) continue;
        const [, name, inline] = match;
        const takesValue = ['port', 'host', 'data-dir', 'user-data-dir', 'connect'].includes(name);
        let value = inline;
        if (takesValue && value === undefined) {
            const next = list[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                value = next;
                i++;
            }
        }
        if (takesValue && (value === undefined || value === '')) {
            args.errors.push(`--${name} braucht einen Wert`);
            continue;
        }
        if (name === 'server-only') args.serverOnly = true;
        else if (name === 'hidden') args.hidden = true;
        else if (name === 'port') {
            const port = parsePort(value);
            if (port === null) args.errors.push(`--port: ungültiger Port „${value}“ (1–65535)`);
            else args.port = port;
        } else if (name === 'host') args.host = value.trim();
        else if (name === 'data-dir') args.dataDir = value;
        else if (name === 'user-data-dir') args.userDataDir = value;
        else if (name === 'connect') {
            if (/^https?:\/\//i.test(value) || DEEP_LINK.test(value)) args.connect = value;
            else args.errors.push(`--connect: Adresse muss mit http://, https:// oder manga-shelf:// beginnen („${value}“)`);
        }
    }
    return args;
}

const isLoopback = (host) => host === LOOPBACK || host === 'localhost' || host === '::1';

/**
 * What this run does: { mode, needsChoice, server: { host, port } | null, view: 'local' | 'remote' | null,
 * connect, tray }. Command-line flags win over the saved settings and are not saved.
 */
function resolveRun(settingsInput, args = parseArgs([])) {
    const settings = normalizeSettings(settingsInput);
    let mode = settings.mode;
    if (args.serverOnly) mode = 'server';
    else if (args.connect) mode = 'client';
    if (!mode) return { mode: null, needsChoice: true, server: null, view: null, connect: null, tray: false };

    let server = null;
    if (mode === 'local') {
        server = { host: args.host || LOOPBACK, port: args.port || settings.localPort };
    } else if (mode === 'server') {
        server = { host: args.host || settings.serverHost, port: args.port || settings.serverPort };
    }
    let view = mode === 'client' || (mode === 'server' && settings.serverView === 'remote') ? 'remote' : 'local';
    if (args.connect) view = 'remote';
    if (args.serverOnly) view = null;
    const network = Boolean(server) && !isLoopback(server.host);
    return {
        mode,
        needsChoice: false,
        server,
        view,
        connect: args.connect || null,
        network,
        tray: Boolean(server) && (args.serverOnly || (mode === 'server' && settings.tray))
    };
}

/** Settings after choosing `mode` in the first-start dialog or the menu. */
function withMode(settingsInput, mode) {
    if (!MODES.includes(mode)) throw new Error(`Unbekannte Betriebsart: ${mode}`);
    return { ...normalizeSettings(settingsInput), mode };
}

/** Same server process (host and port) means no restart is needed when the mode changes. */
const sameServer = (a, b) => Boolean(a) && Boolean(b) && a.host === b.host && a.port === b.port;

/** Host the app itself uses to reach its server: loopback unless the server is bound to one specific address. */
const windowHost = (host) => (!host || host === ALL_INTERFACES || host === '::' || isLoopback(host) ? LOOPBACK : host);

const hostInUrl = (host) => (host.includes(':') ? `[${host}]` : host);

/** Origin of the in-process server as the app reaches it. */
const serverOrigin = (port, host) => `http://${hostInUrl(windowHost(host))}:${port}`;

/** The URL the window shows for a local view. */
const localWindowUrl = (port, host) => `${serverOrigin(port, host)}/`;

module.exports = {
    MODES,
    MODE_LABELS,
    MODE_DETAILS,
    DEFAULT_SETTINGS,
    DEFAULT_LOCAL_PORT,
    DEFAULT_SERVER_PORT,
    LOOPBACK,
    ALL_INTERFACES,
    normalizeSettings,
    parseArgs,
    parsePort,
    resolveRun,
    withMode,
    sameServer,
    isLoopback,
    windowHost,
    serverOrigin,
    localWindowUrl
};
