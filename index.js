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
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const compression = require('compression');
const http = require('http');
const https = require('https');
require('dotenv').config();

const pkg = require('./package.json');
const { db, hasAdmin, uploadsDir, dataDir, closeDb, initDb } = require('./db');
const {
    searchMangaPassionEditions,
    getEditionDetailsAndVolumes,
    reconcileMangaGaps,
    batchImportGaps,
    syncMangaWithEdition,
    searchMangaPassionForLookup
} = require('./mangaPassion');

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

// Serve uploads with browser caching (7 days) for high-performance cover rendering
app.use('/uploads', express.static(uploadsDir, {
    maxAge: '7d',
    etag: true,
    lastModified: true
}));

// Allowed image MIME types and extensions for secure uploads
const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

const imageFileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMAGE_MIMES.has(file.mimetype) && ALLOWED_IMAGE_EXTS.has(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Ungültiger Dateityp. Es sind ausschließlich Bilddateien (JPG, PNG, WebP, GIF, AVIF) erlaubt.'));
    }
};

// Multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const cleanExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.jpg';
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + cleanExt);
    }
});
const upload = multer({ 
    storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // Max 15 MB per image
    fileFilter: imageFileFilter
});

// Secure, persistent JWT Secret (stored in app_settings if not provided via environment)
const crypto = require('crypto');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    try {
        const row = db.prepare("SELECT value FROM app_settings WHERE key = 'jwt_secret'").get();
        if (row && row.value) {
            JWT_SECRET = row.value;
        } else {
            JWT_SECRET = crypto.randomBytes(48).toString('hex');
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(JWT_SECRET);
        }
    } catch (e) {
        JWT_SECRET = 'manga-shelf-fallback-' + crypto.randomBytes(32).toString('hex');
    }
}

// Helper for cookie options (supports direct HTTPS & reverse proxy / Cloudflare / Nginx)
const setAuthCookie = (req, res, token) => {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === 'true';
    res.cookie('token', token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });
};

const clearAuthCookie = (res) => {
    res.clearCookie('token', {
        httpOnly: true,
        sameSite: 'lax'
    });
};

// --- MIDDLEWARE ---
const requireAuth = (req, res, next) => {
    const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const requireAdmin = (req, res, next) => {
    requireAuth(req, res, () => {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
        next();
    });
};

const requireEditor = (req, res, next) => {
    requireAuth(req, res, () => {
        const role = req.user?.role;
        if (role === 'visitor' || role === 'guest') {
            return res.status(403).json({ error: 'Nur Lesezugriff für Besucher/Gäste gestattet' });
        }
        next();
    });
};

// --- SYSTEM & VERSION ---
app.get('/api/version', (req, res) => {
    res.json({ version: pkg.version });
});

// --- SETUP & AUTH ---
app.get('/api/setup/status', (req, res) => {
    res.json({ needsSetup: !hasAdmin(), version: pkg.version });
});

app.post('/api/setup', (req, res) => {
    if (hasAdmin()) return res.status(400).json({ error: 'Admin already exists' });
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort sind erforderlich' });
    
    const hash = bcrypt.hashSync(password, 10);
    const stmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    const result = stmt.run(username.trim(), hash, 'admin');
    const newUserId = Number(result.lastInsertRowid);
    
    // Auto-login on setup
    const token = jwt.sign({ id: newUserId, username: username.trim(), role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(req, res, token);
    res.json({ success: true, user: { id: newUserId, username: username.trim(), role: 'admin' } });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Bitte Benutzername und Passwort eingeben' });
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
    }
    
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(req, res, token);
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// --- USER MANAGEMENT (Admin only) ---
app.get('/api/users', requireAdmin, (req, res) => {
    try {
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all();
        res.json(users);
    } catch (err) {
        console.error('Error fetching users:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Benutzer' });
    }
});

app.post('/api/users', requireAdmin, (req, res) => {
    try {
        const { username, password, role = 'editor' } = req.body;
        if (!username || !username.trim()) {
            return res.status(400).json({ error: 'Benutzername darf nicht leer sein' });
        }
        if (!password || password.length < 4) {
            return res.status(400).json({ error: 'Passwort muss mindestens 4 Zeichen lang sein' });
        }
        const cleanUsername = username.trim();
        const cleanRole = ['admin', 'visitor', 'guest'].includes(role) ? role : 'editor';

        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
        if (existing) {
            return res.status(400).json({ error: 'Dieser Benutzername existiert bereits' });
        }

        const hash = bcrypt.hashSync(password, 10);
        const stmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
        const result = stmt.run(cleanUsername, hash, cleanRole);

        res.json({
            success: true,
            user: {
                id: Number(result.lastInsertRowid),
                username: cleanUsername,
                role: cleanRole
            }
        });
    } catch (err) {
        console.error('Error creating user:', err);
        res.status(500).json({ error: 'Fehler beim Anlegen des Benutzers: ' + err.message });
    }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        const { role, password } = req.body;
        const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId);
        if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        let newRole = user.role;
        if (role) {
            newRole = ['admin', 'visitor', 'guest'].includes(role) ? role : 'editor';
        }

        // Prevent demoting the last remaining admin
        if (user.role === 'admin' && newRole !== 'admin') {
            const adminCountRow = db.prepare("SELECT count(*) as count FROM users WHERE role = 'admin'").get();
            if (adminCountRow && adminCountRow.count <= 1) {
                return res.status(400).json({ error: 'Der letzte verbleibende Administrator kann nicht herabgestuft werden' });
            }
        }

        if (password && password.length >= 4) {
            const hash = bcrypt.hashSync(password, 10);
            db.prepare('UPDATE users SET role = ?, password_hash = ? WHERE id = ?').run(newRole, hash, userId);
        } else {
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, userId);
        }
        res.json({ success: true, user: { id: userId, username: user.username, role: newRole } });
    } catch (err) {
        console.error('Error updating user:', err);
        res.status(500).json({ error: 'Fehler beim Aktualisieren des Benutzers' });
    }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (userId === req.user.id) {
            return res.status(400).json({ error: 'Du kannst dein eigenes Administratorkonto nicht löschen' });
        }
        const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
        if (!user) {
            return res.status(404).json({ error: 'Benutzer nicht gefunden' });
        }

        // Prevent deleting the last admin
        if (user.role === 'admin') {
            const adminCountRow = db.prepare("SELECT count(*) as count FROM users WHERE role = 'admin'").get();
            if (adminCountRow && adminCountRow.count <= 1) {
                return res.status(400).json({ error: 'Der letzte verbleibende Administrator kann nicht gelöscht werden' });
            }
        }

        // Clean up user volume_reads explicitly
        db.prepare('DELETE FROM volume_reads WHERE user_id = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting user:', err);
        res.status(500).json({ error: 'Fehler beim Löschen des Benutzers' });
    }
});

app.get('/api/users/:id/stats', requireAuth, (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        
        const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
        if (!user) return res.status(404).json({ error: 'Benutzer nicht gefunden' });

        const readVolumes = db.prepare(`
            SELECT vr.read_at, v.volume_number, v.pages, m.id as manga_id, m.title as manga_title, m.cover_image as manga_cover
            FROM volume_reads vr
            JOIN volumes v ON vr.volume_id = v.id
            JOIN mangas m ON v.manga_id = m.id
            WHERE vr.user_id = ?
            ORDER BY vr.read_at DESC
        `).all(userId);

        const totalVolumes = readVolumes.length;
        const totalPages = readVolumes.reduce((sum, v) => sum + (v.pages || 0), 0);

        const mangasReadMap = new Map();
        readVolumes.forEach(v => {
            if (!mangasReadMap.has(v.manga_id)) {
                mangasReadMap.set(v.manga_id, {
                    id: v.manga_id,
                    title: v.manga_title,
                    cover_image: v.manga_cover,
                    volumes: []
                });
            }
            mangasReadMap.get(v.manga_id).volumes.push({
                volume_number: v.volume_number,
                read_at: v.read_at
            });
        });
        
        const readMangas = Array.from(mangasReadMap.values());

        res.json({
            user: { id: user.id, username: user.username },
            stats: {
                totalVolumes,
                totalPages,
                recentVolumes: readVolumes.slice(0, 10), // Last 10 read volumes for timeline
                readMangas
            }
        });
    } catch (err) {
        console.error('Error fetching user stats:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Benutzer-Statistiken' });
    }
});

// --- MANGA API ---
app.get('/api/mangas', requireAuth, (req, res) => {
    try {
        const userId = req.user.id;
        const mangas = db.prepare(`
            SELECT m.*, 
                   COALESCE(SUM(CASE WHEN v.status = 'Vorhanden' THEN v.price ELSE 0 END), 0) as total_value,
                   COALESCE(SUM(v.price), 0) as full_value,
                   COUNT(DISTINCT v.id) as volume_count,
                   COUNT(DISTINCT vr.volume_id) as read_volume_count
            FROM mangas m
            LEFT JOIN volumes v ON m.id = v.manga_id
            LEFT JOIN volume_reads vr ON v.id = vr.volume_id AND vr.user_id = ?
            GROUP BY m.id
            ORDER BY m.title ASC
        `).all(userId);
        res.json(mangas);
    } catch (err) {
        console.error('Error fetching mangas:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Mangas' });
    }
});

// Canonical German Manga Publishers map & Normalization Helper
const CANONICAL_PUBLISHERS = {
    'altraverse': 'Altraverse',
    'carlsen manga': 'Carlsen Manga',
    'crunchyroll': 'Crunchyroll',
    'dani books': 'Dani Books',
    'dark horse manga': 'Dark Horse Manga',
    'egmont manga': 'Egmont Manga',
    'hayabusa': 'Hayabusa',
    'kazé manga': 'Kazé Manga',
    'kaze manga': 'Kazé Manga',
    'manga cult': 'Manga Cult',
    'manga jam session': 'Manga JAM Session',
    'panini verlag gmbh': 'Panini Verlags GmbH',
    'panini verlags gmbh': 'Panini Verlags GmbH',
    'panini': 'Panini Verlags GmbH',
    'papertoons': 'Papertoons',
    'schreiber&leser': 'Schreiber&Leser',
    'schreiber & leser': 'Schreiber&Leser',
    'tokyopop': 'TOKYOPOP'
};

const normalizePublisher = (name) => {
    if (!name || typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    return CANONICAL_PUBLISHERS[lower] || trimmed;
};

app.post('/api/mangas', requireEditor, (req, res) => {
    try {
        const {
            title,
            alt_title = null,
            author = null,
            publisher = null,
            language = 'Deutsch',
            status = 'Laufend',
            tags = null,
            total_volumes = null,
            description = null,
            cover_image = null,
            banner_image = null,
            manga_passion_id = null
        } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Titel darf nicht leer sein' });
        }

        const stmt = db.prepare(`
            INSERT INTO mangas (title, alt_title, author, publisher, language, status, tags, total_volumes, description, cover_image, banner_image, manga_passion_id, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            title.trim(),
            alt_title ? alt_title.trim() : null,
            author ? author.trim() : null,
            publisher ? normalizePublisher(publisher) : null,
            language || 'Deutsch',
            status || 'Laufend',
            tags ? tags.trim() : null,
            total_volumes ? (parseInt(total_volumes, 10) || null) : null,
            description ? description.trim() : null,
            cover_image || null,
            banner_image || null,
            manga_passion_id ? (parseInt(manga_passion_id, 10) || null) : null,
            req.user.id
        );
        res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
        console.error('Error creating manga:', err);
        res.status(500).json({ error: 'Fehler beim Erstellen des Mangas: ' + err.message });
    }
});

app.get('/api/mangas/:id', requireAuth, (req, res) => {
    try {
        const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(req.params.id);
        if (!manga) {
            return res.status(404).json({ error: 'Manga nicht gefunden' });
        }
        const volumes = db.prepare(`
            SELECT * FROM volumes 
            WHERE manga_id = ? 
            ORDER BY 
                CASE 
                    WHEN COALESCE(type, 'volume') = 'volume' AND (volume_number = '0' OR CAST(volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(type, 'volume') = 'special_edition' AND (volume_number = '0' OR CAST(volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(type, 'volume') = 'special_edition' THEN 1.5
                    WHEN COALESCE(type, 'volume') = 'schuber' THEN 2 
                    WHEN COALESCE(type, 'volume') = 'special' THEN 3 
                    ELSE 2 
                END ASC, 
                CASE 
                    WHEN CAST(volume_number AS REAL) > 0 THEN CAST(volume_number AS REAL) 
                    WHEN volume_number = '0' THEN 0 
                    ELSE 999999 
                END ASC, 
                CASE 
                    WHEN COALESCE(type, 'volume') = 'volume' THEN 0 
                    WHEN COALESCE(type, 'volume') = 'special_edition' THEN 1 
                    ELSE 2 
                END ASC,
                volume_number ASC
        `).all(req.params.id);
        manga.volumes = volumes || [];

        // Fetch volume reading records
        const reads = db.prepare(`
            SELECT vr.volume_id, vr.user_id, u.username
            FROM volume_reads vr
            JOIN users u ON vr.user_id = u.id
            JOIN volumes v ON vr.volume_id = v.id
            WHERE v.manga_id = ?
        `).all(req.params.id);

        const readMap = {};
        for (const r of reads) {
            if (!readMap[r.volume_id]) readMap[r.volume_id] = [];
            readMap[r.volume_id].push({ id: r.user_id, username: r.username });
        }

        let total_value = 0;
        let full_value = 0;
        for (const v of manga.volumes) {
            const p = typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0);
            if (v.status === 'Vorhanden') total_value += p;
            full_value += p;

            // Reading info
            const usersWhoRead = readMap[v.id] || [];
            v.read_by = usersWhoRead.map(u => u.id);
            v.read_users = usersWhoRead;
            v.is_read = v.read_by.includes(req.user.id);

            // Parse images
            try {
                if (v.images) {
                    v.images = Array.isArray(v.images) ? v.images : JSON.parse(v.images);
                } else if (v.cover_image) {
                    v.images = [v.cover_image];
                } else {
                    v.images = [];
                }
            } catch (e) {
                v.images = v.cover_image ? [v.cover_image] : [];
            }
            if (!v.cover_image && v.images.length > 0) {
                v.cover_image = v.images[0];
            }
        }
        manga.total_value = Math.round(total_value * 100) / 100;
        manga.full_value = Math.round(full_value * 100) / 100;

        // Reading stats per user for this manga
        const allUsers = db.prepare('SELECT id, username FROM users').all();
        const ownedVols = manga.volumes.filter(v => v.status === 'Vorhanden');
        manga.user_reading_stats = allUsers.map(u => {
            const count = ownedVols.filter(v => (v.read_by || []).includes(u.id)).length;
            const total = ownedVols.length;
            return {
                user_id: u.id,
                username: u.username,
                read_count: count,
                total_owned: total,
                unread_count: Math.max(0, total - count),
                percentage: total > 0 ? Math.round((count / total) * 100) : 0
            };
        });

        res.json(manga);
    } catch (err) {
        console.error('Error fetching manga:', err);
        res.status(500).json({ error: 'Fehler beim Laden des Mangas' });
    }
});

app.put('/api/mangas/:id', requireEditor, (req, res) => {
    try {
        const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(req.params.id);
        if (!manga) return res.status(404).json({ error: 'Manga nicht gefunden' });

        const body = req.body;
        const title = body.title !== undefined ? body.title : manga.title;
        const alt_title = body.alt_title !== undefined ? body.alt_title : manga.alt_title;
        const author = body.author !== undefined ? body.author : manga.author;
        const publisher = body.publisher !== undefined ? normalizePublisher(body.publisher) : normalizePublisher(manga.publisher);
        const language = body.language !== undefined ? body.language : manga.language;
        const status = body.status !== undefined ? body.status : manga.status;
        const tags = body.tags !== undefined ? body.tags : manga.tags;
        const total_volumes = body.total_volumes !== undefined ? (parseInt(body.total_volumes, 10) || null) : manga.total_volumes;
        const owned_volumes = body.owned_volumes !== undefined ? (parseInt(body.owned_volumes, 10) || 0) : manga.owned_volumes;
        const description = body.description !== undefined ? body.description : manga.description;
        const cover_image = body.cover_image !== undefined ? body.cover_image : manga.cover_image;
        const banner_image = body.banner_image !== undefined ? body.banner_image : manga.banner_image;
        const manga_passion_id = body.manga_passion_id !== undefined ? (parseInt(body.manga_passion_id, 10) || null) : manga.manga_passion_id;

        const stmt = db.prepare(`
            UPDATE mangas SET title = ?, alt_title = ?, author = ?, publisher = ?, 
            language = ?, status = ?, tags = ?, total_volumes = ?, 
            owned_volumes = ?, description = ?, cover_image = ?, 
            banner_image = ?, manga_passion_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `);
        stmt.run(
            title ? title.trim() : manga.title,
            alt_title || null,
            author || null,
            publisher || null,
            language || 'Deutsch',
            status || 'Laufend',
            tags || null,
            total_volumes,
            owned_volumes,
            description || null,
            cover_image || null,
            banner_image || null,
            manga_passion_id,
            req.user.id,
            req.params.id
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating manga:', err);
        res.status(500).json({ error: 'Fehler beim Speichern: ' + err.message });
    }
});

app.delete('/api/mangas/:id', requireEditor, (req, res) => {
    try {
        db.prepare('DELETE FROM volume_reads WHERE volume_id IN (SELECT id FROM volumes WHERE manga_id = ?)').run(req.params.id);
        db.prepare('DELETE FROM volumes WHERE manga_id = ?').run(req.params.id);
        const result = db.prepare('DELETE FROM mangas WHERE id = ?').run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Manga nicht gefunden' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting manga:', err);
        res.status(500).json({ error: 'Fehler beim Löschen des Mangas' });
    }
});

// --- VOLUMES API ---
const parsePrice = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const str = String(val).replace(',', '.').trim();
    const parsed = parseFloat(str);
    return (isNaN(parsed) || parsed < 0) ? null : Math.round(parsed * 100) / 100;
};

const parseNum = (val) => {
    if (val === null || val === undefined || val === '') return null;
    const parsed = parseInt(val, 10);
    return (isNaN(parsed) || parsed < 0) ? null : parsed;
};

app.post('/api/volumes', requireEditor, (req, res) => {
    try {
        const { 
            manga_id, 
            volume_number, 
            isbn = null, 
            price = null,
            release_date = null,
            release_year = null,
            condition = null,
            pages = null,
            publisher = null,
            purchase_date = null, 
            status = 'Vorhanden', 
            notes = null,
            cover_image = null,
            images = null,
            type = 'volume'
        } = req.body;

        if (!manga_id || volume_number === undefined || volume_number === '') {
            return res.status(400).json({ error: 'manga_id und Bandnummer erforderlich' });
        }

        let volType = type ? String(type).trim().toLowerCase() : 'volume';
        if (!['volume', 'special_edition', 'schuber', 'special'].includes(volType)) {
            const vLower = String(volume_number).toLowerCase();
            const nLower = notes ? String(notes).toLowerCase() : '';
            if (vLower.includes('schuber') || nLower.includes('schuber')) {
                volType = 'schuber';
            } else if (vLower.includes('special edition') || vLower.includes('limited edition') || vLower.includes('spezial edition') || nLower.includes('special edition') || nLower.includes('limited edition')) {
                volType = 'special_edition';
            } else if (vLower.includes('special') || vLower.includes('extra') || vLower.includes('sonderband')) {
                volType = 'special';
            } else {
                volType = 'volume';
            }
        }

        let imagesVal = null;
        if (images) {
            imagesVal = Array.isArray(images) ? JSON.stringify(images) : String(images);
        } else if (cover_image) {
            imagesVal = JSON.stringify([String(cover_image).trim()]);
        }

        const stmt = db.prepare(`
            INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, images, type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const result = stmt.run(
            parseInt(manga_id, 10),
            String(volume_number).trim(),
            isbn ? String(isbn).trim() : null,
            parsePrice(price),
            release_date ? String(release_date).trim() : null,
            parseNum(release_year),
            condition ? String(condition).trim() : null,
            parseNum(pages),
            publisher ? normalizePublisher(publisher) : null,
            purchase_date ? String(purchase_date).trim() : null,
            status || 'Vorhanden',
            notes ? String(notes).trim() : null,
            cover_image ? String(cover_image).trim() : null,
            imagesVal,
            volType
        );

        // Update owned count
        const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(manga_id);
        db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, manga_id);

        res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
        console.error('Error adding volume:', err);
        res.status(500).json({ error: 'Fehler beim Hinzufügen des Bands' });
    }
});

// Batch add volumes (e.g. 1 to 20)
app.post('/api/volumes/batch', requireEditor, (req, res) => {
    try {
        const { 
            manga_id, 
            from, 
            to, 
            status = 'Vorhanden',
            default_price = null,
            publisher = null,
            condition = null,
            release_date = null,
            release_year = null
        } = req.body;
        const mId = parseInt(manga_id, 10);
        const start = parseInt(from, 10);
        const end = parseInt(to, 10);

        if (!mId || isNaN(start) || isNaN(end) || start < 0 || end < 0 || start > end || (end - start) > 300) {
            return res.status(400).json({ error: 'Ungültiger Bereich (maximal 300 Bände, positive Zahlen)' });
        }

        const existing = db.prepare('SELECT volume_number FROM volumes WHERE manga_id = ?').all(mId);
        const existingSet = new Set(existing.map(v => String(v.volume_number)));

        const insertStmt = db.prepare(`
            INSERT INTO volumes (manga_id, volume_number, status, price, publisher, condition, release_date, release_year)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const p = parsePrice(default_price);
        const pub = publisher ? normalizePublisher(publisher) : null;
        const cond = condition ? String(condition).trim() : null;
        const rDate = release_date ? String(release_date).trim() : null;
        const year = parseNum(release_year);

        db.exec('BEGIN TRANSACTION;');
        try {
            for (let i = start; i <= end; i++) {
                if (!existingSet.has(String(i))) {
                    insertStmt.run(mId, String(i), status || 'Vorhanden', p, pub, cond, rDate, year);
                }
            }
            db.exec('COMMIT;');
        } catch (txErr) {
            try { db.exec('ROLLBACK;'); } catch (rbErr) {}
            throw txErr;
        }

        // Update owned count
        const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(mId);
        db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, mId);

        res.json({ success: true });
    } catch (err) {
        console.error('Error batch adding volumes:', err);
        res.status(500).json({ error: 'Fehler beim Hinzufügen mehrerer Bände' });
    }
});

app.put('/api/volumes/:id', requireEditor, (req, res) => {
    try {
        const vol = db.prepare('SELECT * FROM volumes WHERE id = ?').get(req.params.id);
        if (!vol) return res.status(404).json({ error: 'Band nicht gefunden' });

        const body = req.body;
        const volume_number = body.volume_number !== undefined ? String(body.volume_number).trim() : vol.volume_number;
        const isbn = body.isbn !== undefined ? (body.isbn ? String(body.isbn).trim() : null) : vol.isbn;
        const price = body.price !== undefined ? parsePrice(body.price) : vol.price;
        const release_date = body.release_date !== undefined ? (body.release_date ? String(body.release_date).trim() : null) : vol.release_date;
        const release_year = body.release_year !== undefined ? parseNum(body.release_year) : vol.release_year;
        const condition = body.condition !== undefined ? (body.condition ? String(body.condition).trim() : null) : vol.condition;
        const pages = body.pages !== undefined ? parseNum(body.pages) : vol.pages;
        const publisher = body.publisher !== undefined ? normalizePublisher(body.publisher) : normalizePublisher(vol.publisher);
        const purchase_date = body.purchase_date !== undefined ? (body.purchase_date ? String(body.purchase_date).trim() : null) : vol.purchase_date;
        const status = body.status !== undefined ? body.status : vol.status;
        const notes = body.notes !== undefined ? (body.notes ? String(body.notes).trim() : null) : vol.notes;

        let volType = vol.type || 'volume';
        if (body.type !== undefined) {
            const rawType = String(body.type).trim().toLowerCase();
            if (['volume', 'special_edition', 'schuber', 'special'].includes(rawType)) {
                volType = rawType;
            }
        }

        let imagesVal = vol.images;
        if (body.images !== undefined) {
            imagesVal = Array.isArray(body.images) ? JSON.stringify(body.images) : (body.images ? String(body.images) : null);
        }

        let cover_image = body.cover_image !== undefined 
            ? (body.cover_image ? String(body.cover_image).trim() : null) 
            : vol.cover_image;

        if (!cover_image && imagesVal) {
            try {
                const parsed = JSON.parse(imagesVal);
                if (Array.isArray(parsed) && parsed.length > 0) cover_image = parsed[0];
            } catch (e) {}
        }

        const stmt = db.prepare(`
            UPDATE volumes SET 
                volume_number = ?, isbn = ?, price = ?, release_date = ?, release_year = ?, 
                condition = ?, pages = ?, publisher = ?, purchase_date = ?, 
                status = ?, notes = ?, cover_image = ?, images = ?, type = ?
            WHERE id = ?
        `);
        stmt.run(volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, imagesVal, volType, req.params.id);

        // Update owned count
        const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(vol.manga_id);
        db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, vol.manga_id);

        res.json({ success: true });
    } catch (err) {
        console.error('Error updating volume:', err);
        res.status(500).json({ error: 'Fehler beim Aktualisieren des Bands' });
    }
});

app.delete('/api/volumes/:id', requireEditor, (req, res) => {
    try {
        const vol = db.prepare('SELECT manga_id FROM volumes WHERE id = ?').get(req.params.id);
        if (!vol) return res.status(404).json({ error: 'Band nicht gefunden' });

        db.prepare('DELETE FROM volume_reads WHERE volume_id = ?').run(req.params.id);
        db.prepare('DELETE FROM volumes WHERE id = ?').run(req.params.id);

        // Update owned count
        const countRow = db.prepare("SELECT count(*) as count FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").get(vol.manga_id);
        db.prepare('UPDATE mangas SET owned_volumes = ? WHERE id = ?').run(countRow.count, vol.manga_id);

        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting volume:', err);
        res.status(500).json({ error: 'Fehler beim Löschen des Bands' });
    }
});

// --- VOLUME READING STATUS (Multi-User) ---
app.post('/api/volumes/:id/read', requireEditor, (req, res) => {
    try {
        const volumeId = parseInt(req.params.id, 10);
        const targetUserId = (req.body.user_id && req.user.role === 'admin') ? parseInt(req.body.user_id, 10) : req.user.id;
        const vol = db.prepare('SELECT id FROM volumes WHERE id = ?').get(volumeId);
        if (!vol) return res.status(404).json({ error: 'Band nicht gefunden' });

        const existing = db.prepare('SELECT * FROM volume_reads WHERE volume_id = ? AND user_id = ?').get(volumeId, targetUserId);
        let isRead = false;

        if (req.body.read !== undefined) {
            if (req.body.read) {
                if (!existing) {
                    db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, targetUserId);
                }
                isRead = true;
            } else {
                if (existing) {
                    db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
                }
                isRead = false;
            }
        } else {
            // Toggle
            if (existing) {
                db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
                isRead = false;
            } else {
                db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, targetUserId);
                isRead = true;
            }
        }

        const readRows = db.prepare('SELECT vr.user_id, u.username FROM volume_reads vr JOIN users u ON vr.user_id = u.id WHERE vr.volume_id = ?').all(volumeId);
        const readBy = readRows.map(r => r.user_id);

        res.json({ success: true, is_read: isRead, read_by: readBy, read_users: readRows });
    } catch (e) {
        console.error('Error updating read status:', e);
        res.status(500).json({ error: 'Fehler beim Aktualisieren des Lesestatus' });
    }
});

app.post('/api/volumes/batch-read', requireEditor, (req, res) => {
    try {
        const { manga_id, up_to_volume, read = true, user_id } = req.body;
        const targetUserId = (user_id && req.user.role === 'admin') ? parseInt(user_id, 10) : req.user.id;
        const mId = parseInt(manga_id, 10);
        const maxVol = parseFloat(up_to_volume);

        if (!mId || isNaN(maxVol)) {
            return res.status(400).json({ error: 'Ungültige Parameter' });
        }

        const volumes = db.prepare("SELECT id, volume_number, type FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").all(mId);
        const targetVols = volumes.filter(v => {
            if (v.type === 'schuber') return false;
            const num = parseFloat(v.volume_number);
            return !isNaN(num) && num <= maxVol;
        });

        const insertStmt = db.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id) VALUES (?, ?)');
        const deleteStmt = db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?');

        db.exec('BEGIN TRANSACTION;');
        try {
            for (const v of targetVols) {
                if (read) {
                    insertStmt.run(v.id, targetUserId);
                } else {
                    deleteStmt.run(v.id, targetUserId);
                }
            }
            db.exec('COMMIT;');
        } catch (txErr) {
            try { db.exec('ROLLBACK;'); } catch (rbErr) {}
            throw txErr;
        }

        res.json({ success: true, count: targetVols.length });
    } catch (e) {
        console.error('Error batch updating read status:', e);
        res.status(500).json({ error: 'Fehler beim Batch-Lesestatus' });
    }
});

// --- SHOPPING LIST / WISHLIST API ---
app.get('/api/shopping-list', requireAuth, (req, res) => {
    try {
        const missingVols = db.prepare(`
            SELECT 
                v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
                v.release_year, v.condition, v.publisher as vol_publisher, 
                v.notes, v.status,
                m.title as manga_title, 
                m.cover_image as manga_cover,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status = 'Fehlt'
            ORDER BY 
                effective_publisher ASC,
                m.title ASC,
                CASE 
                    WHEN COALESCE(v.type, 'volume') = 'volume' AND (v.volume_number = '0' OR CAST(v.volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' AND (v.volume_number = '0' OR CAST(v.volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' THEN 1.5
                    WHEN COALESCE(v.type, 'volume') = 'schuber' THEN 2 
                    WHEN COALESCE(v.type, 'volume') = 'special' THEN 3 
                    ELSE 2 
                END ASC, 
                CASE 
                    WHEN CAST(v.volume_number AS REAL) > 0 THEN CAST(v.volume_number AS REAL) 
                    WHEN v.volume_number = '0' THEN 0 
                    ELSE 999999 
                END ASC, 
                CASE 
                    WHEN COALESCE(v.type, 'volume') = 'volume' THEN 0 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' THEN 1 
                    ELSE 2 
                END ASC,
                v.volume_number ASC
        `).all();

        const totalCost = missingVols.reduce((sum, v) => sum + (v.price || 0), 0);
        
        // Group by publisher for fast filter chips
        const publisherMap = new Map();
        missingVols.forEach(v => {
            const pub = normalizePublisher(v.effective_publisher) || 'Unbekannt';
            if (!publisherMap.has(pub)) {
                publisherMap.set(pub, { publisher: pub, count: 0, total_price: 0 });
            }
            const pStat = publisherMap.get(pub);
            pStat.count++;
            pStat.total_price += (v.price || 0);
        });

        const publishers = Array.from(publisherMap.values()).map(p => ({
            ...p,
            total_price: Math.round(p.total_price * 100) / 100
        }));

        res.json({
            total_missing: missingVols.length,
            total_cost: Math.round(totalCost * 100) / 100,
            publishers,
            items: missingVols
        });
    } catch (err) {
        console.error('Error fetching shopping list:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Einkaufsliste' });
    }
});

// --- RELEASE RADAR / ERSCHEINUNGSKALENDER API ---
app.get('/api/release-radar', requireAuth, (req, res) => {
    try {
        const radarVols = db.prepare(`
            SELECT 
                v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
                v.release_date, v.release_year, v.condition, v.publisher as vol_publisher, 
                v.notes, v.status, v.type, v.cover_image as vol_cover, v.images as vol_images,
                m.title as manga_title, 
                m.cover_image as manga_cover,
                m.publisher as manga_publisher,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status IN ('Vorbestellt', 'Erscheint bald', 'Bestellt')
               OR (v.release_date IS NOT NULL AND TRIM(v.release_date) != '' AND v.status NOT IN ('Vorhanden', 'Gelesen'))
            ORDER BY 
                CASE WHEN v.release_date IS NOT NULL AND TRIM(v.release_date) != '' THEN 0 ELSE 1 END ASC,
                v.release_date ASC,
                m.title ASC,
                CASE 
                    WHEN CAST(v.volume_number AS REAL) > 0 THEN CAST(v.volume_number AS REAL) 
                    WHEN v.volume_number = '0' THEN 0 
                    ELSE 999999 
                END ASC,
                v.volume_number ASC
        `).all();

        const totalReleases = radarVols.length;
        const preorderedVols = radarVols.filter(v => ['Vorbestellt', 'Bestellt'].includes(v.status));
        const preorderedCount = preorderedVols.length;
        const preorderedBudget = preorderedVols.reduce((sum, v) => sum + (v.price || 0), 0);
        const totalBudget = radarVols.reduce((sum, v) => sum + (v.price || 0), 0);

        const MONTH_NAMES = [
            'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
            'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
        ];

        const today = new Date();

        const formattedItems = radarVols.map(v => {
            let daysUntil = null;
            let countdownLabel = null;

            if (v.release_date) {
                const parts = v.release_date.split('-');
                let targetDate = null;
                if (parts.length >= 3) {
                    targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                } else if (parts.length === 2) {
                    targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
                }

                if (targetDate && !isNaN(targetDate.getTime())) {
                    const diffMs = targetDate.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
                    daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                    if (daysUntil < 0) {
                        countdownLabel = `Vor ${Math.abs(daysUntil)} Tag${Math.abs(daysUntil) === 1 ? '' : 'en'}`;
                    } else if (daysUntil === 0) {
                        countdownLabel = 'Erscheint heute!';
                    } else if (daysUntil === 1) {
                        countdownLabel = 'Morgen!';
                    } else if (daysUntil <= 30) {
                        countdownLabel = `In ${daysUntil} Tagen`;
                    } else {
                        const targetMonth = targetDate.getMonth();
                        const thisMonth = today.getMonth();
                        if (targetDate.getFullYear() === today.getFullYear() && targetMonth === thisMonth + 1) {
                            countdownLabel = 'Nächsten Monat';
                        } else {
                            countdownLabel = `In ${Math.round(daysUntil / 30)} Monaten`;
                        }
                    }
                }
            }

            return {
                ...v,
                effective_publisher: normalizePublisher(v.effective_publisher) || 'Unbekannt',
                days_until: daysUntil,
                countdown_label: countdownLabel
            };
        });

        // Group by Year-Month
        const groupMap = new Map();

        formattedItems.forEach(item => {
            let groupKey = 'Ohne konkretes Datum';
            let sortKey = '9999-99';

            if (item.release_date) {
                const parts = item.release_date.split('-');
                if (parts.length >= 2) {
                    const y = parseInt(parts[0], 10);
                    const m = parseInt(parts[1], 10);
                    if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
                        groupKey = `${MONTH_NAMES[m - 1]} ${y}`;
                        sortKey = `${y}-${String(m).padStart(2, '0')}`;
                    }
                }
            } else if (item.release_year) {
                groupKey = `Im Jahr ${item.release_year}`;
                sortKey = `${item.release_year}-13`;
            }

            if (!groupMap.has(sortKey)) {
                groupMap.set(sortKey, {
                    key: sortKey,
                    label: groupKey,
                    count: 0,
                    total_price: 0,
                    preordered_count: 0,
                    items: []
                });
            }

            const grp = groupMap.get(sortKey);
            grp.count++;
            grp.total_price += (item.price || 0);
            if (['Vorbestellt', 'Bestellt'].includes(item.status)) {
                grp.preordered_count++;
            }
            grp.items.push(item);
        });

        const groups = Array.from(groupMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([_, grp]) => ({
                ...grp,
                total_price: Math.round(grp.total_price * 100) / 100
            }));

        const publisherMap = new Map();
        formattedItems.forEach(v => {
            const pub = v.effective_publisher;
            if (!publisherMap.has(pub)) {
                publisherMap.set(pub, { publisher: pub, count: 0 });
            }
            publisherMap.get(pub).count++;
        });

        const publishers = Array.from(publisherMap.values());

        res.json({
            total_releases: totalReleases,
            preordered_count: preorderedCount,
            preordered_budget: Math.round(preorderedBudget * 100) / 100,
            total_budget: Math.round(totalBudget * 100) / 100,
            groups,
            items: formattedItems,
            publishers
        });
    } catch (err) {
        console.error('Error fetching release radar:', err);
        res.status(500).json({ error: 'Fehler beim Laden des Release-Radars' });
    }
});

// --- MANGA PASSION GERMAN RELEASE CALENDAR API ---
app.get('/api/manga-passion/releases', requireAuth, async (req, res) => {
    try {
        const now = new Date();
        const year = parseInt(req.query.year, 10) || now.getFullYear();
        const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
        const forceRefresh = req.query.force_refresh === 'true';

        if (month < 1 || month > 12 || year < 2000 || year > 2100) {
            return res.status(400).json({ error: 'Ungültiges Jahr oder Monat' });
        }

        const cacheKey = `mp_releases_${year}_${month}`;
        let cachedRow = null;

        if (!forceRefresh) {
            try {
                cachedRow = db.prepare('SELECT json_data, created_at FROM manga_passion_cache WHERE cache_key = ?').get(cacheKey);
            } catch (_) {}
        }

        let rawItems = null;
        const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

        if (cachedRow && cachedRow.json_data && (Date.now() - cachedRow.created_at < CACHE_TTL_MS)) {
            try {
                rawItems = JSON.parse(cachedRow.json_data);
            } catch (_) {}
        }

        if (!rawItems) {
            const baseUrl = `https://api.manga-passion.de/volumes?year=${year}&month=${month}&itemsPerPage=100&order[date]=asc`;
            const headers = { 'User-Agent': 'MangaShelf/2.6.0', 'Accept': 'application/ld+json' };

            let allVolumes = [];
            let page = 1;
            let totalItems = 0;

            while (page <= 5) {
                const response = await fetch(`${baseUrl}&page=${page}`, { headers });
                if (!response.ok) {
                    if (page === 1) throw new Error(`Manga Passion API Fehler (Status ${response.status})`);
                    break;
                }
                const data = await response.json();
                const members = data['hydra:member'] || (Array.isArray(data) ? data : []);
                if (members.length === 0) break;

                allVolumes = allVolumes.concat(members);
                totalItems = data['hydra:totalItems'] || allVolumes.length;
                if (allVolumes.length >= totalItems || members.length < 100) break;
                page++;
            }

            rawItems = allVolumes.map(v => {
                const rawTitle = v.edition?.title || '';
                const isDigital = Boolean(v.edition?.digital || rawTitle.includes('(eBook)'));
                const cleanTitle = rawTitle.replace(/\s*\(eBook\)/i, '').trim();
                const rawPub = v.edition?.publishers?.[0]?.name ? normalizePublisher(v.edition.publishers[0].name) : 'Unbekannt';
                
                return {
                    id: v.id,
                    edition_id: v.edition?.id || null,
                    title: cleanTitle,
                    raw_title: rawTitle,
                    volume_number: v.numberDisplay || (v.number !== null && v.number !== undefined ? String(v.number) : 'Special'),
                    publisher: rawPub,
                    date: v.date ? v.date.slice(0, 10) : null,
                    year: v.year,
                    month: v.month,
                    day: v.day,
                    price: v.price ? Math.round(v.price) / 100 : null,
                    cover_image: v.cover || null,
                    pages: v.pages || null,
                    is_digital: isDigital,
                    format: v.format ?? 0
                };
            });

            try {
                db.prepare(`
                    INSERT INTO manga_passion_cache (cache_key, json_data, created_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
                `).run(cacheKey, JSON.stringify(rawItems), Date.now());
            } catch (cacheErr) {
                console.warn('Cache write failed:', cacheErr);
            }
        }

        // Live reconciliation with user's collection in SQLite
        const userMangas = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas').all();
        const userVolumes = db.prepare('SELECT id, manga_id, volume_number, status, price, release_date FROM volumes').all();

        const cleanStr = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        const mangaMap = new Map();
        userMangas.forEach(m => {
            mangaMap.set(cleanStr(m.title), m);
            if (m.alt_title) mangaMap.set(cleanStr(m.alt_title), m);
        });

        const matchSeries = (title) => {
            const norm = cleanStr(title);
            if (mangaMap.has(norm)) return mangaMap.get(norm);

            const lower = title.toLowerCase();
            for (const m of userMangas) {
                if (m.title.toLowerCase() === lower) return m;
                if (m.alt_title && m.alt_title.toLowerCase() === lower) return m;
            }

            const prefix = title.split(/[–\-:]/)[0].trim();
            const normPre = cleanStr(prefix);
            if (normPre.length >= 4 && mangaMap.has(normPre)) {
                return mangaMap.get(normPre);
            }
            return null;
        };

        const enrichedItems = rawItems.map(item => {
            const matchedManga = matchSeries(item.title);
            let inCollection = false;
            let userMangaId = null;
            let userVolumeStatus = null;
            let userVolumeId = null;

            if (matchedManga) {
                inCollection = true;
                userMangaId = matchedManga.id;
                const volNum = String(item.volume_number || '').trim();
                const existingVol = userVolumes.find(uv => uv.manga_id === matchedManga.id && String(uv.volume_number).trim() === volNum);
                if (existingVol) {
                    userVolumeStatus = existingVol.status;
                    userVolumeId = existingVol.id;
                }
            }

            return {
                ...item,
                in_collection: inCollection,
                user_manga_id: userMangaId,
                user_manga_title: matchedManga ? matchedManga.title : null,
                user_volume_status: userVolumeStatus,
                user_volume_id: userVolumeId
            };
        });

        // Publisher list
        const pubMap = new Map();
        enrichedItems.forEach(it => {
            if (it.publisher && it.publisher !== 'Unbekannt') {
                pubMap.set(it.publisher, (pubMap.get(it.publisher) || 0) + 1);
            }
        });

        const publishers = Array.from(pubMap.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count);

        res.json({
            year,
            month,
            total_items: enrichedItems.length,
            print_count: enrichedItems.filter(i => !i.is_digital).length,
            user_series_count: enrichedItems.filter(i => i.in_collection).length,
            publishers,
            items: enrichedItems
        });
    } catch (err) {
        console.error('Manga Passion releases error:', err);
        res.status(500).json({ error: 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen: ' + err.message });
    }
});

app.post('/api/manga-passion/import', requireEditor, (req, res) => {
    try {
        const {
            manga_id,
            title,
            volume_number,
            publisher,
            release_date,
            price,
            cover_image,
            target_status
        } = req.body;

        let effMangaId = manga_id;

        // If manga doesn't exist yet, create it
        if (!effMangaId) {
            const cleanTitle = (title || '').replace(/\s*\(eBook\)/i, '').trim();
            const insManga = db.prepare(`
                INSERT INTO mangas (title, publisher, cover_image, status, created_at, updated_at)
                VALUES (?, ?, ?, 'Laufend', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(cleanTitle, publisher || null, cover_image || null);
            effMangaId = Number(insManga.lastInsertRowid);
        }

        const volNumStr = String(volume_number || '1').trim();
        const existingVol = db.prepare('SELECT id, status FROM volumes WHERE manga_id = ? AND volume_number = ?').get(effMangaId, volNumStr);

        let volumeId;
        const effStatus = target_status || 'Vorbestellt';

        if (existingVol) {
            db.prepare(`
                UPDATE volumes 
                SET status = ?, 
                    price = COALESCE(?, price),
                    release_date = COALESCE(?, release_date),
                    publisher = COALESCE(?, publisher),
                    cover_image = COALESCE(cover_image, ?)
                WHERE id = ?
            `).run(effStatus, price || null, release_date || null, publisher || null, cover_image || null, existingVol.id);
            volumeId = existingVol.id;
        } else {
            const insVol = db.prepare(`
                INSERT INTO volumes (manga_id, volume_number, status, price, release_date, publisher, cover_image, type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'volume', CURRENT_TIMESTAMP)
            `).run(effMangaId, volNumStr, effStatus, price || null, release_date || null, publisher || null, cover_image || null);
            volumeId = Number(insVol.lastInsertRowid);
        }

        res.json({
            success: true,
            manga_id: effMangaId,
            volume_id: volumeId,
            status: effStatus
        });
    } catch (err) {
        console.error('Import error:', err);
        res.status(500).json({ error: 'Fehler beim Übernehmen des Bands: ' + err.message });
    }
});

// --- MANGA PASSION EDITION SEARCH ---
app.get('/api/manga-passion/editions', requireAuth, async (req, res) => {
    try {
        const title = req.query.title || '';
        const publisher = req.query.publisher || '';
        const totalVolumes = parseInt(req.query.total_volumes, 10) || null;
        if (!title.trim()) {
            return res.status(400).json({ error: 'Titel-Parameter ist erforderlich' });
        }
        const result = await searchMangaPassionEditions(title, publisher, totalVolumes);
        res.json(result);
    } catch (err) {
        console.error('Manga Passion edition search error:', err);
        res.status(500).json({ error: 'Fehler bei der Editionssuche: ' + err.message });
    }
});

// --- MANGA GAPS CHECK (Manga Passion Live-Abgleich) ---
app.get('/api/mangas/:id/gaps', requireAuth, async (req, res) => {
    try {
        const mangaId = parseInt(req.params.id, 10);
        const editionId = req.query.edition_id ? parseInt(req.query.edition_id, 10) : null;
        const forceRefresh = req.query.force_refresh === 'true';

        const result = await reconcileMangaGaps(mangaId, { edition_id: editionId, force_refresh: forceRefresh });
        res.json(result);
    } catch (err) {
        console.error('Manga gaps check error:', err);
        res.status(500).json({ error: 'Fehler beim Abgleich der Lücken: ' + err.message });
    }
});

// --- SYNC MANGA WITH MANGA PASSION EDITION ---
app.post('/api/mangas/:id/sync-edition', requireEditor, async (req, res) => {
    try {
        const mangaId = parseInt(req.params.id, 10);
        const { edition_id, update_total_volumes, update_status, update_publisher } = req.body;
        if (!edition_id) {
            return res.status(400).json({ error: 'edition_id ist erforderlich' });
        }

        const updatedManga = await syncMangaWithEdition(mangaId, edition_id, {
            update_total_volumes: update_total_volumes !== false,
            update_status: Boolean(update_status),
            update_publisher: Boolean(update_publisher)
        });

        res.json({ success: true, manga: updatedManga });
    } catch (err) {
        console.error('Sync edition error:', err);
        res.status(500).json({ error: 'Fehler beim Synchronisieren der Edition: ' + err.message });
    }
});

// --- BATCH IMPORT GAPS FROM MANGA PASSION ---
app.post('/api/mangas/:id/batch-import-gaps', requireEditor, async (req, res) => {
    try {
        const mangaId = parseInt(req.params.id, 10);
        const { volume_numbers, target_status, edition_id } = req.body;

        if (!Array.isArray(volume_numbers) || volume_numbers.length === 0) {
            return res.status(400).json({ error: 'volume_numbers Array ist erforderlich' });
        }

        const result = await batchImportGaps(mangaId, volume_numbers, target_status || 'Fehlt', edition_id);
        res.json(result);
    } catch (err) {
        console.error('Batch import gaps error:', err);
        res.status(500).json({ error: 'Fehler beim Erfassen der Lücken: ' + err.message });
    }
});

// --- STATISTICS & FINANCE API ---
app.get('/api/stats', requireAuth, (req, res) => {
    try {
        const totalSeriesRow = db.prepare('SELECT count(*) as count FROM mangas').get();
        const totalSeries = totalSeriesRow ? totalSeriesRow.count : 0;

        const ownedRow = db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as total_value FROM volumes WHERE status = 'Vorhanden'").get();
        const totalOwnedVolumes = ownedRow ? ownedRow.count : 0;
        const totalOwnedValue = ownedRow ? Math.round((ownedRow.total_value || 0) * 100) / 100 : 0;

        const missingRow = db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as missing_value FROM volumes WHERE status = 'Fehlt'").get();
        const totalMissingVolumes = missingRow ? missingRow.count : 0;
        const totalMissingValue = missingRow ? Math.round((missingRow.missing_value || 0) * 100) / 100 : 0;

        const allVolsRow = db.prepare('SELECT count(*) as count, sum(COALESCE(price, 0)) as full_value FROM volumes').get();
        const totalPossibleValue = allVolsRow ? Math.round((allVolsRow.full_value || 0) * 100) / 100 : 0;

        const completedRow = db.prepare(`
            SELECT count(*) as count FROM mangas 
            WHERE status = 'Abgeschlossen' 
               OR (total_volumes IS NOT NULL AND total_volumes > 0 AND owned_volumes >= total_volumes)
        `).get();
        const completedSeries = completedRow ? completedRow.count : 0;

        // Settings / Start Date
        const settingRow = db.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get();
        const startDateStr = settingRow?.value || '2021-04-09';
        const startDate = new Date(startDateStr);
        const now = new Date();
        const diffMs = Math.max(1, now.getTime() - startDate.getTime());
        const totalDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        const totalMonths = Math.max(1, Math.round(totalDays / 30.4375));
        const totalYears = (totalDays / 365.25).toFixed(2);
        const avgMonthlySpending = totalMonths > 0 ? Math.round((totalOwnedValue / totalMonths) * 100) / 100 : 0;
        const avgPricePerVolume = totalOwnedVolumes > 0 ? Math.round((totalOwnedValue / totalOwnedVolumes) * 100) / 100 : 0;

        // Publisher breakdown
        const pubRows = db.prepare(`
            SELECT 
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as pub_name,
                count(DISTINCT m.id) as series_count,
                count(v.id) as volume_count,
                sum(CASE WHEN v.status = 'Vorhanden' THEN COALESCE(v.price, 0) ELSE 0 END) as total_value
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status = 'Vorhanden'
            GROUP BY pub_name
            ORDER BY volume_count DESC
        `).all();

        const publishers = pubRows.map(p => ({
            publisher: p.pub_name,
            series_count: p.series_count,
            volume_count: p.volume_count,
            volumes_count: p.volume_count,
            total_value: Math.round((p.total_value || 0) * 100) / 100,
            percentage: totalOwnedVolumes > 0 ? Math.round((p.volume_count / totalOwnedVolumes) * 1000) / 10 : 0
        }));

        // User Reading Stats (Multi-User)
        const allUsers = db.prepare('SELECT id, username, role FROM users').all();
        const userReadingStats = allUsers.map(u => {
            const readRow = db.prepare(`
                SELECT count(vr.volume_id) as count
                FROM volume_reads vr
                JOIN volumes v ON vr.volume_id = v.id
                WHERE vr.user_id = ? AND v.status = 'Vorhanden'
            `).get(u.id);
            const readCount = readRow ? readRow.count : 0;
            const pct = totalOwnedVolumes > 0 ? Math.round((readCount / totalOwnedVolumes) * 1000) / 10 : 0;
            return {
                user_id: u.id,
                username: u.username,
                display_name: u.username,
                role: u.role,
                read_count: readCount,
                unread_count: Math.max(0, totalOwnedVolumes - readCount),
                total_owned: totalOwnedVolumes,
                read_pct: pct,
                percentage: pct
            };
        });

        // Top 5 Valuable series
        const topSeries = db.prepare(`
            SELECT 
                m.id, m.title, m.cover_image, m.publisher,
                count(v.id) as owned_volumes,
                sum(COALESCE(v.price, 0)) as total_value
            FROM mangas m
            JOIN volumes v ON m.id = v.manga_id AND v.status = 'Vorhanden'
            GROUP BY m.id
            ORDER BY total_value DESC
            LIMIT 5
        `).all().map(s => ({
            id: s.id,
            title: s.title,
            cover_image: s.cover_image,
            publisher: s.publisher,
            owned_volumes: s.owned_volumes,
            total_value: Math.round((s.total_value || 0) * 100) / 100
        }));

        const summary = {
            total_series: totalSeries,
            completed_series: completedSeries,
            total_owned_volumes: totalOwnedVolumes,
            total_missing_volumes: totalMissingVolumes,
            total_volumes_recorded: totalOwnedVolumes + totalMissingVolumes,
            total_owned_value: totalOwnedValue,
            total_missing_value: totalMissingValue,
            total_possible_value: totalPossibleValue,
            avg_price_per_volume: avgPricePerVolume,
            collection_start_date: startDateStr,
            collection_days: totalDays,
            collection_months: totalMonths,
            collection_years: parseFloat(totalYears),
            avg_monthly_spending: avgMonthlySpending
        };

        res.json({
            summary,
            ...summary,
            total_series: totalSeries,
            total_owned_volumes: totalOwnedVolumes,
            total_missing_volumes: totalMissingVolumes,
            completed_series: completedSeries,
            total_owned_value: totalOwnedValue,
            total_missing_value: totalMissingValue,
            total_possible_value: totalPossibleValue,
            avg_price_per_volume: avgPricePerVolume,
            start_date: startDateStr,
            duration: {
                days: totalDays,
                months: totalMonths,
                years: parseFloat(totalYears)
            },
            settings: {
                collection_start_date: startDateStr
            },
            avg_monthly_spending: avgMonthlySpending,
            publishers,
            user_reading_stats: userReadingStats,
            top_series: topSeries
        });
    } catch (err) {
        console.error('Error calculating stats:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Statistiken' });
    }
});

app.put('/api/stats/settings', requireAdmin, (req, res) => {
    try {
        const dateVal = req.body.collection_start_date || req.body.start_date;
        if (dateVal) {
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', ?)").run(String(dateVal).trim());
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Error saving stats settings:', e);
        res.status(500).json({ error: 'Fehler beim Speichern der Einstellungen' });
    }
});

// --- MANGA METADATA LOOKUP (Manga Passion First, AniList Fallback) ---
function searchAniList(queryTerm) {
    return new Promise((resolve) => {
        const graphqlQuery = {
            query: `
                query ($search: String) {
                    Page(page: 1, perPage: 5) {
                        media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
                            id
                            title { romaji english native }
                            description(asHtml: false)
                            coverImage { extraLarge large medium }
                            bannerImage
                            status
                            volumes
                            genres
                            staff(perPage: 5) {
                                edges {
                                    role
                                    node { name { full } }
                                }
                            }
                        }
                    }
                }
            `,
            variables: { search: queryTerm.trim() }
        };

        const postData = JSON.stringify(graphqlQuery);
        const options = {
            hostname: 'graphql.anilist.co',
            port: 443,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'MangaShelf/2.8.0'
            }
        };

        const apiReq = https.request(options, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => { data += chunk; });
            apiRes.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const list = parsed.data?.Page?.media || [];
                    const results = list.map(m => {
                        let author = null;
                        if (m.staff?.edges) {
                            const storyOrArt = m.staff.edges.find(e => 
                                e.role?.toLowerCase().includes('story') || 
                                e.role?.toLowerCase().includes('art') || 
                                e.role?.toLowerCase().includes('original creator')
                            );
                            author = storyOrArt ? storyOrArt.node?.name?.full : m.staff.edges[0]?.node?.name?.full;
                        }

                        let status = 'Laufend';
                        if (m.status === 'FINISHED') status = 'Abgeschlossen';
                        else if (m.status === 'HIATUS') status = 'Pausiert';
                        else if (m.status === 'CANCELLED') status = 'Abgebrochen';

                        let cleanDesc = m.description || '';
                        cleanDesc = cleanDesc.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();

                        return {
                            id: 'al_' + m.id,
                            manga_passion_id: null,
                            source: 'anilist',
                            source_label: '🌐 AniList',
                            title: m.title.english || m.title.romaji,
                            alt_title: m.title.native || m.title.romaji,
                            author: author || null,
                            publisher: null,
                            description: cleanDesc || null,
                            cover_image: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
                            banner_image: m.bannerImage || null,
                            tags: Array.isArray(m.genres) ? m.genres.join(', ') : null,
                            total_volumes: m.volumes || null,
                            status: status
                        };
                    });
                    resolve(results);
                } catch (e) {
                    resolve([]);
                }
            });
        });

        apiReq.on('error', () => resolve([]));
        apiReq.setTimeout(6000, () => {
            apiReq.destroy();
            resolve([]);
        });
        apiReq.write(postData);
        apiReq.end();
    });
}

app.get('/api/lookup/manga', requireAuth, async (req, res) => {
    try {
        const queryTerm = req.query.q;
        if (!queryTerm || !queryTerm.trim()) {
            return res.status(400).json({ error: 'Suchbegriff erforderlich' });
        }

        const trimmed = queryTerm.trim();

        // 1. ZUERST: Deutsche Manga Passion API nach offiziellen deutschen Ausgaben durchsuchen
        let mpResults = [];
        try {
            mpResults = await searchMangaPassionForLookup(trimmed);
        } catch (mpErr) {
            console.warn('Manga Passion lookup error:', mpErr.message);
        }

        // 2. AniList als Ergänzung und Fallback
        let aniListResults = [];
        try {
            aniListResults = await searchAniList(trimmed);
        } catch (alErr) {
            console.warn('AniList lookup error:', alErr.message);
        }

        // Manga Passion hat Vorrang (deutsche Verlage, korrekte deutsche Bandzahlen & Cover)
        const combined = [...mpResults, ...aniListResults];
        res.json(combined);
    } catch (err) {
        console.error('Lookup endpoint error:', err);
        res.status(500).json({ error: 'Interner Serverfehler beim Metadaten-Lookup' });
    }
});

// Download remote image (e.g. from AniList) and save locally to data/uploads
app.post('/api/upload-remote', requireEditor, async (req, res) => {
    try {
        const { url } = req.body;
        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ error: 'Ungültige Bild-URL' });
        }
        const parsedUrl = new URL(url);
        const ext = path.extname(parsedUrl.pathname).toLowerCase() || '.jpg';
        const cleanExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.jpg';
        const filename = Date.now() + '-' + Math.round(Math.random() * 1E9) + cleanExt;
        const targetPath = path.join(uploadsDir, filename);

        const client = parsedUrl.protocol === 'https:' ? https : http;
        const fileStream = fs.createWriteStream(targetPath);

        const fetchReq = client.get(url, { headers: { 'User-Agent': 'MangaShelf/2.0' } }, (imgRes) => {
            if (imgRes.statusCode !== 200) {
                fileStream.close();
                try { fs.unlinkSync(targetPath); } catch (e) {}
                return res.status(400).json({ error: 'Bild konnte nicht geladen werden (Status ' + imgRes.statusCode + ')' });
            }
            imgRes.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                res.json({ url: '/uploads/' + filename });
            });
        });

        fetchReq.on('error', (err) => {
            fileStream.close();
            try { fs.unlinkSync(targetPath); } catch (e) {}
            res.status(500).json({ error: 'Fehler beim Herunterladen des Bildes: ' + err.message });
        });

        fetchReq.setTimeout(10000, () => {
            fetchReq.destroy();
            fileStream.close();
            try { fs.unlinkSync(targetPath); } catch (e) {}
            res.status(504).json({ error: 'Download-Zeitüberschreitung' });
        });
    } catch (e) {
        console.error('Remote upload error:', e);
        res.status(500).json({ error: 'Fehler beim Speichern des externen Bildes' });
    }
});

// --- GERMAN MANGA ISBN LOOKUP (Deutsche Nationalbibliothek DNB & OpenLibrary Cover) ---
app.get('/api/lookup/isbn', requireAuth, async (req, res) => {
    try {
        const rawIsbn = req.query.isbn;
        if (!rawIsbn) {
            return res.status(400).json({ error: 'ISBN erforderlich' });
        }

        const cleanIsbn = String(rawIsbn).replace(/[^0-9X]/gi, '');
        if (!cleanIsbn || (cleanIsbn.length !== 10 && cleanIsbn.length !== 13)) {
            return res.status(400).json({ error: 'Ungültiges ISBN-Format (muss 10 oder 13 Zeichen lang sein)' });
        }

        // 1. Fetch MARC21 XML from Deutsche Nationalbibliothek (DNB) SRU API
        const dnbUrl = `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=isbn%3D${encodeURIComponent(cleanIsbn)}&recordSchema=MARC21-xml`;

        let xml = '';
        try {
            xml = await new Promise((resolve, reject) => {
                const apiReq = https.get(dnbUrl, { headers: { 'User-Agent': 'MangaShelf/2.0' } }, (apiRes) => {
                    let data = '';
                    apiRes.on('data', chunk => data += chunk);
                    apiRes.on('end', () => resolve(data));
                });
                apiReq.on('error', reject);
                apiReq.setTimeout(8000, () => {
                    apiReq.destroy();
                    reject(new Error('DNB Timeout'));
                });
            });
        } catch (e) {
            console.error('DNB request failed:', e.message);
        }

        let book = null;
        if (xml && xml.includes('<recordData>')) {
            const getField = (tag, code) => {
                const fieldRegex = new RegExp(`<datafield[^>]*tag="${tag}"[^>]*>[\\s\\S]*?<\\/datafield>`, 'g');
                const matches = xml.match(fieldRegex) || [];
                for (const f of matches) {
                    const subRegex = new RegExp(`<subfield[^>]*code="${code}"[^>]*>([^<]+)<\\/subfield>`);
                    const subMatch = f.match(subRegex);
                    if (subMatch) return subMatch[1].trim();
                }
                return null;
            };

            let title = getField('245', 'a');
            if (title) title = title.replace(/\s*[\/:]\s*$/, '').trim();

            let volumeNumber = getField('245', 'n');
            if (volumeNumber) {
                volumeNumber = volumeNumber.replace(/\.$/, '').trim();
                const numOnly = volumeNumber.match(/\d+(\.\d+)?/);
                if (numOnly) volumeNumber = numOnly[0];
            }

            let subtitle = getField('245', 'p');
            let author = getField('100', 'a');
            if (author) {
                const parts = author.split(',').map(s => s.trim());
                if (parts.length === 2) author = `${parts[1]} ${parts[0]}`;
            }

            let publisher = getField('264', 'b') || getField('260', 'b');
            if (publisher) publisher = normalizePublisher(publisher.replace(/\s*;\s*$/, '').trim());

            const releaseYearRaw = getField('264', 'c') || getField('260', 'c');
            let releaseYear = null;
            if (releaseYearRaw) {
                const yMatch = releaseYearRaw.match(/\d{4}/);
                if (yMatch) releaseYear = parseInt(yMatch[0], 10);
            }

            const pagesRaw = getField('300', 'a');
            let pages = null;
            if (pagesRaw) {
                const pMatch = pagesRaw.match(/(\d+)/);
                if (pMatch) pages = parseInt(pMatch[1], 10);
            }

            const priceRaw = getField('020', 'c');
            let price = null;
            if (priceRaw) {
                const eurMatch = priceRaw.match(/EUR\s*([\d,.]+)/i);
                if (eurMatch) price = parseFloat(eurMatch[1].replace(',', '.'));
            }

            if (title) {
                book = {
                    title,
                    volume_number: volumeNumber || '1',
                    subtitle,
                    author,
                    publisher,
                    release_year: releaseYear,
                    pages,
                    price,
                    cover_url: `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`
                };
            }
        }

        if (!book) {
            return res.json({
                isbn: cleanIsbn,
                found: false,
                message: 'Keine Metadaten für diese ISBN in der Deutschen Nationalbibliothek gefunden.'
            });
        }

        // Cross reference existing mangas in SQLite
        const mangas = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas').all();
        let matchedManga = null;
        const normTitle = book.title.toLowerCase().trim();

        for (const m of mangas) {
            const mNorm = m.title.toLowerCase().trim();
            const altNorm = m.alt_title ? m.alt_title.toLowerCase().trim() : '';
            if (normTitle === mNorm || normTitle.includes(mNorm) || mNorm.includes(normTitle) || (altNorm && (normTitle.includes(altNorm) || altNorm.includes(normTitle)))) {
                matchedManga = m;
                break;
            }
        }

        let matchedVolume = null;
        if (matchedManga) {
            const vol = db.prepare(`
                SELECT id, manga_id, volume_number, status, isbn, price, publisher, pages, release_year
                FROM volumes 
                WHERE manga_id = ? AND (volume_number = ? OR isbn = ?)
            `).get(matchedManga.id, book.volume_number, cleanIsbn);
            if (vol) matchedVolume = vol;
        }

        res.json({
            isbn: cleanIsbn,
            found: true,
            book,
            matched_manga: matchedManga,
            matched_volume: matchedVolume
        });
    } catch (err) {
        console.error('Error during ISBN lookup:', err);
        res.status(500).json({ error: 'Fehler beim ISBN-Lookup' });
    }
});

// --- UPLOADS ---
app.post('/api/upload', requireEditor, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    res.json({ url: '/uploads/' + req.file.filename });
});

app.post('/api/upload/multiple', requireEditor, upload.array('images', 10), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Keine Dateien hochgeladen' });
    const urls = req.files.map(f => '/uploads/' + f.filename);
    res.json({ urls });
});

// --- BACKUP & SNAPSHOT MANAGEMENT ---
const backupsDir = path.join(dataDir, 'backups');
if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
}

async function createBackupSnapshot(prefix = 'manga-shelf-backup') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${prefix}-${timestamp}.zip`;
    const targetFile = path.join(backupsDir, filename);

    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(targetFile);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);

        const dbFile = path.join(dataDir, 'manga.db');
        if (fs.existsSync(dbFile)) {
            archive.file(dbFile, { name: 'manga.db' });
        }

        if (fs.existsSync(uploadsDir)) {
            archive.directory(uploadsDir, 'uploads');
        }

        archive.finalize();
    });

    // Prune backups: keep latest 7 snapshots
    try {
        const allBackups = fs.readdirSync(backupsDir)
            .filter(f => f.endsWith('.zip'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(backupsDir, f)).mtimeMs
            }))
            .sort((a, b) => b.time - a.time);

        if (allBackups.length > 7) {
            const toDelete = allBackups.slice(7);
            for (const b of toDelete) {
                try { fs.unlinkSync(path.join(backupsDir, b.name)); } catch (e) {}
            }
        }
    } catch (e) {
        console.warn('Pruning old backups failed:', e);
    }

    const stat = fs.statSync(targetFile);
    return { filename, size: stat.size, created_at: new Date().toISOString() };
}

// Reusable restore implementation from Buffer
async function restoreFromZipBuffer(buffer) {
    const backupBakPath = path.join(dataDir, 'manga.db.bak');
    const dbFilePath = path.join(dataDir, 'manga.db');
    const walFilePath = path.join(dataDir, 'manga.db-wal');
    const shmFilePath = path.join(dataDir, 'manga.db-shm');

    let zip;
    try {
        zip = new AdmZip(buffer);
    } catch (err) {
        throw new Error('Ungültiges ZIP-Archiv: ' + err.message);
    }

    const entries = zip.getEntries();
    const dbEntry = entries.find(e => e.entryName === 'manga.db' || e.entryName.endsWith('/manga.db'));

    if (!dbEntry) {
        throw new Error('Ungültiges Backup-Archiv: Keine manga.db Datenbank im ZIP gefunden.');
    }

    // 1. Close current active SQLite connection
    closeDb();

    // 2. Safety copy of current database
    if (fs.existsSync(dbFilePath)) {
        fs.copyFileSync(dbFilePath, backupBakPath);
    }

    // 3. Remove stale WAL and SHM journal files
    if (fs.existsSync(walFilePath)) {
        try { fs.unlinkSync(walFilePath); } catch (e) {}
    }
    if (fs.existsSync(shmFilePath)) {
        try { fs.unlinkSync(shmFilePath); } catch (e) {}
    }

    try {
        // 4. Overwrite manga.db with restored database
        fs.writeFileSync(dbFilePath, dbEntry.getData());

        // 5. Restore uploads folder (cover images)
        let restoredImagesCount = 0;
        for (const entry of entries) {
            if (entry.isDirectory) continue;

            let relUploadPath = null;
            if (entry.entryName.startsWith('uploads/')) {
                relUploadPath = entry.entryName;
            } else if (entry.entryName.includes('/uploads/')) {
                relUploadPath = entry.entryName.substring(entry.entryName.indexOf('uploads/'));
            }

            if (relUploadPath) {
                const targetFilePath = path.join(dataDir, relUploadPath);
                // Security: Prevent Zip-Slip directory traversal
                if (!path.resolve(targetFilePath).startsWith(path.resolve(uploadsDir))) {
                    continue;
                }
                fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
                fs.writeFileSync(targetFilePath, entry.getData());
                restoredImagesCount++;
            }
        }

        // 6. Reconnect to database and run migrations
        initDb();

        // 7. Verify restored database is functional
        const mangaRow = db.prepare('SELECT count(*) as count FROM mangas').get();
        const mangaCount = mangaRow ? mangaRow.count : 0;

        // Cleanup temporary safety copy
        if (fs.existsSync(backupBakPath)) {
            try { fs.unlinkSync(backupBakPath); } catch (e) {}
        }

        return {
            mangaCount,
            restoredImagesCount
        };
    } catch (err) {
        // Rollback safety copy if available
        try {
            if (fs.existsSync(backupBakPath)) {
                fs.copyFileSync(backupBakPath, dbFilePath);
                try { fs.unlinkSync(backupBakPath); } catch (e) {}
            }
            initDb();
        } catch (rollbackErr) {
            console.error('[Backup Restore] Rollback failed:', rollbackErr);
        }
        throw err;
    }
}

// 1. Direct stream download of current backup
app.get('/api/backup', requireAdmin, (req, res) => {
    res.attachment('manga-shelf-backup.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => res.status(500).send({error: err.message}));
    archive.pipe(res);

    const dbFile = path.join(dataDir, 'manga.db');
    if (fs.existsSync(dbFile)) {
        archive.file(dbFile, { name: 'manga.db' });
    }
    if (fs.existsSync(uploadsDir)) {
        archive.directory(uploadsDir, 'uploads');
    }

    archive.finalize();
});

// 2. List all automated and manual server snapshots
app.get('/api/backups', requireAdmin, (req, res) => {
    try {
        const files = fs.readdirSync(backupsDir)
            .filter(f => f.endsWith('.zip'))
            .map(f => {
                const fp = path.join(backupsDir, f);
                const stat = fs.statSync(fp);
                return {
                    filename: f,
                    size: stat.size,
                    created_at: stat.birthtime || stat.mtime
                };
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({ backups: files });
    } catch (err) {
        console.error('Error listing backups:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Backups' });
    }
});

// 3. Create a new server snapshot
app.post('/api/backups/create', requireAdmin, async (req, res) => {
    try {
        const snapshot = await createBackupSnapshot('manual');
        res.json({ success: true, snapshot });
    } catch (err) {
        console.error('Error creating snapshot:', err);
        res.status(500).json({ error: 'Fehler beim Erstellen des Snapshots: ' + err.message });
    }
});

// 4. Restore from an existing server snapshot
app.post('/api/backups/:filename/restore', requireAdmin, async (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const filePath = path.join(backupsDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Snapshot-Datei nicht gefunden' });
        }

        const buffer = fs.readFileSync(filePath);
        const result = await restoreFromZipBuffer(buffer);

        console.log(`[Backup Restore] Restored snapshot ${filename} (${result.mangaCount} Mangas)`);
        res.json({
            success: true,
            message: `Snapshot "${filename}" erfolgreich wiederhergestellt! (${result.mangaCount} Mangas, ${result.restoredImagesCount} Uploads)`,
            ...result
        });
    } catch (err) {
        console.error('Error restoring snapshot:', err);
        res.status(500).json({ error: 'Fehler beim Wiederherstellen: ' + err.message });
    }
});

// 5. Download a specific server snapshot
app.get('/api/backups/:filename/download', requireAdmin, (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const filePath = path.join(backupsDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Snapshot-Datei nicht gefunden' });
        }

        res.download(filePath, filename);
    } catch (err) {
        res.status(500).json({ error: 'Download-Fehler' });
    }
});

// 6. Delete a specific server snapshot
app.delete('/api/backups/:filename', requireAdmin, (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const filePath = path.join(backupsDir, filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true, message: 'Snapshot gelöscht' });
    } catch (err) {
        res.status(500).json({ error: 'Fehler beim Löschen des Snapshots' });
    }
});

// 7. Manual ZIP upload restore
const uploadBackup = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 } // 500 MB max backup size
});

const handleUploadedBackupRestore = async (req, res) => {
    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Keine Backup-Datei (.zip) ausgewählt' });
    }

    try {
        const result = await restoreFromZipBuffer(req.file.buffer);
        res.json({
            success: true,
            message: `Backup erfolgreich eingespielt! (${result.mangaCount} Manga-Reihen und ${result.restoredImagesCount} Bilddateien wiederhergestellt)`,
            ...result
        });
    } catch (err) {
        console.error('[Backup Restore] Error:', err);
        res.status(500).json({ error: 'Fehler beim Wiederherstellen des Backups: ' + err.message });
    }
};

app.post('/api/backup/restore', requireAdmin, uploadBackup.single('backup'), handleUploadedBackupRestore);
app.post('/api/restore', requireAdmin, uploadBackup.single('backup'), handleUploadedBackupRestore);

// Daily automated backup scheduler (runs after 10s on boot, then every 24 hours)
setTimeout(async () => {
    try {
        const todayStr = new Date().toISOString().slice(0, 10);
        const existing = fs.readdirSync(backupsDir).filter(f => f.includes(todayStr));
        if (existing.length === 0) {
            console.log('[Auto-Backup] Creating daily automatic manga shelf backup snapshot...');
            await createBackupSnapshot('daily-auto');
            console.log('[Auto-Backup] Daily automatic backup completed successfully.');
        }
    } catch (e) {
        console.warn('[Auto-Backup] Initial daily backup check failed:', e.message);
    }
}, 10000);

setInterval(async () => {
    try {
        console.log('[Auto-Backup] Running scheduled daily backup snapshot...');
        await createBackupSnapshot('daily-auto');
        console.log('[Auto-Backup] Scheduled daily backup completed.');
    } catch (e) {
        console.error('[Auto-Backup] Scheduled backup failed:', e);
    }
}, 24 * 60 * 60 * 1000);



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
