const express = require('express');
const router = express.Router();
const { db, runTransaction } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const { toCsv, parseCsv, mapCsvRows } = require('../services/csvExchange');
const { addOwner, syncOwnersWithStatus } = require('../utils/owners');
const log = require('../utils/logger').child('exchange');

const MAX_IMPORT_ROWS = 20000;

router.get('/export/csv', requireAuth, (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT m.title AS series, COALESCE(NULLIF(TRIM(v.publisher), ''), m.publisher) AS publisher, m.author,
                   COALESCE(v.type, 'volume') AS type, v.volume_number, v.status, v.isbn, v.price,
                   v.release_date, v.purchase_date, v.condition, v.pages, v.notes,
                   (SELECT GROUP_CONCAT(u.username, ', ') FROM volume_owners vo JOIN users u ON u.id = vo.user_id WHERE vo.volume_id = v.id) AS owners
            FROM volumes v JOIN mangas m ON m.id = v.manga_id
            ORDER BY m.title COLLATE NOCASE, m.id, CAST(v.volume_number AS REAL), v.volume_number
        `).all();
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="manga-shelf-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.send(toCsv(rows));
    } catch (err) {
        log.error('CSV-Export fehlgeschlagen:', err);
        res.status(500).json({ error: 'Export fehlgeschlagen' });
    }
});

// Body: { csv: "<Text>", dry_run?: true }. Vorhandene Einträge (Reihe + Typ + Nummer) werden nie verändert.
router.post('/import/csv', requireEditor, (req, res) => {
    try {
        const csv = req.body && req.body.csv;
        if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'CSV-Text fehlt' });
        const rows = parseCsv(csv);
        if (rows.length - 1 > MAX_IMPORT_ROWS) return res.status(400).json({ error: `Zu viele Zeilen (maximal ${MAX_IMPORT_ROWS})` });
        const { records, errors } = mapCsvRows(rows);
        const dryRun = !!req.body.dry_run;

        const findManga = db.prepare('SELECT id FROM mangas WHERE LOWER(TRIM(title)) = LOWER(?) ORDER BY id LIMIT 1');
        const findVolume = db.prepare(`SELECT id FROM volumes WHERE manga_id = ? AND LOWER(TRIM(volume_number)) = LOWER(?) AND COALESCE(type, 'volume') = ?`);
        const insertManga = db.prepare('INSERT INTO mangas (title, author, publisher, language, status, updated_by) VALUES (?, ?, ?, ?, ?, ?)');
        const insertVolume = db.prepare(`
            INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, condition, pages, publisher, purchase_date, status, notes, type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const findUser = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE');
        const recount = db.prepare("UPDATE mangas SET owned_volumes = (SELECT count(*) FROM volumes WHERE manga_id = ? AND status = 'Vorhanden') WHERE id = ?");

        const result = { created_series: 0, created_volumes: 0, skipped_existing: 0, errors };
        runTransaction(() => {
            const touched = new Set();
            const newSeries = new Map();
            const seen = new Set();
            for (const r of records) {
                const key = r.series.toLowerCase();
                let mangaId = newSeries.get(key);
                if (!mangaId) {
                    const existing = findManga.get(r.series.toLowerCase());
                    mangaId = existing ? existing.id : null;
                }
                const dupKey = `${key}|${r.type}|${r.volume_number.toLowerCase()}`;
                if (seen.has(dupKey) || (mangaId && findVolume.get(mangaId, r.volume_number.toLowerCase(), r.type))) {
                    result.skipped_existing++;
                    continue;
                }
                seen.add(dupKey);
                result.created_volumes++;
                if (!mangaId) {
                    result.created_series++;
                    if (dryRun) { newSeries.set(key, -1); continue; }
                    mangaId = Number(insertManga.run(r.series, r.author, r.publisher ? normalizePublisher(r.publisher) : null, 'Deutsch', 'Laufend', req.user.id).lastInsertRowid);
                    newSeries.set(key, mangaId);
                }
                if (dryRun || mangaId === -1) continue;
                const ins = insertVolume.run(mangaId, r.volume_number, r.isbn, r.price, r.release_date, r.condition, r.pages,
                    r.publisher ? normalizePublisher(r.publisher) : null, r.purchase_date, r.status, r.notes, r.type);
                const newVolumeId = Number(ins.lastInsertRowid);
                // Besitzer aus der Spalte „Besitzer“ (unbekannte Namen werden ignoriert); ohne Treffer wird der Importierende Besitzer
                if (r.status === 'Vorhanden') {
                    for (const name of r.owners || []) {
                        const u = findUser.get(name);
                        if (u) addOwner(db, newVolumeId, u.id, { price: r.price, purchase_date: r.purchase_date, condition: r.condition });
                    }
                }
                syncOwnersWithStatus(db, newVolumeId, req.user.id);
                touched.add(mangaId);
            }
            for (const id of touched) recount.run(id, id);
        });
        res.json({ success: true, dry_run: dryRun, ...result });
    } catch (err) {
        log.error('CSV-Import fehlgeschlagen:', err);
        res.status(500).json({ error: 'Import fehlgeschlagen' });
    }
});

module.exports = router;
