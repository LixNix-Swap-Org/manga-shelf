const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { badRequest } = require('../utils/httpError');
const { conditional } = require('../utils/dataVersion');

/** Letzte `count` Monate (JJJJ-MM) bis einschließlich `now`, älteste zuerst. */
function lastMonthKeys(now, count) {
    const keys = [];
    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return keys;
}

const round2 = (n) => Math.round((n || 0) * 100) / 100;

const DEFAULT_START_DATE = '2021-04-09';

/** JJJJ-MM-TT ab 1900 als UTC-Datum, sonst null. */
function parseStartDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parsed = new Date(value);
    if (isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || parsed.getUTCFullYear() < 1900) return null;
    return parsed;
}

const PURCHASE_YEAR = "(TRIM(purchase_date) GLOB '[0-9][0-9][0-9][0-9]*' AND SUBSTR(TRIM(purchase_date), 1, 4) >= '1900')";
const PURCHASE_MONTH = `(${PURCHASE_YEAR} AND TRIM(purchase_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*')`;

/**
 * Ausgaben nach Kaufdatum: je Jahr (auch reine Jahresangaben), letzte 12 Monate (mit Nullen),
 * Bände nur mit Jahr (fehlen im Monatsdiagramm) und Bände ohne verwertbares Kaufdatum.
 */
function buildSpending(now = new Date()) {
    const monthRows = db.prepare(`
        SELECT SUBSTR(TRIM(purchase_date), 1, 7) AS month, count(*) AS volumes, sum(COALESCE(price, 0)) AS total
        FROM volumes
        WHERE status = 'Vorhanden' AND ${PURCHASE_MONTH}
        GROUP BY month
    `).all();
    const yearRows = db.prepare(`
        SELECT CAST(SUBSTR(TRIM(purchase_date), 1, 4) AS INTEGER) AS year, count(*) AS volumes, sum(COALESCE(price, 0)) AS total
        FROM volumes
        WHERE status = 'Vorhanden' AND ${PURCHASE_YEAR}
        GROUP BY year
        ORDER BY year
    `).all();
    const yearOnly = db.prepare(`
        SELECT count(*) AS volumes, sum(COALESCE(price, 0)) AS total FROM volumes
        WHERE status = 'Vorhanden' AND ${PURCHASE_YEAR} AND NOT ${PURCHASE_MONTH}
    `).get();
    const none = db.prepare(`
        SELECT count(*) AS volumes, sum(COALESCE(price, 0)) AS total FROM volumes
        WHERE status = 'Vorhanden' AND NOT COALESCE(${PURCHASE_YEAR}, 0)
    `).get();
    const byMonth = new Map(monthRows.map(r => [r.month, r]));
    return {
        by_year: yearRows.map(y => ({ year: y.year, volumes: y.volumes, total: round2(y.total) })),
        by_month: lastMonthKeys(now, 12).map(k => ({ month: k, volumes: byMonth.get(k)?.volumes || 0, total: round2(byMonth.get(k)?.total) })),
        year_only: { volumes: yearOnly?.volumes || 0, total: round2(yearOnly?.total) },
        without_date: { volumes: none?.volumes || 0, total: round2(none?.total) }
    };
}

/**
 * Komplett gesammelt (nicht Erscheinungsstatus): jeder reguläre Band 1..Ziel ist vorhanden, Ziel wie in
 * getSeriesProgress = max(total_volumes, höchste vorhandene Nummer). Band 0 und Doppelte zählen nicht.
 */
const COMPLETED_SERIES_SQL = `
    WITH owned AS (
        SELECT v.manga_id,
               MAX(v.number_sort) AS max_n,
               COUNT(DISTINCT CASE WHEN v.number_sort >= 1 THEN v.number_sort END) AS have
        FROM volumes v
        WHERE v.status = 'Vorhanden' AND COALESCE(v.type, 'volume') = 'volume'
          AND v.number_sort IS NOT NULL AND instr(v.volume_number, '.') = 0
        GROUP BY v.manga_id
    ),
    per_series AS (
        SELECT MAX(COALESCE(m.total_volumes, 0), COALESCE(o.max_n, 0)) AS target, COALESCE(o.have, 0) AS have
        FROM mangas m LEFT JOIN owned o ON o.manga_id = m.id
    )
    SELECT count(*) AS count FROM per_series WHERE target > 0 AND have >= target
`;

router.get('/stats', requireAuth, conditional(), (req, res) => {
    const totalSeriesRow = db.prepare('SELECT count(*) as count FROM mangas').get();
    const totalSeries = totalSeriesRow ? totalSeriesRow.count : 0;

    const ownedRow = db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as total_value, count(price) as priced_count, avg(price) as avg_price FROM volumes WHERE status = 'Vorhanden'").get();
    const totalOwnedVolumes = ownedRow ? ownedRow.count : 0;
    const totalOwnedValue = round2(ownedRow?.total_value);
    const pricedOwnedVolumes = ownedRow ? ownedRow.priced_count : 0;

    const missingRow = db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as missing_value FROM volumes WHERE status = 'Fehlt'").get();
    const totalMissingVolumes = missingRow ? missingRow.count : 0;
    const totalMissingValue = round2(missingRow?.missing_value);

    const allVolsRow = db.prepare('SELECT count(*) as count, sum(COALESCE(price, 0)) as full_value FROM volumes').get();
    const totalVolumesRecorded = allVolsRow ? allVolsRow.count : 0;
    const totalPossibleValue = round2(allVolsRow?.full_value);

    const completedSeries = db.prepare(COMPLETED_SERIES_SQL).get()?.count || 0;

    const settingRow = db.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get();
    const storedStart = settingRow?.value;
    const startDateStr = parseStartDate(storedStart) ? storedStart : DEFAULT_START_DATE;
    const startDate = parseStartDate(startDateStr);
    const now = new Date();
    const diffMs = Math.max(1, now.getTime() - startDate.getTime());
    const totalDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    const totalMonths = Math.max(1, Math.round(totalDays / 30.4375));
    const totalYears = (totalDays / 365.25).toFixed(2);
    const avgMonthlySpending = round2(totalOwnedValue / totalMonths);
    // A stored price of 0 (gift) counts; volumes without a price do not.
    const avgPricePerVolume = pricedOwnedVolumes > 0 ? round2(ownedRow.avg_price) : 0;

    // Publisher breakdown
    const pubRows = db.prepare(`
        SELECT 
            COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as pub_name,
            count(DISTINCT m.id) as series_count,
            count(v.id) as volume_count,
            sum(CASE WHEN v.status = 'Vorhanden' THEN COALESCE(v.price, 0) ELSE 0 END) as total_value
        FROM volumes v
        JOIN mangas m ON v.manga_id = m.id
        WHERE v.status = 'Vorhanden'
        GROUP BY pub_name
        ORDER BY volume_count DESC
    `).all();

    const publishers = pubRows.map(p => ({
        publisher: p.pub_name,
        series_count: p.series_count,
        volume_count: p.volume_count,
        total_value: Math.round((p.total_value || 0) * 100) / 100,
        percentage: totalOwnedVolumes > 0 ? Math.round((p.volume_count / totalOwnedVolumes) * 1000) / 10 : 0
    }));

    // User Reading Stats (Multi-User)
    const allUsers = db.prepare('SELECT id, username, role FROM users').all();
    const userReadingStats = allUsers.map(u => {
        const readRow = db.prepare(`
            SELECT count(vr.volume_id) as count
            FROM volume_reads vr
            JOIN volumes v ON vr.volume_id = v.id
            WHERE vr.user_id = ? AND v.status = 'Vorhanden'
        `).get(u.id);
        const readCount = readRow ? readRow.count : 0;
        const pct = totalOwnedVolumes > 0 ? Math.round((readCount / totalOwnedVolumes) * 1000) / 10 : 0;
        return {
            user_id: u.id,
            username: u.username,
            role: u.role,
            read_count: readCount,
            unread_count: Math.max(0, totalOwnedVolumes - readCount),
            total_owned: totalOwnedVolumes,
            read_pct: pct
        };
    });

    // Besitz pro Benutzer: Bände und Wert (Preis des Besitzers, sonst Bandpreis); ein Band kann mehreren gehören
    const ownerStats = db.prepare(`
        SELECT u.id as user_id, u.username,
               count(vo.volume_id) as volume_count,
               COALESCE(SUM(COALESCE(vo.price, v.price, 0)), 0) as total_value,
               COUNT(DISTINCT v.manga_id) as series_count,
               COALESCE(SUM(CASE WHEN (SELECT count(*) FROM volume_owners o2 WHERE o2.volume_id = vo.volume_id) > 1 THEN 1 ELSE 0 END), 0) as shared_count
        FROM users u
        LEFT JOIN volume_owners vo ON vo.user_id = u.id
        LEFT JOIN volumes v ON v.id = vo.volume_id AND v.status = 'Vorhanden'
        GROUP BY u.id
        ORDER BY u.id
    `).all().map(o => ({ ...o, total_value: Math.round((o.total_value || 0) * 100) / 100 }));

    // Top 5 Valuable series
    const topSeries = db.prepare(`
        SELECT 
            m.id, m.title, m.cover_image, m.publisher,
            count(v.id) as owned_volumes,
            sum(COALESCE(v.price, 0)) as total_value
        FROM mangas m
        JOIN volumes v ON m.id = v.manga_id AND v.status = 'Vorhanden'
        GROUP BY m.id
        ORDER BY total_value DESC, owned_volumes DESC, m.title COLLATE NOCASE ASC
        LIMIT 5
    `).all().map(s => ({
        id: s.id,
        title: s.title,
        cover_image: s.cover_image,
        publisher: s.publisher,
        owned_volumes: s.owned_volumes,
        total_value: Math.round((s.total_value || 0) * 100) / 100
    }));

    const summary = {
        total_series: totalSeries,
        completed_series: completedSeries,
        total_owned_volumes: totalOwnedVolumes,
        total_missing_volumes: totalMissingVolumes,
        total_volumes_recorded: totalVolumesRecorded,
        total_owned_value: totalOwnedValue,
        total_missing_value: totalMissingValue,
        total_possible_value: totalPossibleValue,
        avg_price_per_volume: avgPricePerVolume,
        priced_owned_volumes: pricedOwnedVolumes,
        collection_start_date: startDateStr,
        collection_days: totalDays,
        collection_months: totalMonths,
        collection_years: parseFloat(totalYears),
        avg_monthly_spending: avgMonthlySpending
    };

    res.json({
        summary,
        publishers,
        user_reading_stats: userReadingStats,
        owner_stats: ownerStats,
        top_series: topSeries,
        spending: buildSpending(now)
    });
});

router.put('/stats/settings', requireAdmin, (req, res) => {
    const body = req.body || {};
    const dateVal = body.collection_start_date ?? body.start_date;
    if (dateVal === undefined || dateVal === null) {
        throw badRequest('Kein Startdatum angegeben');
    }
    const dateStr = typeof dateVal === 'string' ? dateVal.trim() : '';
    if (!parseStartDate(dateStr)) {
        throw badRequest('Ungültiges Datum (erwartet: YYYY-MM-DD ab 1900)');
    }
    // One day of slack: the server cannot know the admin's timezone, "today" in Germany can still be yesterday in UTC.
    if (dateStr > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) {
        throw badRequest('Das Startdatum darf nicht in der Zukunft liegen');
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', ?)").run(dateStr);
    res.json({ success: true });
});

module.exports = router;
