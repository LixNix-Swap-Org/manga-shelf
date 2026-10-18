// Who may see which rating of a shared anime entry. Every user rates for themselves; a rating is public (with the name),
// anonymous (counts, no name) or private (only the owner sees it). Notes are never shared.
const episodeMarks = require('./episodes');

const VISIBILITIES = ['public', 'anonymous', 'private'];
const MAX_COMMENT = 500;
// anonymous episode ratings feed a per-episode average only from this many on, so a single one cannot be read off it
const MIN_ANONYMOUS = 2;

const visibilityOf = (row) => (row && VISIBILITIES.includes(row.rating_visibility) ? row.rating_visibility : 'public');

const roundOne = (value) => Math.round(value * 10) / 10;

/**
 * A progress row as somebody else may see it: no notes, no resume link, rating only when public. Neither the visibility
 * nor the time of the last change is shown (that time would point to the moment an anonymous rating appeared); both are
 * left out of every such row, public ones included, so their absence does not tell who rated anonymously or privately.
 */
function othersView(progress, row) {
    const visibility = visibilityOf(row);
    const out = { ...progress, notes: null, resume_url: null, resume_episode: null, updated_at: null };
    delete out.rating_visibility;
    if (visibility !== 'public') {
        out.score = null;
        out.episode_scores = {};
        out.public_comment = null;
    }
    return out;
}

/** { average, count, watchers } over the ratings that are public or anonymous; null average without ratings. */
function summarize(rows) {
    const rated = rows.filter((r) => r.score !== null && r.score !== undefined && visibilityOf(r) !== 'private');
    const sum = rated.reduce((a, r) => a + r.score, 0);
    return {
        average: rated.length ? roundOne(sum / rated.length) : null,
        count: rated.length,
        watchers: rows.filter((r) => r.status !== 'Geplant').length
    };
}

/** Community summary per anime id for the given progress rows. */
function communityByAnime(rows) {
    const by = new Map();
    for (const r of rows) {
        if (!by.has(r.anime_id)) by.set(r.anime_id, []);
        by.get(r.anime_id).push(r);
    }
    const out = new Map();
    for (const [id, list] of by) out.set(id, summarize(list));
    return out;
}

const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Higher score first, then the longer comment, then the comment itself: an order that depends on nothing but what is shown. */
function byScoreAndComment(a, b) {
    const ca = a.comment || '';
    const cb = b.comment || '';
    return b.score - a.score || cb.length - ca.length || textOrder(ca, cb);
}

/**
 * Ratings of one entry for the viewer. The viewer's own and the public ones come first, in the order of `rows`, with
 * user, visibility and time; then the anonymous ones of others with score and comment only, by byScoreAndComment, so
 * neither a field nor the position points to their author. Private ratings of others are left out.
 */
function ratingsOf(rows, viewerId) {
    const named = [];
    const anonymous = [];
    for (const r of rows) {
        if (r.score === null || r.score === undefined) continue;
        const own = r.user_id === viewerId;
        const visibility = visibilityOf(r);
        if (visibility === 'private' && !own) continue;
        const comment = r.public_comment || null;
        if (own || visibility === 'public') {
            named.push({ user_id: r.user_id, username: r.username, score: r.score, comment, visibility, own, updated_at: r.updated_at });
        } else {
            anonymous.push({ user_id: null, username: null, score: r.score, comment, own: false });
        }
    }
    anonymous.sort(byScoreAndComment);
    return { summary: summarize(rows), ratings: [...named, ...anonymous] };
}

/**
 * Per-episode community ratings: { "7": { average, count } }. The count takes the public and the anonymous ratings, the
 * average the public ones and the anonymous ones only when at least MIN_ANONYMOUS of them rate that episode (null when
 * nothing is left).
 */
function episodeCommunity(rows) {
    const acc = new Map();
    for (const r of rows) {
        const visibility = visibilityOf(r);
        if (visibility === 'private') continue;
        const scores = episodeMarks.parseScores(r.episode_scores);
        for (const [ep, value] of Object.entries(scores)) {
            const cur = acc.get(ep) || { sum: 0, count: 0, anonymousSum: 0, anonymousCount: 0 };
            if (visibility === 'public') {
                cur.sum += value;
                cur.count += 1;
            } else {
                cur.anonymousSum += value;
                cur.anonymousCount += 1;
            }
            acc.set(ep, cur);
        }
    }
    const out = {};
    for (const [ep, v] of acc) {
        const withAnonymous = v.anonymousCount >= MIN_ANONYMOUS;
        const sum = v.sum + (withAnonymous ? v.anonymousSum : 0);
        const n = v.count + (withAnonymous ? v.anonymousCount : 0);
        out[ep] = { average: n ? roundOne(sum / n) : null, count: v.count + v.anonymousCount };
    }
    return out;
}

function parseVisibility(value) {
    if (value === undefined) return undefined;
    return VISIBILITIES.includes(value) ? value : null;
}

module.exports = {
    VISIBILITIES, MAX_COMMENT, MIN_ANONYMOUS, visibilityOf, othersView, summarize, communityByAnime, ratingsOf, episodeCommunity, parseVisibility
};
