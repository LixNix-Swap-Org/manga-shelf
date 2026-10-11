// TMDb API v3 adapter: films and TV shows (search/multi, details with external_ids), normalised to AnimeMeta.
const { requestJson, SourceError } = require('./request');
const { emptyMeta, preferredTitle } = require('./normalize');

const BASE = 'https://api.themoviedb.org/3';
const LABEL = 'TMDB';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';
const DETAIL_LANGUAGE = 'en-US';
const HEX_KEY = /^[0-9a-f]{32}$/i;
const KINDS = ['movie', 'tv'];

const MOVIE_STATUS = {
    Released: 'FINISHED', Rumored: 'NOT_YET_RELEASED', Planned: 'NOT_YET_RELEASED', 'In Production': 'NOT_YET_RELEASED',
    'Post Production': 'NOT_YET_RELEASED', Canceled: 'CANCELLED'
};
const TV_STATUS = {
    Ended: 'FINISHED', 'Returning Series': 'RELEASING', 'In Production': 'RELEASING', Planned: 'NOT_YET_RELEASED', Pilot: 'NOT_YET_RELEASED',
    Canceled: 'CANCELLED'
};

function get(ctx, path, credential, options) {
    const secret = credential && credential.secret ? String(credential.secret) : '';
    if (!secret) throw new SourceError('notoken', `${LABEL}: kein Schlüssel`);
    const headers = { Accept: 'application/json' };
    let url = BASE + path;
    if (HEX_KEY.test(secret)) url += `${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(secret)}`;
    else headers.Authorization = `Bearer ${secret}`;
    return requestJson(ctx, url, { headers }, { label: LABEL, ...options });
}

const day = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
const yearOfDay = (value) => (day(value) ? Number(value.slice(0, 4)) : null);
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);
const posterOf = (path) => (typeof path === 'string' && path.startsWith('/') ? POSTER_BASE + path : null);
const scoreOf = (item) => (item.vote_count > 0 && Number.isFinite(item.vote_average) ? Math.round(item.vote_average * 10) : null);
const pageUrl = (kind, id) => `https://www.themoviedb.org/${kind}/${id}`;
const imdbUrl = (imdbId) => (imdbId ? `https://www.imdb.com/title/${imdbId}/` : null);

/** Regular seasons (season_number ≥ 1) ascending: [{ season_number, episode_count, air_date }]. */
function seasonsOf(list) {
    return (Array.isArray(list) ? list : [])
        .filter((s) => s && Number.isInteger(s.season_number) && s.season_number >= 1)
        .map((s) => ({ season_number: s.season_number, episode_count: Number.isInteger(s.episode_count) ? s.episode_count : 0, air_date: day(s.air_date) }))
        .sort((a, b) => a.season_number - b.season_number);
}

/** Episodes of the seasons that started on or before `today` ('JJJJ-MM-TT'); null without any. */
function airedEpisodes(seasons, today) {
    const sum = seasons.filter((s) => s.air_date && s.air_date <= today).reduce((n, s) => n + s.episode_count, 0);
    return sum > 0 ? sum : null;
}

/** next_episode_to_air of a regular season as an absolute episode at 12:00 UTC of its air date (estimated), or null. */
function nextAiringOf(next, seasons) {
    if (!next || !day(next.air_date) || !Number.isInteger(next.episode_number)) return null;
    if (!seasons.some((s) => s.season_number === next.season_number)) return null;
    const before = seasons.filter((s) => s.season_number < next.season_number).reduce((n, s) => n + s.episode_count, 0);
    return { episode: before + next.episode_number, at: Math.floor(Date.parse(`${next.air_date}T12:00:00Z`) / 1000) };
}

function titleOf(english, native) {
    const title = { romaji: null, english: text(english), native: text(native) };
    title.preferred = preferredTitle(title);
    return title;
}

/** One search/multi item (movie or tv) -> AnimeMeta; null for anything else. */
function normalizeHit(item, nowMs) {
    if (!item || !KINDS.includes(item.media_type) || !Number.isInteger(item.id) || item.adult === true) return null;
    const kind = item.media_type;
    const start = day(kind === 'movie' ? item.release_date : item.first_air_date);
    return emptyMeta({
        kind,
        tmdb_id: item.id,
        tmdb_kind: kind,
        title: kind === 'movie' ? titleOf(item.title, item.original_title) : titleOf(item.name, item.original_name),
        format: kind === 'movie' ? 'MOVIE' : 'TV',
        episodes: kind === 'movie' ? 1 : null,
        season_year: yearOfDay(start),
        start_date: start,
        cover_url: posterOf(item.poster_path),
        score: scoreOf(item),
        description: text(item.overview),
        original_language: text(item.original_language),
        tmdb_genre_ids: Array.isArray(item.genre_ids) ? item.genre_ids.filter(Number.isInteger) : [],
        urls: { tmdb: pageUrl(kind, item.id) },
        source: 'tmdb',
        fetched_at: nowMs
    });
}

/** /3/movie/{id} or /3/tv/{id} with external_ids -> AnimeMeta. */
function normalizeDetail(kind, json, nowMs) {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const movie = kind === 'movie';
    const start = day(movie ? json.release_date : json.first_air_date);
    const seasons = movie ? [] : seasonsOf(json.seasons);
    const imdbId = text(movie ? json.imdb_id : json.external_ids && json.external_ids.imdb_id);
    const genres = Array.isArray(json.genres) ? json.genres.filter((g) => g && g.name) : [];
    const runTimes = Array.isArray(json.episode_run_time) ? json.episode_run_time : [];
    const next = movie ? null : nextAiringOf(json.next_episode_to_air, seasons);
    return emptyMeta({
        kind,
        tmdb_id: json.id,
        tmdb_kind: kind,
        imdb_id: imdbId,
        title: movie ? titleOf(json.title, json.original_title) : titleOf(json.name, json.original_name),
        format: movie ? 'MOVIE' : 'TV',
        episodes: movie ? 1 : airedEpisodes(seasons, today),
        duration: movie ? positive(json.runtime) : (positive(runTimes[0]) ?? positive(json.last_episode_to_air && json.last_episode_to_air.runtime) ?? null),
        status: (movie ? MOVIE_STATUS : TV_STATUS)[json.status] || null,
        season_year: yearOfDay(start),
        start_date: start,
        end_date: !movie && json.status === 'Ended' ? day(json.last_air_date) : null,
        cover_url: posterOf(json.poster_path),
        genres: genres.map((g) => g.name),
        score: scoreOf(json),
        description: text(json.overview),
        next_airing: next,
        next_airing_estimated: Boolean(next),
        original_language: text(json.original_language),
        spoken_languages: [...new Set((Array.isArray(json.spoken_languages) ? json.spoken_languages : []).map((l) => l && text(l.iso_639_1)).filter(Boolean))],
        seasons,
        tmdb_genre_ids: genres.map((g) => g.id).filter(Number.isInteger),
        urls: { tmdb: pageUrl(kind, json.id), imdb: imdbUrl(imdbId) },
        source: 'tmdb',
        fetched_at: nowMs
    });
}

/** search/multi in `language` (people dropped): { metas, rate }. */
async function search(ctx, term, { language = DETAIL_LANGUAGE, credential, timeoutMs, signal } = {}) {
    const path = `/search/multi?query=${encodeURIComponent(term)}&include_adult=false&language=${encodeURIComponent(language)}&page=1`;
    const { json } = await get(ctx, path, credential, { timeoutMs, signal });
    const nowMs = ctx.now().getTime();
    return { metas: (json && Array.isArray(json.results) ? json.results : []).map((item) => normalizeHit(item, nowMs)).filter(Boolean), rate: null };
}

/** Details of one film or TV show in en-US: { meta } (null when TMDb does not know it). */
async function byId(ctx, kind, id, { credential, timeoutMs, signal } = {}) {
    if (!KINDS.includes(kind) || !Number.isSafeInteger(Number(id))) return { meta: null, rate: null };
    try {
        const { json } = await get(ctx, `/${kind}/${Number(id)}?language=${DETAIL_LANGUAGE}&append_to_response=external_ids`, credential, { timeoutMs, signal });
        return { meta: json && Number.isInteger(json.id) ? normalizeDetail(kind, json, ctx.now().getTime()) : null, rate: null };
    } catch (err) {
        if (err.kind === 'notfound') return { meta: null, rate: null };
        throw err;
    }
}

/** Regular seasons of a TV show with their names in `language`: [{ season_number, episode_count, name }] ([] when unknown). */
async function seasonList(ctx, id, { language = DETAIL_LANGUAGE, credential, timeoutMs, signal } = {}) {
    if (!Number.isSafeInteger(Number(id))) return [];
    try {
        const { json } = await get(ctx, `/tv/${Number(id)}?language=${encodeURIComponent(language)}`, credential, { timeoutMs, signal });
        const names = {};
        for (const s of json && Array.isArray(json.seasons) ? json.seasons : []) if (s && Number.isInteger(s.season_number)) names[s.season_number] = text(s.name);
        return seasonsOf(json && json.seasons).map((s) => ({ season_number: s.season_number, episode_count: s.episode_count, name: names[s.season_number] || null }));
    } catch (err) {
        if (err.kind === 'notfound') return [];
        throw err;
    }
}

/** Check of a key or read token: resolves { label } on 200, rejects with a SourceError (auth for a refused key). */
async function check(ctx, secret, { timeoutMs, signal } = {}) {
    await get(ctx, '/authentication', { secret }, { timeoutMs, signal });
    return { label: `Schlüssel …${String(secret).slice(-4)}` };
}

module.exports = { search, byId, seasonList, check, normalizeHit, normalizeDetail, BASE, LABEL, POSTER_BASE, KINDS };
