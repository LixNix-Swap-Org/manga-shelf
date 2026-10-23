// CSV exchange: export of all series and volumes (GET /export/csv) and the import (POST /import/csv, dry run first).
const { normalizePublisher } = require('../lib/publishers');
const { csvLines, joinCsv, parseCsv, mapCsvRows, matchKey, rowNote, CsvFormatError, SERIES_DETAIL_KEYS, SERIES_ROW_TYPE } = require('../csvExchange');
const { canonicalVolumeNumber } = require('../lib/volumeNumber');
const { inferVolumeType } = require('../lib/volumeType');
const { addOwner, syncOwnersWithStatus, markRead, OWNED_STATUS } = require('../lib/owners');
const { HttpError, badRequest, msg } = require('../errors');
const { DEFAULT_CURRENCY, DEFAULT_LANGUAGE, isManualWorkKey, manualWorkKey } = require('../lib/language');
const { readProfile } = require('../lib/locales');
const access = require('../lib/access');
const { qstr } = require('../lib/query');

const DRY_RUN_ROLLBACK = Symbol('dry-run');
const MAX_IMPORT_ROWS = 20000;
// maxCellLength limits only the parser (DoS, an old data: cover still fits); cells longer than MAX_CELL_LENGTH are
// an error of their row, except volume covers, images and series columns (mapCsvRows)
const CSV_LIMITS = { maxRows: MAX_IMPORT_ROWS, maxCells: 100, maxCellLength: 2000000 };
const OTHERS_ONLY_OWNERS = msg('Besitz anderer Benutzer kann nur ein Admin importieren');
// Unknown names in one cell: report this many individually, the rest summarised
const MAX_NAME_WARNINGS = 5;

// Like parseFlag in core/lib/validate.js ("false"/"0"/"nein" are false), but absent = no dry run
const isDryRun = (val) => val !== undefined && val !== null && val !== false && val !== 0
    && !/^(false|0|no|nein|)$/i.test(String(val).trim());

const publisherKey = (name) => matchKey(normalizePublisher(name) || '');

// Series per block of the export; other requests get the event loop between blocks. Tests lower it.
const exportOptions = { seriesPerBlock: 50 };

const SERIES_DETAILS_SELECT = `
    SELECT id, status AS series_status, NULLIF(collecting, 'aktiv') AS series_collecting, total_volumes AS series_total,
           alt_title AS series_alt_title, language AS series_language, region AS series_region, currency AS series_currency,
           work_key AS series_work_key, tags AS series_tags, manga_passion_id AS series_mp_id,
           cover_image AS series_cover, banner_image AS series_banner, description AS series_description,
           NULLIF(format, 'print') AS series_format, total_chapters AS series_chapters,
           (SELECT GROUP_CONCAT(entry, ', ') FROM (
               SELECT u.username || ': ' || cp.chapters_read AS entry FROM chapter_progress cp JOIN users u ON u.id = cp.user_id
               WHERE cp.manga_id = mangas.id ORDER BY cp.user_id
           )) AS series_chapter_readers
    FROM mangas`;

// LEFT JOIN: series without volumes appear as a series row (type "Reihe", no volume number)
const EXPORT_SELECT = `
    SELECT m.id AS manga_id, m.title AS series, m.publisher AS series_publisher, NULLIF(TRIM(v.publisher), '') AS publisher, m.author,
           CASE WHEN v.id IS NULL THEN '${SERIES_ROW_TYPE}' ELSE COALESCE(v.type, 'volume') END AS type, v.volume_number, v.status, v.isbn,
           v.price, v.target_price, NULLIF(v.priority, 0) AS priority, v.release_date, v.release_year, v.purchase_date,
           v.condition, v.pages, v.notes, m.wish_priority AS series_wish,
           v.cover_image, v.images, v.manga_passion_volume_id AS mp_volume_id, v.language AS volume_language,
           (SELECT GROUP_CONCAT(u.username, ', ') FROM volume_reads vr JOIN users u ON u.id = vr.user_id WHERE vr.volume_id = v.id) AS readers,
           (SELECT GROUP_CONCAT(username, ', ') FROM (SELECT u.username FROM volume_owners vo JOIN users u ON u.id = vo.user_id WHERE vo.volume_id = v.id ORDER BY vo.created_at, vo.rowid)) AS owners
    FROM mangas m LEFT JOIN volumes v ON v.manga_id = m.id`;

const EXPORT_ORDER = 'ORDER BY m.title COLLATE NOCASE, m.id, COALESCE(v.number_sort, 0), v.volume_number, v.id';

/**
 * All series and volumes as CSV, built in blocks of series so a large collection does not hold the event loop.
 * A database reopened meanwhile (restore) fails the export instead of mixing two databases.
 */
async function exportCsv(ctx, { query } = {}) {
    const generation = ctx.db.generation();
    const scope = access.inShelves('shelf_id', access.requestedShelfIds(ctx, qstr(query && query.shelf_id)));
    const order = ctx.db.prepare(`SELECT id FROM mangas WHERE ${scope.sql} ORDER BY title COLLATE NOCASE, id`).all(...scope.params).map(r => r.id);
    const statements = new Map();
    const prepared = (n) => {
        if (!statements.has(n)) {
            const marks = Array(n).fill('?').join(', ');
            statements.set(n, {
                rows: ctx.db.prepare(`${EXPORT_SELECT} WHERE m.id IN (${marks}) ${EXPORT_ORDER}`),
                details: ctx.db.prepare(`${SERIES_DETAILS_SELECT} WHERE id IN (${marks})`)
            });
        }
        return statements.get(n);
    };
    const size = Math.max(1, exportOptions.seriesPerBlock);
    const blocks = [];
    for (let i = 0; i < order.length; i += size) {
        if (i > 0) {
            await ctx.yield();
            if (ctx.db.generation() !== generation) throw new HttpError(503, 'Die Datenbank wurde während des Exports neu geöffnet', 'DB_REOPENED');
        }
        const ids = order.slice(i, i + size);
        const stmt = prepared(ids.length);
        const details = new Map(stmt.details.all(...ids).map(d => [d.id, d]));
        const rows = stmt.rows.all(...ids);
        let previous = null;
        for (const row of rows) {
            const own = row.manga_id !== previous ? details.get(row.manga_id) : null;
            for (const key of SERIES_DETAIL_KEYS) row[key] = own ? own[key] : null;
            previous = row.manga_id;
        }
        blocks.push(csvLines(rows));
    }
    return {
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="manga-shelf-${ctx.now().toISOString().slice(0, 10)}.csv"`
        },
        body: joinCsv(blocks)
    };
}

// Body: { csv: "<text>", dry_run?: true }. Existing entries (series + type + number) are never changed.
function importCsv(ctx, { body }) {
    const csv = body && body.csv;
    if (typeof csv !== 'string' || !csv.trim()) throw badRequest('CSV-Text fehlt');
    let rows;
    try {
        rows = parseCsv(csv, CSV_LIMITS);
    } catch (err) {
        if (err instanceof CsvFormatError) throw badRequest(err.detail || err.message, 'CSV_FORMAT', { line: err.line });
        throw err;
    }
    const { records, errors, warnings, columns } = mapCsvRows(rows);
    const dryRun = isDryRun(body.dry_run);
    const shelfId = access.targetShelfId(ctx, body.shelf_id);
    const bySeriesPublisher = columns.includes('series_publisher');
    // with a "Sprache" column, same-title editions in different languages stay apart
    const byLanguage = columns.includes('series_language');

    // Load titles, volumes and users once and compare in JS: SQLite LOWER() folds only ASCII (Ä would stay Ä)
    const seriesByTitle = new Map();
    for (const m of ctx.db.prepare('SELECT id, title, publisher, wish_priority, language FROM mangas WHERE shelf_id = ? ORDER BY id').all(shelfId)) {
        const key = matchKey(m.title);
        if (!seriesByTitle.has(key)) seriesByTitle.set(key, []);
        seriesByTitle.get(key).push({ id: m.id, pubKey: publisherKey(m.publisher), wish: m.wish_priority, language: m.language || DEFAULT_LANGUAGE });
    }
    const volumeKey = (mangaId, type, number) => `${mangaId}|${type}|${matchKey(canonicalVolumeNumber(number, type))}`;
    const labelKey = (mangaId, type, label) => `${mangaId}|${type}|=${matchKey(label)}`;
    const knownVolumes = new Set();
    // stored volumes once more by their own spelling: "3" as plain number, "Band 3" by its label
    const knownLabels = new Set();
    for (const v of ctx.db.prepare("SELECT manga_id, COALESCE(type, 'volume') AS type, volume_number FROM volumes WHERE manga_id IN (SELECT id FROM mangas WHERE shelf_id = ?)").all(shelfId)) {
        knownVolumes.add(volumeKey(v.manga_id, v.type, v.volume_number));
        knownLabels.add(labelKey(v.manga_id, v.type, v.volume_number));
    }
    const volumesBeforeImport = new Set(knownVolumes);
    const usernames = new Map();
    // owners and readers come from the target shelf's members only; other accounts are named in a warning. A member
    // wins every name a member matches (exactly or case-folded), other accounts count only where no member does.
    const shelfMembers = new Set(ctx.db.prepare('SELECT user_id FROM shelf_members WHERE shelf_id = ?').all(shelfId).map(r => r.user_id));
    const directory = () => ({ exact: new Map(), folded: new Map() });
    const members = directory();
    const others = directory();
    // longest user name in sections of the owner cell ("Müller, Hans" = 2)
    let maxNameParts = 1;
    for (const u of ctx.db.prepare('SELECT id, username FROM users ORDER BY id').all()) {
        const into = shelfMembers.has(u.id) ? members : others;
        if (!into.exact.has(u.username.trim())) into.exact.set(u.username.trim(), u.id);
        const key = matchKey(u.username);
        if (!into.folded.has(key)) into.folded.set(key, u.id);
        usernames.set(u.id, u.username);
        maxNameParts = Math.max(maxNameParts, u.username.split(/[,|]/).length);
    }
    const lookup = ({ exact, folded }) => (name) => exact.get(name) ?? folded.get(matchKey(name));
    const findMember = lookup(members);
    const findOther = lookup(others);
    const isAdmin = ctx.user.role === 'admin';

    // The export names the language only on the first row of a series: later rows of the same title inherit it
    // (rows before the first named one take that first one)
    const rowLanguage = new Map();
    if (byLanguage) {
        const sources = [...records.map(r => [r, r]), ...errors.filter(e => e.series_source).map(e => [e.series_source, e.record])]
            .sort((a, b) => a[0].line - b[0].line);
        const named = (source) => (source.series_meta && source.series_meta.language) || null;
        const first = new Map();
        for (const [source] of sources) if (named(source) && !first.has(matchKey(source.series))) first.set(matchKey(source.series), named(source));
        const current = new Map();
        for (const [source, record] of sources) {
            const title = matchKey(source.series);
            if (named(source)) current.set(title, named(source));
            const language = current.get(title) || first.get(title) || null;
            rowLanguage.set(source, language);
            if (record && record !== source) rowLanguage.set(record, language);
        }
    }
    const languageOf = (r) => rowLanguage.get(r) || null;

    // Without a "Reihenverlag" column only the title counts (lowest ID wins); with it title + publisher of the series.
    // A row without a known language matches any edition, as before.
    const findSeries = (r) => {
        const titled = seriesByTitle.get(matchKey(r.series));
        const language = languageOf(r);
        const list = titled && language ? titled.filter(c => c.language === language) : titled;
        if (!list || !list.length) return null;
        if (!bySeriesPublisher) return list[0];
        const want = publisherKey(r.series_publisher);
        return list.find(c => c.pubKey === want) || (want ? list.find(c => !c.pubKey) : list[0]) || null;
    };
    const volumeExists = (series, r) => knownVolumes.has(volumeKey(series.id, r.type, r.volume_number))
        // Imported earlier without type detection ("Schuber 1" as a volume): do not create twice
        || (r.type_inferred && inferVolumeType({ volume_number: r.volume_number }) !== 'volume'
            && volumesBeforeImport.has(volumeKey(series.id, 'volume', r.volume_number)));

    // Name cell: at each position the longest section a member is called ("Müller, Hans" before "Müller"), then the
    // longest section another account is called
    const resolveNames = (raw) => {
        const parts = String(raw || '').split(/([,|])/);
        const count = Math.ceil(parts.length / 2);
        const ids = [];
        const unknown = [];
        const sectionAt = (i, find) => {
            for (let j = Math.min(count, i + maxNameParts) - 1; j >= i; j--) {
                const name = parts.slice(2 * i, 2 * j + 1).join('').trim();
                const id = name ? find(name) : undefined;
                if (id !== undefined) return { id, next: j + 1 };
            }
            return null;
        };
        for (let i = 0; i < count;) {
            const hit = sectionAt(i, findMember) || sectionAt(i, findOther);
            if (hit) {
                if (!ids.includes(hit.id)) ids.push(hit.id);
                i = hit.next;
                continue;
            }
            const name = parts[2 * i].trim();
            if (name) unknown.push(name);
            i++;
        }
        return { ids, unknown };
    };
    // Only admins may enter other users as owner or reader (like /volumes/:id/owners and /read), and only members
    const resolveUsers = (raw, r, unknownMsg, outsideMsg) => {
        const { ids: named, unknown } = resolveNames(raw);
        const ids = named.filter(id => shelfMembers.has(id));
        const allowed = isAdmin ? ids : ids.filter(id => id === ctx.user.id);
        const messages = [...unknown.map(unknownMsg), ...named.filter(id => !shelfMembers.has(id)).map(id => outsideMsg(usernames.get(id)))];
        if (allowed.length < ids.length) messages.push(msg('Andere Benutzer als dich selbst kann nur ein Admin eintragen (ignoriert)'));
        const shown = messages.length > MAX_NAME_WARNINGS + 1 ? messages.slice(0, MAX_NAME_WARNINGS) : messages;
        for (const message of shown) result.warnings.push(rowNote(r.line, message));
        if (shown.length < messages.length) {
            result.warnings.push(rowNote(r.line, msg('… und {count} weitere Hinweise zu dieser Zeile', { count: messages.length - shown.length })));
        }
        return allowed;
    };

    // Series fields of a new series: per field the first filled value from all rows of this series, also discarded ones
    const seriesMetaKey = (r) => matchKey(r.series) + (bySeriesPublisher ? '|' + publisherKey(r.series_publisher) : '')
        + (byLanguage ? '|' + (languageOf(r) || '') : '');
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
                            banner_image, manga_passion_id, wish_priority, collecting, updated_by, region, currency, work_key, shelf_id,
                            format, total_chapters)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChapters = ctx.db.prepare('INSERT OR REPLACE INTO chapter_progress (manga_id, user_id, chapters_read) VALUES (?, ?, ?)');
    const defaultLanguage = readProfile(ctx.db, ctx.user.id).default_language;
    const updateWish = ctx.db.prepare('UPDATE mangas SET wish_priority = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const insertVolume = ctx.db.prepare(`
        INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, release_year, condition, pages, publisher,
                             purchase_date, status, notes, type, priority, target_price, cover_image, images, manga_passion_volume_id, language)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // v2.19.1 kept "Band 3" next to "3" in one series; when a file carries both, each row stays a volume of its own
    // and is matched against stored volumes by its own spelling only
    const labelsByVolume = new Map();
    for (const r of records) {
        if (r.series_only) continue;
        const key = `${seriesMetaKey(r)}|${r.type}|${matchKey(r.volume_number)}`;
        if (!labelsByVolume.has(key)) labelsByVolume.set(key, new Set());
        labelsByVolume.get(key).add(matchKey(r.label));
    }
    const isPaired = (r) => {
        const labels = labelsByVolume.get(`${seriesMetaKey(r)}|${r.type}|${matchKey(r.volume_number)}`);
        return labels.size > 1 && labels.has(matchKey(r.volume_number));
    };

    const result = { created_series: 0, updated_series: 0, created_volumes: 0, skipped_existing: 0, errors: [], warnings: [...warnings] };
    const rowErrors = [];
    let placeholderId = 0;
    // a manual key only means something in the database that made it: each one of the file gets a fresh key here
    const manualKeys = new Map();
    const importedWorkKey = (key) => {
        if (!isManualWorkKey(key)) return key ?? null;
        if (!manualKeys.has(key)) manualKeys.set(key, manualWorkKey(ctx.randomId()));
        return manualKeys.get(key);
    };
    const createSeries = (r) => {
        const publisher = normalizePublisher(bySeriesPublisher ? r.series_publisher : r.publisher);
        const meta = seriesMeta.get(seriesMetaKey(r)) || {};
        const language = meta.language || languageOf(r) || defaultLanguage;
        const format = meta.format || 'print';
        const id = dryRun
            ? --placeholderId
            : Number(insertManga.run(
                r.series, r.author, publisher, language, meta.status || 'Laufend', meta.alt_title ?? null,
                meta.tags ?? null, meta.total_volumes ?? null, meta.description ?? null, meta.cover_image ?? null,
                // Manga Passion knows no webtoons
                meta.banner_image ?? null, format === 'webtoon' ? null : meta.manga_passion_id ?? null, meta.wish_priority ?? null,
                meta.collecting || 'aktiv', ctx.user.id,
                meta.region ?? null, meta.currency || DEFAULT_CURRENCY, importedWorkKey(meta.work_key), shelfId,
                format, meta.total_chapters ?? null
            ).lastInsertRowid);
        importChapters(r, id, meta);
        const entry = { id, pubKey: publisherKey(publisher), wish: meta.wish_priority ?? null, language };
        const key = matchKey(r.series);
        if (!seriesByTitle.has(key)) seriesByTitle.set(key, []);
        seriesByTitle.get(key).push(entry);
        result.created_series++;
        return entry;
    };

    // chapter progress of a new series ("Kapitel gelesen von"): the same name rules as the readers of a volume
    const importChapters = (r, mangaId, meta) => {
        for (const { name, chapters } of meta.chapter_readers || []) {
            const [userId] = resolveUsers(name, r, (unknown) => msg('Unbekannter Leser „{name}“ (ignoriert)', { name: unknown }),
                (outside) => msg('Leser „{name}“ gehört nicht zu diesem Regal (ignoriert)', { name: outside }));
            if (userId === undefined) continue;
            if (meta.total_chapters && chapters > meta.total_chapters) {
                result.warnings.push(rowNote(r.line, msg('Kapitelstand von „{name}“ liegt über der Gesamtkapitelzahl (ignoriert)', { name })));
                continue;
            }
            if (chapters > 0 && mangaId > 0) insertChapters.run(mangaId, userId, chapters);
        }
    };

    const run = () => {
        for (const record of records) {
            let r = record;
            let series = findSeries(r);
            if (r.series_only) {
                const wish = r.series_meta?.wish_priority;
                // a series row sets the wish of an existing series; otherwise existing series stay untouched
                if (series && wish !== undefined && wish !== series.wish) {
                    if (!dryRun && series.id > 0) updateWish.run(wish, ctx.user.id, series.id);
                    series.wish = wish;
                    result.updated_series++;
                } else if (series) result.skipped_existing++;
                else createSeries(r);
                continue;
            }
            const paired = isPaired(r);
            const ownLabel = paired && matchKey(r.label) !== matchKey(r.volume_number);
            if (paired) {
                if (series && knownLabels.has(labelKey(series.id, r.type, r.label))) {
                    result.skipped_existing++;
                    continue;
                }
            } else if (series && volumeExists(series, r)) {
                result.skipped_existing++;
                continue;
            }
            // A non-admin is never put in the place of the owners the file names
            if (!isAdmin && r.status === OWNED_STATUS) {
                const named = resolveNames(r.owners_raw).ids;
                if (named.length > 0 && !named.includes(ctx.user.id)) {
                    rowErrors.push(rowNote(r.line, OTHERS_ONLY_OWNERS));
                    continue;
                }
            }
            if (!series) series = createSeries(r);
            knownVolumes.add(volumeKey(series.id, r.type, r.volume_number));
            knownLabels.add(labelKey(series.id, r.type, r.label));
            if (ownLabel) {
                result.warnings.push(rowNote(r.line, msg('„{label}“ und „{number}“ stehen beide in der Datei: beide übernommen, „{label}“ unter dieser Bezeichnung', { label: r.label, number: r.volume_number })));
                r = { ...r, volume_number: r.label };
            }
            result.created_volumes++;

            const ownerIds = r.status === OWNED_STATUS
                ? resolveUsers(r.owners_raw, r, (name) => msg('Unbekannter Besitzer „{name}“ (ignoriert)', { name }),
                    (name) => msg('Besitzer „{name}“ gehört nicht zu diesem Regal (ignoriert)', { name }))
                : [];
            const readerIds = resolveUsers(r.readers_raw, r, (name) => msg('Unbekannter Leser „{name}“ (ignoriert)', { name }),
                (name) => msg('Leser „{name}“ gehört nicht zu diesem Regal (ignoriert)', { name }));
            if (r.mark_read) readerIds.push(...(ownerIds.length ? ownerIds : [ctx.user.id]));
            if (dryRun || series.id < 0) continue;

            const volumePublisher = normalizePublisher(r.publisher);
            const ins = insertVolume.run(series.id, r.volume_number, r.isbn, r.price, r.release_date, r.release_year, r.condition,
                r.pages, volumePublisher && publisherKey(volumePublisher) !== series.pubKey ? volumePublisher : null,
                r.purchase_date, r.status, r.notes, r.type, r.priority, r.target_price, r.cover_image, r.images, r.manga_passion_volume_id, r.language);
            const newVolumeId = Number(ins.lastInsertRowid);
            for (const userId of ownerIds) {
                addOwner(ctx.db, newVolumeId, userId, { price: r.price, purchase_date: r.purchase_date, condition: r.condition });
            }
            syncOwnersWithStatus(ctx.db, newVolumeId, ctx.user.id);
            for (const userId of new Set(readerIds)) markRead(ctx.db, newVolumeId, userId);
        }
    };
    if (dryRun) {
        // Dry run: writes nothing, still runs inside a transaction that is always rolled back, to be safe
        try {
            ctx.db.transaction(() => { run(); throw DRY_RUN_ROLLBACK; });
        } catch (err) {
            if (err !== DRY_RUN_ROLLBACK) throw err;
        }
    } else {
        ctx.db.transaction(run);
    }

    // Faulty rows whose volume already exists would be skipped anyway
    for (const e of errors) {
        const series = e.record ? findSeries(e.record) : null;
        if (series && volumeExists(series, e.record)) result.skipped_existing++;
        else result.errors.push(e);
    }
    result.errors.push(...rowErrors);
    result.errors.sort((a, b) => a.line - b.line);
    result.warnings.sort((a, b) => a.line - b.line);
    // parallel to errors/warnings (their { line, message } entries keep their shape), for the client's catalog
    const msgsOf = (list) => list.map(e => e.message_msg ?? null);
    return { body: { success: true, dry_run: dryRun, ...result, errors_msg: msgsOf(result.errors), warnings_msg: msgsOf(result.warnings) } };
}

module.exports = { exportCsv, importCsv, exportOptions, MAX_IMPORT_ROWS };
