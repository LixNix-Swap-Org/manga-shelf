// CSV exchange: export of all series and volumes (GET /export/csv) and the import (POST /import/csv, dry run first).
const { normalizePublisher } = require('../lib/publishers');
const { toCsv, parseCsv, mapCsvRows, matchKey, CsvFormatError, SERIES_DETAIL_KEYS, SERIES_ROW_TYPE } = require('../csvExchange');
const { canonicalVolumeNumber } = require('../lib/volumeNumber');
const { inferVolumeType } = require('../lib/volumeType');
const { addOwner, syncOwnersWithStatus, markRead, OWNED_STATUS } = require('../lib/owners');
const { badRequest } = require('../errors');

const DRY_RUN_ROLLBACK = Symbol('dry-run');
const MAX_IMPORT_ROWS = 20000;
// maxCellLength begrenzt nur den Parser (DoS, ein altes data:-Cover passt noch); längere Zellen als MAX_CELL_LENGTH sind
// ein Fehler ihrer Zeile, außer Band-Cover, Bilder und Reihenspalten (mapCsvRows)
const CSV_LIMITS = { maxRows: MAX_IMPORT_ROWS, maxCells: 100, maxCellLength: 2000000 };
const OTHERS_ONLY_OWNERS = 'Besitz anderer Benutzer kann nur ein Admin importieren';
// Unbekannte Namen einer Zelle: so viele einzeln melden, den Rest zusammengefasst
const MAX_NAME_WARNINGS = 5;

// Wie parseFlag in core/lib/validate.js ("false"/"0"/"nein" sind falsch), aber ohne Angabe = kein Probelauf
const isDryRun = (val) => val !== undefined && val !== null && val !== false && val !== 0
    && !/^(false|0|no|nein|)$/i.test(String(val).trim());

const publisherKey = (name) => matchKey(normalizePublisher(name) || '');

function exportCsv(ctx) {
    // LEFT JOIN: Reihen ohne Bände erscheinen als Reihen-Zeile (Typ "Reihe", ohne Bandnummer)
    const rows = ctx.db.prepare(`
        SELECT m.id AS manga_id, m.title AS series, m.publisher AS series_publisher, NULLIF(TRIM(v.publisher), '') AS publisher, m.author,
               CASE WHEN v.id IS NULL THEN '${SERIES_ROW_TYPE}' ELSE COALESCE(v.type, 'volume') END AS type, v.volume_number, v.status, v.isbn,
               v.price, v.target_price, NULLIF(v.priority, 0) AS priority, v.release_date, v.release_year, v.purchase_date,
               v.condition, v.pages, v.notes,
               m.wish_priority AS series_wish, m.status AS series_status, NULLIF(m.collecting, 'aktiv') AS series_collecting, m.total_volumes AS series_total, m.alt_title AS series_alt_title,
               m.language AS series_language, m.tags AS series_tags, m.manga_passion_id AS series_mp_id, m.cover_image AS series_cover,
               m.banner_image AS series_banner, m.description AS series_description,
               v.cover_image, v.images, v.manga_passion_volume_id AS mp_volume_id,
               (SELECT GROUP_CONCAT(u.username, ', ') FROM volume_reads vr JOIN users u ON u.id = vr.user_id WHERE vr.volume_id = v.id) AS readers,
               (SELECT GROUP_CONCAT(u.username, ', ') FROM volume_owners vo JOIN users u ON u.id = vo.user_id WHERE vo.volume_id = v.id) AS owners
        FROM mangas m LEFT JOIN volumes v ON v.manga_id = m.id
        ORDER BY m.title COLLATE NOCASE, m.id, COALESCE(v.number_sort, 0), v.volume_number, v.id
    `).all();
    let previous = null;
    for (const row of rows) {
        if (row.manga_id === previous) for (const key of SERIES_DETAIL_KEYS) row[key] = null;
        previous = row.manga_id;
    }
    return {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="manga-shelf-${ctx.now().toISOString().slice(0, 10)}.csv"`
        },
        body: toCsv(rows)
    };
}

// Body: { csv: "<Text>", dry_run?: true }. Vorhandene Einträge (Reihe + Typ + Nummer) werden nie verändert.
function importCsv(ctx, { body }) {
    const csv = body && body.csv;
    if (typeof csv !== 'string' || !csv.trim()) throw badRequest('CSV-Text fehlt');
    let rows;
    try {
        rows = parseCsv(csv, CSV_LIMITS);
    } catch (err) {
        if (err instanceof CsvFormatError) throw badRequest(err.message, 'CSV_FORMAT', { line: err.line });
        throw err;
    }
    const { records, errors, warnings, columns } = mapCsvRows(rows);
    const dryRun = isDryRun(body.dry_run);
    const bySeriesPublisher = columns.includes('series_publisher');

    // Titel, Bände und Benutzer einmal laden und in JS vergleichen: SQLite-LOWER() faltet nur ASCII (Ä bliebe Ä)
    const seriesByTitle = new Map();
    for (const m of ctx.db.prepare('SELECT id, title, publisher, wish_priority FROM mangas ORDER BY id').all()) {
        const key = matchKey(m.title);
        if (!seriesByTitle.has(key)) seriesByTitle.set(key, []);
        seriesByTitle.get(key).push({ id: m.id, pubKey: publisherKey(m.publisher), wish: m.wish_priority });
    }
    const volumeKey = (mangaId, type, number) => `${mangaId}|${type}|${matchKey(canonicalVolumeNumber(number, type))}`;
    const knownVolumes = new Set(ctx.db.prepare("SELECT manga_id, COALESCE(type, 'volume') AS type, volume_number FROM volumes").all()
        .map(v => volumeKey(v.manga_id, v.type, v.volume_number)));
    const volumesBeforeImport = new Set(knownVolumes);
    const usersExact = new Map();
    const usersFolded = new Map();
    // längster Benutzername in Abschnitten der Besitzer-Zelle ("Müller, Hans" = 2)
    let maxNameParts = 1;
    for (const u of ctx.db.prepare('SELECT id, username FROM users ORDER BY id').all()) {
        usersExact.set(u.username.trim(), u.id);
        const key = matchKey(u.username);
        if (!usersFolded.has(key)) usersFolded.set(key, u.id);
        maxNameParts = Math.max(maxNameParts, u.username.split(/[,|]/).length);
    }
    const findUser = (name) => usersExact.get(name) ?? usersFolded.get(matchKey(name));
    const isAdmin = ctx.user.role === 'admin';

    // Ohne Spalte "Reihenverlag" zählt nur der Titel (niedrigste ID gewinnt); mit ihr Titel + Verlag der Reihe
    const findSeries = (r) => {
        const list = seriesByTitle.get(matchKey(r.series));
        if (!list) return null;
        if (!bySeriesPublisher) return list[0];
        const want = publisherKey(r.series_publisher);
        return list.find(c => c.pubKey === want) || (want ? list.find(c => !c.pubKey) : list[0]) || null;
    };
    const volumeExists = (series, r) => knownVolumes.has(volumeKey(series.id, r.type, r.volume_number))
        // Früher ohne Typ-Erkennung importiert ("Schuber 1" als Band): nicht doppelt anlegen
        || (r.type_inferred && inferVolumeType({ volume_number: r.volume_number }) !== 'volume'
            && volumesBeforeImport.has(volumeKey(series.id, 'volume', r.volume_number)));

    // Namens-Zelle: zuerst der längste Abschnitt, der ein Benutzername ist ("Müller, Hans" vor "Müller")
    const resolveNames = (raw) => {
        const parts = String(raw || '').split(/([,|])/);
        const count = Math.ceil(parts.length / 2);
        const ids = [];
        const unknown = [];
        for (let i = 0; i < count;) {
            let matched = false;
            for (let j = Math.min(count, i + maxNameParts) - 1; j >= i; j--) {
                const name = parts.slice(2 * i, 2 * j + 1).join('').trim();
                const id = name ? findUser(name) : undefined;
                if (id !== undefined) {
                    if (!ids.includes(id)) ids.push(id);
                    i = j + 1;
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                const name = parts[2 * i].trim();
                if (name) unknown.push(name);
                i++;
            }
        }
        return { ids, unknown };
    };
    // Nur Admins dürfen andere Benutzer als Besitzer oder Leser eintragen (wie /volumes/:id/owners und /read)
    const resolveUsers = (raw, r, unknownText) => {
        const { ids, unknown } = resolveNames(raw);
        const allowed = isAdmin ? ids : ids.filter(id => id === ctx.user.id);
        const messages = unknown.map(name => `${unknownText} „${name}“ (ignoriert)`);
        if (allowed.length < ids.length) messages.push('Andere Benutzer als dich selbst kann nur ein Admin eintragen (ignoriert)');
        const shown = messages.length > MAX_NAME_WARNINGS + 1 ? messages.slice(0, MAX_NAME_WARNINGS) : messages;
        for (const message of shown) result.warnings.push({ line: r.line, message });
        if (shown.length < messages.length) {
            result.warnings.push({ line: r.line, message: `… und ${messages.length - shown.length} weitere Hinweise zu dieser Zeile` });
        }
        return allowed;
    };

    // Reihenfelder einer neuen Reihe: je Feld der erste ausgefüllte Wert aus allen Zeilen dieser Reihe, auch aus verworfenen
    const seriesMetaKey = (r) => matchKey(r.series) + (bySeriesPublisher ? '|' + publisherKey(r.series_publisher) : '');
    const seriesMeta = new Map();
    const metaSources = [...records, ...errors.map(e => e.series_source).filter(Boolean)].sort((a, b) => a.line - b.line);
    for (const r of metaSources) {
        const key = seriesMetaKey(r);
        const merged = seriesMeta.get(key) || {};
        for (const [field, value] of Object.entries(r.series_meta || {})) if (merged[field] === undefined) merged[field] = value;
        seriesMeta.set(key, merged);
    }

    const insertManga = ctx.db.prepare(`
        INSERT INTO mangas (title, author, publisher, language, status, alt_title, tags, total_volumes, description, cover_image,
                            banner_image, manga_passion_id, wish_priority, collecting, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateWish = ctx.db.prepare('UPDATE mangas SET wish_priority = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const insertVolume = ctx.db.prepare(`
        INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, release_year, condition, pages, publisher,
                             purchase_date, status, notes, type, priority, target_price, cover_image, images, manga_passion_volume_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = { created_series: 0, updated_series: 0, created_volumes: 0, skipped_existing: 0, errors: [], warnings: [...warnings] };
    const rowErrors = [];
    let placeholderId = 0;
    const createSeries = (r) => {
        const publisher = normalizePublisher(bySeriesPublisher ? r.series_publisher : r.publisher);
        const meta = seriesMeta.get(seriesMetaKey(r)) || {};
        const id = dryRun
            ? --placeholderId
            : Number(insertManga.run(
                r.series, r.author, publisher, meta.language || 'Deutsch', meta.status || 'Laufend', meta.alt_title ?? null,
                meta.tags ?? null, meta.total_volumes ?? null, meta.description ?? null, meta.cover_image ?? null,
                meta.banner_image ?? null, meta.manga_passion_id ?? null, meta.wish_priority ?? null, meta.collecting || 'aktiv', ctx.user.id
            ).lastInsertRowid);
        const entry = { id, pubKey: publisherKey(publisher), wish: meta.wish_priority ?? null };
        const key = matchKey(r.series);
        if (!seriesByTitle.has(key)) seriesByTitle.set(key, []);
        seriesByTitle.get(key).push(entry);
        result.created_series++;
        return entry;
    };

    const run = () => {
        for (const r of records) {
            let series = findSeries(r);
            if (r.series_only) {
                const wish = r.series_meta?.wish_priority;
                // eine Reihen-Zeile setzt den Wunsch einer vorhandenen Reihe; sonst bleiben vorhandene Reihen unangetastet
                if (series && wish !== undefined && wish !== series.wish) {
                    if (!dryRun && series.id > 0) updateWish.run(wish, ctx.user.id, series.id);
                    series.wish = wish;
                    result.updated_series++;
                } else if (series) result.skipped_existing++;
                else createSeries(r);
                continue;
            }
            if (series && volumeExists(series, r)) {
                result.skipped_existing++;
                continue;
            }
            // Ein Nicht-Admin wird nie an die Stelle der Besitzer gesetzt, die die Datei nennt
            if (!isAdmin && r.status === OWNED_STATUS) {
                const named = resolveNames(r.owners_raw).ids;
                if (named.length > 0 && !named.includes(ctx.user.id)) {
                    rowErrors.push({ line: r.line, message: OTHERS_ONLY_OWNERS });
                    continue;
                }
            }
            if (!series) series = createSeries(r);
            knownVolumes.add(volumeKey(series.id, r.type, r.volume_number));
            result.created_volumes++;

            const ownerIds = r.status === OWNED_STATUS ? resolveUsers(r.owners_raw, r, 'Unbekannter Besitzer') : [];
            const readerIds = resolveUsers(r.readers_raw, r, 'Unbekannter Leser');
            if (r.mark_read) readerIds.push(...(ownerIds.length ? ownerIds : [ctx.user.id]));
            if (dryRun || series.id < 0) continue;

            const volumePublisher = normalizePublisher(r.publisher);
            const ins = insertVolume.run(series.id, r.volume_number, r.isbn, r.price, r.release_date, r.release_year, r.condition,
                r.pages, volumePublisher && publisherKey(volumePublisher) !== series.pubKey ? volumePublisher : null,
                r.purchase_date, r.status, r.notes, r.type, r.priority, r.target_price, r.cover_image, r.images, r.manga_passion_volume_id);
            const newVolumeId = Number(ins.lastInsertRowid);
            for (const userId of ownerIds) {
                addOwner(ctx.db, newVolumeId, userId, { price: r.price, purchase_date: r.purchase_date, condition: r.condition });
            }
            syncOwnersWithStatus(ctx.db, newVolumeId, ctx.user.id);
            for (const userId of new Set(readerIds)) markRead(ctx.db, newVolumeId, userId);
        }
    };
    if (dryRun) {
        // Probelauf: schreibt nichts, läuft zur Sicherheit trotzdem in einer Transaktion, die immer zurückgerollt wird
        try {
            ctx.db.transaction(() => { run(); throw DRY_RUN_ROLLBACK; });
        } catch (err) {
            if (err !== DRY_RUN_ROLLBACK) throw err;
        }
    } else {
        ctx.db.transaction(run);
    }

    // Fehlerhafte Zeilen, deren Band es schon gibt, würden ohnehin übersprungen
    for (const e of errors) {
        const series = e.record ? findSeries(e.record) : null;
        if (series && volumeExists(series, e.record)) result.skipped_existing++;
        else result.errors.push(e);
    }
    result.errors.push(...rowErrors);
    result.errors.sort((a, b) => a.line - b.line);
    result.warnings.sort((a, b) => a.line - b.line);
    return { body: { success: true, dry_run: dryRun, ...result } };
}

module.exports = { exportCsv, importCsv, MAX_IMPORT_ROWS };
