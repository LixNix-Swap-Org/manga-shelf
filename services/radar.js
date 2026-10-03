// Shopping list and release radar: turns the rows of the two queries into the API responses.
// Pure functions (no database, no clock of their own) so they can be unit-tested.
const { normalizePublisher } = require('../utils/publishers');

const MONTH_NAMES = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
];

const DAY_MS = 1000 * 60 * 60 * 24;
const round2 = (n) => Math.round(n * 100) / 100;
const isPreordered = (status) => ['Vorbestellt', 'Bestellt'].includes(status);

/**
 * Days until a release date ("YYYY-MM-DD", or "YYYY-MM" = first of the month) and the label shown on the card.
 * `today` is a parameter so the result is testable. Unparseable dates give nulls.
 */
function countdownFor(releaseDate, today = new Date()) {
    if (!releaseDate) return { days_until: null, countdown_label: null };

    const parts = String(releaseDate).split('-');
    let targetDate = null;
    if (parts.length >= 3) {
        targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
    } else if (parts.length === 2) {
        targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
    }
    if (!targetDate || isNaN(targetDate.getTime())) return { days_until: null, countdown_label: null };

    // whole calendar days via UTC midnights: local midnights are 23 / 25 hours apart across a daylight-saving change
    const toUtcDay = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const daysUntil = Math.round((toUtcDay(targetDate) - toUtcDay(today)) / DAY_MS);

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

/** Response of GET /api/shopping-list for the missing volumes (already sorted by the query). */
function buildShoppingList(missingVols) {
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
    const publishers = Array.from(publisherMap.values()).map(p => ({ ...p, total_price: round2(p.total_price) }));

    return {
        total_missing: missingVols.length,
        total_cost: round2(totalCost),
        publishers,
        items: missingVols
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

module.exports = { countdownFor, buildShoppingList, buildReleaseRadar, monthGroupOf };
