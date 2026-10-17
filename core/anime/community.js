// Who may see which rating of a shared anime entry. Every user rates for themselves; a rating is public (with the name),
// anonymous (counts, no name) or private (only the owner sees it). Notes are never shared.
const episodeMarks = require('./episodes');

const VISIBILITIES = ['public', 'anonymous', 'private'];
const MAX_COMMENT = 500;

const visibilityOf = (row) => (row && VISIBILITIES.includes(row.rating_visibility) ? row.rating_visibility : 'public');

/**
 * A progress row as somebody else may see it: no notes, no resume link, rating only when public. The visibility itself
 * is not shown either, so nobody learns that a user rated anonymously or privately.
 */
function othersView(progress, row) {
    const visibility = visibilityOf(row);
    const out = { ...progress, notes: null, resume_url: null, resume_episode: null };
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
        average: rated.length ? Math.round((sum / rated.length) * 10) / 10 : null,
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

/** Ratings of one entry for the viewer: public ones with the name, anonymous ones without, the viewer's own always named. */
function ratingsOf(rows, viewerId) {
    const items = [];
    for (const r of rows) {
        if (r.score === null || r.score === undefined) continue;
        const own = r.user_id === viewerId;
        const visibility = visibilityOf(r);
        if (visibility === 'private' && !own) continue;
        const named = own || visibility === 'public';
        items.push({
            user_id: named ? r.user_id : null,
            username: named ? r.username : null,
            score: r.score,
            comment: r.public_comment || null,
            visibility,
            own,
            updated_at: r.updated_at
        });
    }
    return { summary: summarize(rows), ratings: items };
}

/** Per-episode community average over the public and anonymous ratings: { "7": { average, count } }. */
function episodeCommunity(rows) {
    const acc = new Map();
    for (const r of rows) {
        if (visibilityOf(r) === 'private') continue;
        const scores = episodeMarks.parseScores(r.episode_scores);
        for (const [ep, value] of Object.entries(scores)) {
            const cur = acc.get(ep) || { sum: 0, count: 0 };
            cur.sum += value;
            cur.count += 1;
            acc.set(ep, cur);
        }
    }
    const out = {};
    for (const [ep, v] of acc) out[ep] = { average: Math.round((v.sum / v.count) * 10) / 10, count: v.count };
    return out;
}

function parseVisibility(value) {
    if (value === undefined) return undefined;
    return VISIBILITIES.includes(value) ? value : null;
}

module.exports = { VISIBILITIES, MAX_COMMENT, visibilityOf, othersView, summarize, communityByAnime, ratingsOf, episodeCommunity, parseVisibility };
