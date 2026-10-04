// Crunchyroll watch history in the apps: endpoint table, request building and answer parsing for the device-side sync
// (transport and secret storage stay in the app shell), plus the item rules the watch-sync handler checks again.
// Unofficial interface: every shape here may change without notice, so a break stays local to this table.
const links = require('./links');

const BASE = 'https://www.crunchyroll.com';
// the app sends at most page_size 100 from each of the two history calls
const MAX_ITEMS = 200;
const MAX_EPISODE = 100000;
const MAX_SEASON = 99;
const MAX_TITLE = 200;
// an episode stopped in the credits counts as seen
const SEEN_SHARE = 0.9;

const CLIENT_ID_SCRIPT = '(function () { try { var c = window.__APP_CONFIG__ && window.__APP_CONFIG__.cxApiParams;'
    + ' return JSON.stringify({ accountAuthClientId: (c && c.accountAuthClientId) || null, anonClientId: (c && c.anonClientId) || null });'
    + ' } catch (e) { return null; } })()';

const ENDPOINTS = {
    hosts: ['www.crunchyroll.com', 'beta-api.crunchyroll.com'],
    login: { url: `${BASE}/de/login`, cookieDomain: 'crunchyroll.com', cookieName: 'etp_rt', doneWhen: { pathNotContaining: '/login' } },
    token: `${BASE}/auth/v1/token`,
    me: `${BASE}/accounts/v1/me`,
    pageSize: 100,
    locale: 'de-DE',
    watchHistory: (accountId, { pageSize = 100, locale = 'de-DE' } = {}) =>
        `${BASE}/content/v2/${encodeURIComponent(accountId)}/watch-history?page_size=${pageSize}&locale=${encodeURIComponent(locale)}`,
    discoverHistory: (accountId, { pageSize = 100, locale = 'de-DE' } = {}) =>
        `${BASE}/content/v2/discover/${encodeURIComponent(accountId)}/history?n=${pageSize}&locale=${encodeURIComponent(locale)}`,
    // used only when the login page did not reveal the current id; it rotates, hence the date it was last seen
    clientIdFallback: { id: 'noaihdevm_6iyg0a8l0q', date: '2026-10-04' },
    deviceType: 'Manga Shelf App'
};

const LOGIN_OPTIONS = { ...ENDPOINTS.login, readScript: CLIENT_ID_SCRIPT };

const MESSAGES = {
    reconnect: 'Bitte erneut verbinden',
    blocked: 'Crunchyroll blockiert den Abruf gerade',
    rate_limited: 'Crunchyroll bremst gerade, später erneut',
    unavailable: 'Crunchyroll ist gerade nicht erreichbar',
    bad_response: 'Crunchyroll antwortet unerwartet'
};

const failure = (error) => ({ ok: false, error, clear_secret: error === 'reconnect', message: MESSAGES[error] });

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64(text) {
    const bytes = new TextEncoder().encode(text);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
        out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
}

const isText = (value, re) => typeof value === 'string' && re.test(value);
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const COOKIE_RE = /^[A-Za-z0-9._~+/=%-]{8,4096}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const ACCOUNT_RE = /^[A-Za-z0-9-]{1,64}$/;

function parseJson(text) {
    if (text && typeof text === 'object') return text;
    if (typeof text !== 'string' || !text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
}

/** The web client id the login page exposes (readScript answer), or null. */
function clientIdFrom(scriptResult) {
    const value = parseJson(scriptResult);
    if (!value || typeof value !== 'object') return null;
    for (const id of [value.accountAuthClientId, value.anonClientId]) if (isText(id, CLIENT_ID_RE)) return id;
    return null;
}

/** The secret to keep in secure storage after WebLogin.open; null without a usable cookie. */
function secretFromLogin(result, { deviceId, now } = {}) {
    const cookie = result && result.cookie && result.cookie.value;
    if (!isText(cookie, COOKIE_RE)) return null;
    return {
        etp_rt: cookie,
        client_id: clientIdFrom(result.scriptResult) || ENDPOINTS.clientIdFallback.id,
        device_id: isText(deviceId, DEVICE_ID_RE) ? deviceId : null,
        account_id: null,
        saved_at: Number.isFinite(now) ? now : null
    };
}

/** A stored secret (JSON text or object) checked field by field; null when unusable. */
function parseSecret(raw) {
    const s = parseJson(raw);
    if (!s || typeof s !== 'object' || !isText(s.etp_rt, COOKIE_RE) || !isText(s.client_id, CLIENT_ID_RE)) return null;
    return {
        etp_rt: s.etp_rt,
        client_id: s.client_id,
        device_id: isText(s.device_id, DEVICE_ID_RE) ? s.device_id : null,
        account_id: isText(s.account_id, ACCOUNT_RE) ? s.account_id : null,
        saved_at: Number.isFinite(s.saved_at) ? s.saved_at : null
    };
}

const serializeSecret = (secret) => JSON.stringify(parseSecret(secret));

/** POST /auth/v1/token with the cookie grant the website uses (Basic client id, form body, the cookie by hand). */
function buildTokenRequest(secret) {
    const form = new URLSearchParams({ grant_type: 'etp_rt_cookie' });
    if (secret.device_id) {
        form.set('device_id', secret.device_id);
        form.set('device_type', ENDPOINTS.deviceType);
    }
    return {
        url: ENDPOINTS.token,
        method: 'POST',
        headers: {
            Authorization: `Basic ${base64(`${secret.client_id}:`)}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Cookie: `etp_rt=${secret.etp_rt}`
        },
        body: form.toString()
    };
}

function headerValues(headers, name) {
    if (!headers || typeof headers !== 'object') return [];
    const out = [];
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== name) continue;
        const value = headers[key];
        for (const v of Array.isArray(value) ? value : [value]) if (typeof v === 'string') out.push(v);
    }
    return out;
}

/** A new etp_rt (the token call may rotate it): the platform's parsed cookies first, else the Set-Cookie header; or null. */
function rotatedEtpRt(headers, cookies) {
    for (const c of Array.isArray(cookies) ? cookies : []) {
        if (c && c.name === 'etp_rt' && isText(c.value, COOKIE_RE)) return c.value;
    }
    for (const value of headerValues(headers, 'set-cookie')) {
        const m = /(?:^|[,;]\s*)etp_rt=([^;,\s]*)/.exec(value);
        if (m && isText(m[1], COOKIE_RE)) return m[1];
    }
    return null;
}

/** Status classes shared by every call; null means "look at the body". */
function statusFailure(status, json) {
    if (!Number.isInteger(status) || status === 0 || status >= 500) return failure('unavailable');
    if (status === 401) return failure('reconnect');
    if (status === 403) return failure('blocked');
    if (status === 429) return failure('rate_limited');
    if (status === 400 && json && ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token'].includes(json.error)) return failure('reconnect');
    if (status < 200 || status >= 300) return failure('bad_response');
    return null;
}

/** Answer of the token call: { ok, access_token, account_id, etp_rt (rotated or null) } or a failure. */
function parseTokenResponse(response) {
    const res = response || {};
    const json = parseJson(res.text);
    const failed = statusFailure(res.status, json);
    if (failed) return failed;
    if (!json || typeof json.access_token !== 'string' || !json.access_token) return failure('bad_response');
    return {
        ok: true,
        access_token: json.access_token,
        account_id: isText(json.account_id, ACCOUNT_RE) ? json.account_id : null,
        etp_rt: rotatedEtpRt(res.headers, res.cookies)
    };
}

const isAllowedApiUrl = (raw) => {
    if (typeof raw !== 'string' || raw.length > links.MAX_URL) return false;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && ENDPOINTS.hosts.includes(url.hostname);
    } catch (_) {
        return false;
    }
};

const buildApiRequest = (url, accessToken) => ({
    url, method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
});

/** Answer of /accounts/v1/me: { ok, account_id } or a failure. */
function parseMe(response) {
    const res = response || {};
    const json = parseJson(res.text);
    const failed = statusFailure(res.status, json);
    if (failed) return failed;
    return json && isText(json.account_id, ACCOUNT_RE) ? { ok: true, account_id: json.account_id } : failure('bad_response');
}

function cleanTitle(value) {
    if (typeof value !== 'string') return null;
    const t = value.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, MAX_TITLE) : null;
}

const intIn = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : null);

function isoOrNull(value) {
    if (typeof value !== 'string' || value.length > 40) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A canonical episode link or null (only /watch/ links of an allowlisted host). */
function episodeUrl(raw) {
    const link = typeof raw === 'string' ? links.linkOf(raw) : null;
    return link && link.kind === 'episode' ? link.url : null;
}

/**
 * One sync item checked and normalised, or null when the series id or episode is unusable. The handler runs every
 * incoming item through this, so the device and the core never disagree about what is valid.
 */
function cleanItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const externalId = isText(raw.external_id, /^[A-Za-z0-9]{6,20}$/) ? raw.external_id.toUpperCase() : null;
    const episode = intIn(raw.episode, 1, MAX_EPISODE);
    if (!externalId || !episode) return null;
    if (raw.season !== undefined && raw.season !== null && intIn(raw.season, 1, MAX_SEASON) === null) return null;
    if (raw.fully_watched !== undefined && typeof raw.fully_watched !== 'boolean') return null;
    const fully = raw.fully_watched === true;
    const resumeUrl = episodeUrl(raw.resume_url);
    const resumeEpisode = resumeUrl ? (intIn(raw.resume_episode, 1, MAX_EPISODE) || (fully ? episode + 1 : episode)) : null;
    return {
        external_id: externalId,
        series_title: cleanTitle(raw.series_title),
        season: intIn(raw.season, 1, MAX_SEASON) || 1,
        episode,
        fully_watched: fully,
        resume_url: resumeUrl,
        resume_episode: resumeEpisode,
        watched_at: isoOrNull(raw.watched_at)
    };
}

/** Episodes an item stands for: the fully watched one, else the one before it. */
const watchedCount = (item) => (item.fully_watched ? item.episode : item.episode - 1);

/** One history record (an entry with `panel`, or a bare panel) as an item; specials, movies and odd shapes give null. */
function recordOf(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const panel = entry.panel && typeof entry.panel === 'object' ? entry.panel : entry;
    if (panel.type && panel.type !== 'episode') return null;
    const meta = panel.episode_metadata;
    if (!meta || typeof meta !== 'object') return null;
    const number = Number.isInteger(meta.episode_number) ? meta.episode_number
        : (isText(meta.episode, /^\d{1,5}$/) ? Number(meta.episode) : null);
    const durationMs = Number.isFinite(meta.duration_ms) ? meta.duration_ms : 0;
    const playhead = Number.isFinite(entry.playhead) ? entry.playhead : 0;
    const fully = entry.fully_watched === true || (durationMs > 0 && playhead * 1000 >= durationMs * SEEN_SHARE);
    const url = isText(panel.id, /^[A-Za-z0-9]{6,20}$/)
        ? episodeUrl(`${BASE}/watch/${panel.id}${isText(panel.slug_title, /^[a-z0-9-]{1,200}$/i) ? `/${panel.slug_title}` : ''}`)
        : null;
    return cleanItem({
        external_id: meta.series_id,
        series_title: meta.series_title,
        season: intIn(meta.season_number, 1, MAX_SEASON) || 1,
        episode: number,
        fully_watched: fully,
        resume_url: fully ? null : url,
        resume_episode: fully ? null : number,
        watched_at: entry.date_played || null
    });
}

const historyData = (json) => {
    const value = parseJson(json);
    if (Array.isArray(value)) return value;
    return value && Array.isArray(value.data) ? value.data : null;
};

const parseHistory = (json) => mergeItems((historyData(json) || []).map(recordOf));

/** /content/v2/{account}/watch-history: the highest episode per series and season. */
const parseWatchHistory = parseHistory;

/** /content/v2/discover/{account}/history ("continue watching"): the in-progress or next episode per series. */
const parseDiscoverHistory = parseHistory;

const later = (a, b) => (a && (!b || a > b) ? a : b);

/** Items of several lists folded to one per series and season: the most episodes win, then a resume link, then the newest. */
function mergeItems(...lists) {
    const groups = new Map();
    for (const raw of [].concat(...lists.map((l) => (Array.isArray(l) ? l : [])))) {
        const item = cleanItem(raw);
        if (!item) continue;
        const key = `${item.external_id}|${item.season}`;
        const best = groups.get(key);
        if (!best) {
            groups.set(key, item);
            continue;
        }
        const newest = later(item.watched_at, best.watched_at);
        const better = watchedCount(item) - watchedCount(best) || Number(Boolean(item.resume_url)) - Number(Boolean(best.resume_url))
            || (item.watched_at && item.watched_at === newest && item.watched_at !== best.watched_at ? 1 : 0);
        const winner = better > 0 ? item : best;
        groups.set(key, { ...winner, series_title: winner.series_title || item.series_title || best.series_title, watched_at: newest });
    }
    return [...groups.values()].sort((a, b) => (b.watched_at || '').localeCompare(a.watched_at || '')
        || a.external_id.localeCompare(b.external_id) || a.season - b.season);
}

/** Answer of a history call: { ok, items } or a failure. */
function parseHistoryResponse(response) {
    const res = response || {};
    const json = parseJson(res.text);
    const failed = statusFailure(res.status, json);
    if (failed) return failed;
    if (!historyData(json)) return failure('bad_response');
    return { ok: true, items: parseHistory(json) };
}

const syncBody = (items) => ({ service: 'crunchyroll', items: mergeItems(items).slice(0, MAX_ITEMS) });

// What one entry gets from its items: never backwards, at most the known total (more -> above_total, nothing written), resume
// link only when it shows the next episode. `existing`: { episodes, episodes_watched, resume_url } of the caller (0 without a row).
// Returns { change } | { above_total: true } | null (nothing to do).
function planProgress(items, existing) {
    const current = existing || {};
    const total = current.episodes > 0 ? current.episodes : null;
    const have = Number.isInteger(current.episodes_watched) ? current.episodes_watched : 0;
    let best = null;
    for (const item of items) {
        const count = watchedCount(item);
        if (count < 1) continue;
        if (!best || count > best.count || (count === best.count && item.resume_url && !best.item.resume_url)) best = { item, count };
    }
    if (!best) return null;
    // an entry already at its total (e.g. confirmed as complete) stays as it is
    if (total !== null && best.count > total) return have >= total ? null : { above_total: true, count: best.count };
    if (best.count < have) return null;
    const { item, count } = best;
    const resumeFits = item.resume_url && item.resume_episode === count + 1 && (total === null || item.resume_episode <= total);
    const resumeUrl = resumeFits ? item.resume_url : null;
    if (count === have && (!resumeUrl || resumeUrl === current.resume_url)) return null;
    return { change: { episodes_watched: count, resume_url: resumeUrl, resume_episode: resumeFits ? item.resume_episode : null } };
}

const ORDINALS = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, zweite: 2, dritte: 3, vierte: 4, 'fünfte': 5 };
const SEASON_RES = [
    /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i, /\bseason\s+(\d{1,2})\b/i, /\b(\d{1,2})\.\s*staffel\b/i, /\bstaffel\s+(\d{1,2})\b/i,
    /(?:^|\s)(second|third|fourth|fifth|sixth)\s+season\b/i, /(?:^|\s)(zweite|dritte|vierte|fünfte)\s+staffel\b/i
];

/** Season number an entry's titles name ('2nd Season', 'Season 2', '2. Staffel', 'Second Season'), or null without one. */
function seasonMarkerOf(titles) {
    for (const title of titles) {
        for (const re of SEASON_RES) {
            const m = re.exec(String(title || ''));
            if (!m) continue;
            const n = ORDINALS[m[1].toLowerCase()] || Number(m[1]);
            if (n >= 1 && n <= MAX_SEASON) return n;
        }
    }
    return null;
}

/** Season number an entry's titles name; 1 without one. */
const seasonFromTitles = (titles) => seasonMarkerOf(titles) || 1;

/**
 * anime_links row for one season of a series. Each season has its own service name, so one entry can hold several
 * seasons (UNIQUE per entry and service) and the series link stays as it is.
 */
const seasonServiceOf = (serviceId, season) => `${serviceId}:season:${season}`;
const seasonLinkOf = (serviceId, seriesId, season) => ({ service: seasonServiceOf(serviceId, season), external_id: `${String(seriesId).toUpperCase()}:${season}` });

module.exports = {
    ENDPOINTS, LOGIN_OPTIONS, CLIENT_ID_SCRIPT, MESSAGES, MAX_ITEMS, MAX_SEASON, clientIdFrom, secretFromLogin, parseSecret, serializeSecret,
    buildTokenRequest, parseTokenResponse, rotatedEtpRt, isAllowedApiUrl, buildApiRequest, parseMe, parseHistoryResponse, parseWatchHistory,
    parseDiscoverHistory, mergeItems, cleanItem, watchedCount, syncBody, planProgress, seasonMarkerOf, seasonFromTitles, seasonServiceOf, seasonLinkOf, base64
};
