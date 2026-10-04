#!/usr/bin/env node
// Rehearses the pending schema migrations on a copy of a database: node scripts/migrate-dry-run.js <manga.db> [--keep]
// The original file is only opened read-only; the copy lives in a temporary DATA_DIR that is deleted afterwards.
const fs = require('fs');
const os = require('os');
const path = require('path');

const COUNTED_TABLES = ['users', 'mangas', 'volumes', 'volume_owners', 'volume_reads'];

function usage(message) {
    if (message) console.error(message);
    console.error('Aufruf: node scripts/migrate-dry-run.js <pfad/zu/manga.db> [--keep]');
    process.exit(2);
}

function copyDatabase(source, target) {
    const { DatabaseSync } = require('node:sqlite');
    // a read-only connection to a WAL database still creates -wal/-shm next to it: remove the ones it created
    const created = ['-wal', '-shm'].filter(suffix => !fs.existsSync(source + suffix));
    let src;
    try {
        src = new DatabaseSync(source, { readOnly: true });
        src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        return 'VACUUM INTO';
    } catch (err) {
        // e.g. a WAL database in a read-only folder without its -shm file: copy the files instead
        for (const suffix of ['', '-wal']) {
            if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, target + suffix);
        }
        return `Dateikopie (${err.message})`;
    } finally {
        try { src && src.close(); } catch (e) { /* ignore */ }
        for (const suffix of created) {
            try {
                if (suffix === '-shm' || fs.statSync(source + suffix).size === 0) fs.unlinkSync(source + suffix);
            } catch (e) { /* not there */ }
        }
    }
}

function tableCounts(conn) {
    const tables = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
    const counts = {};
    for (const t of COUNTED_TABLES) counts[t] = tables.has(t) ? conn.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n : null;
    return counts;
}

function schemaVersion(conn) {
    const tracked = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    return tracked ? (conn.prepare('SELECT max(version) AS v FROM schema_migrations').get().v || 0) : 0;
}

const fmt = (n) => (n === null ? '–' : n.toLocaleString('de-DE'));

function main() {
    const args = process.argv.slice(2);
    const keep = args.includes('--keep');
    const file = args.find(a => !a.startsWith('--'));
    if (!file) usage();
    const source = path.resolve(file);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) usage(`Datei nicht gefunden: ${source}`);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-dry-run-'));
    const copy = path.join(dataDir, 'manga.db');
    let ok = false;
    try {
        const method = copyDatabase(source, copy);
        const { DatabaseSync } = require('node:sqlite');
        const before = new DatabaseSync(copy);
        const fromVersion = schemaVersion(before);
        const countsBefore = tableCounts(before);
        before.close();

        process.env.DATA_DIR = dataDir;
        if (process.env.LOG_LEVEL === undefined) process.env.LOG_LEVEL = 'warn';
        const dbm = require('../db');
        const report = dbm.getLastMigrationReport();
        const conn = dbm.db;
        const countsAfter = tableCounts(conn);
        const integrity = conn.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
        const foreignKeyErrors = conn.prepare('PRAGMA foreign_key_check').all();
        const safety = fs.existsSync(path.join(dataDir, 'backups'))
            ? fs.readdirSync(path.join(dataDir, 'backups')).filter(f => f.startsWith('vor-update-')) : [];

        console.log(`Datenbank:   ${source}`);
        console.log(`Kopie:       ${copy} (${method})`);
        console.log(`Schema:      v${fromVersion} -> v${schemaVersion(conn)} (App: v${dbm.LATEST_SCHEMA_VERSION})`);
        if (!report.length) {
            console.log('Migrationen: keine ausstehend');
        } else {
            console.log(`Migrationen: ${report.length} ausgeführt${safety.length ? `, Sicherung vorher: ${safety[0]}` : ''}`);
            for (const m of report) console.log(`  v${m.version} ${m.name}: ${fmt(m.changes)} Zeilen geändert, ${m.ms} ms`);
        }
        console.log('Zeilen (vorher -> nachher):');
        for (const t of COUNTED_TABLES) console.log(`  ${t.padEnd(14)} ${fmt(countsBefore[t])} -> ${fmt(countsAfter[t])}`);
        console.log(`integrity_check:   ${integrity.join('; ')}`);
        console.log(`foreign_key_check: ${foreignKeyErrors.length ? `${foreignKeyErrors.length} Verstöße` : 'ok'}`);
        for (const v of foreignKeyErrors.slice(0, 20)) console.log(`  ${v.table} rowid ${v.rowid} -> ${v.parent}`);
        dbm.closeDb();
        ok = integrity.length === 1 && integrity[0] === 'ok' && foreignKeyErrors.length === 0;
        console.log(ok ? 'Ergebnis: ok, das Original wurde nicht verändert.' : 'Ergebnis: PROBLEME gefunden, das Original wurde nicht verändert.');
    } catch (err) {
        console.error(`Migration der Kopie fehlgeschlagen: ${err && err.message}`);
    } finally {
        if (keep) console.log(`Kopie behalten: ${dataDir}`);
        else fs.rmSync(dataDir, { recursive: true, force: true });
    }
    process.exit(ok ? 0 : 1);
}

main();
