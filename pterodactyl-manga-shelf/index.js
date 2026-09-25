const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const archiver = require('archiver');
require('dotenv').config();

const { db, hasAdmin, uploadsDir, dataDir } = require('./db');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors());

// Serve uploads
app.use('/uploads', express.static(uploadsDir));

// Multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-manga-key-change-in-prod';

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

// --- SETUP & AUTH ---
app.get('/api/setup/status', (req, res) => {
    res.json({ needsSetup: !hasAdmin() });
});

app.post('/api/setup', (req, res) => {
    if (hasAdmin()) return res.status(400).json({ error: 'Admin already exists' });
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    
    const hash = bcrypt.hashSync(password, 10);
    const stmt = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    stmt.run(username, hash, 'admin');
    res.json({ success: true });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
    res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// --- MANGA API ---
app.get('/api/mangas', requireAuth, (req, res) => {
    const mangas = db.prepare('SELECT * FROM mangas ORDER BY title ASC').all();
    res.json(mangas);
});

app.post('/api/mangas', requireAuth, (req, res) => {
    const data = req.body;
    const stmt = db.prepare(`
        INSERT INTO mangas (title, alt_title, author, publisher, language, status, tags, total_volumes, description, cover_image, banner_image, updated_by)
        VALUES (@title, @alt_title, @author, @publisher, @language, @status, @tags, @total_volumes, @description, @cover_image, @banner_image, @updated_by)
    `);
    const result = stmt.run({ ...data, updated_by: req.user.id });
    res.json({ id: result.lastInsertRowid });
});

app.get('/api/mangas/:id', requireAuth, (req, res) => {
    const manga = db.prepare('SELECT * FROM mangas WHERE id = ?').get(req.params.id);
    if (!manga) return res.status(404).json({ error: 'Manga not found' });
    const volumes = db.prepare('SELECT * FROM volumes WHERE manga_id = ? ORDER BY volume_number ASC').all(req.params.id);
    manga.volumes = volumes;
    res.json(manga);
});

app.put('/api/mangas/:id', requireAuth, (req, res) => {
    const data = req.body;
    const stmt = db.prepare(`
        UPDATE mangas SET title = @title, alt_title = @alt_title, author = @author, publisher = @publisher, 
        language = @language, status = @status, tags = @tags, total_volumes = @total_volumes, 
        owned_volumes = @owned_volumes, description = @description, cover_image = @cover_image, 
        banner_image = @banner_image, updated_by = @updated_by, updated_at = CURRENT_TIMESTAMP
        WHERE id = @id
    `);
    stmt.run({ ...data, updated_by: req.user.id, id: req.params.id });
    res.json({ success: true });
});

// --- VOLUMES API ---
app.post('/api/volumes', requireAuth, (req, res) => {
    const data = req.body;
    const stmt = db.prepare(`
        INSERT INTO volumes (manga_id, volume_number, isbn, purchase_date, status, notes)
        VALUES (@manga_id, @volume_number, @isbn, @purchase_date, @status, @notes)
    `);
    const result = stmt.run(data);
    // Update owned count
    db.prepare('UPDATE mangas SET owned_volumes = (SELECT count(*) FROM volumes WHERE manga_id = ? AND status = "Vorhanden") WHERE id = ?').run(data.manga_id, data.manga_id);
    res.json({ id: result.lastInsertRowid });
});

app.put('/api/volumes/:id', requireAuth, (req, res) => {
    const data = req.body;
    const stmt = db.prepare(`
        UPDATE volumes SET volume_number = @volume_number, isbn = @isbn, purchase_date = @purchase_date, status = @status, notes = @notes
        WHERE id = @id
    `);
    stmt.run({ ...data, id: req.params.id });
    // Update owned count
    const vol = db.prepare('SELECT manga_id FROM volumes WHERE id = ?').get(req.params.id);
    if(vol) {
        db.prepare('UPDATE mangas SET owned_volumes = (SELECT count(*) FROM volumes WHERE manga_id = ? AND status = "Vorhanden") WHERE id = ?').run(vol.manga_id, vol.manga_id);
    }
    res.json({ success: true });
});

// --- UPLOADS ---
app.post('/api/upload', requireAuth, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({ url: '/uploads/' + req.file.filename });
});

// --- BACKUP ---
app.get('/api/backup', requireAdmin, (req, res) => {
    res.attachment('manga-shelf-backup.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => res.status(500).send({error: err.message}));
    archive.pipe(res);
    archive.directory(dataDir, false);
    archive.finalize();
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

app.use(express.static(frontendPath));
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
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Manga Shelf running on http://0.0.0.0:${PORT}`);
});

// Graceful Shutdown
const shutdown = () => {
    console.log('Shutting down...');
    server.close(() => {
        db.close();
        process.exit(0);
    });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
