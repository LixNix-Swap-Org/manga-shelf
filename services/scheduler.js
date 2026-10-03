const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { db, dataDir, uploadsDir, tempDir } = require('../db');
const log = require('../utils/logger').child('scheduler');

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
        log.warn('Pruning old backups failed:', e);
    }
}

/**
 * Writes a consistent copy of the live database to a temp file (VACUUM INTO) and returns its path.
 * Zipping manga.db directly could read it while a write is in progress. The caller deletes the file afterwards.
 */
function copyDatabaseToTemp() {
    fs.mkdirSync(tempDir, { recursive: true });
    const target = path.join(tempDir, `backup-db-${Date.now()}-${Math.round(Math.random() * 1e9)}.db`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return target;
}

/**
 * Creates a new ZIP backup snapshot of manga.db and uploads/
 */
async function createBackupSnapshot(prefix = 'manga-shelf-backup') {
    const dbCopy = copyDatabaseToTemp();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${prefix}-${timestamp}.zip`;
    const targetFile = path.join(backupsDir, filename);

    try {
        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(targetFile);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);

            archive.file(dbCopy, { name: 'manga.db' });

            if (fs.existsSync(uploadsDir)) {
                archive.directory(uploadsDir, 'uploads');
            }

            archive.finalize();
        });
    } finally {
        try { fs.unlinkSync(dbCopy); } catch (e) { /* temp file already gone */ }
    }

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
                log.info('[Auto-Backup] Creating daily automatic manga shelf backup snapshot...');
                await createBackupSnapshot('daily-auto');
                log.info('[Auto-Backup] Daily automatic backup completed successfully.');
            }
        } catch (e) {
            log.warn('[Auto-Backup] Initial daily backup check failed:', e.message);
        }
    }, 10000);

    setInterval(async () => {
        try {
            log.info('[Auto-Backup] Running scheduled daily backup snapshot...');
            await createBackupSnapshot('daily-auto');
            log.info('[Auto-Backup] Scheduled daily backup completed.');
        } catch (e) {
            log.error('[Auto-Backup] Scheduled backup failed:', e);
        }
    }, 24 * 60 * 60 * 1000);
}

module.exports = {
    backupsDir,
    copyDatabaseToTemp,
    createBackupSnapshot,
    pruneBackups,
    initScheduler
};
