// Anime block of GET /stats: only when the list has entries.
const MONTHS = 12;
const TOP = 8;

const splitList = (value) => String(value || '').split(',').map((x) => x.trim()).filter(Boolean);

/** Keys sorted by count (then name), at most TOP: [{ name, count, average }]. */
function topOf(map) {
    return [...map.entries()]
        .map(([name, v]) => ({ name, count: v.count, average: v.scores ? Math.round((v.sum / v.scores) * 10) / 10 : null }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, TOP);
}

/** "YYYY-MM" of a finished_at / updated_at text ('2026-03-14', '2026-03-14 10:00:00'), else null. */
const monthOf = (text) => { const m = /^(\d{4})-(\d{2})/.exec(String(text || '')); return m ? `${m[1]}-${m[2]}` : null; };

/**
 * The caller's own list in numbers: genres, studios and score spread (over every entry with progress), the last twelve months of
 * finished entries with their average score, and the recap of the current year.
 */
function insightsOf(ctx) {
    const rows = ctx.db.prepare(`
        SELECT a.genres, a.studios, a.duration, a.episodes, p.status, p.score, p.episodes_watched, p.finished_at, p.updated_at
        FROM anime_progress p JOIN animes a ON a.id = p.anime_id WHERE p.user_id = ? AND p.status != 'Geplant'
    `).all(ctx.user.id);
    if (!rows.length) return null;
    const genres = new Map();
    const studios = new Map();
    const scores = Array(10).fill(0);
    const months = new Map();
    const now = ctx.now();
    const thisYear = String(now.getUTCFullYear());
    const recap = { year: Number(thisYear), completed: 0, episodes: 0, minutes: 0, average: null };
    let recapSum = 0;
    let recapScores = 0;
    const bump = (map, name, score) => {
        const v = map.get(name) || { count: 0, sum: 0, scores: 0 };
        v.count++;
        if (score) { v.sum += score; v.scores++; }
        map.set(name, v);
    };
    for (const r of rows) {
        const score = Number.isInteger(r.score) && r.score >= 1 && r.score <= 10 ? r.score : null;
        splitList(r.genres).forEach((g) => bump(genres, g, score));
        splitList(r.studios).forEach((g) => bump(studios, g, score));
        if (score) scores[score - 1]++;
        if (r.status !== 'Gesehen') continue;
        const month = monthOf(r.finished_at) || monthOf(r.updated_at);
        if (!month) continue;
        const m = months.get(month) || { count: 0, sum: 0, scores: 0 };
        m.count++;
        if (score) { m.sum += score; m.scores++; }
        months.set(month, m);
        if (month.startsWith(thisYear)) {
            recap.completed++;
            recap.episodes += r.episodes_watched || 0;
            recap.minutes += (r.episodes_watched || 0) * (r.duration || 0);
            if (score) { recapSum += score; recapScores++; }
        }
    }
    if (recapScores) recap.average = Math.round((recapSum / recapScores) * 10) / 10;
    const series = [];
    for (let i = MONTHS - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const m = months.get(key);
        series.push({ month: key, completed: m ? m.count : 0, average: m && m.scores ? Math.round((m.sum / m.scores) * 10) / 10 : null });
    }
    return { genres: topOf(genres), studios: topOf(studios), scores, by_month: series, recap };
}

function animeStats(ctx) {
    const total = ctx.db.prepare('SELECT count(*) AS n FROM animes').get().n;
    if (!total) return null;
    const counts = ctx.db.prepare(`
        SELECT
            count(DISTINCT CASE WHEN status = 'Schaue' THEN anime_id END) AS watching,
            count(DISTINCT CASE WHEN status = 'Gesehen' THEN anime_id END) AS completed,
            count(DISTINCT CASE WHEN status = 'Geplant' THEN anime_id END) AS planned
        FROM anime_progress WHERE user_id = ?
    `).get(ctx.user.id);
    const perUser = ctx.db.prepare(`
        SELECT u.id AS user_id, u.username, sum(p.episodes_watched) AS episodes_watched,
               sum(p.episodes_watched * COALESCE(a.duration, 0)) AS watch_minutes,
               count(CASE WHEN p.status = 'Gesehen' THEN 1 END) AS completed
        FROM anime_progress p JOIN users u ON u.id = p.user_id JOIN animes a ON a.id = p.anime_id
        GROUP BY u.id ORDER BY watch_minutes DESC, u.username COLLATE NOCASE
    `).all();
    const byKind = { anime: 0, tv: 0, movie: 0 };
    for (const r of ctx.db.prepare('SELECT kind, count(*) AS n FROM animes GROUP BY kind').all()) if (Object.prototype.hasOwnProperty.call(byKind, r.kind)) byKind[r.kind] = r.n;
    return {
        total,
        by_kind: byKind,
        watching: counts.watching || 0,
        completed: counts.completed || 0,
        planned: counts.planned || 0,
        insights: insightsOf(ctx),
        per_user: perUser.map((r) => ({
            user_id: r.user_id,
            username: r.username,
            episodes_watched: r.episodes_watched || 0,
            watch_minutes: r.watch_minutes || 0,
            completed: r.completed || 0
        }))
    };
}

module.exports = { animeStats };
