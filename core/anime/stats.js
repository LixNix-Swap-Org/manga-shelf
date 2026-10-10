// Anime block of GET /stats: only when the list has entries.
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
    return {
        total,
        watching: counts.watching || 0,
        completed: counts.completed || 0,
        planned: counts.planned || 0,
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
