// The built web portal inside the server binary: SEA assets (web/<datei> + web-manifest.json) or, for the plain
// bundle, the web/ folder next to it. It is unpacked once per build into
// <cache>/manga-shelf-portal/server-<id>/frontend/dist; old builds are only ever removed inside that folder.
const fs = require('fs');
const path = require('path');

const MANIFEST = 'web-manifest.json';
const PORTAL_DIR = 'manga-shelf-portal';
const PORTAL_MARKER = '.manga-shelf-portal';

/** The folder the portal builds live in (MANGA_SHELF_CACHE_DIR may be a shared folder). */
const portalDir = (cacheDir) => path.join(cacheDir, PORTAL_DIR);
const appDirFor = (cacheDir, id) => path.join(portalDir(cacheDir), `server-${id}`);

function seaModule() {
    try {
        const sea = require('node:sea');
        return sea.isSea() ? sea : null;
    } catch (e) {
        return null;
    }
}

/** { id, files, read(rel) } or null when the binary carries no portal. `dir` is the folder of the plain bundle. */
function webSource(dir) {
    const sea = seaModule();
    if (sea) {
        const manifest = JSON.parse(sea.getAsset(MANIFEST, 'utf8'));
        return { ...manifest, read: (rel) => Buffer.from(sea.getAsset(`web/${rel}`)) };
    }
    const manifestPath = path.join(dir, MANIFEST);
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { ...manifest, read: (rel) => fs.readFileSync(path.join(dir, 'web', ...rel.split('/'))) };
}

const isInside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Unpacks the portal into <cacheDir>/manga-shelf-portal/server-<id> unless that build is there, removes older builds
 * (only in a folder with this program's marker file) and returns the app folder.
 */
function prepareAppDir({ cacheDir, source, dataDir }) {
    const base = portalDir(cacheDir);
    const root = appDirFor(cacheDir, source.id);
    if (dataDir && (isInside(path.resolve(dataDir), root) || isInside(root, path.resolve(dataDir)))) {
        throw new Error(`Der Cache-Ordner ${cacheDir} liegt im oder um den Datenordner; bitte MANGA_SHELF_CACHE_DIR auf einen anderen Ordner setzen.`);
    }
    const marker = path.join(base, PORTAL_MARKER);
    if (!fs.existsSync(base)) {
        fs.mkdirSync(base, { recursive: true });
        fs.writeFileSync(marker, 'Manga Shelf Server: entpackte Web-Portale, wird automatisch aufgeräumt\n');
    }
    if (!fs.existsSync(path.join(root, '.complete'))) {
        const tmp = `${root}.tmp-${process.pid}`;
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const rel of source.files) {
            const dest = path.join(tmp, 'frontend', 'dist', ...rel.split('/'));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, source.read(rel));
        }
        fs.writeFileSync(path.join(tmp, '.complete'), `${source.id}\n`);
        fs.rmSync(root, { recursive: true, force: true });
        try {
            fs.renameSync(tmp, root);
        } catch (err) {
            fs.rmSync(tmp, { recursive: true, force: true });
            if (!fs.existsSync(path.join(root, '.complete'))) throw err;
        }
    }
    if (fs.existsSync(marker)) {
        for (const name of fs.readdirSync(base)) {
            if (name.startsWith('server-') && name !== path.basename(root) && !name.includes('.tmp-')) {
                try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch (e) { /* in use */ }
            }
        }
    }
    return root;
}

module.exports = { webSource, prepareAppDir, portalDir, appDirFor, MANIFEST, PORTAL_DIR, PORTAL_MARKER };
