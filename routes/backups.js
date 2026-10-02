const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const { db, dataDir, uploadsDir, closeDb, initDb, validateDbFile } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { uploadBackup } = require('../middleware/upload');
const { backupsDir, createBackupSnapshot } = require('../services/scheduler');

/**
 * Reusable restore implementation from a file path or Buffer.
 * Passing a file path avoids loading the entire archive into Node heap.
 */
async function restoreFromZip(source) {
    const backupBakPath = path.join(dataDir, 'manga.db.bak');
    const dbFilePath = path.join(dataDir, 'manga.db');
    const walFilePath = path.join(dataDir, 'manga.db-wal');
    const shmFilePath = path.join(dataDir, 'manga.db-shm');

    let zip;
    try {
        zip = new AdmZip(source);
    } catch (err) {
        throw new Error('Ungültiges ZIP-Archiv: ' + err.message);
    }

    const entries = zip.getEntries();
    const dbEntry = entries.find(e => e.entryName === 'manga.db' || e.entryName.endsWith('/manga.db'));

    if (!dbEntry) {
        throw new Error('Ungültiges Backup-Archiv: Keine manga.db Datenbank im ZIP gefunden.');
    }

    // 1. Extract the new database next to the live one and validate it BEFORE touching anything
    const stagedDbPath = path.join(dataDir, 'manga.db.restore-tmp');
    try {
        fs.writeFileSync(stagedDbPath, dbEntry.getData());
        validateDbFile(stagedDbPath);
    } catch (err) {
        try { fs.unlinkSync(stagedDbPath); } catch (e) {}
        throw err;
    }

    // 2. Flush WAL logs to disk then close active connection
    // (this function is fully synchronous, so no other request can use the DB until initDb() below)
    try {
        db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').run();
    } catch (e) {}
    closeDb();

    // 3. Safety copy of current database
    if (fs.existsSync(dbFilePath)) {
        fs.copyFileSync(dbFilePath, backupBakPath);
    }

    // 4. Remove stale WAL and SHM journal files
    if (fs.existsSync(walFilePath)) {
        try { fs.unlinkSync(walFilePath); } catch (e) {}
    }
    if (fs.existsSync(shmFilePath)) {
        try { fs.unlinkSync(shmFilePath); } catch (e) {}
    }

    try {
        // 5. Atomically replace manga.db with the validated restored database
        fs.renameSync(stagedDbPath, dbFilePath);

        // 6. Restore uploads folder (cover images)
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
                const relToUploads = path.relative(path.resolve(uploadsDir), path.resolve(targetFilePath));
                if (!relToUploads || relToUploads.startsWith('..') || path.isAbsolute(relToUploads)) {
                    continue;
                }
                fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
                fs.writeFileSync(targetFilePath, entry.getData());
                restoredImagesCount++;
            }
        }

        // 7. Reconnect to database and run migrations
        initDb();

        // 8. Verify restored database is functional
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
        try { fs.unlinkSync(stagedDbPath); } catch (e) {}
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
router.get('/backup', requireAdmin, (req, res) => {
    try {
        // Flush WAL checkpoint to disk before streaming
        try {
            db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').run();
        } catch (e) {}

        res.attachment('manga-shelf-backup.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => res.status(500).send({ error: err.message }));
        archive.pipe(res);

        const dbFile = path.join(dataDir, 'manga.db');
        if (fs.existsSync(dbFile)) {
            archive.file(dbFile, { name: 'manga.db' });
        }
        if (fs.existsSync(uploadsDir)) {
            archive.directory(uploadsDir, 'uploads');
        }

        archive.finalize();
    } catch (err) {
        console.error('Error generating backup stream:', err);
        res.status(500).json({ error: 'Fehler beim Erstellen des Backups' });
    }
});

// 2. List all automated and manual server snapshots
router.get('/backups', requireAdmin, (req, res) => {
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
router.post('/backups/create', requireAdmin, async (req, res) => {
    try {
        const snapshot = await createBackupSnapshot('manual');
        res.json({ success: true, snapshot });
    } catch (err) {
        console.error('Error creating snapshot:', err);
        res.status(500).json({ error: 'Fehler beim Erstellen des Snapshots: ' + err.message });
    }
});

// 4. Restore from an existing server snapshot
router.post('/backups/:filename/restore', requireAdmin, async (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const filePath = path.join(backupsDir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Snapshot-Datei nicht gefunden' });
        }

        const result = await restoreFromZip(filePath);

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
router.get('/backups/:filename/download', requireAdmin, (req, res) => {
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
router.delete('/backups/:filename', requireAdmin, (req, res) => {
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

// 7. Manual ZIP upload restore with disk staging (DoS/OOM protection)
const handleUploadedBackupRestore = async (req, res) => {
    const uploadedPath = req.file?.path;
    if (!uploadedPath || !fs.existsSync(uploadedPath)) {
        return res.status(400).json({ error: 'Keine Backup-Datei (.zip) ausgewählt' });
    }

    try {
        const result = await restoreFromZip(uploadedPath);
        res.json({
            success: true,
            message: `Backup erfolgreich eingespielt! (${result.mangaCount} Manga-Reihen und ${result.restoredImagesCount} Bilddateien wiederhergestellt)`,
            ...result
        });
    } catch (err) {
        console.error('[Backup Restore] Error:', err);
        res.status(500).json({ error: 'Fehler beim Wiederherstellen des Backups: ' + err.message });
    } finally {
        // Clean up temporary staging file to free disk space
        if (uploadedPath && fs.existsSync(uploadedPath)) {
            try { 
                fs.unlinkSync(uploadedPath); 
            } catch (e) {}
        }
    }
};

router.post('/backup/restore', requireAdmin, uploadBackup.single('backup'), handleUploadedBackupRestore);
router.post('/restore', requireAdmin, uploadBackup.single('backup'), handleUploadedBackupRestore);

module.exports = router;
