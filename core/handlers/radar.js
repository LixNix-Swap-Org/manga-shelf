// Release radar: pre-orders and coming volumes by month (GET /release-radar), the dashboard badge counts
// (GET /dashboard-summary) and pre-orders whose date moved in the Manga Passion calendar (GET /release-radar/changes).
const { buildReleaseRadar, zonedToday, monthKeyOf } = require('../radar');
const releases = require('../mangaPassion/releases');
const { SHOPPING_SERIES } = require('./shopping');
const { sha256Hex, buildCalendar } = require('../ical');
const { inferVolumeType } = require('../lib/volumeType');
const { qstr } = require('../lib/query');
const { HttpError } = require('../errors');
const { MP_LANGUAGE, DEFAULT_LANGUAGE } = require('../lib/language');

const { buildMatcher, monthsToCheck, detectDateChanges } = releases;
const log = (ctx) => ctx.log.child('radar');

// Volumes on the release radar: pre-orders, plus missing ones that come out this month or later (missing back-catalogue
// volumes belong on the shopping list). A dropped series (collecting 'abgebrochen') keeps only what is already ordered.
// Parameter: the current month "YYYY-MM".
const RADAR_WHERE = `((
    v.status IN ('Vorbestellt', 'Erscheint bald', 'Bestellt')
    OR (v.release_date IS NOT NULL AND TRIM(v.release_date) != '' AND v.status NOT IN ('Vorhanden', 'Gelesen')
        AND SUBSTR(TRIM(v.release_date), 1, 7) >= ?))
    AND (COALESCE(m.collecting, 'aktiv') != 'abgebrochen' OR v.status IN ('Vorbestellt', 'Bestellt')))`;

function releaseRadar(ctx) {
    const today = zonedToday(ctx.now(), ctx.config.appTimeZone);
    const radarVols = ctx.db.prepare(`
        SELECT 
            v.id, v.manga_id, v.volume_number, v.isbn, v.price, v.purchase_date,
            v.release_date, v.release_year, v.condition, v.publisher as vol_publisher, 
            v.notes, v.status, v.type, v.cover_image as vol_cover, v.images as vol_images,
            m.title as manga_title, 
            m.cover_image as manga_cover,
            m.publisher as manga_publisher,
            COALESCE(v.language, m.language) as language, m.currency as currency,
            COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
        FROM volumes v
        JOIN mangas m ON v.manga_id = m.id
        WHERE ${RADAR_WHERE}
        ORDER BY 
            CASE WHEN v.release_date IS NOT NULL AND TRIM(v.release_date) != '' THEN 0 ELSE 1 END ASC,
            CASE 
                WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' THEN TRIM(v.release_date) || '-01'
                WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9]' THEN SUBSTR(TRIM(v.release_date), 1, 5) || '0' || SUBSTR(TRIM(v.release_date), 6) || '-01'
                ELSE TRIM(v.release_date)
            END ASC,
            m.title ASC,
            COALESCE(v.number_sort, 999999) ASC,
            v.volume_number ASC
    `).all(monthKeyOf(today));

    // the client reads groups[].items; the flat copy only doubled the body
    const radar = buildReleaseRadar(radarVols, today);
    delete radar.items;
    return { body: radar };
}

// Badge counts of the dashboard without loading the shopping list and the radar: the same numbers as their
// total_missing, total_releases and preordered_count.
function dashboardSummary(ctx) {
    const missing = ctx.db.prepare(`SELECT count(*) AS c FROM volumes v JOIN mangas m ON v.manga_id = m.id WHERE v.status = 'Fehlt' AND ${SHOPPING_SERIES}`).get().c;
    const radar = ctx.db.prepare(`
        SELECT count(*) AS total, sum(CASE WHEN v.status IN ('Vorbestellt', 'Bestellt') THEN 1 ELSE 0 END) AS preordered
        FROM volumes v JOIN mangas m ON v.manga_id = m.id WHERE ${RADAR_WHERE}
    `).get(monthKeyOf(zonedToday(ctx.now(), ctx.config.appTimeZone)));
    return { body: { total_missing: missing, total_releases: radar.total, preordered_count: radar.preordered || 0 } };
}

// The Manga Passion calendar lists German editions only: series and volumes in other languages never match it
const loadUserMangas = (ctx) => ctx.db.prepare(`
    SELECT m.id, m.title, m.alt_title, m.publisher, m.cover_image, m.manga_passion_id, m.wish_priority, m.collecting,
           (SELECT count(*) FROM volumes v WHERE v.manga_id = m.id AND v.status = 'Vorhanden') AS owned_count
    FROM mangas m WHERE COALESCE(m.language, ?) = ? ORDER BY m.id
`).all(DEFAULT_LANGUAGE, MP_LANGUAGE);
const loadUserVolumes = (ctx) => ctx.db.prepare(`
    SELECT v.id, v.manga_id, v.volume_number, v.type, v.notes, v.status, v.price, v.release_date, v.manga_passion_volume_id
    FROM volumes v JOIN mangas m ON m.id = v.manga_id
    WHERE COALESCE(v.language, m.language, ?) = ? ORDER BY v.id
`).all(DEFAULT_LANGUAGE, MP_LANGUAGE);

// Preorders whose date in the Manga Passion calendar has changed since (postponements)
async function dateChanges(ctx) {
    const pending = ctx.db.prepare(`
        SELECT v.id, v.manga_id, v.volume_number, v.type, v.notes, v.status, v.release_date, m.title AS manga_title
        FROM volumes v JOIN mangas m ON m.id = v.manga_id
        WHERE v.status IN ('Vorbestellt', 'Erscheint bald', 'Bestellt')
          AND v.release_date IS NOT NULL AND TRIM(v.release_date) != ''
          AND COALESCE(v.language, m.language, ?) = ?
    `).all(DEFAULT_LANGUAGE, MP_LANGUAGE);
    const months = monthsToCheck(pending, zonedToday(ctx.now(), ctx.config.appTimeZone));
    const results = await releases.fetchMonthsForCheck(ctx, months);
    const matcher = buildMatcher(loadUserMangas(ctx), loadUserVolumes(ctx));
    const enriched = [];
    let failed = 0;
    for (const r of results) {
        if (r.error) {
            failed++;
            log(ctx).warn(`Terminabgleich ${r.year}-${r.month} fehlgeschlagen:`, r.error);
        } else if (r.stale) {
            // a month cached long ago may still list the old date: never suggest it as the new one
            failed++;
            log(ctx).warn(`Terminabgleich ${r.year}-${r.month}: nur veraltete Daten im Cache, Monat übersprungen`);
        } else {
            enriched.push(...matcher.enrich(r.items));
        }
    }
    return { body: { changes: detectDateChanges(pending, enriched), months_checked: months.length - failed, months_failed: failed } };
}

// Calendar feed (GET /radar/feed.ics?token=…): a per-user token, stored as app_settings 'calendar_feed:<sha256>' with
// { user_id, created_at, last_used_at, sealed }; routes/system.js issues and revokes it (the sealed copy needs the
// server secret). The feed lists the radar's volumes that have a full release date, from 30 days back.
const FEED_KEY_PREFIX = 'calendar_feed:';
const FEED_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const FEED_PAST_DAYS = 30;
const FEED_USED_WRITE_GAP_MS = 60 * 60 * 1000;

const feedNotFound = () => new HttpError(404, 'Kalender-Abo nicht gefunden oder widerrufen', 'NOT_FOUND');

/** The stored feed entry for a token (user still present), else null. */
function feedEntryFor(ctx, token) {
    if (typeof token !== 'string' || !FEED_TOKEN.test(token)) return null;
    const key = FEED_KEY_PREFIX + sha256Hex(token);
    const row = ctx.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    if (!row) return null;
    let entry;
    try { entry = JSON.parse(row.value); } catch (e) { return null; }
    if (!entry || !Number.isInteger(entry.user_id)) return null;
    if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(entry.user_id)) return null;
    return { key, entry };
}

/**
 * Deletes the calendar feed tokens of `userId`, or of every user when it is null (sessions ended for everyone).
 * `db` is ctx.db or the server connection; returns how many were removed.
 */
function revokeFeedTokens(db, userId = null) {
    const rows = db.prepare('SELECT key, value FROM app_settings WHERE substr(key, 1, ?) = ?').all(FEED_KEY_PREFIX.length, FEED_KEY_PREFIX);
    let removed = 0;
    for (const row of rows) {
        let owner;
        try { owner = JSON.parse(row.value)?.user_id; } catch (e) { owner = undefined; }
        if (userId === null || owner === userId) removed += db.prepare('DELETE FROM app_settings WHERE key = ?').run(row.key).changes;
    }
    return removed;
}

function feedVolumeLabel(row) {
    const raw = String(row.volume_number || '').trim();
    const numeric = /^\d+(?:[.,]\d+)?$/.test(raw);
    switch (inferVolumeType(row)) {
        case 'schuber': return /schuber/i.test(raw) ? raw : `Schuber ${raw}`.trim();
        case 'special_edition': return numeric ? `Band ${raw} (Special Edition)` : raw;
        case 'special': return numeric ? `Sonderband ${raw}` : raw;
        default: return numeric ? `Band ${raw}` : raw;
    }
}

const feedPrice = (value, currency = 'EUR') => (typeof value === 'number' && value > 0
    ? `${value.toFixed(2).replace('.', ',')} ${currency === 'EUR' ? '€' : currency}` : null);
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function calendarFeed(ctx, { query }) {
    const found = feedEntryFor(ctx, qstr(query.token));
    if (!found) throw feedNotFound();
    const nowMs = ctx.now().getTime();
    if (!(found.entry.last_used_at > nowMs - FEED_USED_WRITE_GAP_MS)) {
        ctx.db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(JSON.stringify({ ...found.entry, last_used_at: nowMs }), found.key);
    }
    const today = zonedToday(ctx.now(), ctx.config.appTimeZone);
    const from = isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - FEED_PAST_DAYS));
    const rows = ctx.db.prepare(`
        SELECT v.id, v.volume_number, v.type, v.notes, v.status, v.price, v.isbn, TRIM(v.release_date) AS release_date,
               m.title AS manga_title, m.currency,
               COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') AS effective_publisher
        FROM volumes v JOIN mangas m ON v.manga_id = m.id
        WHERE ${RADAR_WHERE} AND TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND TRIM(v.release_date) >= ?
        ORDER BY TRIM(v.release_date), m.title COLLATE NOCASE, COALESCE(v.number_sort, 999999), v.id
    `).all(monthKeyOf(today), from);
    const instance = ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'instance_id'").get();
    const domain = instance && instance.value ? `${instance.value}.manga-shelf` : 'manga-shelf';
    const events = rows.map(row => ({
        uid: `volume-${row.id}@${domain}`,
        date: row.release_date,
        summary: `${row.manga_title} – ${feedVolumeLabel(row)}`,
        description: [
            `Status: ${row.status || 'unbekannt'}`,
            `Verlag: ${row.effective_publisher}`,
            feedPrice(row.price, row.currency) && `Preis: ${feedPrice(row.price, row.currency)}`,
            row.isbn && `ISBN: ${row.isbn}`
        ].filter(Boolean).join('\n'),
        categories: 'Manga'
    }));
    const body = buildCalendar({
        name: 'Manga Shelf – Erscheinungstermine',
        description: 'Vorbestellte und angekündigte Bände aus Manga Shelf',
        events,
        now: ctx.now()
    });
    return {
        body,
        headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': 'inline; filename="manga-shelf-termine.ics"'
        }
    };
}

module.exports = { releaseRadar, dashboardSummary, dateChanges, calendarFeed, feedEntryFor, feedVolumeLabel, revokeFeedTokens, loadUserMangas, loadUserVolumes, FEED_KEY_PREFIX };
