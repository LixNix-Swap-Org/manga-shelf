const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { db, dataDir, uploadsDir } = require('../db');

const backupsDir = path.join(dataDir, 'backups');
if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
}

/**
 * Retains only the newest N backup snapshots in backupsDir
 */
function pruneBackups(maxSnapshots = 7) {
    try {
        const allBackups = fs.readdirSync(backupsDir)
            .filter(f => f.endsWith('.zip'))
            .map(f => ({
                name: f,
                time: fs.statSync(path.join(backupsDir, f)).mtimeMs
            }))
            .sort((a, b) => b.time - a.time);

        if (allBackups.length > maxSnapshots) {
            const toDelete = allBackups.slice(maxSnapshots);
            for (const b of toDelete) {
                try { 
                    fs.unlinkSync(path.join(backupsDir, b.name)); 
                } catch (e) {}
            }
        }
    } catch (e) {
        console.warn('Pruning old backups failed:', e);
    }
}

/**
 * Creates a new ZIP backup snapshot of manga.db and uploads/
 */
async function createBackupSnapshot(prefix = 'manga-shelf-backup') {
    // Flush WAL checkpoint to ensure manga.db is fully consistent on disk
    try {
        db.prepare('PRAGMA wal_checkpoint(TRUNCATE);').run();
    } catch (e) {}

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
    pruneBackups(7);

    const stat = fs.statSync(targetFile);
    return { filename, size: stat.size, created_at: new Date().toISOString() };
}

/**
 * Initializes automated daily backup scheduler
 */
function initScheduler() {
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
}

module.exports = {
    backupsDir,
    createBackupSnapshot,
    pruneBackups,
    initScheduler
};
