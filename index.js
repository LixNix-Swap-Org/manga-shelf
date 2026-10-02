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
const cookieParser = require('cookie-parser');
const compression = require('compression');
const http = require('http');
const https = require('https');
require('dotenv').config({ quiet: true });

const pkg = require('./package.json');
const { db, closeDb, uploadsDir } = require('./db');
const { initScheduler } = require('./services/scheduler');
const { setStaticHeaders } = require('./utils/staticHeaders');

// Route modules
const authRoutes = require('./routes/auth');
const mangasRoutes = require('./routes/mangas');
const volumesRoutes = require('./routes/volumes');
const backupsRoutes = require('./routes/backups');
const statsRoutes = require('./routes/stats');
const radarRoutes = require('./routes/radar');
const lookupRoutes = require('./routes/lookup');
const log = require('./utils/logger').child('app');

const app = express();

// Trust proxy for reverse proxies (Cloudflare, Nginx, Caddy, Traefik)
// Allows Express to correctly identify HTTPS (req.secure) and client IPs behind proxies
app.set('trust proxy', true);

// Enable Gzip/Brotli response compression for blazing fast API responses
app.use(compression());

// Access log for the API: debug level (set LOG_LEVEL=debug), slow requests are always warned about.
// Only method, path (no query string) and status are recorded - never bodies, cookies or user data.
const accessLog = log.child('http');
app.use('/api', (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
        const ctx = { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms };
        if (ms > 2000) accessLog.warn('Slow request', ctx);
        else accessLog.debug('request', ctx);
    });
    next();
});

app.use(express.json());
// Express 5 leaves req.body undefined for requests without a JSON body (Express 4 gave {}).
// Handlers destructure req.body directly, so keep the old behaviour.
app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
});
app.use(cookieParser());
app.use(cors({
    origin: true,
    credentials: true
}));

// Serve uploaded covers and volume images with 7-day browser caching
app.use('/uploads', express.static(uploadsDir, {
    maxAge: '7d',
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    }
}));

// Liveness/readiness probe for Docker, Pterodactyl and reverse proxies (no auth, no data exposed)
app.get('/api/health', (req, res) => {
    try {
        db.prepare('SELECT 1').get();
        res.json({ status: 'ok', version: pkg.version, uptime: Math.round(process.uptime()) });
    } catch (e) {
        res.status(503).json({ status: 'error' });
    }
});

// Mount API routes
app.use('/api', authRoutes);
app.use('/api', mangasRoutes);
app.use('/api', volumesRoutes);
app.use('/api', backupsRoutes);
app.use('/api', statsRoutes);
app.use('/api', radarRoutes);
app.use('/api', lookupRoutes);

// Database maintenance / restore error handler for API requests
app.use('/api', (err, req, res, next) => {
    if (err && err.message && err.message.includes('DATABASE_MAINTENANCE_RESTORE_IN_PROGRESS')) {
        return res.status(503).json({ error: 'Server wartet: Datenbank-Wiederherstellung läuft gerade. Bitte versuche es in wenigen Sekunden erneut.' });
    }
    next(err);
});


// Unknown API routes get a JSON 404 instead of falling through to the SPA's index.html
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Nicht gefunden' });
});


// --- SERVE FRONTEND ---
let frontendPath = path.join(__dirname, 'frontend/dist');
let indexPath = path.join(frontendPath, 'index.html');

if (!fs.existsSync(indexPath)) {
    if (fs.existsSync(path.join(__dirname, 'dist/index.html'))) {
        frontendPath = path.join(__dirname, 'dist');
        indexPath = path.join(frontendPath, 'index.html');
    } else if (fs.existsSync(path.join(__dirname, 'index.html'))) {
        frontendPath = __dirname;
        indexPath = path.join(frontendPath, 'index.html');
    }
}

// Cache compiled Vite assets (CSS/JS with content hashes) for 1 year immutable
const assetsDir = path.join(frontendPath, 'assets');
if (fs.existsSync(assetsDir)) {
    app.use('/assets', express.static(assetsDir, {
        maxAge: '1y',
        immutable: true
    }));
}

// Serve root static assets (manifest.json, sw.js, icons, favicon)
app.use(express.static(frontendPath, {
    maxAge: '1h',
    setHeaders: setStaticHeaders
}));

// SPA fallback: serves index.html for all non-API GET/HEAD requests
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath, { dotfiles: 'allow' }); // install path may contain dot-directories
    } else {
        res.status(500).send(`
            <h1>Frontend nicht gefunden</h1>
            <p>Die Datei <code>index.html</code> konnte nicht gefunden werden.</p>
            <p>Hast du vergessen, das Frontend zu bauen? Du musst lokal <b><code>npm run package</code></b> ausführen, bevor du die ZIP-Datei hochlädst.</p>
            <p>Aktuell gesuchter Pfad: ${indexPath}</p>
        `);
    }
});

// Last-resort error handler: log details server-side, never leak stack traces to clients
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const isUpload = err.name === 'MulterError';
    const status = isUpload ? 400 : (err.status >= 400 && err.status < 600 ? err.status : 500);
    // Client errors (bad JSON, rejected upload, ...) keep their message; server errors stay generic.
    const message = status < 500 ? err.message : 'Interner Serverfehler';
    if (status >= 500) log.error('Unhandled error:', err);
    if (req.path.startsWith('/api')) return res.status(status).json({ error: message });
    res.status(status).type('text/plain').send(message);
});

// --- START SERVER --- (only when run directly; tests import the app without listening)
if (require.main === module) {
initScheduler(); // Daily automated backup scheduler (after 10s on boot, then every 24 hours)
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, 'ssl', 'privkey.pem');
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || (fs.existsSync(path.join(__dirname, 'ssl', 'fullchain.pem')) ? path.join(__dirname, 'ssl', 'fullchain.pem') : path.join(__dirname, 'ssl', 'cert.pem'));

let server;
let isNativeHttps = false;

if (fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
    try {
        const sslOptions = {
            key: fs.readFileSync(SSL_KEY_PATH),
            cert: fs.readFileSync(SSL_CERT_PATH)
        };
        server = https.createServer(sslOptions, app);
        isNativeHttps = true;
        log.info(`[SSL] Native HTTPS enabled using certificate from ${SSL_CERT_PATH}`);
    } catch (e) {
        log.error('[SSL] Failed to load SSL certificates, falling back to HTTP:', e.message);
        server = http.createServer(app);
    }
} else {
    server = http.createServer(app);
}

server.listen(PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log(`[Manga Shelf] Running Version: v${pkg.version}`);
    console.log('=========================================');
    // Keep 'Manga Shelf running on http://0.0.0.0:' to ensure Pterodactyl egg triggers
    console.log(`Manga Shelf running on http://0.0.0.0:${PORT}`);
    if (isNativeHttps) {
        console.log(`Manga Shelf HTTPS secure connection active on https://0.0.0.0:${PORT}`);
    }
    console.log(`Server listening on port ${PORT}`);
    // Pterodactyl Wings startup triggers (generic node.js egg uses 'change this text 1' / 'change this text 2')
    console.log('change this text 1');
    console.log('change this text 2');
    console.log('Server is online and ready.');
});

// Graceful Shutdown
const shutdown = () => {
    log.info('Shutting down...');
    server.close(() => {
        closeDb();
        process.exit(0);
    });
};
// Last-resort safety nets: log and shut down in a controlled way instead of crashing mid-write
process.on('unhandledRejection', (reason) => {
    log.error('[Process] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
    log.error('[Process] Uncaught exception:', err);
    shutdown();
    setTimeout(() => process.exit(1), 5000).unref();
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
}

module.exports = app;
