// Global catalog, stage 1 (migration 40): one catalog_series per edition and one catalog_volumes row per volume of it,
// shared by every shelf that holds the edition. mangas.catalog_series_id and volumes.catalog_volume_id follow their row
// through triggers on every write path (like works / number_sort); handlers keep writing mangas and volumes.
// The match keys are SQL expressions, so the backfill (JS) and the triggers (SQL) always agree. Frozen once shipped.
const { MARK_FOLLOW_TRIGGERS, stashMarks, restoreMarks } = require('./marks');

/** Title for matching: lower case (ASCII), common punctuation dropped, spaces folded. */
const titleKeySql = (col) => {
    let expr = `lower(trim(COALESCE(${col}, '')))`;
    for (const ch of ['!', '?', '.', ',', "''", '"', '(', ')']) expr = `replace(${expr}, '${ch}', '')`;
    for (const ch of [':', ';', '–', '—', '-', '/', '_']) expr = `replace(${expr}, '${ch}', ' ')`;
    for (let i = 0; i < 3; i++) expr = `replace(${expr}, '  ', ' ')`;
    return `trim(${expr})`;
};

/** Publisher for matching, like publisherKey() in publishers.js (lower case, no trailing "!"). */
const publisherKeySql = (col) => `trim(rtrim(lower(trim(COALESCE(${col}, ''))), '!'))`;

/** The Manga Passion id a series row stands for in the catalog (only German editions carry one). */
const mpOfSql = (row) => `CASE WHEN ${row}.language = 'de' THEN ${row}.manga_passion_id END`;

/** A valid stored ISBN-13 (digits only) or NULL. */
const isbnSql = (col) => `CASE WHEN length(${col}) = 13 AND ${col} NOT GLOB '*[^0-9]*' THEN ${col} END`;

/** id of the catalog series the series row `row` (NEW, or an alias) matches, NULL when none. */
const matchSeriesSql = (row) => `COALESCE(
    (SELECT c.id FROM catalog_series c WHERE ${mpOfSql(row)} IS NOT NULL AND c.mp_series_id = ${mpOfSql(row)}),
    (SELECT c.id FROM catalog_series c
      WHERE c.title_key = ${titleKeySql(`${row}.title`)} AND c.language = COALESCE(${row}.language, 'de')
        AND c.format = COALESCE(${row}.format, 'print') AND c.publisher_key = ${publisherKeySql(`${row}.publisher`)}
        AND (${mpOfSql(row)} IS NULL OR c.mp_series_id IS NULL)
        AND c.title_key <> ''
      ORDER BY c.id LIMIT 1))`;

/** Statements (trigger body) that link the series row NEW to its catalog series, creating it when none matches. */
const LINK_SERIES_BODY = `
    INSERT INTO catalog_series (work_id, title, title_key, publisher, publisher_key, language, region, format, alt_title, author,
        pub_status, total_volumes, total_chapters, list_currency, description, cover_image, banner_image, mp_series_id)
    SELECT (SELECT work_id FROM mangas WHERE id = NEW.id), NEW.title, ${titleKeySql('NEW.title')}, NEW.publisher,
        ${publisherKeySql('NEW.publisher')}, COALESCE(NEW.language, 'de'), NEW.region, COALESCE(NEW.format, 'print'), NEW.alt_title,
        NEW.author, NEW.status, NEW.total_volumes, NEW.total_chapters, COALESCE(NEW.currency, 'EUR'), NEW.description,
        NEW.cover_image, NEW.banner_image, ${mpOfSql('NEW')}
    WHERE ${matchSeriesSql('NEW')} IS NULL;
    UPDATE mangas SET catalog_series_id = ${matchSeriesSql('NEW')} WHERE id = NEW.id AND catalog_series_id IS NOT ${matchSeriesSql('NEW')};
    -- a manual catalog entry adopts the Manga Passion id of the first linked edition that has one
    UPDATE catalog_series SET mp_series_id = ${mpOfSql('NEW')}
     WHERE id = (SELECT catalog_series_id FROM mangas WHERE id = NEW.id) AND mp_series_id IS NULL AND ${mpOfSql('NEW')} IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM catalog_series o WHERE o.mp_series_id = ${mpOfSql('NEW')});
    -- empty catalog fields take the values of the row
    UPDATE catalog_series SET
        work_id = COALESCE(work_id, (SELECT work_id FROM mangas WHERE id = NEW.id)), alt_title = COALESCE(alt_title, NEW.alt_title),
        author = COALESCE(author, NEW.author), region = COALESCE(region, NEW.region), pub_status = COALESCE(pub_status, NEW.status),
        total_volumes = COALESCE(total_volumes, NEW.total_volumes), total_chapters = COALESCE(total_chapters, NEW.total_chapters),
        description = COALESCE(description, NEW.description), cover_image = COALESCE(cover_image, NEW.cover_image),
        banner_image = COALESCE(banner_image, NEW.banner_image)
     WHERE id = (SELECT catalog_series_id FROM mangas WHERE id = NEW.id);`;

/** Statements (trigger body) that link the volumes `where` selects (alias v) to catalog volumes of their series. */
const linkVolumesBody = (where) => `
    INSERT OR IGNORE INTO catalog_volumes (series_id, volume_type, volume_number, isbn, language, publisher, release_date, pages,
        list_price, mp_volume_id, cover_image, sort_after)
    SELECT m.catalog_series_id, COALESCE(v.type, 'volume'), trim(v.volume_number),
        CASE WHEN NOT EXISTS (SELECT 1 FROM catalog_volumes c WHERE c.isbn = ${isbnSql('v.isbn')}) THEN ${isbnSql('v.isbn')} END,
        v.language, v.publisher, v.release_date, v.pages, v.price,
        CASE WHEN NOT EXISTS (SELECT 1 FROM catalog_volumes c WHERE c.mp_volume_id = v.manga_passion_volume_id) THEN v.manga_passion_volume_id END,
        v.cover_image, v.sort_after
    FROM volumes v JOIN mangas m ON m.id = v.manga_id
    WHERE ${where} AND m.catalog_series_id IS NOT NULL;
    INSERT OR IGNORE INTO catalog_volumes (series_id, volume_type, volume_number)
    SELECT m.catalog_series_id, COALESCE(v.type, 'volume'), trim(v.volume_number)
    FROM volumes v JOIN mangas m ON m.id = v.manga_id
    WHERE ${where} AND m.catalog_series_id IS NOT NULL;
    UPDATE volumes SET catalog_volume_id = (
        SELECT c.id FROM catalog_volumes c JOIN mangas m ON m.id = volumes.manga_id
         WHERE c.series_id = m.catalog_series_id AND c.volume_type = COALESCE(volumes.type, 'volume') AND c.volume_number = trim(volumes.volume_number))
    WHERE id IN (SELECT v.id FROM volumes v WHERE ${where});`;

/**
 * The same for the single volume NEW (insert and identity triggers): the ISBN and Manga Passion id checks keep the insert from
 * failing on a unique key, so one insert and the link are enough.
 */
const sameVolumeSql = (c) => `${c}.series_id = m.catalog_series_id AND ${c}.volume_type = COALESCE(NEW.type, 'volume')
    AND ${c}.volume_number = trim(NEW.volume_number)`;
const LINK_VOLUME_ROW_BODY = `
    INSERT INTO catalog_volumes (series_id, volume_type, volume_number, isbn, language, publisher, release_date, pages, list_price,
        mp_volume_id, cover_image, sort_after)
    SELECT m.catalog_series_id, COALESCE(NEW.type, 'volume'), trim(NEW.volume_number),
        CASE WHEN NOT EXISTS (SELECT 1 FROM catalog_volumes c WHERE c.isbn = ${isbnSql('NEW.isbn')}) THEN ${isbnSql('NEW.isbn')} END,
        NEW.language, NEW.publisher, NEW.release_date, NEW.pages, NEW.price,
        CASE WHEN NOT EXISTS (SELECT 1 FROM catalog_volumes c WHERE c.mp_volume_id = NEW.manga_passion_volume_id) THEN NEW.manga_passion_volume_id END,
        NEW.cover_image, NEW.sort_after
    FROM mangas m
    WHERE m.id = NEW.manga_id AND m.catalog_series_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM catalog_volumes c WHERE ${sameVolumeSql('c')});
    UPDATE volumes SET catalog_volume_id = (SELECT c.id FROM catalog_volumes c JOIN mangas m ON m.id = NEW.manga_id WHERE ${sameVolumeSql('c')})
    WHERE id = NEW.id;`;

/** Series columns whose change pushes the new value into the catalog series (last write wins, NULL never clears). */
const SERIES_SHARED_COLUMNS = ['work_id', 'alt_title', 'author', 'region', 'status', 'total_volumes', 'total_chapters', 'description',
    'cover_image', 'banner_image', 'currency'];
const SERIES_IDENTITY_COLUMNS = ['title', 'language', 'publisher', 'format', 'manga_passion_id'];
const VOLUME_SHARED_COLUMNS = ['isbn', 'price', 'release_date', 'pages', 'cover_image', 'manga_passion_volume_id', 'language', 'publisher', 'sort_after'];

const CATALOG_TRIGGERS = ['trg_mangas_catalog_insert', 'trg_mangas_catalog_identity', 'trg_mangas_catalog_shared', 'trg_mangas_catalog_relink',
    'trg_volumes_catalog_insert', 'trg_volumes_catalog_identity', 'trg_volumes_catalog_shared',
    'trg_animes_work_links_insert', 'trg_animes_work_links_update', 'trg_works_anime_links'];

const CATALOG_TRIGGERS_SQL = `
    CREATE TRIGGER trg_mangas_catalog_insert AFTER INSERT ON mangas BEGIN
        ${LINK_SERIES_BODY}
    END;
    -- title, language, publisher, format or Manga Passion id changed: the catalog series is renamed in place while this row is
    -- its only edition and no other catalog series has the new key, else the row moves to the matching (or a new) one
    CREATE TRIGGER trg_mangas_catalog_identity AFTER UPDATE OF ${SERIES_IDENTITY_COLUMNS.join(', ')} ON mangas BEGIN
        UPDATE catalog_series SET title = NEW.title, title_key = ${titleKeySql('NEW.title')}, publisher = NEW.publisher,
            publisher_key = ${publisherKeySql('NEW.publisher')}, language = COALESCE(NEW.language, 'de'), format = COALESCE(NEW.format, 'print'),
            mp_series_id = CASE WHEN NOT EXISTS (SELECT 1 FROM catalog_series o WHERE o.mp_series_id = ${mpOfSql('NEW')} AND o.id <> catalog_series.id)
                THEN ${mpOfSql('NEW')} END,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = NEW.catalog_series_id
           AND NOT EXISTS (SELECT 1 FROM mangas o WHERE o.catalog_series_id = NEW.catalog_series_id AND o.id <> NEW.id)
           AND COALESCE(${matchSeriesSql('NEW')}, NEW.catalog_series_id) = NEW.catalog_series_id;
        ${LINK_SERIES_BODY}
    END;
    CREATE TRIGGER trg_mangas_catalog_shared AFTER UPDATE OF ${SERIES_SHARED_COLUMNS.join(', ')} ON mangas
    WHEN NEW.catalog_series_id IS NOT NULL BEGIN
        UPDATE catalog_series SET work_id = COALESCE(NEW.work_id, work_id), alt_title = COALESCE(NEW.alt_title, alt_title),
            author = COALESCE(NEW.author, author), region = COALESCE(NEW.region, region), pub_status = COALESCE(NEW.status, pub_status),
            total_volumes = COALESCE(NEW.total_volumes, total_volumes), total_chapters = COALESCE(NEW.total_chapters, total_chapters),
            description = COALESCE(NEW.description, description), cover_image = COALESCE(NEW.cover_image, cover_image),
            banner_image = COALESCE(NEW.banner_image, banner_image), list_currency = COALESCE(NEW.currency, list_currency),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = NEW.catalog_series_id;
    END;
    -- a series that moved to another catalog series takes its volumes along
    CREATE TRIGGER trg_mangas_catalog_relink AFTER UPDATE OF catalog_series_id ON mangas
    WHEN NEW.catalog_series_id IS NOT OLD.catalog_series_id BEGIN
        ${linkVolumesBody('v.manga_id = NEW.id')}
    END;
    CREATE TRIGGER trg_volumes_catalog_insert AFTER INSERT ON volumes BEGIN
        ${LINK_VOLUME_ROW_BODY}
    END;
    CREATE TRIGGER trg_volumes_catalog_identity AFTER UPDATE OF manga_id, volume_number, type ON volumes BEGIN
        ${LINK_VOLUME_ROW_BODY}
    END;
    CREATE TRIGGER trg_volumes_catalog_shared AFTER UPDATE OF ${VOLUME_SHARED_COLUMNS.join(', ')} ON volumes
    WHEN NEW.catalog_volume_id IS NOT NULL BEGIN
        UPDATE catalog_volumes SET
            isbn = CASE WHEN ${isbnSql('NEW.isbn')} IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM catalog_volumes o WHERE o.isbn = ${isbnSql('NEW.isbn')} AND o.id <> catalog_volumes.id)
                        THEN ${isbnSql('NEW.isbn')} ELSE isbn END,
            mp_volume_id = CASE WHEN NEW.manga_passion_volume_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM catalog_volumes o WHERE o.mp_volume_id = NEW.manga_passion_volume_id AND o.id <> catalog_volumes.id)
                        THEN NEW.manga_passion_volume_id ELSE mp_volume_id END,
            list_price = COALESCE(NEW.price, list_price), release_date = COALESCE(NEW.release_date, release_date),
            pages = COALESCE(NEW.pages, pages), cover_image = COALESCE(NEW.cover_image, cover_image),
            language = COALESCE(NEW.language, language), publisher = COALESCE(NEW.publisher, publisher),
            sort_after = COALESCE(NEW.sort_after, sort_after), updated_at = CURRENT_TIMESTAMP
         WHERE id = NEW.catalog_volume_id;
    END;`;

// AniList relation types (version 2) seen from the anime; everything else counts as OTHER
const RELATION_SQL = (col) => `CASE ${col} WHEN 'SOURCE' THEN 'SOURCE' WHEN 'ADAPTATION' THEN 'ADAPTATION' WHEN 'SPIN_OFF' THEN 'SPIN_OFF'
    WHEN 'SIDE_STORY' THEN 'SIDE_STORY' WHEN 'ALTERNATIVE' THEN 'ALTERNATIVE' ELSE 'OTHER' END`;

/** Statements that rebuild the automatic work links of the anime rows `where` selects (alias a). */
const linkAnimeBody = (where) => `
    DELETE FROM anime_work_links WHERE origin IN ('collection', 'anilist', 'mal') AND scope_shelf_id IS NULL
       AND anime_id IN (SELECT a.id FROM animes a WHERE ${where});
    INSERT OR IGNORE INTO anime_work_links (anime_id, work_id, relation, origin)
    SELECT a.id, a.work_id, 'SOURCE', 'collection' FROM animes a WHERE ${where} AND a.work_id IS NOT NULL;
    INSERT OR IGNORE INTO anime_work_links (anime_id, work_id, relation, origin)
    SELECT a.id, w.id, ${RELATION_SQL("json_extract(r.value, '$.relation')")},
           CASE WHEN json_extract(r.value, '$.anilist_id') IS NOT NULL THEN 'anilist' ELSE 'mal' END
    FROM animes a, json_each(a.relations) r
    JOIN works w ON (w.anilist_id IS NOT NULL AND w.anilist_id = json_extract(r.value, '$.anilist_id'))
                 OR (w.mal_id IS NOT NULL AND w.mal_id = json_extract(r.value, '$.mal_id'))
    WHERE ${where} AND a.relations IS NOT NULL AND json_valid(a.relations) AND json_type(a.relations) = 'array'
      AND json_extract(r.value, '$.kind') = 'MANGA';`;

const ANIME_LINK_TRIGGERS_SQL = `
    CREATE TRIGGER trg_animes_work_links_insert AFTER INSERT ON animes BEGIN
        ${linkAnimeBody('a.id = NEW.id')}
    END;
    CREATE TRIGGER trg_animes_work_links_update AFTER UPDATE OF work_id, relations ON animes BEGIN
        ${linkAnimeBody('a.id = NEW.id')}
    END;
    -- a new work (its first edition came into a collection): anime whose stored relations name it link to it
    CREATE TRIGGER trg_works_anime_links AFTER INSERT ON works BEGIN
        INSERT OR IGNORE INTO anime_work_links (anime_id, work_id, relation, origin)
        SELECT a.id, NEW.id, ${RELATION_SQL("json_extract(r.value, '$.relation')")},
               CASE WHEN json_extract(r.value, '$.anilist_id') IS NOT NULL THEN 'anilist' ELSE 'mal' END
        FROM animes a, json_each(a.relations) r
        WHERE a.relations IS NOT NULL AND json_valid(a.relations) AND json_type(a.relations) = 'array'
          AND json_extract(r.value, '$.kind') = 'MANGA'
          AND ((NEW.anilist_id IS NOT NULL AND json_extract(r.value, '$.anilist_id') = NEW.anilist_id)
            OR (NEW.mal_id IS NOT NULL AND json_extract(r.value, '$.mal_id') = NEW.mal_id));
    END;`;

/** Union-find over series rows that refuses to join two different Manga Passion ids, languages or formats. */
class SeriesGroups {
    constructor(rows) {
        this.parent = new Map();
        this.info = new Map();
        for (const r of rows) {
            this.parent.set(r.id, r.id);
            this.info.set(r.id, { language: r.language, format: r.format, mp: r.mp ? new Set([r.mp]) : new Set() });
        }
    }

    find(x) {
        while (this.parent.get(x) !== x) {
            this.parent.set(x, this.parent.get(this.parent.get(x)));
            x = this.parent.get(x);
        }
        return x;
    }

    /** Joins the groups of a and b; { ok: false, why } when they must stay apart. */
    union(a, b) {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return { ok: true };
        const ia = this.info.get(ra);
        const ib = this.info.get(rb);
        if (ia.language !== ib.language || ia.format !== ib.format) return { ok: false, why: 'language or format differ' };
        if (ia.mp.size && ib.mp.size && ![...ib.mp].every(m => ia.mp.has(m))) return { ok: false, why: `Manga Passion ids ${[...ia.mp]} / ${[...ib.mp]}` };
        this.parent.set(rb, ra);
        for (const m of ib.mp) ia.mp.add(m);
        return { ok: true };
    }
}

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Fills the catalog from the stored series and volumes (migration 40; the triggers do not exist yet). Series are grouped by
 * Manga Passion id, then a shared valid ISBN-13, then title key + language + format + publisher key; one catalog series per
 * group (values of the preferred row first: with Manga Passion id, more volumes, newest change), one catalog volume per
 * (type, number) of it. Differences the grouping papers over go to catalog_merge_log. Returns the counts.
 */
function backfillCatalog(d, log) {
    // a second run (a migration replayed from an older version) rebuilds the catalog from scratch; reading marks and chapter
    // progress on it (migration 42) are kept by the shelf rows that show them and put back on the new entries
    for (const name of [...CATALOG_TRIGGERS, ...MARK_FOLLOW_TRIGGERS]) d.exec(`DROP TRIGGER IF EXISTS ${name};`);
    const marks = stashMarks(d);
    d.exec(`
        UPDATE volumes SET catalog_volume_id = NULL WHERE catalog_volume_id IS NOT NULL;
        UPDATE mangas SET catalog_series_id = NULL WHERE catalog_series_id IS NOT NULL;
        DELETE FROM catalog_volumes;
        DELETE FROM catalog_series;
        DELETE FROM catalog_merge_log;
        DELETE FROM anime_work_links WHERE origin <> 'manual';
    `);
    const series = d.prepare(`SELECT *, ${titleKeySql('title')} AS tkey, ${publisherKeySql('publisher')} AS pkey,
        CASE WHEN language = 'de' THEN manga_passion_id END AS mp FROM mangas ORDER BY id`).all();
    const volumes = d.prepare(`SELECT *, ${isbnSql('isbn')} AS valid_isbn FROM volumes ORDER BY id`).all();
    const volsOf = new Map(series.map(s => [s.id, []]));
    for (const v of volumes) if (volsOf.has(v.manga_id)) volsOf.get(v.manga_id).push(v);
    const note = d.prepare('INSERT INTO catalog_merge_log (kind, catalog_id, old_ids, detail) VALUES (?, ?, ?, ?)');

    const groups = new SeriesGroups(series);
    const unionBy = (label, keysOf) => {
        const first = new Map();
        for (const s of series) {
            for (const key of keysOf(s)) {
                if (!first.has(key)) { first.set(key, s.id); continue; }
                const res = groups.union(first.get(key), s.id);
                if (!res.ok) note.run('series_kept_apart', null, JSON.stringify([first.get(key), s.id]), `${label} ${key}: ${res.why}`);
            }
        }
    };
    unionBy('manga_passion', s => (s.mp ? [`mp:${s.mp}`] : []));
    unionBy('isbn', s => [...new Set(volsOf.get(s.id).map(v => v.valid_isbn).filter(Boolean))].map(i => `isbn:${i}`));
    unionBy('title', s => (s.tkey ? [`t:${s.tkey}|${s.language}|${s.format}|${s.pkey}`] : []));

    const members = new Map();
    for (const s of series) {
        const root = groups.find(s.id);
        if (!members.has(root)) members.set(root, []);
        members.get(root).push(s);
    }

    const insSeries = d.prepare(`INSERT INTO catalog_series (work_id, title, title_key, publisher, publisher_key, language, region, format,
        alt_title, author, pub_status, total_volumes, total_chapters, list_currency, description, cover_image, banner_image, mp_series_id,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))`);
    const linkSeries = d.prepare('UPDATE mangas SET catalog_series_id = ? WHERE id = ?');
    const insVolume = d.prepare(`INSERT INTO catalog_volumes (series_id, volume_type, volume_number, isbn, language, publisher, release_date,
        pages, list_price, mp_volume_id, cover_image, sort_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`);
    const linkVolume = d.prepare('UPDATE volumes SET catalog_volume_id = ? WHERE id = ?');
    const usedIsbn = new Set();
    const usedMpVolume = new Set();
    let catalogVolumes = 0;

    for (const group of members.values()) {
        group.sort((a, b) => (Boolean(b.mp) - Boolean(a.mp)) || (volsOf.get(b.id).length - volsOf.get(a.id).length)
            || String(b.updated_at || '').localeCompare(String(a.updated_at || '')) || a.id - b.id);
        const master = group[0];
        const pick = (col) => { for (const s of group) if (!blank(s[col])) return s[col]; return null; };
        const ids = JSON.stringify(group.map(s => s.id).sort((a, b) => a - b));
        // same key, different spelling: a title that is not all lower case wins ("Frieren" over "frieren")
        const title = (group.find(s => s.tkey === master.tkey && s.title !== String(s.title).toLowerCase()) || master).title;
        const catalogId = Number(insSeries.run(pick('work_id'), title, master.tkey, master.publisher, master.pkey, master.language || 'de',
            pick('region'), master.format || 'print', pick('alt_title'), pick('author'), pick('status'), pick('total_volumes'),
            pick('total_chapters'), pick('currency') || 'EUR', pick('description'), pick('cover_image'), pick('banner_image'), master.mp,
            master.created_at, master.updated_at).lastInsertRowid);
        for (const s of group) linkSeries.run(catalogId, s.id);
        for (const col of ['title', 'publisher', 'author', 'total_volumes', 'work_id']) {
            const values = new Set(group.map(s => (col === 'title' ? s.tkey : s[col])).filter(v => !blank(v)).map(String));
            if (values.size > 1) note.run('series_field', catalogId, ids, `${col}: ${[...values].join(' | ')}`);
        }

        const byNumber = new Map();
        for (const s of group) {
            for (const v of volsOf.get(s.id)) {
                const key = `${v.type || 'volume'}\u0000${String(v.volume_number).trim()}`;
                if (!byNumber.has(key)) byNumber.set(key, []);
                byNumber.get(key).push(v);
            }
        }
        for (const [key, rows] of byNumber) {
            const [type, number] = key.split('\u0000');
            const vpick = (col) => { for (const v of rows) if (!blank(v[col])) return v[col]; return null; };
            const isbns = [...new Set(rows.map(v => v.valid_isbn).filter(Boolean))];
            const isbn = isbns.find(i => !usedIsbn.has(i)) || null;
            if (isbns.length > 1 || (isbns.length && !isbn)) {
                note.run('volume_isbn', catalogId, JSON.stringify(rows.map(v => v.id)), `${type} ${number}: ${isbns.join(', ')} -> ${isbn || 'none'}`);
            }
            if (isbn) usedIsbn.add(isbn);
            let mpVolume = vpick('manga_passion_volume_id');
            if (mpVolume !== null && usedMpVolume.has(mpVolume)) mpVolume = null;
            if (mpVolume !== null) usedMpVolume.add(mpVolume);
            const volumeId = Number(insVolume.run(catalogId, type, number, isbn, vpick('language'), vpick('publisher'), vpick('release_date'),
                vpick('pages'), vpick('price'), mpVolume, vpick('cover_image'), type === 'special' ? vpick('sort_after') : null,
                rows[0].created_at).lastInsertRowid);
            catalogVolumes++;
            for (const v of rows) linkVolume.run(volumeId, v.id);
        }
    }
    d.exec(linkAnimeBody('1 = 1'));
    restoreMarks(d, marks);
    const report = {
        series: series.length,
        catalog_series: members.size,
        volumes: volumes.length,
        catalog_volumes: catalogVolumes,
        conflicts: d.prepare('SELECT count(*) AS n FROM catalog_merge_log').get().n
    };
    if (series.length && log) log.info(`[Database Migration] v40: ${report.series} series -> ${report.catalog_series} catalog series, ${report.volumes} volumes -> ${report.catalog_volumes} catalog volumes, ${report.conflicts} entries in catalog_merge_log`);
    return report;
}

module.exports = {
    backfillCatalog,
    titleKeySql,
    publisherKeySql,
    isbnSql,
    matchSeriesSql,
    linkVolumesBody,
    linkAnimeBody,
    CATALOG_TRIGGERS_SQL,
    ANIME_LINK_TRIGGERS_SQL,
    CATALOG_TRIGGERS,
    SERIES_SHARED_COLUMNS,
    VOLUME_SHARED_COLUMNS,
    SeriesGroups
};
