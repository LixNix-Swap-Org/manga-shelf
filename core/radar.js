// Shopping list and release radar: turns the rows of the two queries into the API responses.
// Pure functions (no database, no clock of their own) so they can be unit-tested.
const { normalizePublisher } = require('./lib/publishers');

const DEFAULT_TIME_ZONE = 'Europe/Berlin';

const MONTH_NAMES = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
];

const DAY_MS = 1000 * 60 * 60 * 24;
const round2 = (n) => Math.round(n * 100) / 100;
const isPreordered = (status) => ['Vorbestellt', 'Bestellt'].includes(status);

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Today's calendar date in the app's time zone (ctx.config.appTimeZone, default Europe/Berlin; null means the
 * host's) as a local-midnight Date, so getFullYear/getMonth/getDate give the user's day even when the server runs in UTC.
 */
function zonedToday(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
    let parts;
    if (!timeZone) return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    try {
        parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    } catch {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
    return new Date(get('year'), get('month') - 1, get('day'));
}

/** "YYYY-MM" of a Date's local calendar month. */
const monthKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

/** Strict release date check: "YYYY-MM" or "YYYY-MM-DD" with a month 1-12 and a day that exists in that month. */
function isValidReleaseDate(value) {
    if (typeof value !== 'string') return false;
    const m = value.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (y < 1900 || y > 2999 || mo < 1 || mo > 12) return false;
    if (m[3] === undefined) return true;
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// whole calendar days via UTC midnights: local midnights are 23 / 25 hours apart across a daylight-saving change
const toUtcDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (from, to) => Math.round((toUtcDay(to) - toUtcDay(from)) / DAY_MS);

/**
 * Countdown for a month-only date: month labels instead of a day count. days_until stays null while the month is
 * current or ahead (the day is unknown), and becomes negative (days since the month ended) once it is over.
 */
function monthCountdown(y, m, today) {
    const monthsAhead = (y - today.getFullYear()) * 12 + (m - 1 - today.getMonth());
    if (monthsAhead < 0) {
        const ago = -monthsAhead;
        return {
            days_until: daysBetween(today, new Date(y, m, 0)),
            countdown_label: `Vor ${ago} Monat${ago === 1 ? '' : 'en'}`,
            date_precision: 'month'
        };
    }
    const label = monthsAhead === 0 ? 'Diesen Monat' : (monthsAhead === 1 ? 'Nächsten Monat' : `In ${monthsAhead} Monaten`);
    return { days_until: null, countdown_label: label, date_precision: 'month' };
}

/**
 * Days until a release date ("YYYY-MM-DD") and the label shown on the card; a month-only date ("YYYY-MM" or "YYYY-M")
 * gets month labels (see monthCountdown). `today` is a parameter so the result is testable. Unparseable or impossible
 * dates give nulls.
 */
function countdownFor(releaseDate, today = new Date()) {
    const empty = { days_until: null, countdown_label: null };
    if (!releaseDate) return empty;
    const raw = String(releaseDate).trim();

    const monthOnly = raw.match(/^(\d{4})-(\d{1,2})$/);
    if (monthOnly) {
        const y = Number(monthOnly[1]);
        const m = Number(monthOnly[2]);
        return m >= 1 && m <= 12 ? monthCountdown(y, m, today) : empty;
    }

    const full = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!full) return empty;
    const [y, m, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
    const targetDate = new Date(y, m - 1, d);
    // "2026-13-45" would roll over into another date
    if (isNaN(targetDate.getTime()) || targetDate.getFullYear() !== y || targetDate.getMonth() !== m - 1 || targetDate.getDate() !== d) return empty;

    const daysUntil = daysBetween(today, targetDate);

    let label;
    if (daysUntil < 0) {
        const ago = Math.abs(daysUntil);
        label = `Vor ${ago} Tag${ago === 1 ? '' : 'en'}`;
    } else if (daysUntil === 0) {
        label = 'Erscheint heute!';
    } else if (daysUntil === 1) {
        label = 'Morgen!';
    } else if (daysUntil <= 30) {
        label = `In ${daysUntil} Tagen`;
    } else {
        // calendar months, so December -> January counts as "next month" as well
        const monthsAhead = (targetDate.getFullYear() - today.getFullYear()) * 12 + (targetDate.getMonth() - today.getMonth());
        if (monthsAhead === 1) {
            label = 'Nächsten Monat';
        } else {
            label = `In ${monthsAhead} Monaten`;
        }
    }
    return { days_until: daysUntil, countdown_label: label };
}

/**
 * Response of GET /api/shopping-list for the missing volumes (already sorted by the query). wishedSeries (rows of the
 * wished-series query, sorted by priority and title) is appended as wished_series; publisher chips count them as wished_count.
 */
function buildShoppingList(missingVols, wishedSeries = []) {
    const totalCost = missingVols.reduce((sum, v) => sum + (v.price || 0), 0);

    // Group by publisher for the filter chips
    const publisherMap = new Map();
    missingVols.forEach(v => {
        const pub = normalizePublisher(v.effective_publisher) || 'Unbekannt';
        if (!publisherMap.has(pub)) publisherMap.set(pub, { publisher: pub, count: 0, total_price: 0 });
        const stat = publisherMap.get(pub);
        stat.count++;
        stat.total_price += (v.price || 0);
    });
    const wished = wishedSeries.map(s => ({
        id: s.id,
        title: s.title,
        cover_image: s.cover_image || null,
        publisher: normalizePublisher(s.publisher) || 'Unbekannt',
        wish_priority: s.wish_priority,
        total_volumes: s.total_volumes ?? null,
        manga_passion_id: s.manga_passion_id ?? null,
        known_missing_count: s.known_missing_count || 0,
        known_missing_cost: round2(s.known_missing_cost || 0)
    }));
    const wishedCounts = new Map();
    for (const s of wished) wishedCounts.set(s.publisher, (wishedCounts.get(s.publisher) || 0) + 1);
    for (const pub of wishedCounts.keys()) {
        if (!publisherMap.has(pub)) publisherMap.set(pub, { publisher: pub, count: 0, total_price: 0 });
    }
    const publishers = Array.from(publisherMap.values())
        .map(p => ({ ...p, total_price: round2(p.total_price), wished_count: wishedCounts.get(p.publisher) || 0 }));

    return {
        total_missing: missingVols.length,
        total_cost: round2(totalCost),
        total_wished_series: wished.length,
        publishers,
        items: missingVols,
        wished_series: wished
    };
}

/** Month group an item belongs to: label + sort key ("Ohne konkretes Datum" sorts last). */
function monthGroupOf(item) {
    if (item.release_date) {
        const parts = item.release_date.split('-');
        if (parts.length >= 2) {
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
                return { label: `${MONTH_NAMES[m - 1]} ${y}`, sortKey: `${y}-${String(m).padStart(2, '0')}` };
            }
        }
    } else if (item.release_year) {
        return { label: `Im Jahr ${item.release_year}`, sortKey: `${item.release_year}-13` };
    }
    return { label: 'Ohne konkretes Datum', sortKey: '9999-99' };
}

/** Response of GET /api/release-radar for the pre-ordered / upcoming volumes (already sorted by the query). */
function buildReleaseRadar(radarVols, today = new Date()) {
    const preorderedVols = radarVols.filter(v => isPreordered(v.status));
    const preorderedBudget = preorderedVols.reduce((sum, v) => sum + (v.price || 0), 0);
    const totalBudget = radarVols.reduce((sum, v) => sum + (v.price || 0), 0);

    const items = radarVols.map(v => ({
        ...v,
        effective_publisher: normalizePublisher(v.effective_publisher) || 'Unbekannt',
        ...countdownFor(v.release_date, today)
    }));

    // Group by year-month
    const groupMap = new Map();
    items.forEach(item => {
        const { label, sortKey } = monthGroupOf(item);
        if (!groupMap.has(sortKey)) {
            groupMap.set(sortKey, { key: sortKey, label, count: 0, total_price: 0, preordered_count: 0, items: [] });
        }
        const grp = groupMap.get(sortKey);
        grp.count++;
        grp.total_price += (item.price || 0);
        if (isPreordered(item.status)) grp.preordered_count++;
        grp.items.push(item);
    });
    const groups = Array.from(groupMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, grp]) => ({ ...grp, total_price: round2(grp.total_price) }));

    const publisherMap = new Map();
    items.forEach(v => {
        if (!publisherMap.has(v.effective_publisher)) publisherMap.set(v.effective_publisher, { publisher: v.effective_publisher, count: 0 });
        publisherMap.get(v.effective_publisher).count++;
    });

    return {
        total_releases: radarVols.length,
        preordered_count: preorderedVols.length,
        preordered_budget: round2(preorderedBudget),
        total_budget: round2(totalBudget),
        groups,
        items,
        publishers: Array.from(publisherMap.values())
    };
}

module.exports = { countdownFor, buildShoppingList, buildReleaseRadar, monthGroupOf, zonedToday, monthKeyOf, isValidReleaseDate };
