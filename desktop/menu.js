const { MODES, MODE_LABELS } = require('./modes');

/**
 * Application menu as an Electron template (pure: no Electron import, the main process passes state and actions).
 * state: { platform, mode, view, serverRunning, network, serverView, tray, autostart, setupPending }
 */
function buildMenuTemplate(state, actions) {
    const mac = state.platform === 'darwin';
    const serverMode = state.mode === 'server';
    const hasServer = Boolean(state.serverRunning);
    const showsCollection = state.view === 'local' || state.view === 'remote';

    const file = [
        // "&&" shows one "&" (a single one marks the access key on Windows/Linux and disappears)
        { id: 'api-keys', label: 'Quellen && Schlüssel…', accelerator: 'CmdOrCtrl+,', enabled: showsCollection, click: () => actions.openApiKeys() },
        { type: 'separator' },
        { id: 'backup-now', label: 'Backup jetzt', enabled: hasServer, click: () => actions.backupNow() },
        { id: 'open-data-dir', label: 'Datenordner öffnen', enabled: hasServer, click: () => actions.openDataDir() }
    ];
    if (state.setupPending) {
        file.push({ id: 'setup-code', label: 'Einrichtungscode anzeigen…', click: () => actions.showSetupCode() });
    }
    if (!mac) file.push({ type: 'separator' }, { id: 'quit', label: 'Beenden', accelerator: 'CmdOrCtrl+Q', click: () => actions.quit() });

    const modeItems = MODES.map((mode) => ({
        id: `mode-${mode}`,
        label: MODE_LABELS[mode],
        type: 'radio',
        checked: state.mode === mode,
        click: () => { if (state.mode !== mode) actions.setMode(mode); }
    }));
    const serverItems = [
        { id: 'address', label: 'Adresse für andere Geräte…', enabled: hasServer && Boolean(state.network), click: () => actions.showAddress() },
        { id: 'port', label: 'Port ändern…', enabled: serverMode, click: () => actions.changePort() },
        {
            id: 'server-view-remote',
            label: 'Fenster zeigt einen anderen Server',
            type: 'checkbox',
            enabled: serverMode,
            checked: serverMode && state.serverView === 'remote',
            click: (item) => actions.setServerView(item.checked ? 'remote' : 'local')
        },
        { id: 'tray', label: 'Server läuft im Hintergrund (Tray)', type: 'checkbox', enabled: serverMode, checked: Boolean(state.tray), click: (item) => actions.setTray(item.checked) },
        { id: 'autostart', label: 'Beim Anmelden starten', type: 'checkbox', checked: Boolean(state.autostart), click: (item) => actions.setAutostart(item.checked) }
    ];

    const template = [];
    if (mac) {
        template.push({
            label: 'Manga Shelf',
            submenu: [
                { role: 'about', label: 'Über Manga Shelf' },
                { type: 'separator' },
                { role: 'hide', label: 'Manga Shelf ausblenden' },
                { role: 'hideOthers', label: 'Andere ausblenden' },
                { role: 'unhide', label: 'Alle einblenden' },
                { type: 'separator' },
                { id: 'quit', label: 'Manga Shelf beenden', accelerator: 'Cmd+Q', click: () => actions.quit() }
            ]
        });
    }
    template.push(
        { label: 'Datei', submenu: file },
        {
            label: 'Bearbeiten',
            submenu: [
                { role: 'undo', label: 'Widerrufen' },
                { role: 'redo', label: 'Wiederholen' },
                { type: 'separator' },
                { role: 'cut', label: 'Ausschneiden' },
                { role: 'copy', label: 'Kopieren' },
                { role: 'paste', label: 'Einsetzen' },
                { role: 'selectAll', label: 'Alles auswählen' }
            ]
        },
        {
            label: 'Ansicht',
            submenu: [
                { role: 'reload', label: 'Neu laden' },
                { role: 'toggleDevTools', label: 'Entwicklertools' },
                { type: 'separator' },
                { role: 'resetZoom', label: 'Originalgröße' },
                { role: 'zoomIn', label: 'Vergrößern' },
                { role: 'zoomOut', label: 'Verkleinern' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: 'Vollbild' }
            ]
        },
        { label: 'Betriebsart', submenu: [...modeItems, { type: 'separator' }, ...serverItems] },
        { role: 'windowMenu', label: 'Fenster' }
    );
    return template;
}

/** Depth-first search for a menu item by id (tests and the main process). */
function findItem(template, id) {
    for (const item of template) {
        if (item.id === id) return item;
        if (Array.isArray(item.submenu)) {
            const hit = findItem(item.submenu, id);
            if (hit) return hit;
        }
    }
    return null;
}

module.exports = { buildMenuTemplate, findItem };
