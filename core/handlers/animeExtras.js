// Anime calendar feed (iCal), the discover views (a season of AniList, recommendations from the user's ratings).
const { qstr } = require('../lib/query');
const { HttpError, msg, badRequest } = require('../errors');
const gateway = require('../anime/gateway');
const { SourceError } = require('../anime/request');
const { buildCalendar } = require('../ical');
const radar = require('./radar');
const anime = require('./anime');

const WEEK_S = 7 * 24 * 60 * 60;
const PROJECTED_WEEKS = 3;
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const MIN_LIKED_SCORE = 8;
const MAX_SEEDS = 40;

/**
 * Airing times of one entry: the announced next episode and, for a running TV show, the following weekly episodes
 * as estimates (until the known episode count). [{ episode, at (seconds), estimated }].
 */
function airings(row, nowSeconds) {
    if (!row.next_airing_at) return [];
    const out = [];
    const total = row.episodes > 0 ? row.episodes : null;
    const weekly = ['TV', 'TV_SHORT', 'ONA'].includes(row.format) && !row.next_airing_estimated;
    const weeks = weekly ? PROJECTED_WEEKS : 0;
    for (let i = 0; i <= weeks; i++) {
        const episode = row.next_airing_episode == null ? null : row.next_airing_episode + i;
        if (total && episode && episode > total) break;
        const at = row.next_airing_at + i * WEEK_S;
        if (at < nowSeconds - WEEK_S) continue;
        out.push({ episode, at, estimated: i > 0 || Boolean(row.next_airing_estimated) });
    }
    return out;
}

const titleOf = (row) => row.title_de || row.title || row.title_romaji || row.title_english || row.title_native;

/** GET /anime/feed.ics?token= : the airing times of the entries the token's owner watches or plans. */
function calendarFeed(ctx, { query }) {
    const found = radar.feedEntryFor(ctx, qstr(query.token));
    if (!found) throw new HttpError(404, 'Kalender-Abo nicht gefunden oder widerrufen', 'NOT_FOUND');
    radar.touchFeed(ctx, found);
    const rows = ctx.db.prepare(`
        SELECT a.*, p.status AS my_status FROM animes a JOIN anime_progress p ON p.anime_id = a.id
        WHERE p.user_id = ? AND p.status IN ('Schaue', 'Geplant') AND a.next_airing_at IS NOT NULL AND a.kind != 'movie'
        ORDER BY a.next_airing_at, a.id
    `).all(found.entry.user_id);
    const nowSeconds = Math.floor(ctx.now().getTime() / 1000);
    const instance = ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'instance_id'").get();
    const domain = instance && instance.value ? `${instance.value}.manga-shelf` : 'manga-shelf';
    const events = [];
    for (const row of rows) {
        for (const airing of airings(row, nowSeconds)) {
            events.push({
                uid: `anime-${row.id}-${airing.episode ?? 'x'}@${domain}`,
                at: airing.at * 1000,
                minutes: row.duration || 24,
                summary: `${titleOf(row)}${airing.episode ? ` – Folge ${airing.episode}` : ''}${airing.estimated ? ' (geschätzt)' : ''}`,
                description: [`Status: ${row.my_status}`, airing.estimated && 'Geschätzter Termin (wöchentlich fortgeschrieben)'].filter(Boolean).join('\n'),
                categories: 'Anime'
            });
        }
    }
    const body = buildCalendar({ name: 'Manga Shelf – Anime-Folgen', description: 'Neue Folgen der Anime, die du schaust oder planst', events, now: ctx.now(), refreshHours: 6 });
    return {
        body,
        headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="manga-shelf-anime.ics"' }
    };
}

function sourceFailure(err) {
    if (err instanceof SourceError) return new HttpError(502, msg('AniList antwortet gerade nicht'), 'SOURCE_UNAVAILABLE');
    return err;
}

/** The season of a date: WINTER (Jan–Mar) … FALL (Oct–Dec). */
const seasonOf = (date) => ({ season: SEASONS[Math.floor(date.getUTCMonth() / 3)], year: date.getUTCFullYear() });

/** GET /anime/discover/season?season=&year=&page= : a season of AniList by popularity, marked with what is in the list already. */
async function discoverSeason(ctx, { query }) {
    const current = seasonOf(ctx.now());
    const season = (qstr(query.season) || current.season).toUpperCase();
    const year = parseInt(qstr(query.year) || current.year, 10);
    const page = Math.max(1, parseInt(qstr(query.page), 10) || 1);
    if (!SEASONS.includes(season) || !(year >= 1960 && year <= current.year + 2)) throw badRequest('Ungültige Season');
    let answer;
    try { answer = await gateway.discoverSeason(ctx, { season, year, page }, { userId: ctx.user ? ctx.user.id : null }); } catch (err) { throw sourceFailure(err); }
    const inCollection = anime.collectionMatcher(ctx);
    return {
        body: {
            season, year, page, has_next: answer.has_next,
            results: answer.metas.map((meta) => ({ ...meta, in_collection_id: inCollection(meta) }))
        }
    };
}

/** GET /anime/discover/recommendations : what AniList users recommend after the entries the caller rated 8 or higher (or finished without a rating). */
async function discoverRecommendations(ctx) {
    const userId = ctx.user ? ctx.user.id : null;
    const seeds = ctx.db.prepare(`
        SELECT a.id, a.anilist_id, a.title, a.title_de FROM animes a JOIN anime_progress p ON p.anime_id = a.id
        WHERE p.user_id = ? AND a.anilist_id IS NOT NULL AND ((p.score >= ?) OR (p.score IS NULL AND p.status = 'Gesehen'))
        ORDER BY COALESCE(p.score, 0) DESC, p.updated_at DESC LIMIT ?
    `).all(userId, MIN_LIKED_SCORE, MAX_SEEDS);
    if (!seeds.length) return { body: { seeds: 0, results: [] } };
    let hits;
    try { hits = await gateway.discoverRecommendations(ctx, seeds.map((s) => s.anilist_id), { userId }); } catch (err) { throw sourceFailure(err); }
    const inCollection = anime.collectionMatcher(ctx);
    const seedOf = new Map(seeds.map((s) => [s.anilist_id, s.title_de || s.title]));
    const results = hits
        .map((hit) => ({ ...hit.meta, in_collection_id: inCollection(hit.meta), rating: hit.rating, because: hit.from.map((id) => seedOf.get(id)).filter(Boolean).slice(0, 3) }))
        .filter((hit) => !hit.in_collection_id)
        .sort((a, b) => b.rating - a.rating || (b.score || 0) - (a.score || 0))
        .slice(0, 24);
    return { body: { seeds: seeds.length, results } };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_DAYS = 400;

/**
 * GET /anime/history?from=YYYY-MM-DD&to=YYYY-MM-DD : the episodes that aired in the range (entries I have progress on) and
 * the days I finished an entry. Times are what the server stored, in seconds / as dates.
 */
function history(ctx, { query }) {
    const from = qstr(query.from);
    const to = qstr(query.to);
    const parse = (text) => (DAY_RE.test(text || '') ? Date.parse(`${text}T00:00:00Z`) : NaN);
    if (!(parse(from) <= parse(to)) || (parse(to) - parse(from)) / 86400000 > MAX_HISTORY_DAYS) throw badRequest('Ungültiger Zeitraum');
    const userId = ctx.user.id;
    // a day of any time zone: one day of slack on both sides, the client sorts them into its own days
    const fromS = Math.floor(parse(from) / 1000) - 86400;
    const toS = Math.floor(parse(to) / 1000) + 2 * 86400;
    const airings = ctx.db.prepare(`
        SELECT g.anime_id, g.episode, g.at FROM anime_airings g JOIN anime_progress p ON p.anime_id = g.anime_id AND p.user_id = ?
        WHERE g.at >= ? AND g.at < ? ORDER BY g.at, g.anime_id
    `).all(userId, fromS, toS);
    const finished = ctx.db.prepare(`
        SELECT anime_id, substr(COALESCE(finished_at, updated_at), 1, 10) AS date FROM anime_progress
        WHERE user_id = ? AND status = 'Gesehen' AND substr(COALESCE(finished_at, updated_at), 1, 10) BETWEEN ? AND ? ORDER BY date, anime_id
    `).all(userId, from, to);
    return { body: { airings, finished } };
}

module.exports = { history, calendarFeed, discoverSeason, discoverRecommendations, airings };
