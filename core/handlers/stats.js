// Collection statistics (GET /stats).
const { wishedSummary } = require('./wishlist');
const { regularNumberedSql } = require('../lib/volumeNumber');
const { animeStats } = require('../anime/stats');
const { badRequest, notFound } = require('../errors');

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
function buildSpending(ctx, now = new Date()) {
    const monthRows = ctx.db.prepare(`
        SELECT SUBSTR(TRIM(purchase_date), 1, 7) AS month, count(*) AS volumes, sum(COALESCE(price, 0)) AS total
        FROM volumes
        WHERE status = 'Vorhanden' AND ${PURCHASE_MONTH}
        GROUP BY month
    `).all();
    const yearRows = ctx.db.prepare(`
        SELECT CAST(SUBSTR(TRIM(purchase_date), 1, 4) AS INTEGER) AS year, count(*) AS volumes, sum(COALESCE(price, 0)) AS total
        FROM volumes
        WHERE status = 'Vorhanden' AND ${PURCHASE_YEAR}
        GROUP BY year
        ORDER BY year
    `).all();
    const yearOnly = ctx.db.prepare(`
        SELECT count(*) AS volumes, sum(COALESCE(price, 0)) AS total FROM volumes
        WHERE status = 'Vorhanden' AND ${PURCHASE_YEAR} AND NOT ${PURCHASE_MONTH}
    `).get();
    const none = ctx.db.prepare(`
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
 * Komplett gesammelt (nicht Erscheinungsstatus), wie isSeriesComplete im Frontend: total_volumes > 0 und die Zahl der
 * verschiedenen regulären vorhandenen Nummern (regular_owned der Reihenliste) erreicht total_volumes.
 */
const COMPLETED_SERIES_SQL = `
    SELECT count(*) AS count FROM mangas m
    WHERE m.total_volumes > 0
      AND (SELECT COUNT(DISTINCT v.number_sort) FROM volumes v
           WHERE v.manga_id = m.id AND v.status = 'Vorhanden' AND ${regularNumberedSql('v')}) >= m.total_volumes
`;

const EFF_PUB = "COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt')";

// one pass over all volumes: owned figures plus what the missing ones would cost; priced = a stored price (0 = gift counts)
const PUBLISHERS_SQL = `
    SELECT ${EFF_PUB} AS pub_name,
           COUNT(DISTINCT CASE WHEN v.status = 'Vorhanden' THEN m.id END) AS series_count,
           SUM(CASE WHEN v.status = 'Vorhanden' THEN 1 ELSE 0 END) AS volume_count,
           SUM(CASE WHEN v.status = 'Vorhanden' THEN COALESCE(v.price, 0) ELSE 0 END) AS total_value,
           SUM(CASE WHEN v.status = 'Vorhanden' AND v.price IS NOT NULL THEN 1 ELSE 0 END) AS priced_count,
           AVG(CASE WHEN v.status = 'Vorhanden' THEN v.price END) AS avg_price,
           SUM(CASE WHEN v.status = 'Fehlt' THEN 1 ELSE 0 END) AS missing_count,
           SUM(CASE WHEN v.status = 'Fehlt' THEN COALESCE(v.price, 0) ELSE 0 END) AS missing_value
    FROM volumes v
    JOIN mangas m ON v.manga_id = m.id
    WHERE v.status IN ('Vorhanden', 'Fehlt')
    GROUP BY pub_name
    HAVING volume_count > 0
    ORDER BY volume_count DESC, total_value DESC, pub_name
`;

const TOP_SERIES_SQL = `
    SELECT m.id, m.title, m.cover_image, m.publisher,
           SUM(CASE WHEN v.status = 'Vorhanden' THEN 1 ELSE 0 END) AS owned_volumes,
           SUM(CASE WHEN v.status = 'Vorhanden' THEN COALESCE(v.price, 0) ELSE 0 END) AS owned_value,
           SUM(CASE WHEN v.status = 'Fehlt' THEN COALESCE(v.price, 0) ELSE 0 END) AS missing_value,
           AVG(CASE WHEN v.status = 'Vorhanden' THEN v.price END) AS avg_price,
           SUM(CASE WHEN v.status = 'Vorhanden' AND v.price IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM mangas m
    JOIN volumes v ON v.manga_id = m.id
    GROUP BY m.id
    HAVING owned_value > 0
    ORDER BY owned_value DESC, owned_volumes DESC, m.title COLLATE NOCASE ASC
    LIMIT 10
`;

// Wert je Besitzer mit dem Listenpreis (volumes.price), wie alle anderen Kennzahlen; geteilte Bände zählen bei jedem voll
const OWNER_STATS_SQL = `
    SELECT u.id as user_id, u.username,
           count(v.id) as volume_count,
           COALESCE(SUM(COALESCE(v.price, 0)), 0) as total_value,
           COUNT(DISTINCT v.manga_id) as series_count,
           COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND (SELECT count(*) FROM volume_owners o2 WHERE o2.volume_id = vo.volume_id) > 1 THEN 1 ELSE 0 END), 0) as shared_count
    FROM users u
    LEFT JOIN volume_owners vo ON vo.user_id = u.id
    LEFT JOIN volumes v ON v.id = vo.volume_id AND v.status = 'Vorhanden'
    GROUP BY u.id
    ORDER BY u.id
`;

const OWNER_PUBLISHERS_SQL = `
    SELECT u.id AS user_id, u.username, ${EFF_PUB} AS pub_name, COUNT(*) AS volume_count,
           SUM(COALESCE(v.price, 0)) AS total_value
    FROM volume_owners vo
    JOIN users u ON u.id = vo.user_id
    JOIN volumes v ON v.id = vo.volume_id AND v.status = 'Vorhanden'
    JOIN mangas m ON m.id = v.manga_id
    GROUP BY u.id, pub_name
    ORDER BY u.id, total_value DESC, volume_count DESC, pub_name
`;


const round1 = (n) => Math.round(n * 10) / 10;
const avgOrNull = (n) => (n === null || n === undefined ? null : round2(n));

function stats(ctx) {
    const totalSeriesRow = ctx.db.prepare('SELECT count(*) as count FROM mangas').get();
    const totalSeries = totalSeriesRow ? totalSeriesRow.count : 0;

    const ownedRow = ctx.db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as total_value, count(price) as priced_count, avg(price) as avg_price FROM volumes WHERE status = 'Vorhanden'").get();
    const totalOwnedVolumes = ownedRow ? ownedRow.count : 0;
    const totalOwnedValue = round2(ownedRow?.total_value);
    const pricedOwnedVolumes = ownedRow ? ownedRow.priced_count : 0;

    const missingRow = ctx.db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as missing_value FROM volumes WHERE status = 'Fehlt'").get();
    const totalMissingVolumes = missingRow ? missingRow.count : 0;
    const totalMissingValue = round2(missingRow?.missing_value);

    const allVolsRow = ctx.db.prepare('SELECT count(*) as count, sum(COALESCE(price, 0)) as full_value FROM volumes').get();
    const totalVolumesRecorded = allVolsRow ? allVolsRow.count : 0;
    const totalPossibleValue = round2(allVolsRow?.full_value);

    const completedSeries = ctx.db.prepare(COMPLETED_SERIES_SQL).get()?.count || 0;

    const settingRow = ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get();
    const storedStart = settingRow?.value;
    const startDateStr = parseStartDate(storedStart) ? storedStart : DEFAULT_START_DATE;
    const startDate = parseStartDate(startDateStr);
    const now = ctx.now();
    const diffMs = Math.max(1, now.getTime() - startDate.getTime());
    const totalDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
    const totalMonths = Math.max(1, Math.round(totalDays / 30.4375));
    const totalYears = (totalDays / 365.25).toFixed(2);
    const avgMonthlySpending = round2(totalOwnedValue / totalMonths);
    // A stored price of 0 (gift) counts; volumes without a price do not.
    const avgPricePerVolume = pricedOwnedVolumes > 0 ? round2(ownedRow.avg_price) : 0;

    const publishers = ctx.db.prepare(PUBLISHERS_SQL).all().map(p => ({
        publisher: p.pub_name,
        series_count: p.series_count,
        volume_count: p.volume_count,
        total_value: round2(p.total_value),
        percentage: totalOwnedVolumes > 0 ? round1((p.volume_count / totalOwnedVolumes) * 100) : 0,
        value_percentage: totalOwnedValue > 0 ? round1((p.total_value / totalOwnedValue) * 100) : 0,
        priced_count: p.priced_count,
        avg_price: avgOrNull(p.avg_price),
        missing_count: p.missing_count,
        missing_value: round2(p.missing_value)
    }));

    // User Reading Stats (Multi-User)
    const allUsers = ctx.db.prepare('SELECT id, username, role FROM users').all();
    const userReadingStats = allUsers.map(u => {
        const readRow = ctx.db.prepare(`
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

    const ownerStats = ctx.db.prepare(OWNER_STATS_SQL).all().map(o => ({ ...o, total_value: round2(o.total_value) }));
    // only shown with two or more users (OwnerStatsCard)
    const ownerPublishers = allUsers.length >= 2
        ? ctx.db.prepare(OWNER_PUBLISHERS_SQL).all().map(r => ({
            user_id: r.user_id,
            username: r.username,
            publisher: r.pub_name,
            volume_count: r.volume_count,
            total_value: round2(r.total_value)
        }))
        : [];

    const topSeries = ctx.db.prepare(TOP_SERIES_SQL).all().map(s => ({
        id: s.id,
        title: s.title,
        cover_image: s.cover_image,
        publisher: s.publisher,
        owned_volumes: s.owned_volumes,
        owned_value: round2(s.owned_value),
        total_value: round2(s.owned_value),
        missing_value: round2(s.missing_value),
        avg_price: avgOrNull(s.avg_price),
        unpriced: s.unpriced
    }));

    const wishedRow = wishedSummary(ctx);

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
        avg_monthly_spending: avgMonthlySpending,
        wished_series: wishedRow?.count || 0,
        wished_known_cost: round2(wishedRow?.known_cost)
    };

    return {
        body: {
            summary,
            publishers,
            user_reading_stats: userReadingStats,
            owner_stats: ownerStats,
            owner_publishers: ownerPublishers,
            top_series: topSeries,
            spending: buildSpending(ctx, now),
            ...animeBlock(ctx)
        }
    };
}

const READING_MONTHS = 24;
const CONTINUE_LIMIT = 12;
const REGULAR_V = regularNumberedSql('v');

const monthIndex = (key) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;

/** Longest and current run of consecutive months with at least one read (current: up to this or last month). */
function readingStreaks(monthKeys, currentKey) {
    const indices = [...new Set(monthKeys.map(monthIndex))].sort((a, b) => a - b);
    let longest = 0;
    let longestEnd = null;
    let run = 0;
    for (let i = 0; i < indices.length; i++) {
        run = i > 0 && indices[i] === indices[i - 1] + 1 ? run + 1 : 1;
        if (run > longest) {
            longest = run;
            longestEnd = indices[i];
        }
    }
    const last = indices[indices.length - 1];
    const now = monthIndex(currentKey);
    const current = last === now || last === now - 1 ? run : 0;
    const keyOf = (index) => (index === null ? null : `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
    return { longest, longest_end: keyOf(longestEnd), current };
}

/** Series with a read regular volume whose next owned regular volume after the highest read one is still unread. */
function continueReading(ctx, userId) {
    return ctx.db.prepare(`
        SELECT * FROM (
            SELECT m.id AS manga_id, m.title, m.cover_image, r.last_read_at, r.last_number,
                   (SELECT v2.id FROM volumes v2
                    WHERE v2.manga_id = m.id AND v2.status = 'Vorhanden' AND ${regularNumberedSql('v2')} AND v2.number_sort > r.last_number
                      AND NOT EXISTS (SELECT 1 FROM volume_reads x WHERE x.volume_id = v2.id AND x.user_id = ?)
                    ORDER BY v2.number_sort, v2.id LIMIT 1) AS next_id,
                   (SELECT count(*) FROM volumes v3
                    WHERE v3.manga_id = m.id AND v3.status = 'Vorhanden' AND ${regularNumberedSql('v3')} AND v3.number_sort > r.last_number
                      AND NOT EXISTS (SELECT 1 FROM volume_reads x WHERE x.volume_id = v3.id AND x.user_id = ?)) AS unread_after
            FROM (
                SELECT v.manga_id, MAX(v.number_sort) AS last_number, MAX(vr.read_at) AS last_read_at
                FROM volume_reads vr JOIN volumes v ON v.id = vr.volume_id
                WHERE vr.user_id = ? AND ${REGULAR_V}
                GROUP BY v.manga_id
            ) r
            JOIN mangas m ON m.id = r.manga_id
        )
        WHERE next_id IS NOT NULL
        ORDER BY last_read_at IS NULL, last_read_at DESC, title COLLATE NOCASE
        LIMIT ${CONTINUE_LIMIT}
    `).all(userId, userId, userId).map((row) => {
        const next = ctx.db.prepare('SELECT id, volume_number, cover_image FROM volumes WHERE id = ?').get(row.next_id);
        return {
            manga_id: row.manga_id,
            title: row.title,
            cover_image: row.cover_image,
            last_read_at: row.last_read_at,
            next_volume: next ? { id: next.id, volume_number: next.volume_number, cover_image: next.cover_image } : null,
            unread_after: row.unread_after
        };
    });
}

/**
 * GET /stats/reading?user_id=: reads per month (24 months: volumes, pages, series), the backlog curve (owned volumes by
 * purchase month minus the reader's reads, cumulative), this vs last year, reading streaks in months and the
 * "Weiterlesen" list. Reads without a date count as read but stay out of every timeline (unknown_date).
 */
function reading(ctx, { query }) {
    const raw = query.user_id;
    const userId = raw === undefined || raw === '' ? ctx.user.id : Number(raw);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw badRequest('Ungültige user_id');
    const user = ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user) throw notFound('Benutzer');

    const now = ctx.now();
    const keys = lastMonthKeys(now, READING_MONTHS);
    const first = keys[0];
    const currentKey = keys[keys.length - 1];

    const monthRows = ctx.db.prepare(`
        SELECT SUBSTR(vr.read_at, 1, 7) AS month, count(*) AS volumes, SUM(COALESCE(v.pages, 0)) AS pages, COUNT(DISTINCT v.manga_id) AS series
        FROM volume_reads vr JOIN volumes v ON v.id = vr.volume_id
        WHERE vr.user_id = ? AND vr.read_at IS NOT NULL
        GROUP BY month
    `).all(userId);
    const byMonthMap = new Map(monthRows.map(r => [r.month, r]));
    const unknownDate = ctx.db.prepare('SELECT count(*) AS n FROM volume_reads WHERE user_id = ? AND read_at IS NULL').get(userId).n;

    // backlog: owned volumes (household) by purchase month, minus this reader's reads of owned volumes by read month
    const owned = ctx.db.prepare(`
        SELECT CASE WHEN ${PURCHASE_MONTH} THEN SUBSTR(TRIM(purchase_date), 1, 7) ELSE NULL END AS month, count(*) AS n
        FROM volumes WHERE status = 'Vorhanden' GROUP BY month
    `).all();
    const readOwned = ctx.db.prepare(`
        SELECT SUBSTR(vr.read_at, 1, 7) AS month, count(*) AS n
        FROM volume_reads vr JOIN volumes v ON v.id = vr.volume_id
        WHERE vr.user_id = ? AND v.status = 'Vorhanden' GROUP BY month
    `).all(userId);
    const startCount = (rows) => rows.filter(r => !r.month || r.month < first).reduce((sum, r) => sum + r.n, 0);
    const perMonth = (rows) => new Map(rows.filter(r => r.month && r.month >= first).map(r => [r.month, r.n]));
    let ownedSum = startCount(owned);
    let readSum = startCount(readOwned);
    const ownedByMonth = perMonth(owned);
    const readByMonth = perMonth(readOwned);
    const backlog = keys.map((month) => {
        ownedSum += ownedByMonth.get(month) || 0;
        readSum += readByMonth.get(month) || 0;
        return { month, owned: ownedSum, read: readSum, backlog: Math.max(0, ownedSum - readSum) };
    });

    const thisYear = now.getFullYear();
    const yearTotals = (year) => monthRows
        .filter(r => r.month && r.month.startsWith(`${year}-`))
        .reduce((acc, r) => ({ year, volumes: acc.volumes + r.volumes, pages: acc.pages + (r.pages || 0) }), { year, volumes: 0, pages: 0 });

    return {
        body: {
            user: { id: user.id, username: user.username },
            months: READING_MONTHS,
            by_month: keys.map(month => {
                const r = byMonthMap.get(month);
                return { month, volumes: r?.volumes || 0, pages: r?.pages || 0, series: r?.series || 0 };
            }),
            backlog_by_month: backlog,
            this_year: yearTotals(thisYear),
            last_year: yearTotals(thisYear - 1),
            streak: readingStreaks(monthRows.map(r => r.month).filter(Boolean), currentKey),
            unknown_date: unknownDate,
            continue_reading: continueReading(ctx, userId)
        }
    };
}

/** { anime } only when the anime list has entries (the parity tests compare /stats without it). */
function animeBlock(ctx) {
    const anime = animeStats(ctx);
    return anime ? { anime } : {};
}

module.exports = { stats, reading, readingStreaks, parseStartDate, DEFAULT_START_DATE };
