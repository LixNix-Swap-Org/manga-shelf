const path = require('path');

/**
 * Where the bundled parts live. Packaged: resources/server, resources/app-frontend (app:// build) and resources/qr.mjs
 * (placed by scripts/stage.js). Development: the repository itself; MANGA_SHELF_APP_DIST points at another app build.
 */
function resolvePaths({ isPackaged, resourcesPath, desktopDir, env = process.env }) {
    if (isPackaged) {
        return {
            serverDir: path.join(resourcesPath, 'server'),
            appFrontendDir: path.join(resourcesPath, 'app-frontend'),
            qrModule: path.join(resourcesPath, 'qr.mjs'),
            trayIcon: path.join(desktopDir, 'assets', 'tray.png'),
            windowIcon: path.join(desktopDir, 'assets', 'icon.png')
        };
    }
    const repo = path.resolve(desktopDir, '..');
    return {
        serverDir: repo,
        appFrontendDir: env.MANGA_SHELF_APP_DIST ? path.resolve(env.MANGA_SHELF_APP_DIST) : path.join(repo, 'frontend', 'dist-app'),
        qrModule: path.join(repo, 'frontend', 'src', 'app', 'qr.js'),
        trayIcon: path.join(desktopDir, 'assets', 'tray.png'),
        windowIcon: path.join(desktopDir, 'assets', 'icon.png')
    };
}

/** DATA_DIR of the in-process server: --data-dir, else <userData>/data. */
const resolveDataDir = (argDataDir, userDataDir) => (argDataDir ? path.resolve(argDataDir) : path.join(userDataDir, 'data'));

module.exports = { resolvePaths, resolveDataDir };
