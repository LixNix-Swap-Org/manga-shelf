const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pkg = require('../package.json');
const { db, hasAdmin } = require('../db');
const { 
    JWT_SECRET, 
    setAuthCookie, 
    clearAuthCookie, 
    requireAuth, 
    requireAdmin 
} = require('../middleware/auth');
const { loginLimiter, setupLimiter } = require('../middleware/rateLimit');
const log = require('../utils/logger').child('auth');

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // bcrypt ignores everything beyond 72 bytes
const passwordError = (pw) => {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
        return `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein`;
    }
    if (Buffer.byteLength(pw) > MAX_PASSWORD_LENGTH) {
        return `Passwort darf höchstens ${MAX_PASSWORD_LENGTH} Bytes lang sein`;
    }
    return null;
};

// --- SYSTEM & VERSION ---
router.get('/version', (req, res) => {
    res.json({ version: pkg.version });
});

// --- SETUP & AUTH ---
router.get('/setup/status', (req, res) => {
    res.json({ needsSetup: !hasAdmin(), version: pkg.version });
});

router.post('/setup', setupLimiter, async (req, res) => {
    try {
        if (hasAdmin()) return res.status(400).json({ error: 'Admin already exists' });
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || !username.trim() || typeof password !== 'string') {
            return res.status(400).json({ error: 'Benutzername und Passwort sind erforderlich' });
        }
        const pwErr = passwordError(password);
        if (pwErr) return res.status(400).json({ error: pwErr });

        const cleanUsername = username.trim();
        const hash = await bcrypt.hash(password, 10);

        // Re-check right before the (synchronous) insert so two concurrent setups cannot both create an admin
        if (hasAdmin()) return res.status(400).json({ error: 'Admin already exists' });
        const result = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(cleanUsername, hash, 'admin');
        const newUserId = Number(result.lastInsertRowid);

        // Auto-login on setup
        const token = jwt.sign({ id: newUserId, username: cleanUsername, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
        setAuthCookie(req, res, token);
        res.json({ success: true, user: { id: newUserId, username: cleanUsername, role: 'admin' } });
    } catch (err) {
        log.error('Setup error:', err);
        res.status(500).json({ error: 'Fehler bei der Einrichtung' });
    }
});

// Pre-computed hash so unknown usernames cost the same time as wrong passwords (no user enumeration by timing)
const DUMMY_HASH = bcrypt.hashSync('manga-shelf-dummy-password', 10);

router.post('/auth/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
            return res.status(400).json({ error: 'Bitte Benutzername und Passwort eingeben' });
        }
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
        const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
        if (!user || !valid) {
            return res.status(401).json({ error: 'Ungültige Anmeldedaten' });
        }

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        setAuthCookie(req, res, token);
        res.json({ success: true, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
        log.error('Login error:', err);
        res.status(500).json({ error: 'Anmeldung fehlgeschlagen' });
    }
});

router.post('/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
});

router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// --- USER MANAGEMENT (Admin only) ---
router.get('/users', requireAdmin, (req, res) => {
    try {
        const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id ASC').all();
        res.json(users);
    } catch (err) {
        log.error('Error fetching users:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Benutzer' });
    }
});

router.post('/users', requireAdmin, async (req, res) => {
    try {
        const { username, password, role = 'editor' } = req.body || {};
        if (typeof username !== 'string' || !username.trim()) {
            return res.status(400).json({ error: 'Benutzername darf nicht leer sein' });
        }
        const pwErr = passwordError(password);
        if (pwErr) return res.status(400).json({ error: pwErr });
        const cleanUsername = username.trim();
        const cleanRole = ['admin', 'visitor', 'guest'].includes(role) ? role : 'editor';

        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
        if (existing) {
            return res.status(400).json({ error: 'Dieser Benutzername existiert bereits' });
        }

        const hash = await bcrypt.hash(password, 10);
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
        log.error('Error creating user:', err);
        res.status(500).json({ error: 'Fehler beim Anlegen des Benutzers' });
    }
});

router.put('/users/:id', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        const { role, password } = req.body || {};
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

        if (password) {
            const pwErr = passwordError(password);
            if (pwErr) return res.status(400).json({ error: pwErr });
            const hash = await bcrypt.hash(password, 10);
            db.prepare('UPDATE users SET role = ?, password_hash = ? WHERE id = ?').run(newRole, hash, userId);
        } else {
            db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, userId);
        }
        res.json({ success: true, user: { id: userId, username: user.username, role: newRole } });
    } catch (err) {
        log.error('Error updating user:', err);
        res.status(500).json({ error: 'Fehler beim Aktualisieren des Benutzers' });
    }
});

router.delete('/users/:id', requireAdmin, (req, res) => {
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
        log.error('Error deleting user:', err);
        res.status(500).json({ error: 'Fehler beim Löschen des Benutzers' });
    }
});

router.get('/users/:id/stats', requireAuth, (req, res) => {
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
        log.error('Error fetching user stats:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Benutzer-Statistiken' });
    }
});

module.exports = router;
