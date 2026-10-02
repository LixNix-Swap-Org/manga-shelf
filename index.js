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
require('dotenv').config();

const pkg = require('./package.json');
const { closeDb, uploadsDir } = require('./db');
const { initScheduler } = require('./services/scheduler');

// Route modules
const authRoutes = require('./routes/auth');
const mangasRoutes = require('./routes/mangas');
const volumesRoutes = require('./routes/volumes');
const backupsRoutes = require('./routes/backups');
const statsRoutes = require('./routes/stats');
const radarRoutes = require('./routes/radar');
const lookupRoutes = require('./routes/lookup');

const app = express();

// Trust proxy for reverse proxies (Cloudflare, Nginx, Caddy, Traefik)
// Allows Express to correctly identify HTTPS (req.secure) and client IPs behind proxies
app.set('trust proxy', true);

// Enable Gzip/Brotli response compression for blazing fast API responses
app.use(compression());

app.use(express.json());
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

// Daily automated backup scheduler (runs after 10s on boot, then every 24 hours)
initScheduler();

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
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

app.get('*', (req, res) => {
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(500).send(`
            <h1>Frontend nicht gefunden</h1>
            <p>Die Datei <code>index.html</code> konnte nicht gefunden werden.</p>
            <p>Hast du vergessen, das Frontend zu bauen? Du musst lokal <b><code>npm run package</code></b> ausführen, bevor du die ZIP-Datei hochlädst.</p>
            <p>Aktuell gesuchter Pfad: ${indexPath}</p>
        `);
    }
});

// --- START SERVER ---
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
        console.log(`[SSL] Native HTTPS enabled using certificate from ${SSL_CERT_PATH}`);
    } catch (e) {
        console.error('[SSL] Failed to load SSL certificates, falling back to HTTP:', e.message);
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
    console.log('Shutting down...');
    server.close(() => {
        closeDb();
        process.exit(0);
    });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
