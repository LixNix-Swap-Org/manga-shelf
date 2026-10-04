/**
 * Tray menu while the server runs in the background. Pure template; createTray wires it with Electron's Tray.
 */
function buildTrayTemplate(state, actions) {
    return [
        { id: 'status', label: state.serverRunning ? `Server läuft (Port ${state.port})` : 'Server gestoppt', enabled: false },
        { type: 'separator' },
        { id: 'open', label: 'Öffnen', enabled: state.view !== null, click: () => actions.openWindow() },
        { id: 'copy-address', label: 'Adresse kopieren', enabled: Boolean(state.address), click: () => actions.copyAddress() },
        { id: 'backup-now', label: 'Backup jetzt', enabled: Boolean(state.serverRunning), click: () => actions.backupNow() },
        { type: 'separator' },
        { id: 'quit', label: 'Beenden', click: () => actions.quit() }
    ];
}

const trayTooltip = (state) => (state.address ? `Manga Shelf – ${state.address}` : 'Manga Shelf');

function createTray({ Tray, Menu, nativeImage }, iconPath, getState, actions) {
    const tray = new Tray(nativeImage.createFromPath(iconPath));
    const refresh = () => {
        const state = getState();
        tray.setToolTip(trayTooltip(state));
        tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate(state, actions)));
    };
    tray.on('double-click', () => actions.openWindow());
    refresh();
    return { tray, refresh, destroy: () => tray.destroy() };
}

module.exports = { buildTrayTemplate, trayTooltip, createTray };
