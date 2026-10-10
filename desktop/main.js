const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, ipcMain, clipboard, protocol, net, safeStorage, powerMonitor, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, resolveRun, withMode, sameServer, localWindowUrl, parsePort, deepLinkAction, MODE_LABELS, MODE_DETAILS, MODES } = require('./modes');
const { buildMenuTemplate } = require('./menu');
const { createTray } = require('./tray');
const { createSettings } = require('./lib/settings');
const { createSecureStore, safeStorageCrypto } = require('./lib/secureStore');
const { createServerController, createSerialQueue, createRunSwitcher, createLockedWarning, permissionAllowed, generateSetupToken, BUSY_MESSAGE } = require('./lib/server');
const { originOf, APP_SCHEME, APP_ORIGIN, APP_START_URL, APP_SCHEME_PRIVILEGES, registerAppProtocol } = require('./lib/appProtocol');
const { lanAddresses, serverAddress, connectLink } = require('./lib/lan');
const { addressPage, portPage, dataUrl } = require('./lib/pages');
const { qrSvgData } = require('./lib/qrCode');
const { resolvePaths, resolveDataDir } = require('./lib/paths');
const { setAutostart, startedAtLogin } = require('./lib/autostart');
const { createWatchSecret } = require('./lib/watchSecret');
const { createWatchPrefs } = require('./lib/watchPrefs');
const { createTransport } = require('./lib/watchTransport');
const { createForeground } = require('./lib/watchForeground');
const { createWatchService } = require('./lib/watchService');
const { createWatchLogin, browserUserAgent, registerClientCertificateGuard } = require('./lib/watchLogin');
const { registerWatchIpc } = require('./lib/watchIpc');

const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const startArgs = parseArgs(argv);
for (const error of startArgs.errors) process.stderr.write(`[Manga Shelf] ${error}\n`);
if (startArgs.userDataDir) app.setPath('userData', path.resolve(startArgs.userDataDir));

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);

const paths = resolvePaths({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, desktopDir: __dirname });
const log = (line) => process.stdout.write(`[Desktop] ${line}\n`);

let settings = null;
let secureStore = null;
let serverCtl = null;
let dataDir = null;
let overrides = startArgs;
let run = null;
let mainWindow = null;
let trayCtl = null;
let quitting = false;
let stopped = false;
let setupPending = false;
let pendingUrl = startArgs.deepLink || null;
let bridgeReady = false;
let hiddenStart = false;
let foreground = null;
let login = null;
let service = null;
// every change of mode, port, view or tray runs after the previous one has finished
const runQueue = createSerialQueue();

const localOrigin = () => (serverCtl?.current() ? originOf(serverCtl.current().url) : null);
const senderOrigin = (event) => originOf(event.senderFrame?.url || event.sender?.getURL?.() || '');
const fromApp = (event) => senderOrigin(event) === APP_ORIGIN;
const fromLocal = (event) => Boolean(localOrigin()) && senderOrigin(event) === localOrigin();
const fromOwnPage = (event) => fromApp(event) || fromLocal(event);
const isWatchSender = (event) => fromOwnPage(event) && event.sender === mainWindow?.webContents;
const isWebUrl = (url) => /^https?:\/\//i.test(String(url || ''));

function openExternal(url) {
    if (isWebUrl(url)) shell.openExternal(url).catch((err) => log(`Link nicht geöffnet: ${err.message}`));
}

function viewUrl() {
    if (!run || !run.view) return null;
    if (run.view === 'remote') return APP_START_URL;
    const current = serverCtl?.current();
    return current ? localWindowUrl(current.port, current.host) : null;
}

function rebuildMenu() {
    const current = serverCtl?.current();
    const state = {
        platform: process.platform,
        mode: run?.mode,
        view: run?.view ?? null,
        serverRunning: Boolean(current),
        network: Boolean(run?.network),
        serverView: settings.get().serverView,
        tray: settings.get().tray,
        autostart: settings.get().autostart,
        setupPending
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(state, menuActions)));
    trayCtl?.refresh();
}

function currentAddress() {
    const current = serverCtl?.current();
    if (!current || !run?.network) return null;
    return serverAddress(current.host, current.port, os.networkInterfaces());
}

function trayState() {
    const current = serverCtl?.current();
    return { serverRunning: Boolean(current), port: current?.port, address: currentAddress(), view: run?.view ?? null };
}

function syncTray() {
    if (run?.tray && !trayCtl) {
        try {
            trayCtl = createTray({ Tray, Menu, nativeImage }, paths.trayIcon, trayState, trayActions);
        } catch (err) {
            log(`Tray nicht verfügbar: ${err.message}`);
        }
    } else if (!run?.tray && trayCtl) {
        trayCtl.destroy();
        trayCtl = null;
    }
    trayCtl?.refresh();
}

function guardNavigation(contents) {
    contents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
        const allowed = originOf(viewUrl() || '');
        if (allowed && originOf(url) === allowed) return;
        event.preventDefault();
        openExternal(url);
    });
    contents.on('will-redirect', (details) => {
        if (details.isMainFrame && originOf(details.url) !== originOf(viewUrl() || '')) details.preventDefault();
    });
}

function createMainWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 360,
        minHeight: 480,
        show: false,
        title: 'Manga Shelf',
        icon: process.platform === 'linux' ? paths.windowIcon : undefined,
        backgroundColor: '#0f172a',
        autoHideMenuBar: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false
        }
    });
    guardNavigation(win.webContents);
    foreground.attach(win);
    win.webContents.on('did-start-loading', () => { bridgeReady = false; });
    win.once('ready-to-show', () => { if (!hiddenStart) win.show(); });
    win.on('close', (event) => {
        if (!quitting && trayCtl) {
            event.preventDefault();
            win.hide();
        }
    });
    win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
    return win;
}

function showWindow() {
    hiddenStart = false;
    if (!run?.view) return;
    if (!mainWindow) {
        mainWindow = createMainWindow();
        const url = viewUrl();
        if (url) mainWindow.loadURL(url);
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

async function startServer() {
    if (!run.server) {
        try {
            await serverCtl?.stop();
            return true;
        } catch (err) {
            if (err.code !== 'SERVER_BUSY') throw err;
            await showBusy(err.jobs);
            return false;
        }
    }
    const before = serverCtl.current();
    if (before && sameServer(before, run.server)) return true;
    try {
        const started = await serverCtl.start({
            host: run.server.host,
            port: run.server.port,
            fallbackPort: run.mode === 'local',
            console: Boolean(overrides.serverOnly && process.stdin.isTTY)
        });
        if (run.mode === 'local' && started.port !== run.server.port && !overrides.port) settings.update({ localPort: started.port });
        log(`Server läuft auf ${run.server.host}:${started.port}`);
        return true;
    } catch (err) {
        if (err.code === 'SERVER_BUSY') {
            await showBusy(err.jobs);
            return false;
        }
        log(`Server-Start fehlgeschlagen: ${err.message}`);
        const busy = err.code === 'EADDRINUSE';
        const choice = await dialog.showMessageBox({
            type: 'error',
            title: 'Server nicht gestartet',
            message: busy ? `Port ${run.server.port} ist schon belegt.` : 'Der Server konnte nicht starten.',
            detail: busy ? 'Ein anderes Programm (oder eine zweite Manga-Shelf-Instanz) nutzt diesen Port. Wähle einen anderen Port.' : err.message,
            buttons: busy && run.mode === 'server' ? ['Port ändern…', 'Beenden'] : ['Beenden'],
            defaultId: 0,
            noLink: true
        });
        if (busy && run.mode === 'server' && choice.response === 0) {
            const port = await promptPort();
            if (port) {
                settings.update({ serverPort: port });
                return applyRun();
            }
        }
        app.quit();
        return false;
    }
}

function showBusy(jobs = []) {
    return dialog.showMessageBox({
        type: 'info',
        title: 'Betriebsart',
        message: BUSY_MESSAGE,
        detail: jobs.length ? `Läuft gerade: ${jobs.join(', ')}` : undefined
    });
}

function refreshRun() {
    run = resolveRun(settings.get(), overrides);
    syncTray();
    rebuildMenu();
}

const warnLockedStore = createLockedWarning({
    isLocked: () => Boolean(secureStore?.locked),
    show: () => dialog.showMessageBox({
        type: 'warning',
        title: 'Schlüsselbund nicht verfügbar',
        message: 'Schlüsselbund nicht verfügbar',
        detail: 'Gespeicherte Server und Anmeldungen bleiben verschlüsselt erhalten, sind aber gerade nicht lesbar. Änderungen gelten nur bis zum Beenden. Schlüsselbund entsperren und Manga Shelf neu starten.'
    })
});

/** Every change of mode, port, view or tray (see createRunSwitcher); a refused one is undone. */
const switchRun = createRunSwitcher({
    queue: runQueue,
    settings: { get: () => settings.get(), update: (patch) => settings.update(patch) },
    getOverrides: () => overrides,
    setOverrides: (next) => { overrides = next; },
    resolveRun,
    controller: { current: () => serverCtl.current(), busy: () => serverCtl.busy() },
    apply: (options) => applyRun(options),
    showBusy,
    refresh: refreshRun
});

async function refreshSetupState() {
    setupPending = serverCtl?.current() ? await serverCtl.needsSetup() : false;
}

async function applyRun({ announceSetup = false } = {}) {
    run = resolveRun(settings.get(), overrides);
    if (run.view === 'remote' && !fs.existsSync(path.join(paths.appFrontendDir, 'index.html'))) {
        dialog.showErrorBox('Manga Shelf', `Der App-Build fehlt (${paths.appFrontendDir}). Im Frontend "npm run build:app" ausführen oder MANGA_SHELF_APP_DIST setzen.`);
    }
    if (!(await startServer())) return false;
    await refreshSetupState();
    syncTray();
    rebuildMenu();
    if (run.view) {
        const url = viewUrl();
        if (!mainWindow) mainWindow = createMainWindow();
        if (url && originOf(mainWindow.webContents.getURL()) !== originOf(url)) mainWindow.loadURL(url);
    } else if (mainWindow) {
        mainWindow.destroy();
        mainWindow = null;
    }
    warnLockedStore(run.view);
    if (pendingUrl && run.view === 'remote') deliverUrl(pendingUrl);
    if (announceSetup && setupPending && run.view === 'local' && mainWindow) {
        if (mainWindow.isVisible()) showSetupCode();
        else mainWindow.once('ready-to-show', () => showSetupCode());
    }
    return true;
}

async function setMode(mode) {
    if (!MODES.includes(mode)) return;
    const switched = await switchRun(() => {
        if (mode === run?.mode) return false;
        settings.update(withMode(settings.get(), mode));
        overrides = { ...parseArgs([]), dataDir: overrides.dataDir };
        return true;
    }, { announceSetup: true });
    if (switched) showWindow();
}

async function chooseMode() {
    const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Manga Shelf einrichten',
        message: 'Wie möchtest du Manga Shelf nutzen?',
        detail: MODES.map((m) => `${MODE_LABELS[m]}: ${MODE_DETAILS[m]}`).join('\n\n') + '\n\nDu kannst das später im Menü „Betriebsart“ ändern.',
        buttons: [...MODES.map((m) => MODE_LABELS[m]), 'Beenden'],
        defaultId: 0,
        cancelId: MODES.length,
        noLink: true
    });
    return MODES[response] || null;
}

function deliverUrl(url) {
    pendingUrl = url;
    if (mainWindow && bridgeReady) {
        mainWindow.webContents.send('desktop:open-url', url);
        pendingUrl = null;
    }
}

async function handleDeepLink(url) {
    const action = deepLinkAction({ url, ready: Boolean(settings && run), view: run?.view });
    if (action === 'ignore') return;
    if (action === 'pending') {
        pendingUrl = url;
        return;
    }
    if (action === 'show') {
        showWindow();
        return;
    }
    if (action === 'confirm') {
        const { response } = await dialog.showMessageBox({
            type: 'question',
            title: 'Mit Server verbinden',
            message: 'Mit diesem Server verbinden?',
            detail: `Die App wechselt in die Betriebsart „${MODE_LABELS.client}“. Deine lokale Sammlung bleibt erhalten.`,
            buttons: ['Verbinden', 'Abbrechen'],
            defaultId: 0,
            cancelId: 1,
            noLink: true
        });
        if (response !== 0) return;
        pendingUrl = url;
        await setMode('client');
        return;
    }
    deliverUrl(url);
    showWindow();
}

function dialogWindow({ html, width, height, title, onSubmit }) {
    const parent = mainWindow && mainWindow.isVisible() ? mainWindow : undefined;
    const win = new BrowserWindow({
        width, height, title, parent, modal: Boolean(parent), resizable: false, minimizable: false, maximizable: false,
        show: false, autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'ui', 'dialogPreload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    win.setMenu(null);
    guardDialog(win, onSubmit);
    win.loadURL(dataUrl(html));
    win.once('ready-to-show', () => win.show());
    return win;
}

const dialogHandlers = new Map();
function guardDialog(win, onSubmit) {
    const id = win.webContents.id;
    dialogHandlers.set(id, { win, onSubmit });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('closed', () => {
        const entry = dialogHandlers.get(id);
        dialogHandlers.delete(id);
        entry?.onSubmit?.(null);
    });
}

function promptPort() {
    return new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            resolve(value);
        };
        dialogWindow({
            html: portPage({ port: settings.get().serverPort, hint: 'Andere Geräte erreichen den Server unter dieser Portnummer (Standard 3000). Der Server startet danach neu.' }),
            width: 420, height: 300, title: 'Port ändern',
            onSubmit: (value) => finish(value === null ? null : parsePort(value))
        });
    });
}

async function showAddress() {
    const address = currentAddress();
    if (!address) {
        await dialog.showMessageBox({ type: 'info', title: 'Adresse für andere Geräte', message: 'Keine Netzwerkadresse gefunden.', detail: 'Der Server ist nur auf diesem Gerät erreichbar oder der Computer hat keine Verbindung zum Heimnetz.' });
        return;
    }
    const health = await serverCtl.health();
    const link = connectLink({ url: address, name: health?.name || 'Manga Shelf', instanceId: health?.instance_id });
    let qr = null;
    try {
        qr = await qrSvgData(link, paths.qrModule);
    } catch (err) {
        log(`QR-Code nicht erzeugt: ${err.message}`);
    }
    const current = serverCtl.current();
    const others = lanAddresses(os.networkInterfaces()).map((a) => `http://${a}:${current.port}`).filter((a) => a !== address);
    dialogWindow({ html: addressPage({ address, link, qr, others }), width: 460, height: 620, title: 'Adresse für andere Geräte' });
}

async function showSetupCode() {
    const token = settings.get().setupToken;
    if (!token) return;
    const options = {
        type: 'info',
        title: 'Ersteinrichtung',
        message: 'Lege jetzt das Admin-Konto an.',
        detail: `Der Einrichtungsassistent fragt nach dem Einrichtungscode:\n\n${token}\n\nDu findest ihn später im Menü „Datei“ → „Einrichtungscode anzeigen…“.`,
        buttons: ['Code kopieren', 'Schließen'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
    };
    const parent = mainWindow && mainWindow.isVisible() ? mainWindow : null;
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (response === 0) clipboard.writeText(token);
}

async function backupNow() {
    try {
        const result = await serverCtl.backupNow();
        await dialog.showMessageBox({
            type: result.ok ? 'info' : 'warning',
            title: 'Backup',
            message: result.ok ? 'Backup erstellt.' : 'Backup mit Problemen.',
            detail: result.lines.join('\n')
        });
    } catch (err) {
        await dialog.showMessageBox({ type: 'error', title: 'Backup', message: 'Backup fehlgeschlagen.', detail: err.message });
    }
}

const menuActions = {
    openApiKeys: () => {
        showWindow();
        mainWindow?.webContents.send('desktop:open-api-keys');
    },
    backupNow,
    openDataDir: () => shell.openPath(dataDir),
    showSetupCode,
    setMode: (mode) => { setMode(mode).catch((err) => log(`Moduswechsel fehlgeschlagen: ${err.message}`)); },
    setServerView: async (view) => {
        if (await switchRun(() => { settings.update({ serverView: view }); })) showWindow();
    },
    setTray: (on) => switchRun(() => { settings.update({ tray: on }); }),
    setAutostart: (on) => {
        try {
            setAutostart(app, on);
            settings.update({ autostart: on });
        } catch (err) {
            dialog.showErrorBox('Autostart', `Autostart konnte nicht geändert werden: ${err.message}`);
        }
        rebuildMenu();
    },
    changePort: async () => {
        const port = await promptPort();
        if (!port || port === settings.get().serverPort) return;
        await switchRun(() => {
            settings.update({ serverPort: port });
            overrides = { ...overrides, port: null };
        });
    },
    showAddress,
    quit: () => app.quit()
};

const trayActions = {
    openWindow: showWindow,
    copyAddress: () => {
        const address = currentAddress();
        if (address) clipboard.writeText(address);
    },
    backupNow,
    quit: () => app.quit()
};

function registerIpc() {
    ipcMain.on('desktop:locale', (event) => {
        event.returnValue = fromOwnPage(event) ? app.getLocale() : null;
    });
    ipcMain.on('desktop:store-all', (event) => {
        event.returnValue = fromApp(event) ? secureStore.all() : {};
    });
    ipcMain.handle('desktop:store-set', (event, key, value) => (fromApp(event) ? secureStore.set(key, value) : false));
    ipcMain.handle('desktop:store-remove', (event, key) => (fromApp(event) ? secureStore.remove(key) : false));
    ipcMain.on('desktop:open-external', (event, url) => {
        if (fromOwnPage(event)) openExternal(url);
    });
    ipcMain.on('desktop:set-mode', (event, mode) => {
        if (fromOwnPage(event)) menuActions.setMode(mode);
    });
    ipcMain.handle('desktop:setup-token', async (event) => {
        if (!fromLocal(event)) return null;
        await refreshSetupState();
        return setupPending ? settings.get().setupToken : null;
    });
    ipcMain.handle('desktop:take-pending-url', (event) => {
        if (!fromApp(event)) return null;
        bridgeReady = true;
        const url = pendingUrl;
        pendingUrl = null;
        return url;
    });
    ipcMain.handle('desktop:info', (event) => (fromOwnPage(event)
        ? { version: app.getVersion(), mode: run?.mode ?? null, view: run?.view ?? null, secureStorage: secureStore.encrypted, secureStorageLocked: secureStore.locked }
        : null));
    ipcMain.on('desktop:open-api-keys-unhandled', () => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Quellen & Schlüssel',
            message: 'Bitte zuerst anmelden.',
            detail: 'Quellen & Schlüssel stehen nach der Anmeldung in der Sammlung bereit (Konto → API-Schlüssel).'
        });
    });
    ipcMain.on('desktop-dialog:submit', (event, value) => {
        const entry = dialogHandlers.get(event.sender.id);
        if (!entry) return;
        dialogHandlers.delete(event.sender.id);
        entry.onSubmit?.(value);
        entry.win.close();
    });
    ipcMain.on('desktop-dialog:cancel', (event) => dialogHandlers.get(event.sender.id)?.win.close());
    ipcMain.on('desktop-dialog:copy', (event, text) => {
        if (dialogHandlers.has(event.sender.id) && typeof text === 'string') clipboard.writeText(text);
    });
}

function registerSession() {
    const ses = session.defaultSession;
    ses.on('will-download', (_event, item) => {
        item.setSaveDialogOptions({ title: 'Speichern unter', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
        item.once('done', (_e, state) => {
            if (state === 'interrupted') dialog.showErrorBox('Download', `„${item.getFilename()}“ konnte nicht gespeichert werden.`);
        });
    });
    // camera for the barcode scanner and the clipboard, only for the app's own pages
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
        const origin = originOf(details?.requestingUrl || contents.getURL());
        callback(permissionAllowed({ permission, origin, appOrigin: APP_ORIGIN, localOrigin: localOrigin() }));
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine) => {
        const link = parseArgs(commandLine).deepLink;
        if (link) handleDeepLink(link);
        else showWindow();
    });
    app.on('will-finish-launching', () => {
        app.on('open-url', (event, url) => {
            event.preventDefault();
            handleDeepLink(url);
        });
    });
    app.on('window-all-closed', () => {
        if (!quitting && (trayCtl || process.platform === 'darwin')) return;
        app.quit();
    });
    app.on('activate', () => showWindow());
    // Ctrl+C in --server-only and a service manager's SIGTERM end the server like "Beenden"
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.quit());
    app.on('before-quit', (event) => {
        quitting = true;
        login?.finishPending('cancelled');
        if (stopped || !serverCtl?.current()) return;
        event.preventDefault();
        serverCtl.stop({ force: true })
            .catch((err) => log(`Server-Stopp: ${err.message}`))
            .finally(() => {
                stopped = true;
                app.quit();
            });
    });

    app.whenReady().then(async () => {
        if (process.defaultApp) {
            app.setAsDefaultProtocolClient('manga-shelf', process.execPath, [path.resolve(process.argv[1] || '.')]);
        } else {
            app.setAsDefaultProtocolClient('manga-shelf');
        }
        const userData = app.getPath('userData');
        settings = createSettings(userData);
        secureStore = createSecureStore(userData, safeStorageCrypto(safeStorage));
        dataDir = resolveDataDir(startArgs.dataDir, userData);
        if (!settings.get().setupToken) settings.update({ setupToken: generateSetupToken() });
        serverCtl = createServerController({ serverDir: paths.serverDir, dataDir, setupToken: settings.get().setupToken, log });
        registerAppProtocol({ protocol, net }, paths.appFrontendDir);
        registerSession();
        registerIpc();
        const crunchyroll = require(path.join(paths.serverDir, 'core', 'watch', 'crunchyroll.js'));
        const { createFlow, FlowError } = require(path.join(paths.serverDir, 'core', 'watch', 'crunchyrollFlow.js'));
        const apiSession = session.fromPartition('crunchyroll-api', { cache: false });
        const ua = browserUserAgent(app.userAgentFallback);
        const secret = createWatchSecret({ file: path.join(userData, 'watch-secret.json'), safeStorage, platform: process.platform });
        const prefs = createWatchPrefs({ file: path.join(userData, 'watch-state.json') });
        const transport = createTransport({ net, session: apiSession, userAgent: ua, isAllowedUrl: crunchyroll.isAllowedApiUrl, deadlineMs: 20000 });
        foreground = createForeground({ powerMonitor, net, platform: process.platform, timers: { setTimeout, clearTimeout, setInterval, clearInterval } });
        service = createWatchService({ createFlow, FlowError, crunchyroll, secret, transport, apiSession, randomUUID: crypto.randomUUID, now: Date.now, isForeground: foreground.isForeground });
        login = createWatchLogin({ BrowserWindow, session, dialog, app, getMainWindow: () => mainWindow, service, crunchyroll, userAgent: ua });
        registerClientCertificateGuard(app, login.isLoginContents);
        registerWatchIpc({ ipcMain, isWatchSender, service, login, prefs, foreground });
        powerMonitor.on('resume', () => mainWindow?.webContents.send('desktop:resume'));

        if (resolveRun(settings.get(), overrides).needsChoice) {
            const mode = await chooseMode();
            if (!mode) {
                app.quit();
                return;
            }
            settings.update(withMode(settings.get(), mode));
        }
        hiddenStart = Boolean(overrides.serverOnly) || (startedAtLogin(app, argv) && Boolean(resolveRun(settings.get(), overrides).tray));
        if (overrides.connect) pendingUrl = overrides.connect;
        const startLink = pendingUrl;
        await runQueue(() => applyRun({ announceSetup: true }));
        log(`Betriebsart ${run?.mode}, Daten in ${dataDir}`);
        if (startLink && run?.view !== 'remote') {
            pendingUrl = null;
            await handleDeepLink(startLink);
        }
    }).catch((err) => {
        dialog.showErrorBox('Manga Shelf', `Start fehlgeschlagen: ${err.message}`);
        app.exit(1);
    });
}
