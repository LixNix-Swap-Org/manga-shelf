// The one list of the core endpoints (paths below /api): the server mounts it into Express, the apps call it via dispatch().
// Row: { method, path, role, handler(ctx, input) -> { status?, body, headers? }, parse?, conditional?, limit? }
// role: public | auth | editor (not visitor/guest) | admin; conditional: ETag/304 for reads; limit: per-account budget.
const mangas = require('./handlers/mangas');
const snapshot = require('./handlers/snapshot');
const volumes = require('./handlers/volumes');
const owners = require('./handlers/owners');
const reads = require('./handlers/reads');
const stats = require('./handlers/stats');
const settings = require('./handlers/settings');
const shopping = require('./handlers/shopping');
const radar = require('./handlers/radar');
const mangaPassion = require('./handlers/mangaPassion');
const lookup = require('./handlers/lookup');
const csv = require('./handlers/csv');
const anime = require('./handlers/anime');
const watch = require('./handlers/watch');
const trash = require('./handlers/trash');
const publishers = require('./handlers/publishers');
const cleanup = require('./handlers/cleanup');
const { guidesHandler } = require('./sources/guides');
const { listVolumeSearch } = require('./snapshot');
const { HttpError, AUTH_TEXTS } = require('./errors');

const routes = [
    { method: 'GET', path: '/mangas', role: 'auth', conditional: true, handler: mangas.list },
    { method: 'POST', path: '/mangas', role: 'editor', handler: mangas.create },
    // before /mangas/:id; the list leaves the search text out, the dashboard loads it on demand
    { method: 'GET', path: '/mangas/volume-search', role: 'auth', conditional: true, handler: (ctx) => ({ body: listVolumeSearch(ctx) }) },
    { method: 'GET', path: '/mangas/:id', role: 'auth', conditional: true, handler: mangas.detail },
    // the 30 MB copy never lands in the HTTP cache; the client sends If-None-Match by hand
    { method: 'GET', path: '/offline-snapshot', role: 'auth', conditional: { cacheControl: 'private, no-store' }, handler: snapshot.offlineSnapshot },
    { method: 'PUT', path: '/mangas/:id', role: 'editor', handler: mangas.update },
    { method: 'DELETE', path: '/mangas/:id', role: 'editor', handler: mangas.remove },
    { method: 'POST', path: '/mangas/:id/editions', role: 'editor', handler: mangas.createEdition },
    { method: 'PUT', path: '/mangas/:id/work', role: 'editor', handler: mangas.linkWork },
    { method: 'GET', path: '/mangas/:id/gaps', role: 'auth', handler: mangaPassion.gaps },
    { method: 'POST', path: '/mangas/:id/sync-edition', role: 'editor', handler: mangaPassion.syncEdition },
    { method: 'POST', path: '/mangas/:id/batch-import-gaps', role: 'editor', handler: mangaPassion.batchImportGaps },
    { method: 'POST', path: '/mangas/:id/autofill-volumes', role: 'editor', handler: mangaPassion.autofillVolumes },

    { method: 'POST', path: '/volumes', role: 'editor', handler: volumes.create },
    { method: 'POST', path: '/volumes/batch', role: 'editor', handler: volumes.createBatch },
    { method: 'POST', path: '/volumes/bulk', role: 'editor', handler: volumes.bulk },
    { method: 'PUT', path: '/volumes/:id', role: 'editor', handler: volumes.update },
    { method: 'DELETE', path: '/volumes/:id', role: 'editor', handler: volumes.remove },
    { method: 'POST', path: '/volumes/:id/owners', role: 'editor', handler: owners.toggleOwner },
    { method: 'POST', path: '/volumes/:id/read', role: 'editor', handler: reads.toggleRead },
    { method: 'POST', path: '/volumes/batch-read', role: 'editor', handler: reads.batchRead },
    { method: 'GET', path: '/volumes/lookup', role: 'editor', limit: 'lookup', handler: mangaPassion.volumeLookup },

    { method: 'GET', path: '/stats', role: 'auth', conditional: true, handler: stats.stats },
    { method: 'PUT', path: '/stats/settings', role: 'admin', handler: (ctx, input) => stats.clearStartDate(ctx, input) || settings.updateSettings(ctx, input) },
    { method: 'GET', path: '/users/:id/stats', role: 'auth', handler: reads.userStats },
    { method: 'GET', path: '/stats/reading', role: 'auth', handler: stats.reading },

    { method: 'GET', path: '/tags', role: 'auth', handler: mangas.tags },
    { method: 'GET', path: '/trash', role: 'auth', handler: trash.list },
    { method: 'POST', path: '/trash/:id/restore', role: 'editor', handler: trash.restore },
    { method: 'DELETE', path: '/trash/:id', role: 'editor', handler: trash.remove },
    { method: 'DELETE', path: '/trash', role: 'admin', handler: trash.empty },
    { method: 'GET', path: '/publishers', role: 'auth', handler: publishers.list },
    { method: 'POST', path: '/publishers/merge', role: 'admin', handler: publishers.merge },
    { method: 'DELETE', path: '/publishers/aliases/:alias', role: 'admin', handler: publishers.removeAlias },
    { method: 'GET', path: '/maintenance/quality', role: 'auth', handler: cleanup.quality },
    { method: 'POST', path: '/maintenance/fix', role: 'editor', handler: cleanup.fix },

    { method: 'GET', path: '/shopping-list', role: 'auth', conditional: true, handler: shopping.shoppingList },
    { method: 'GET', path: '/release-radar', role: 'auth', conditional: true, handler: radar.releaseRadar },
    { method: 'GET', path: '/dashboard-summary', role: 'auth', conditional: true, handler: radar.dashboardSummary },
    { method: 'GET', path: '/release-radar/changes', role: 'auth', handler: radar.dateChanges },
    // calendar apps send no session: the per-user feed token in the query is the credential
    { method: 'GET', path: '/radar/feed.ics', role: 'public', handler: radar.calendarFeed },
    { method: 'GET', path: '/manga-passion/releases', role: 'auth', handler: mangaPassion.monthlyReleases },
    { method: 'POST', path: '/manga-passion/import', role: 'editor', handler: mangaPassion.importRelease },
    { method: 'GET', path: '/manga-passion/editions', role: 'auth', limit: 'lookup', handler: mangaPassion.editions },

    { method: 'GET', path: '/lookup/manga', role: 'auth', limit: 'lookup', handler: lookup.lookupManga },
    { method: 'POST', path: '/upload-remote', role: 'editor', limit: 'remoteImage', handler: lookup.uploadRemote },
    { method: 'GET', path: '/lookup/isbn', role: 'auth', handler: lookup.lookupIsbn },

    { method: 'GET', path: '/export/csv', role: 'auth', handler: csv.exportCsv },
    { method: 'POST', path: '/import/csv', role: 'editor', handler: csv.importCsv },

    { method: 'GET', path: '/anime/search', role: 'auth', limit: 'lookup', handler: anime.search },
    { method: 'GET', path: '/anime/sources', role: 'auth', handler: anime.sources },
    { method: 'GET', path: '/anime', role: 'auth', handler: anime.list },
    { method: 'POST', path: '/anime', role: 'editor', handler: anime.create },
    // before /anime/:id; the page fetch inside counts against 'lookup' only when it happens
    { method: 'POST', path: '/anime/resolve-link', role: 'editor', handler: anime.resolveLink },
    // results the app read from the user's streaming history on the device; never cookies or tokens
    { method: 'POST', path: '/anime/watch-sync', role: 'editor', handler: watch.sync },
    { method: 'POST', path: '/anime/watch-sync/undo', role: 'editor', handler: watch.undo },
    { method: 'GET', path: '/anime/sync', role: 'editor', handler: anime.syncState },
    { method: 'PUT', path: '/anime/sync', role: 'editor', handler: anime.syncUpdate },
    { method: 'POST', path: '/anime/sync/run', role: 'editor', handler: anime.syncRun },
    { method: 'GET', path: '/anime/:id', role: 'auth', handler: anime.detail },
    { method: 'PUT', path: '/anime/:id', role: 'editor', handler: anime.update },
    { method: 'DELETE', path: '/anime/:id', role: 'editor', handler: anime.remove },
    { method: 'PUT', path: '/anime/:id/progress', role: 'editor', handler: anime.updateProgress },
    { method: 'POST', path: '/anime/:id/watched', role: 'editor', handler: anime.markWatched },
    { method: 'DELETE', path: '/anime/:id/progress', role: 'editor', handler: anime.removeProgress },
    { method: 'POST', path: '/anime/:id/refresh', role: 'editor', handler: anime.refresh },
    { method: 'GET', path: '/mangas/:id/adaptations', role: 'auth', limit: 'lookup', handler: anime.adaptations },
    { method: 'GET', path: '/export/anime.csv', role: 'auth', handler: anime.exportCsv },
    { method: 'GET', path: '/sources/guides', role: 'auth', handler: guidesHandler }
];

const defaultParse = ({ params, query, body }) => ({ params: params || {}, query: query || {}, body: body || {} });

const ROLES = ['public', 'auth', 'editor', 'admin'];

/** null when `user` may call a row of `role`, else the HttpError the server's auth middleware answers with. */
function roleError(role, user) {
    if (role === 'public') return null;
    if (!user) return new HttpError(401, AUTH_TEXTS.AUTH_REQUIRED, 'AUTH_REQUIRED');
    if (role === 'admin' && user.role !== 'admin') return new HttpError(403, AUTH_TEXTS.FORBIDDEN, 'FORBIDDEN');
    if (role === 'editor' && (user.role === 'visitor' || user.role === 'guest')) return new HttpError(403, AUTH_TEXTS.READ_ONLY, 'READ_ONLY');
    return null;
}

const compiled = routes.map(row => {
    const names = [];
    const pattern = row.path.replace(/:([A-Za-z_]+)/g, (_, name) => {
        names.push(name);
        return '([^/]+)';
    });
    return { row, names, re: new RegExp(`^${pattern}/?$`, 'i') };
});

/** The row and path parameters for a request below /api ("/mangas/7"), or null. */
function matchRoute(method, path) {
    const m = String(method).toUpperCase();
    const wanted = m === 'HEAD' ? 'GET' : m;
    for (const { row, names, re } of compiled) {
        if (row.method !== wanted) continue;
        const hit = re.exec(path);
        if (!hit) continue;
        const params = {};
        names.forEach((name, i) => { params[name] = decodeURIComponent(hit[i + 1]); });
        return { row, params };
    }
    return null;
}

/** Query string ("?a=1&a=2") as Express' simple parser reads it: repeated keys become arrays. */
function parseQuery(search) {
    const query = {};
    for (const [key, value] of new URLSearchParams(String(search || '').replace(/^\?/, ''))) {
        if (!Object.prototype.hasOwnProperty.call(query, key)) query[key] = value;
        else query[key] = [].concat(query[key], value);
    }
    return query;
}

/**
 * In-process call of a core endpoint with the caller in ctx.user: { method, url: '/mangas/7?x=1', body }.
 * Resolves with { status, body, headers }; rejects with an HttpError (404 for an unknown path, 401/403 by role).
 */
async function dispatch(ctx, { method, url, body }) {
    const [path, search = ''] = String(url).split('?');
    const match = matchRoute(method, path);
    if (!match) throw new HttpError(404, 'Nicht gefunden', 'NOT_FOUND');
    const denied = roleError(match.row.role, ctx.user);
    if (denied) throw denied;
    if (match.row.limit) await ctx.limit(match.row.limit);
    const input = (match.row.parse || defaultParse)({ params: match.params, query: parseQuery(search), body: body ?? {} });
    const result = await match.row.handler(ctx, input);
    return { status: result.status || 200, body: result.body, headers: result.headers || {} };
}

module.exports = { routes, ROLES, roleError, defaultParse, matchRoute, parseQuery, dispatch };
