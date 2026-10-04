// Suppress Node.js 25+ fs.Stats constructor deprecation warning from internal dependencies
const origEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if ((args[0] && (args[0] === 'DEP0180' || args[0].code === 'DEP0180')) ||
        (warning && (warning.code === 'DEP0180' || (typeof warning === 'string' && warning.includes('fs.Stats'))))) {
        return;
    }
    return origEmitWarning.call(process, warning, ...args);
};

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const http = require('http');
const https = require('https');
const { config, validateConfig, loadDotenv } = require('./utils/config');
// Tests import the app with MANGA_SHELF_NO_LISTEN=1 and must not pick up a developer's .env
if (!config.noListen) loadDotenv();
const log = require('./utils/logger').child('app');

try {
    validateConfig(log);
} catch (err) {
    if (config.noListen) throw err;
    log.error(`[Konfiguration] ${err.message}`);
    process.exit(1);
}

const pkg = require('./package.json');
const { db, closeDb, uploadsDir, dataDir, getInstanceId } = require('./db');
const { initScheduler, lastVerifiedSnapshot } = require('./services/scheduler');
const lifecycle = require('./services/lifecycle');
const { setStaticHeaders, createUploadHeaders } = require('./utils/staticHeaders');
const { freeBytes } = require('./utils/disk');
const { defaultCode, errorBody } = require('./utils/httpError');
const { requireEditor } = require('./middleware/auth');
const { createOriginCheck, normalizeOrigin } = require('./middleware/originCheck');
const { ALLOWED_IMAGE_EXTS } = require('./middleware/upload');

const authRoutes = require('./routes/auth');
const mangasRoutes = require('./routes/mangas');
const volumesRoutes = require('./routes/volumes');
const backupsRoutes = require('./routes/backups');
const statsRoutes = require('./routes/stats');
const radarRoutes = require('./routes/radar');
const lookupRoutes = require('./routes/lookup');
const exchangeRoutes = require('./routes/exchange');

// The CSP allows https/http images because a cover may still point at another host, and inline styles because the
// build and the React components use them; scripts and fonts (self-hosted) only come from this server.
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: http: https:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
].join('; ');
// camera stays allowed for this origin (a live barcode scanner would need getUserMedia)
const PERMISSIONS_POLICY = 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()';
const HSTS = 'max-age=15552000';
const APP_CORS = {
    origin: true,
    credentials: false,
    allowedHeaders: ['Authorization', 'X-Client', 'Content-Type', 'If-None-Match'],
    exposedHeaders: ['ETag', 'X-Request-Id', 'Retry-After', 'Content-Disposition'],
    maxAge: 600
};

const CLIENT_ERROR_TEXTS = {
    400: 'Ungültige Anfrage',
    403: 'Zugriff verweigert',
    404: 'Nicht gefunden',
    405: 'Methode nicht erlaubt',
    413: 'Anfrage ist zu groß',
    415: 'Format wird nicht unterstützt'
};

const formatLimit = (bytes) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`);

// Limits as configured in middleware/upload.js
function uploadErrorMessage(err) {
    switch (err.code) {
        case 'LIMIT_FILE_SIZE': return err.field === 'backup' ? 'Backup ist größer als 500 MB' : 'Bild ist größer als 15 MB';
        case 'LIMIT_UNEXPECTED_FILE': return err.field === 'images' ? 'Höchstens 10 Bilder auf einmal' : 'Unerwartetes Dateifeld im Upload';
        case 'LIMIT_FILE_COUNT': return 'Zu viele Dateien auf einmal';
        default: return 'Upload abgelehnt';
    }
}

// Errors of Express, body-parser, serve-static and multer carry `type` or a boolean `expose` and English texts
const isLibraryError = (err) => Boolean(err.type) || (typeof err.expose === 'boolean' && err.name !== 'HttpError') || err instanceof URIError;

function clientErrorMessage(err, req, status) {
    if (err.name === 'MulterError') return uploadErrorMessage(err);
    if (err.type === 'entity.parse.failed') return 'Ungültige Anfrage (fehlerhaftes JSON)';
    if (err.type === 'entity.too.large') {
        const max = Number.isFinite(err.limit) ? ` (max. ${formatLimit(err.limit)})` : '';
        return (/^\/api\/import\/csv\/?$/i.test(req.path) ? 'CSV-Datei ist zu groß' : 'Anfrage ist zu groß') + max;
    }
    if (isLibraryError(err)) return CLIENT_ERROR_TEXTS[status] || 'Anfrage konnte nicht verarbeitet werden';
    return err.message;
}

// Own codes are upper-case words joined by "_" (SCHEMA_NEWER); errno (ENOENT) and Node's ERR_* codes stay internal
const isAppCode = (code) => typeof code === 'string' && /^[A-Z]+(?:_[A-Z]+)*$/.test(code) && !code.startsWith('ERR_') && !/^E[A-Z]+$/.test(code);

function errorCode(err, status) {
    if (err.type === 'entity.parse.failed') return 'INVALID_JSON';
    if (err.type === 'entity.too.large') return 'PAYLOAD_TOO_LARGE';
    if (err.name === 'MulterError') return 'UPLOAD_REJECTED';
    if (isAppCode(err.code) && !isLibraryError(err) && (status !== 500 || err.name === 'HttpError')) return err.code;
    return defaultCode(status);
}

/** A 5xx keeps its message only when the app set the status on purpose (503 restore running, 507 disk full). */
const exposesServerMessage = (err, status) => err.name === 'HttpError' || (status !== 500 && Number.isInteger(err.status) && !isLibraryError(err));

const isInside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
// realpathSync.native follows symlinks and returns the on-disk letter case (macOS, Windows), so an alias of the app
// or data directory cannot pass the lexical comparison below
const realPath = (p) => {
    try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); }
};

/**
 * Where the built frontend is served from. FRONTEND_DIR overrides the build location (frontend/dist, then dist/).
 * Besides these two build folders nothing inside the app directory is served, and nothing inside or around data/:
 * the app directory holds the source code, data/ the database, uploads and backups.
 */
function resolveFrontend(frontendDir = config.frontendDir) {
    const appDir = realPath(__dirname);
    const realDataDir = realPath(dataDir);
    const defaultDirs = [path.join(__dirname, 'frontend', 'dist'), path.join(__dirname, 'dist')];
    const realDefaults = defaultDirs.map(realPath);
    const candidates = frontendDir ? [frontendDir] : defaultDirs;
    // a default build folder may sit inside the app directory, but neither it nor anything else may be the app
    // directory or one of its ancestors (e.g. dist -> .)
    const isServable = (dir) => {
        const real = realPath(dir);
        if (isInside(real, realDataDir) || isInside(realDataDir, real) || isInside(real, appDir)) return false;
        return realDefaults.includes(real) || !isInside(appDir, real);
    };
    let frontendPath = candidates.find(dir => fs.existsSync(path.join(dir, 'index.html'))) || candidates[0];
    if (!isServable(frontendPath)) {
        log.error(`[Frontend] ${frontendPath} liegt im oder um das App- oder Datenverzeichnis und wird nicht ausgeliefert.`);
        frontendPath = null;
    }
    const indexPath = frontendPath && path.join(frontendPath, 'index.html');
    const hasIndex = Boolean(indexPath) && fs.existsSync(indexPath);
    if (!hasIndex) {
        if (fs.existsSync(path.join(__dirname, 'index.html'))) {
            log.error('[Frontend] index.html liegt direkt im App-Verzeichnis. Dieses wird aus Sicherheitsgründen nicht ausgeliefert (es enthält data/ und den Quellcode): den Frontend-Build nach frontend/dist/ verschieben.');
        } else if (indexPath) {
            log.warn(`[Frontend] ${indexPath} nicht gefunden – Frontend bauen (npm run build:frontend) oder npm run package verwenden.`);
        }
    }
    return { frontendPath, indexPath, hasIndex };
}

const PRECOMPRESSED = [['br', '.br'], ['gzip', '.gz']];

/** Serves <asset>.br / .gz written by the build when the client accepts them; anything else falls through. */
function precompressedAssets(assetsDir) {
    const available = new Set(fs.readdirSync(assetsDir).filter(f => /\.(br|gz)$/.test(f)));
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const name = req.path.slice(1);
        if (!name || name.includes('/') || name.includes('\\')) return next();
        res.vary('Accept-Encoding');
        for (const [encoding, ext] of PRECOMPRESSED) {
            if (!available.has(name + ext) || !req.acceptsEncodings(encoding)) continue;
            res.setHeader('Content-Encoding', encoding);
            res.type(path.extname(name));
            return res.sendFile(path.join(assetsDir, name + ext), { maxAge: '1y', immutable: true, dotfiles: 'allow' }, err => {
                // a client that goes away mid-transfer is not an error
                if (!err || err.code === 'ECONNABORTED' || err.syscall === 'write') return;
                if (res.headersSent) {
                    // the length is already promised: only closing the socket tells the client the file is incomplete
                    log.warn('Asset-Auslieferung abgebrochen', { path: req.originalUrl.split('?')[0] }, err);
                    res.destroy();
                    return;
                }
                res.removeHeader('Content-Encoding');
                next(err.status === 404 ? undefined : err);
            });
        }
        next();
    };
}

const notFound = (req, res) => res.status(404).type('text/plain').send('Nicht gefunden');

function healthHandler(req, res) {
    const report = lifecycle.healthReport({
        db,
        dataDir,
        freeBytes,
        lastVerifiedSnapshot,
        isRestoreRunning: backupsRoutes.isRestoreRunning,
        uptimeMs: process.uptime() * 1000
    });
    res.status(report.status === 'error' ? 503 : 200).json({
        name: 'Manga Shelf',
        instance_id: getInstanceId(),
        status: report.status,
        version: pkg.version,
        uptime: Math.round(process.uptime()),
        checks: report.checks
    });
}

/**
 * Error answers are never cached or revalidated: conditional() sets the ETag before the handler runs, Express adds
 * its own to any body, and send() sets the static cache headers before it checks Range and preconditions (416/412).
 * Hooked into writeHead so direct responses of routes and middleware are covered too.
 */
function uncachedErrors(req, res, next) {
    const writeHead = res.writeHead;
    res.writeHead = function (status, ...rest) {
        if ((typeof status === 'number' ? status : this.statusCode) >= 400 && !this.headersSent) {
            this.removeHeader('ETag');
            this.removeHeader('Last-Modified');
            this.setHeader('Cache-Control', 'no-store');
        }
        return writeHead.call(this, status, ...rest);
    };
    next();
}

/** Error bodies that a route or middleware sends itself get the same code and ref as those of the final handler. */
function errorBodyShape(req, res, next) {
    const json = res.json;
    res.json = function (body) {
        if (this.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string') {
            body = { ...errorBody(req, this.statusCode, body.error, body.code), ...body };
            if (!body.code) body.code = defaultCode(this.statusCode);
        }
        return json.call(this, body);
    };
    next();
}

function createApp() {
    const app = express();
    app.disable('x-powered-by');
    // Default `loopback` only trusts a proxy on the same host; TRUST_PROXY=false (direct access), a hop count
    // (1 = one proxy) or a subnet list ("loopback, 172.16.0.0/12") configures other setups.
    app.set('trust proxy', config.trustProxy);

    app.use((req, res, next) => {
        req.id = crypto.randomUUID().slice(0, 8);
        res.setHeader('X-Request-Id', req.id);
        next();
    });
    app.use(uncachedErrors);

    app.use(compression());

    // set before the body parsers so their error responses carry them too
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
        res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        if (req.secure || config.cookieSecure) res.setHeader('Strict-Transport-Security', HSTS);
        next();
    });

    // API answers are never cached (sessions, user data, backups); the data endpoints replace this with
    // `private, no-cache` plus an ETag (utils/dataVersion.js). The access log records method, path (no query),
    // status, user id and the request id - never bodies or cookies; debug level, slow requests always.
    const accessLog = log.child('http');
    app.use('/api', errorBodyShape);
    app.use('/api', (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
            const ctx = { reqId: req.id, method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms };
            if (req.user) ctx.user = req.user.id;
            if (ms > 2000) accessLog.warn('Slow request', ctx);
            else accessLog.debug('request', ctx);
        });
        next();
    });

    // The bundled frontend calls the API with relative URLs and same-origin cookies, so it must come from the same
    // origin as the API (this server, a reverse proxy, or the Vite dev proxy); it never needs CORS_ORIGIN. CORS_ORIGIN
    // (comma separated) only serves external clients on other origins, which must send credentials: 'include'; the
    // SameSite=Lax auth cookie still only reaches them within the same site. The app origins get CORS without
    // credentials (they send a bearer token). Only listed origins are echoed back.
    const corsOrigins = config.corsOrigins;
    const credentialedOrigins = new Set(corsOrigins.map(normalizeOrigin));
    const appOriginList = config.appOrigins;
    const appOrigins = new Set(appOriginList);
    app.use(cors((req, callback) => {
        const origin = req.headers.origin ? normalizeOrigin(req.headers.origin) : null;
        if (origin && credentialedOrigins.has(origin)) return callback(null, { origin: true, credentials: true });
        if (origin && appOrigins.has(origin)) return callback(null, APP_CORS);
        callback(null, { origin: false });
    }));
    // before any body parser: a refused cross-origin request never gets its body read
    app.use('/api', createOriginCheck({ allowedOrigins: corsOrigins, appOrigins: appOriginList }));

    app.use(cookieParser());
    // The 10 MB CSV body is only read once the caller is known to be an editor; the general parser below then skips
    // the already consumed request.
    app.post('/api/import/csv', requireEditor, express.json({ limit: '10mb' }));
    app.use(express.json());
    // Express 5 leaves req.body undefined for requests without a JSON body; handlers destructure it directly
    app.use((req, res, next) => {
        if (req.body === undefined) req.body = {};
        next();
    });

    // Uploaded covers and volume images (unique, never rewritten names). A missing file is a 404, never index.html,
    // which the service worker would otherwise keep as the image.
    // CORP same-origin only blocks no-cors loads: the app shells request images in CORS mode (crossorigin="anonymous")
    // and are let through by the CORS answer above. A no-cors image request carries no Origin, so CORP cannot depend
    // on it. Vary keeps a cached copy without CORS headers from being reused for an app's CORS request.
    app.use('/uploads', (req, res, next) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.vary('Origin');
        next();
    },
        express.static(uploadsDir, { setHeaders: createUploadHeaders(ALLOWED_IMAGE_EXTS) }), notFound);

    // Liveness/readiness probe for Docker, Pterodactyl and reverse proxies (no auth, no paths or counts)
    app.get('/api/health', healthHandler);

    for (const router of [authRoutes, mangasRoutes, volumesRoutes, backupsRoutes, statsRoutes, radarRoutes, lookupRoutes, exchangeRoutes]) {
        app.use('/api', router);
    }

    // Unknown API routes get a JSON 404 instead of falling through to the SPA's index.html
    app.use('/api', (req, res) => {
        res.status(404).json({ error: 'Nicht gefunden', code: 'NOT_FOUND' });
    });

    const { frontendPath, indexPath, hasIndex } = resolveFrontend();
    // Compiled Vite assets carry content hashes: cached for 1 year. An old hash after an update is a 404, not
    // index.html. Only a real build (with index.html) is served at all.
    const assetsDir = hasIndex && path.join(frontendPath, 'assets');
    if (assetsDir && fs.existsSync(assetsDir)) {
        app.use('/assets', precompressedAssets(assetsDir));
        app.use('/assets', express.static(assetsDir, { maxAge: '1y', immutable: true }));
    }
    app.use('/assets', notFound);

    // Root static files (manifest.json, sw.js, icons, favicon)
    if (hasIndex) {
        app.use(express.static(frontendPath, { maxAge: '1h', setHeaders: setStaticHeaders }));
    }

    // SPA fallback: client routes (no file extension) get index.html; missing files and other methods get a 404.
    app.use((req, res) => {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || path.extname(req.path)) return notFound(req, res);
        if (indexPath && fs.existsSync(indexPath)) {
            res.sendFile(indexPath, { dotfiles: 'allow' }); // install path may contain dot-directories
        } else {
            res.status(500).send(`
                <h1>Frontend nicht gefunden</h1>
                <p>Die Datei <code>index.html</code> konnte nicht gefunden werden (Pfad im Server-Log).</p>
                <p>Hast du vergessen, das Frontend zu bauen? Du musst lokal <b><code>npm run package</code></b> ausführen, bevor du die ZIP-Datei hochlädst.</p>
            `);
        }
    });

    // The only builder of error responses: German text, a machine-readable code, extras of an HttpError
    // (existing_id ...) and for 5xx the request id as reference. Details and stacks only go to the log.
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        const isUpload = err.name === 'MulterError';
        const status = isUpload ? 400 : (err.status >= 400 && err.status < 600 ? err.status : 500);
        let message;
        if (status < 500) message = clientErrorMessage(err, req, status);
        else message = exposesServerMessage(err, status) ? err.message : 'Interner Serverfehler';
        const context = { reqId: req.id, method: req.method, path: req.originalUrl.split('?')[0], user: req.user?.id };
        if (status >= 500 && err.name === 'HttpError') log.warn(`${status} ${message}`, context);
        else if (status >= 500) log.error('Unhandled error', context, err);
        else if (!isLibraryError(err) && !isUpload) log.debug(`${status} ${message}`, context);
        res.removeHeader('ETag');
        if (!req.originalUrl.startsWith('/api')) return res.status(status).type('text/plain').send(message);
        res.setHeader('Cache-Control', 'no-store');
        res.status(status).json(errorBody(req, status, message, errorCode(err, status), err.extra));
    });

    return app;
}

const app = createApp();

let running = null;

/**
 * Starts the HTTP(S) server on `port` (default PORT/SERVER_PORT) and `host` (default 0.0.0.0) with the daily
 * scheduler and, unless `console: false` or ADMIN_CONSOLE is off, the admin console on stdin. Resolves with { server, port, url } once it
 * listens. DATA_DIR must be set before index.js is loaded (db.js opens the database at load); a different `dataDir`
 * is refused. Use stop() to end it.
 */
async function start({ host = '0.0.0.0', port = config.port, dataDir: wantedDataDir, console: withConsole = config.adminConsole, banner = false } = {}) {
    if (running) throw new Error('Server läuft bereits');
    if (wantedDataDir && path.resolve(wantedDataDir) !== dataDir) {
        throw new Error(`dataDir muss vor dem Laden von index.js als DATA_DIR gesetzt werden (geladen: ${dataDir})`);
    }
    lifecycle.resetLifecycle();
    let server;
    let isNativeHttps = false;
    const { sslKeyPath, sslCertPath } = config;
    if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
        try {
            server = https.createServer({ key: fs.readFileSync(sslKeyPath), cert: fs.readFileSync(sslCertPath) }, app);
            isNativeHttps = true;
            log.info(`[SSL] Native HTTPS enabled using certificate from ${sslCertPath}`);
        } catch (e) {
            log.error('[SSL] Failed to load SSL certificates, falling back to HTTP:', e.message);
        }
    }
    if (!server) server = http.createServer(app);

    // the scheduler's startup sweep removes leftover temp files, so it runs before any request can create one
    const stopScheduler = initScheduler();
    try {
        await new Promise((resolve, reject) => {
            const onError = (err) => { server.off('listening', onListening); reject(err); };
            const onListening = () => { server.off('error', onError); resolve(); };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, host);
        });
    } catch (err) {
        stopScheduler();
        throw err;
    }
    const actualPort = server.address().port;
    if (banner) printBanner(actualPort, isNativeHttps);
    else printSetupNotice();

    const adminConsole = withConsole ? require('./services/console').startConsole() : null;
    try {
        log.info(require('./services/console').statusLines().slice(1).join(' | '));
    } catch (err) {
        log.warn('Statuszeile beim Start nicht verfügbar:', err);
    }
    running = {
        server,
        parts: { server, stopScheduler, closeConsole: adminConsole ? () => adminConsole.close() : null, closeDb }
    };
    const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return { server, port: actualPort, url: `${isNativeHttps ? 'https' : 'http'}://${shownHost}:${actualPort}` };
}

/** Ends what start() started: scheduler, console, open connections (after running jobs, max. 8 s), database. */
async function stop() {
    if (!running) return;
    const { parts } = running;
    await lifecycle.shutdown(parts);
    running = null;
}

// stdout regardless of LOG_LEVEL: without the code nobody can finish the setup
function printSetupNotice() {
    const notice = authRoutes.setupNotice();
    if (notice) console.log(notice);
}

// Pterodactyl Wings recognise "started" by exactly these lines (generic egg: 'change this text 1/2')
function printBanner(port, isNativeHttps) {
    console.log('=========================================');
    console.log(`[Manga Shelf] Running Version: v${pkg.version}`);
    console.log('=========================================');
    console.log(`Manga Shelf running on http://0.0.0.0:${port}`);
    if (isNativeHttps) {
        console.log(`Manga Shelf HTTPS secure connection active on https://0.0.0.0:${port}`);
    }
    console.log(`Server listening on port ${port}`);
    printSetupNotice();
    console.log('change this text 1');
    console.log('change this text 2');
    console.log('Server is online and ready.');
}

// --- START SERVER --- (tests set MANGA_SHELF_NO_LISTEN=1 to import the app without listening).
// Bewusst kein `require.main === module`: Startet ein Loader (z. B. `ts-node --esm index.js` im generischen
// Pterodactyl-Egg) die Datei, ist require.main ein anderes Modul und der Server würde sofort mit Exit-Code 0 enden.
if (!config.noListen) {
    const port = config.port;
    start({ port, banner: true, console: config.adminConsole }).catch((err) => {
        // EADDRINUSE/EACCES: nothing to shut down gracefully, end with a clear line and a non-zero code
        log.error(`[Server] Port ${port} konnte nicht geöffnet werden:`, err);
        closeDb();
        process.exit(1);
    });
    const shutdown = (code) => {
        if (!lifecycle.isShuttingDown()) log.info('Shutting down...');
        lifecycle.exitAfterShutdown(running ? running.parts : { closeDb }, code);
    };
    process.on('unhandledRejection', (reason) => {
        log.error('[Process] Unhandled promise rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
        log.error('[Process] Uncaught exception:', err);
        shutdown(1);
    });
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
}

module.exports = app;
module.exports.createApp = createApp;
module.exports.start = start;
module.exports.stop = stop;
