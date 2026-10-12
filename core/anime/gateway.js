// Anime metadata gateway: AniList, MyAnimeList (official API with a client id,
// Jikan without) and TMDb (films and TV shows, key only) behind one budget, one queue and one cache. Personal keys go first for their owner, then the shared
// pool; a paused or broken source is replaced by the other one, then by the cache.
const { HttpError, msg } = require('../errors');
const { credentialsOf } = require('../sources/credentials');
const { settings } = require('./settings');
const { createBudget } = require('./budget');
const {
    acquire, createCoalescer, createBatcher, createGrouper, createUserLimiter, createBackgroundQueue, INTERACTIVE_WAIT_MS, BATCH_WAIT_MS
} = require('./queue');
const { SourceError, requestJson } = require('./request');
const cache = require('./cache');
const anilist = require('./anilist');
const jikan = require('./jikan');
const mal = require('./mal');
const tmdb = require('./tmdb');
const store = require('./store');
const { foldUmlauts, searchKey, rankByTitle, mergeResults, mergeMeta, titleScore, allTitles, foldTmdbHits, isTmdbAnime, yearOf, tmdbTwinScore } = require('./normalize');
const { seasonsFromCounts } = require('./episodes');

const MANUAL_REFRESH_MS = 60 * 1000;
// once one source answered, the other gets this long before the answer goes out without it
const SECOND_SOURCE_GRACE_MS = 2500;
const SEARCH_GRACE_MS = 400;
const SEARCH_TIMEOUT_MS = 5000;
const SEARCH_SOURCES = ['anilist', 'mal', 'tmdb'];
const KIND_SOURCES = { anime: ['anilist', 'mal'], tv: ['tmdb'], movie: ['tmdb'], all: SEARCH_SOURCES };
const TMDB_LANGUAGES = {
    de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', 'pt-BR': 'pt-BR', nl: 'nl-NL', pl: 'pl-PL', ja: 'ja-JP', ko: 'ko-KR',
    'zh-Hans': 'zh-CN', ru: 'ru-RU', tr: 'tr-TR'
};
const SEARCH_GROUP_MAX = 3;
const SOURCE_LABELS = { anilist: 'AniList', mal: 'MyAnimeList', jikan: 'MyAnimeList (Jikan)', tmdb: 'TMDB' };
// a personal key is disabled after its second refused-looking answer within this window that the pool answered properly
const SUSPECT_WINDOW_MS = 10 * 60 * 1000;
const OWN_BACKGROUND_WAIT_MS = 60 * 1000;

let state = null;

function freshState() {
    return {
        budget: createBudget({ onChange: (key, event, info) => logChange(key, event, info) }),
        coalescer: createCoalescer(),
        users: createUserLimiter(),
        background: createBackgroundQueue({
            onDrop: (n) => logger().warn(`Anime background queue full (${n} waiting): new jobs are dropped`),
            onError: (key, err) => logger().warn(`Anime background job ${key} failed:`, err && err.message)
        }),
        groupSize: SEARCH_GROUP_MAX,
        groupers: new Map(),
        batchers: new Map(),
        manualRefresh: new Map(),
        ownTmdbRefresh: new Map(),
        suspects: new Map(),
        refreshIds: new Set(),
        refreshOpen: null,
        refreshSeq: 0,
        log: null,
        hostCtx: null
    };
}

/** Forgets budgets, waiting jobs and refresh locks (tests; a restore keeps them on purpose). */
function resetGatewayState() {
    if (state) {
        state.background.clear();
        if (state.refreshOpen) clearTimeout(state.refreshOpen.timer);
        if (state.listSync) for (const timer of state.listSync.pushTimers.values()) clearTimeout(timer);
    }
    state = freshState();
}

function S() {
    if (!state) state = freshState();
    return state;
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const logger = () => (state && state.log) || silent;

function logChange(key, event, info) {
    const provider = key.split(':').pop();
    const who = key.startsWith('user:') ? `persönlicher Zugang (Benutzer ${key.split(':')[1]})` : 'gemeinsamer Pool';
    const name = SOURCE_LABELS[provider] || provider;
    if (event === 'paused') logger().info(`${name}: ${who} pausiert bis ${new Date(info.until).toISOString()}`);
    else if (event === 'resumed') logger().info(`${name}: ${who} wieder aktiv`);
    else if (event === 'open') logger().info(`${name}: ${who} nach wiederholten Fehlern vorübergehend abgeschaltet`);
    else if (event === 'closed') logger().info(`${name}: ${who} antwortet wieder`);
}

function remember(ctx) {
    const s = S();
    if (!s.log) s.log = ctx.log.child('anime');
    // background work outlives the request: no caller, no abort signal
    s.hostCtx = { ...ctx, user: null, signal: undefined, limit: () => {} };
    return s;
}

const nowMs = (ctx) => ctx.now().getTime();

function bucketOptions(ctx, provider) {
    const cfg = settings(ctx);
    if (provider === 'anilist') return { perMinute: cfg.anilistRpm };
    if (provider === 'jikan') return { perMinute: cfg.jikanRpm, burst: { size: 3, perMs: 1000 } };
    if (provider === 'tmdb') return { perMinute: cfg.tmdbRpm };
    return { perMinute: 60 };
}

/** 'mal' (official API) when a personal or instance client id exists, else 'jikan'. */
function malSide(ctx, userId, priority = 'interactive') {
    const creds = credentialsOf(ctx);
    if (creds.instance('mal')) return 'mal';
    if (priority === 'interactive' && userId && creds.get(userId, 'mal')) return 'mal';
    return 'jikan';
}

/**
 * The accesses a request may use, in order: personal key (interactive), shared pool, volunteers (background). ownOnly
 * (the user's own AniList list): the personal key alone, at any priority.
 */
function accessesFor(ctx, provider, { userId, priority, ownOnly = false }) {
    const creds = credentialsOf(ctx);
    const out = [];
    const credProvider = provider === 'jikan' ? null : provider;
    if (ownOnly) {
        const own = credProvider && userId ? creds.get(userId, credProvider) : null;
        return own && own.secret ? [{ bucket: `user:${userId}:${provider}`, credential: own, kind: 'own', userId }] : [];
    }
    if (credProvider && priority === 'interactive' && userId) {
        const own = creds.get(userId, credProvider);
        if (own && own.secret) out.push({ bucket: `user:${userId}:${provider}`, credential: own, kind: 'own', userId });
    }
    if (provider === 'mal' || provider === 'tmdb') {
        const inst = creds.instance(provider);
        if (inst && inst.secret) out.push({ bucket: `shared:${provider}`, credential: inst, kind: 'shared' });
    } else {
        out.push({ bucket: `shared:${provider}`, credential: null, kind: 'shared' });
    }
    if (credProvider && priority !== 'interactive') {
        const volunteers = creds.background(credProvider) || [];
        const s = S();
        s.rotation = (s.rotation || 0) + 1;
        for (let i = 0; i < volunteers.length; i++) {
            const v = volunteers[(i + s.rotation) % volunteers.length];
            if (v && v.secret) out.push({ bucket: `user:${v.userId}:${provider}`, credential: { secret: v.secret }, kind: 'volunteer', userId: v.userId });
        }
    }
    return out;
}

// an HTTP 400/401/403 that carries a GraphQL error body; an empty or non-JSON 2xx answer is a glitch, not the key
const refusedLike = (err) => err.kind === 'bad' && [400, 401, 403].includes(err.status) && err.graphql === true;

const unavailable = (provider, reason = 'unavailable') => new SourceError(reason, `${SOURCE_LABELS[provider] || provider} ist gerade nicht verfügbar`);
const aborted = (provider) => new SourceError('network', `${SOURCE_LABELS[provider] || provider}: Anfrage abgebrochen`, { aborted: true });
const isAborted = (err, signal) => Boolean((err && err.aborted) || (signal && signal.aborted));

function spareAccesses(ctx, provider, userId) {
    const s = S();
    const own = userId ? credentialsOf(ctx).get(userId, provider) : null;
    const list = [];
    if (own && own.secret) list.push({ bucket: `user:${userId}:${provider}`, credential: own, kind: 'own', userId });
    list.push({ bucket: `shared:${provider}`, credential: null, kind: 'shared' });
    return list.filter((access) => {
        const state = s.budget.state(access.bucket, nowMs(ctx));
        return !state || state.circuit === 'closed';
    });
}

// One source request through budget and accesses. exec(credential) does the request and may resolve with `rate` (headers).
// Resolves { ...result, credential_used }; rejects with a SourceError.
// ownOnly: only the caller's own key (kind 'notoken' without one), no pool fallback and so no suspect strikes.
async function call(ctx, provider, { priority = 'interactive', userId = null, signal, probe = false, ownOnly = false, spare = false, beforeRequest = null } = {}, exec) {
    const s = remember(ctx);
    const creds = credentialsOf(ctx);
    const options = bucketOptions(ctx, provider);
    const accesses = spare ? spareAccesses(ctx, provider, userId) : accessesFor(ctx, provider, { userId, priority, ownOnly });
    if (ownOnly && !accesses.length) throw new SourceError('notoken', `Kein eigener ${SOURCE_LABELS[provider] || provider}-Schlüssel hinterlegt`);
    if (spare) priority = 'prefetch';
    const plan = [];
    for (const access of accesses) {
        if (spare) {
            plan.push({ access, deadlineMs: 0 });
        } else if (ownOnly) {
            plan.push({ access, deadlineMs: priority === 'interactive' ? INTERACTIVE_WAIT_MS : OWN_BACKGROUND_WAIT_MS });
        } else if (probe) {
            if (access.kind === 'shared') plan.push({ access, deadlineMs: 0 });
        } else {
            plan.push({ access, deadlineMs: priority === 'interactive' && access.kind === 'shared' ? INTERACTIVE_WAIT_MS : 0 });
        }
    }
    // background work waits for the shared pool's background share when nobody had a token at once
    const shared = accesses.find((a) => a.kind === 'shared');
    if (priority !== 'interactive' && !probe && !spare && shared) plan.push({ access: shared, deadlineMs: Infinity });
    let lastError = null;
    // a personal key that got a refused-looking answer: a strike only when a later shared access gets a proper one
    let suspect = null;
    const disable = (access, err) => {
        s.suspects.delete(access.bucket);
        creds.failed(access.userId, provider, `${SOURCE_LABELS[provider]} lehnt den Schlüssel ab (${err.status || 401})`);
        s.budget.drop(access.bucket);
        logger().info(`${SOURCE_LABELS[provider]}: Schlüssel von Benutzer ${access.userId} abgelehnt und deaktiviert`);
    };
    const strike = (access, err) => {
        const now = nowMs(ctx);
        const first = s.suspects.get(access.bucket);
        if (first !== undefined && now - first <= SUSPECT_WINDOW_MS) disable(access, err);
        else s.suspects.set(access.bucket, now);
    };
    const refused = new Set();
    for (const { access, deadlineMs } of plan) {
        if (signal && signal.aborted) throw aborted(provider);
        if (refused.has(access.bucket)) continue;
        if (!probe && !s.budget.available(access.bucket, options, nowMs(ctx))) {
            lastError = lastError || unavailable(provider);
            continue;
        }
        const got = await acquire(s.budget, access.bucket, options, priority, { now: () => nowMs(ctx), deadlineMs, probe, signal });
        if (!got) {
            if (signal && signal.aborted) throw aborted(provider);
            lastError = lastError || unavailable(provider, 'busy');
            continue;
        }
        if (beforeRequest) {
            try {
                beforeRequest();
            } catch (err) {
                s.budget.release(access.bucket);
                throw err;
            }
        }
        try {
            const result = await exec(access.credential);
            s.budget.success(access.bucket);
            if (result && result.rate) s.budget.observe(access.bucket, result.rate, nowMs(ctx));
            if (access.kind !== 'shared') {
                creds.used(access.userId, provider, true);
                s.suspects.delete(access.bucket);
            }
            if (suspect && access.kind === 'shared') strike(suspect.access, suspect.err);
            return { ...result, provider, credential_used: access.kind === 'own' ? 'own' : 'shared' };
        } catch (err) {
            if (!(err instanceof SourceError) || err.aborted || (signal && signal.aborted)) {
                s.budget.release(access.bucket);
                throw err;
            }
            lastError = err;
            if (err.kind === 'rate') {
                s.budget.rateLimited(access.bucket, err, nowMs(ctx));
                continue;
            }
            const personal = access.kind !== 'shared';
            if (err.kind === 'auth' && personal) {
                disable(access, err);
                continue;
            }
            if (err.kind === 'auth' && provider === 'tmdb' && access.credential) {
                refused.add(access.bucket);
                creds.failed(null, provider, String(msg('TMDB lehnt den Schlüssel ab ({status})', { status: err.status || 401 })));
                s.budget.drop(access.bucket);
                logger().info('TMDB: instance key refused and disabled');
                continue;
            }
            if (err.isOutage) {
                s.budget.failure(access.bucket, nowMs(ctx));
                if (access.kind === 'own') continue;
                throw err;
            }
            s.budget.success(access.bucket);
            if (personal) {
                if (!suspect && refusedLike(err)) suspect = { access, err };
                continue;
            }
            throw err;
        }
    }
    throw lastError || unavailable(provider);
}

/** True when the shared pool of `provider` cannot serve right now (paused or circuit open). */
function poolDown(ctx, provider) {
    const s = S();
    return !s.budget.available(`shared:${provider}`, bucketOptions(ctx, provider), nowMs(ctx));
}

const circuitOf = (ctx, provider) => {
    const state = S().budget.state(`shared:${provider}`, nowMs(ctx));
    return state ? state.circuit : 'closed';
};

function grouperFor(ctx, userId) {
    const s = S();
    const own = userId && credentialsOf(ctx).get(userId, 'anilist');
    const scope = own ? `user:${userId}` : 'shared';
    if (!s.groupers.has(scope)) {
        s.groupers.set(scope, createGrouper({
            size: () => S().groupSize,
            run: async ({ seal }) => {
                const host = S().hostCtx || ctx;
                let terms = null;
                const result = await call(host, 'anilist', { priority: 'interactive', userId: own ? userId : null }, async (credential) => {
                    terms = seal();
                    return searchTermsSplit(host, terms, credential, SEARCH_TIMEOUT_MS);
                });
                return result.metas.map((metas) => ({ metas, credential_used: result.credential_used }));
            }
        }));
    }
    return s.groupers.get(scope);
}

/** AniList search of several terms; a "max query complexity" answer halves the group size and splits the request. */
async function searchTermsSplit(ctx, terms, credential, timeoutMs) {
    try {
        return await anilist.search(ctx, terms, { credential, timeoutMs });
    } catch (err) {
        if (!(err instanceof SourceError) || err.kind !== 'complexity' || terms.length < 2) throw err;
        const s = S();
        s.groupSize = Math.max(1, Math.floor(terms.length / 2));
        logger().info(`AniList: Suchgruppe zu komplex, ab jetzt höchstens ${s.groupSize} Begriffe je Anfrage`);
        const half = Math.ceil(terms.length / 2);
        const a = await searchTermsSplit(ctx, terms.slice(0, half), credential, timeoutMs);
        const b = await searchTermsSplit(ctx, terms.slice(half), credential, timeoutMs);
        return { metas: [...a.metas, ...b.metas], rate: b.rate || a.rate };
    }
}

async function aniListSearch(ctx, terms, userId) {
    const parts = await grouperFor(ctx, userId).add(terms);
    const seen = new Set();
    const metas = [];
    for (const part of parts) {
        for (const meta of part.metas) {
            if (seen.has(meta.anilist_id)) continue;
            seen.add(meta.anilist_id);
            metas.push(meta);
        }
    }
    return { metas, credential_used: parts[0] ? parts[0].credential_used : 'shared' };
}

const spareCall = (ctx, { userId, signal, beforeRequest }, exec) => call(ctx, 'anilist', { userId, signal, spare: true, beforeRequest }, exec);

async function spareTerms(ctx, terms, options) {
    const { timeoutMs, signal } = options;
    try {
        return (await spareCall(ctx, options, (credential) => anilist.search(ctx, terms, { credential, timeoutMs, signal }))).metas;
    } catch (err) {
        if (!(err instanceof SourceError) || err.kind !== 'complexity' || terms.length < 2) throw err;
        const half = Math.ceil(terms.length / 2);
        const a = await spareTerms(ctx, terms.slice(0, half), options);
        const b = await spareTerms(ctx, terms.slice(half), options);
        return [...a, ...b];
    }
}

/** AniList search of up to 3 terms over the spare plan (own key, then pool, no waiting): one list of AniList metas per term. */
async function spareSearch(ctx, terms, { userId = null, timeoutMs, signal, beforeRequest = () => {} } = {}) {
    remember(ctx);
    const list = terms.slice(0, 3);
    const found = new Map();
    const ask = [];
    for (const term of list) {
        const key = searchKey(term);
        const ui = key ? cache.read(ctx, `anime:search:${key}:10`) : null;
        if (ui && ui.value && Array.isArray(ui.value.sources_used) && ui.value.sources_used.includes('anilist') && Array.isArray(ui.value.results)) {
            found.set(term, ui.value.results.filter((meta) => meta && meta.anilist_id));
            continue;
        }
        const own = key ? cache.read(ctx, `watch:search:${key}`) : null;
        if (own && Array.isArray(own.value)) {
            found.set(term, own.value);
            continue;
        }
        ask.push(term);
    }
    if (ask.length) {
        const metas = await spareTerms(ctx, ask, { userId, timeoutMs, signal, beforeRequest });
        ask.forEach((term, i) => {
            const hits = (metas[i] || []).filter((meta) => meta && meta.anilist_id);
            cache.write(ctx, `watch:search:${searchKey(term)}`, hits, hits.length ? cache.TTL.search : cache.TTL.notFound);
            found.set(term, hits);
        });
    }
    return list.map((term) => found.get(term) || []);
}

/** AniList details (relations, links) of up to 50 ids over the spare plan; a too complex request is split in halves. */
async function spareDetail(ctx, ids, { userId = null, timeoutMs, signal, beforeRequest = () => {} } = {}) {
    remember(ctx);
    const options = { userId, timeoutMs, signal, beforeRequest };
    try {
        return (await spareCall(ctx, options, (credential) => anilist.byIdsDetail(ctx, ids, { credential, timeoutMs, signal }))).metas;
    } catch (err) {
        if (!(err instanceof SourceError) || err.kind !== 'complexity' || ids.length < 2) throw err;
        const half = Math.ceil(ids.length / 2);
        const a = await spareDetail(ctx, ids.slice(0, half), options);
        const b = await spareDetail(ctx, ids.slice(half), options);
        return [...a, ...b];
    }
}

/** The MyAnimeList side: official API when a client id exists, Jikan otherwise and when the official API fails. */
async function callMalSide(ctx, { priority = 'interactive', userId = null, probe = false, signal } = {}, viaMal, viaJikan) {
    const side = malSide(ctx, userId, priority);
    if (side === 'mal') {
        try {
            return await call(ctx, 'mal', { priority, userId, probe, signal }, viaMal);
        } catch (err) {
            if (!(err instanceof SourceError) || isAborted(err, signal)) throw err;
            logger().debug('MyAnimeList API failed, trying Jikan:', err.message);
        }
    }
    return call(ctx, 'jikan', { priority, userId, probe, signal }, viaJikan);
}

function malSideSearch(ctx, term, userId, limit, probe = false, signal) {
    const options = { limit, timeoutMs: SEARCH_TIMEOUT_MS, signal };
    return callMalSide(ctx, { userId, probe, signal }, (credential) => mal.search(ctx, term, { ...options, credential }), () => jikan.search(ctx, term, options));
}

function enterInteractive(ctx) {
    const s = S();
    const userId = ctx.user ? ctx.user.id : null;
    if (!s.users.enter(userId)) {
        throw new HttpError(429, 'Zu viele Suchanfragen, bitte kurz warten', 'TOO_MANY_SEARCHES', { retry_after: 5 });
    }
    return () => s.users.leave(userId);
}

/** Every source failed only because it is paused or open: one probe of the shared pool (AniList first). */
async function probeSources(ctx, attempts) {
    for (const attempt of attempts) {
        try {
            return { name: attempt.name, value: await attempt.run(true) };
        } catch (err) {
            logger().debug(`Probe of ${attempt.name} failed:`, err && err.message);
        }
    }
    return null;
}

/**
 * Promise.allSettled, but once the first promise fulfilled (or from the start with `answered`) the others get `graceMs`;
 * a slower one counts as rejected with kind 'slow' (it keeps running, and its outcome still reaches the budget).
 */
function settleWithGrace(promises, graceMs = SECOND_SOURCE_GRACE_MS, { answered = false } = {}) {
    return new Promise((resolve) => {
        const results = new Array(promises.length).fill(null);
        let pending = promises.length;
        let timer = null;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            resolve(results.map((r) => r || { status: 'rejected', reason: new SourceError('slow', 'Quelle antwortet zu langsam') }));
        };
        const settle = (i, result) => {
            if (done) return;
            results[i] = result;
            pending--;
            if (!pending) finish();
            else if (result.status === 'fulfilled' && !timer) timer = setTimeout(finish, graceMs);
        };
        if (!pending) finish();
        else if (answered) timer = setTimeout(finish, graceMs);
        promises.forEach((promise, i) => {
            promise.then((value) => settle(i, { status: 'fulfilled', value }), (reason) => settle(i, { status: 'rejected', reason }));
        });
    });
}

const failedOnlyByPause = (errors) => errors.length > 0 && errors.every((e) => e instanceof SourceError && (e.kind === 'unavailable' || e.kind === 'busy'));
const isSlow = (err) => err instanceof SourceError && err.kind === 'slow';
const lateFailure = (err) => logger().debug('Late source answer failed:', err && err.message);

function logSourceErrors(text, errors, signal) {
    const log = logger();
    for (const err of errors) {
        if (isAborted(err, signal)) log.debug(text, err && err.message);
        else log.warn(text, err && err.message);
    }
}

function searchSourcesFor(ctx, userId) {
    const cfg = settings(ctx);
    const keyed = (provider) => {
        const creds = credentialsOf(ctx);
        const own = userId ? creds.get(userId, provider) : null;
        const instance = creds.instance(provider);
        return Boolean((own && own.secret) || (instance && instance.secret));
    };
    return SEARCH_SOURCES.filter((name) => (name === 'tmdb' ? Boolean(cfg.tmdb) && keyed('tmdb') : Boolean(cfg[name])));
}

/** TMDb's language for a UI locale (en-US when unknown). */
const tmdbLanguage = (locale) => TMDB_LANGUAGES[locale] || 'en-US';

const searchRow = (value) => ({ metas: value.metas || [], provider: value.provider || null, credential_used: value.credential_used || 'shared' });

function readSearchRows(ctx, search, { allowStale = false } = {}) {
    const rows = {};
    for (const name of search.asked) {
        const row = cache.read(ctx, search.rowKey(name), { allowStale });
        if (row && row.value && Array.isArray(row.value.metas)) rows[name] = row.value;
    }
    return rows;
}

const writeSearchRow = (ctx, search, name, row) => cache.write(ctx, search.rowKey(name), row, row.metas.length ? cache.TTL.search : cache.TTL.notFound);

function animeResults(term, answers, limit, kind = 'all') {
    const merged = mergeResults(answers.anilist ? answers.anilist.metas : [], answers.mal ? answers.mal.metas : []);
    const { metas, rest } = foldTmdbHits(merged, answers.tmdb ? answers.tmdb.metas : []);
    const ranked = rankByTitle(term, [...metas, ...rest]);
    return (kind === 'all' ? ranked : ranked.filter((meta) => (meta.kind || 'anime') === kind)).slice(0, limit);
}

function sourcesDown(asked) {
    if (asked.length === 2 && asked.includes('anilist') && asked.includes('mal')) {
        return new HttpError(503, 'AniList und MyAnimeList sind gerade nicht erreichbar. Bitte später erneut versuchen.', 'SOURCES_UNAVAILABLE');
    }
    const names = asked.map((name) => SOURCE_LABELS[name] || name);
    const text = names.length === 1
        ? msg('{source} ist gerade nicht erreichbar. Bitte später erneut versuchen.', { source: names[0] })
        : msg('{sources} sind gerade nicht erreichbar. Bitte später erneut versuchen.', { sources: names.join(', ') });
    return new HttpError(503, text, 'SOURCES_UNAVAILABLE');
}

function animeAnswer(search, answers, exempt) {
    return {
        results: animeResults(search.term, answers, search.limit, search.kind),
        sources_used: search.asked.filter((name) => answers[name]).map((name) => (name === 'mal' ? answers.mal.provider || 'jikan' : name)),
        partial: search.asked.some((name) => !answers[name] && !(name === 'mal' && exempt)),
        credential_used: (answers.anilist || answers.mal || answers.tmdb || {}).credential_used || 'shared'
    };
}

function writeLegacyRow(ctx, search, answers) {
    const body = {
        results: animeResults(search.term, { anilist: answers.anilist, mal: answers.mal }, search.limit),
        sources_used: ['anilist', ...(answers.mal ? [answers.mal.provider || 'jikan'] : [])],
        partial: !answers.mal,
        credential_used: answers.anilist.credential_used || 'shared'
    };
    cache.write(ctx, search.legacyKey, body, body.partial ? cache.TTL.partial : (body.results.length ? cache.TTL.search : cache.TTL.notFound));
}

function staleAnimeAnswer(ctx, search) {
    const rows = readSearchRows(ctx, search, { allowStale: true });
    if (Object.keys(rows).length) return { ...animeAnswer(search, rows, false), cached: true, partial: true };
    if (search.asked.includes('anilist') && search.asked.includes('mal')) {
        const legacy = cache.read(ctx, search.legacyKey, { allowStale: true });
        if (legacy) return { ...legacy.value, cached: true, partial: true };
    }
    return null;
}

function animeSearchRunners(ctx, search, signal) {
    const { term, terms, limit, userId } = search;
    return {
        anilist: (probe) => (probe ? probeAniListSearch(ctx, terms) : aniListSearch(ctx, terms, userId)),
        mal: (probe) => (probe ? probeMalSearch(ctx, term, limit) : malSideSearch(ctx, term, userId, limit, false, signal)),
        tmdb: (probe) => {
            const own = probe ? undefined : signal;
            return call(ctx, 'tmdb', { priority: 'interactive', userId: probe ? null : userId, probe, signal: own },
                (credential) => tmdb.search(ctx, term, { language: search.tmdbLanguage, credential, timeoutMs: SEARCH_TIMEOUT_MS, signal: own }));
        }
    };
}

async function runAnimeSearch(ctx, search, signal) {
    const generation = generationOf(ctx);
    const answers = readSearchRows(ctx, search);
    const fromRows = new Set(Object.keys(answers));
    const malProvider = malSide(ctx, search.userId);
    const exempt = search.asked.includes('mal') && circuitOf(ctx, malProvider) !== 'closed';
    const runners = animeSearchRunners(ctx, search, signal);
    const attempts = search.asked.filter((name) => !answers[name] && runners[name]).map((name) => ({ name, run: runners[name] }));
    const promises = attempts.map((a) => a.run(false));
    const settled = await settleWithGrace(promises, SEARCH_GRACE_MS, { answered: fromRows.size > 0 });
    const errors = [];
    const late = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') answers[attempts[i].name] = searchRow(r.value);
        else if (isSlow(r.reason)) late.push(attempts[i]);
        else errors.push(r.reason);
    });
    for (const err of errors) if (!(err instanceof SourceError)) throw err;
    if (!Object.keys(answers).length && failedOnlyByPause(errors)) {
        const probed = await probeSources(ctx, attempts);
        if (probed) answers[probed.name] = searchRow(probed.value);
    }
    if (!Object.keys(answers).length) {
        const stale = staleAnimeAnswer(ctx, search);
        if (stale) return stale;
        logSourceErrors('Anime search failed:', errors, signal);
        throw sourcesDown(search.asked);
    }
    for (const name of Object.keys(answers)) if (!fromRows.has(name)) writeSearchRow(ctx, search, name, answers[name]);
    if (answers.anilist && search.asked.includes('mal')) writeLegacyRow(ctx, search, answers);
    const current = { ...answers };
    const merge = (name, value) => {
        if (generationOf(ctx) !== generation) return;
        try {
            current[name] = searchRow(value);
            writeSearchRow(ctx, search, name, current[name]);
            if (current.anilist && search.asked.includes('mal')) writeLegacyRow(ctx, search, current);
        } catch (err) {
            logger().debug('Late anime search answer dropped:', err && err.message);
        }
    };
    for (const attempt of late) promises[attempts.indexOf(attempt)].then((value) => merge(attempt.name, value), lateFailure);
    if (search.asked.includes('mal') && !answers.mal && !late.some((a) => a.name === 'mal') && circuitOf(ctx, malProvider) === 'half-open') {
        runners.mal(true).then((value) => merge('mal', value), lateFailure);
    }
    return { ...animeAnswer(search, answers, exempt), cached: search.asked.every((name) => fromRows.has(name)) };
}

/**
 * Anime search over the asked sources (`sources` ∩ the kind's sources ∩ what the caller can use): { results, sources_used,
 * cached, partial, credential_used, sources_available }. Every source answer has its own cache row; only sources
 * without one are asked. Umlauts are folded (AniList does not match "ü"); both spellings go out in one AniList request.
 */
async function searchAnime(ctx, q, { limit = 10, sources, kind = 'all', language, signal = ctx.signal } = {}) {
    remember(ctx);
    const term = String(q || '').trim();
    const folded = foldUmlauts(term);
    const terms = folded !== term ? [term, folded] : [term];
    const key = searchKey(term);
    const userId = ctx.user ? ctx.user.id : null;
    const available = searchSourcesFor(ctx, userId);
    const wanted = Array.isArray(sources) && sources.length ? sources : SEARCH_SOURCES;
    const kindName = KIND_SOURCES[kind] ? kind : 'all';
    const asked = SEARCH_SOURCES.filter((name) => wanted.includes(name) && KIND_SOURCES[kindName].includes(name) && available.includes(name));
    if (!asked.length) return { results: [], sources_used: [], partial: false, cached: false, sources_available: available };
    const tmdbLang = tmdbLanguage(language || 'de');
    const search = {
        term, terms, limit, asked, userId, kind: kindName, tmdbLanguage: tmdbLang,
        legacyKey: `anime:search:${key}:${limit}`,
        rowKey: (name) => (name === 'tmdb' ? `anime:search:tmdb:${tmdbLang}:${key}:${limit}` : `anime:search:${name}:${key}:${limit}`)
    };
    const rows = readSearchRows(ctx, search);
    if (asked.every((name) => rows[name])) return { ...animeAnswer(search, rows, false), cached: true, sources_available: available };
    const leave = enterInteractive(ctx);
    try {
        const body = await S().coalescer.run(`${search.legacyKey}|${asked.join(',')}|${kindName}|${tmdbLang}`, (runSignal) => runAnimeSearch(ctx, search, runSignal), { signal });
        return { ...body, sources_available: available };
    } finally {
        leave();
    }
}

async function probeAniListSearch(ctx, terms) {
    const result = await call(ctx, 'anilist', { priority: 'interactive', probe: true }, (credential) => anilist.search(ctx, terms, { credential, timeoutMs: SEARCH_TIMEOUT_MS }));
    return { metas: [].concat(...result.metas), credential_used: 'shared' };
}

const probeMalSearch = (ctx, term, limit) => malSideSearch(ctx, term, null, limit, true);

/** Rejection of searchManga when no enabled source answered; every coalesced caller gets it. */
const searchUnavailable = () => Object.assign(new Error('AniList und MyAnimeList haben nicht geantwortet'), { unavailable: true });

async function runMangaSearch(ctx, search, signal) {
    const { term, terms, key, limit, timeoutMs, userId } = search;
    const cfg = settings(ctx);
    const generation = generationOf(ctx);
    const runAni = (probe) => call(ctx, 'anilist', { priority: 'interactive', userId, probe, signal },
        (credential) => anilist.search(ctx, terms, { type: 'MANGA', perPage: limit, credential, timeoutMs, signal }))
        .then((r) => dedupeById([].concat(...r.metas)));
    const runJikan = (probe, own = signal) => call(ctx, 'jikan', { priority: 'interactive', userId, probe, signal: own },
        async () => ({ list: await jikan.searchManga(ctx, term, { limit, timeoutMs, signal: own }) }))
        .then((r) => r.list);
    const attempts = [];
    if (cfg.anilist) attempts.push({ name: 'anilist', run: runAni, exempt: false });
    if (cfg.mal) attempts.push({ name: 'jikan', run: runJikan, exempt: circuitOf(ctx, 'jikan') !== 'closed' });
    const promises = attempts.map((a) => a.run(false));
    const settled = await settleWithGrace(promises, SEARCH_GRACE_MS);
    const lists = {};
    const errors = [];
    const late = [];
    settled.forEach((r, i) => {
        if (r.status === 'fulfilled') lists[attempts[i].name] = r.value;
        else if (isSlow(r.reason)) late.push(attempts[i]);
        else errors.push(r.reason);
    });
    if (!Object.keys(lists).length && failedOnlyByPause(errors)) {
        const probed = await probeSources(ctx, attempts);
        if (probed) lists[probed.name] = probed.value;
    }
    logSourceErrors('Manga lookup source failed:', errors, signal);
    const answered = Object.keys(lists).length;
    if (attempts.length && !answered) throw searchUnavailable();
    const write = (current) => {
        const results = joinMangaHits(current.anilist || [], current.jikan || []);
        const partial = attempts.some((a) => !a.exempt && !current[a.name]);
        cache.write(ctx, key, results, partial ? cache.TTL.partial : (results.length ? cache.TTL.search : cache.TTL.notFound));
        return results;
    };
    if (!answered) return [];
    const results = write(lists);
    const current = { ...lists };
    const merge = (name, value) => {
        if (generationOf(ctx) !== generation) return;
        try {
            current[name] = value;
            write(current);
        } catch (err) {
            logger().debug('Late manga lookup answer dropped:', err && err.message);
        }
    };
    for (const attempt of late) promises[attempts.indexOf(attempt)].then((value) => merge(attempt.name, value), lateFailure);
    if (cfg.mal && !lists.jikan && !late.some((a) => a.name === 'jikan') && circuitOf(ctx, 'jikan') === 'half-open') {
        runJikan(true, undefined).then((value) => merge('jikan', value), lateFailure);
    }
    return results;
}

/**
 * Manga search for the series lookup (AniList + Jikan) in the lookup shape. A failing source gives [] for itself;
 * when no enabled source answered it rejects with `err.unavailable`, so "no hits" stays distinguishable.
 */
async function searchManga(ctx, q, { timeoutMs, limit = 5, signal = ctx.signal } = {}) {
    remember(ctx);
    const term = String(q || '').trim();
    const folded = foldUmlauts(term);
    const terms = folded !== term ? [term, folded] : [term];
    const key = `manga:search:${searchKey(term)}`;
    const hit = cache.read(ctx, key);
    if (hit) return hit.value;
    let leave;
    try {
        leave = enterInteractive(ctx);
    } catch (err) {
        logger().info('Manga lookup: too many waiting requests of this user, answering without AniList/MyAnimeList');
        throw searchUnavailable();
    }
    const userId = ctx.user ? ctx.user.id : null;
    try {
        return await S().coalescer.run(key, (runSignal) => runMangaSearch(ctx, { term, terms, key, limit, timeoutMs, userId }, runSignal), { signal });
    } catch (err) {
        if (err && err.unavailable) throw err;
        if (isAborted(err, signal)) logger().debug('Manga lookup aborted');
        else logger().warn('Manga lookup failed:', err && err.message);
        throw searchUnavailable();
    } finally {
        leave();
    }
}

/** AniList hits first; a MyAnimeList hit with the MAL id of an AniList hit is dropped and marks that hit `also_on`. */
function joinMangaHits(aniHits, malHits) {
    const byMal = new Map();
    const out = aniHits.map((hit) => ({ ...hit }));
    for (const hit of out) if (hit.mal_id) byMal.set(`mal_${hit.mal_id}`, hit);
    for (const hit of malHits) {
        const twin = byMal.get(hit.id);
        if (!twin) {
            out.push(hit);
            continue;
        }
        twin.also_on = [...new Set([...(twin.also_on || []), 'mal'])];
    }
    return out;
}

function dedupeById(list) {
    const seen = new Set();
    return list.filter((item) => (seen.has(item.id) ? false : seen.add(item.id)));
}

function batcherFor(kind) {
    const s = S();
    if (!s.batchers.has(kind)) {
        s.batchers.set(kind, createBatcher({
            run: async (ids) => {
                const host = S().hostCtx;
                const result = await call(host, 'anilist', { priority: 'refresh' }, (credential) => anilist.byIds(host, kind === 'mal' ? { mal: ids } : { anilist: ids }, { credential }));
                return new Map(result.metas.map((m) => [kind === 'mal' ? m.mal_id : m.anilist_id, m]));
            }
        }));
    }
    return s.batchers.get(kind);
}

/**
 * One entry by AniList and/or MAL id, merged when both answer: AnimeMeta or null. interactive: AniList plus MAL in
 * parallel; background: the AniList batcher, MAL only when AniList cannot serve. skipAniList: MAL side only.
 */
async function getAnime(ctx, ref, { priority = 'interactive', skipAniList = false } = {}) {
    remember(ctx);
    if (ref.tmdb_id) return getTmdb(ctx, ref, { priority });
    const cfg = settings(ctx);
    const userId = ctx.user ? ctx.user.id : null;
    const errors = [];
    let ani = null;
    let aniAnswered = false;
    if (cfg.anilist && !skipAniList && (ref.anilist_id || ref.mal_id)) {
        try {
            if (priority === 'interactive') {
                ani = (await call(ctx, 'anilist', { priority, userId }, (credential) => anilist.byId(ctx, ref, { credential }))).meta;
            } else {
                ani = await batcherFor(ref.anilist_id ? 'anilist' : 'mal').add(Number(ref.anilist_id || ref.mal_id)) || null;
            }
            aniAnswered = true;
        } catch (err) {
            if (!(err instanceof SourceError)) throw err;
            errors.push(err);
        }
    }
    const malId = ref.mal_id || (ani && ani.mal_id);
    let other = null;
    const wantMal = cfg.mal && malId && (priority === 'interactive' || !ani);
    if (wantMal) {
        try {
            const request = callMalSide(ctx, { priority, userId }, (credential) => mal.byMalId(ctx, malId, { credential }), () => jikan.byMalId(ctx, malId));
            // with AniList's answer in hand MyAnimeList only fills gaps: it gets the grace period, not the full timeout
            const [settled] = ani ? await settleWithGrace([Promise.resolve(null), request]).then((r) => [r[1]]) : await settleWithGrace([request]);
            if (settled.status === 'rejected') throw settled.reason;
            other = settled.value.meta;
        } catch (err) {
            if (!(err instanceof SourceError)) throw err;
            errors.push(err);
        }
    }
    const meta = mergeMeta(ani, other);
    if (!meta && errors.length && !aniAnswered) throw errors[0];
    return meta;
}

async function getTmdb(ctx, ref, { priority = 'interactive', userId = ctx.user ? ctx.user.id : null, ownOnly = false } = {}) {
    if (!settings(ctx).tmdb) throw unavailable('tmdb');
    const result = await call(ctx, 'tmdb', { priority, userId, ownOnly }, (credential) => tmdb.byId(ctx, ref.tmdb_kind, ref.tmdb_id, { credential }));
    return result.meta;
}

/**
 * TMDb seasons for an entry (its own TMDb show, else the best Japanese animation TV hit whose titles match at 0.9 or more,
 * the nearest start year first) with names in the UI language: { seasons: [{ start, name, episodes, season_number }],
 * reason: null | 'no_key' | 'not_found', tmdb_id }. Needs a TMDb key of the caller or the instance.
 */
async function tmdbSeasons(ctx, row, { language = 'de', userId = ctx.user ? ctx.user.id : null } = {}) {
    const none = (reason) => ({ seasons: [], reason, tmdb_id: null });
    if (!searchSourcesFor(ctx, userId).includes('tmdb')) return none('no_key');
    const lang = tmdbLanguage(language);
    let tmdbId = row.tmdb_kind === 'tv' && row.tmdb_id ? row.tmdb_id : null;
    if (!tmdbId) {
        if (row.tmdb_kind === 'movie') return none('not_found');
        const titles = [row.title, row.title_de, row.title_romaji, row.title_english, row.title_native].filter(Boolean);
        const term = row.title_english || row.title_romaji || row.title;
        if (!term) return none('not_found');
        const found = await call(ctx, 'tmdb', { userId }, (credential) => tmdb.search(ctx, term, { language: lang, credential, timeoutMs: SEARCH_TIMEOUT_MS }));
        const year = yearOf(row);
        const distance = (meta) => (year && yearOf(meta) ? Math.abs(yearOf(meta) - year) : 99);
        const best = (found.metas || [])
            .filter((meta) => meta.tmdb_kind === 'tv' && ((row.kind || 'anime') !== 'anime' || isTmdbAnime(meta)))
            .map((meta) => ({ meta, score: tmdbTwinScore(meta, titles) }))
            .filter((hit) => hit.score >= 0.9)
            .sort((a, b) => distance(a.meta) - distance(b.meta) || b.score - a.score)[0];
        tmdbId = best ? best.meta.tmdb_id : null;
    }
    if (!tmdbId) return none('not_found');
    const result = await call(ctx, 'tmdb', { userId }, async (credential) => ({ seasons: await tmdb.seasonList(ctx, tmdbId, { language: lang, credential }) }));
    // a season that starts after the known episode count (not aired yet) cannot be stored
    const seasons = seasonsFromCounts(result.seasons).filter((season) => !(row.episodes > 0) || season.start <= row.episodes);
    return seasons.length ? { seasons, reason: null, tmdb_id: tmdbId } : none('not_found');
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const OWN_TMDB_AGE_MS = 14 * DAY_MS;
const generationOf = (ctx) => (ctx.db && typeof ctx.db.generation === 'function' ? ctx.db.generation() : null);
const reopened = (ctx, generation) => generationOf(ctx) !== generation;
const reopenedError = () => new HttpError(503, 'Die Datenbank wurde während der Aktualisierung neu geöffnet (Wiederherstellung). Bitte erneut versuchen.');

/**
 * Refreshes one stored entry (snapshot, ids, cover when its URL changed). Resolves with true when it was found. A
 * background refresh is a partial snapshot. Rejects with a 503 HttpError when the database was reopened meanwhile.
 */
async function refreshEntry(ctx, id, { priority = 'interactive', skipAniList = false, generation = generationOf(ctx) } = {}) {
    const row = ctx.db.prepare('SELECT * FROM animes WHERE id = ?').get(id);
    if (row && row.tmdb_id) return (await refreshTmdbRow(ctx, row, { priority, generation })) === 'updated';
    if (!row || (!row.anilist_id && !row.mal_id)) return false;
    const meta = await getAnime(ctx, { anilist_id: row.anilist_id, mal_id: row.mal_id }, { priority, skipAniList });
    if (!meta) {
        if (reopened(ctx, generation)) throw reopenedError();
        store.updateRow(ctx, id, { next_check_at: nowMs(ctx) + DAY_MS });
        return false;
    }
    const images = await store.freshImages(ctx, meta, row);
    if (reopened(ctx, generation)) throw reopenedError();
    store.applySnapshot(ctx, id, meta, images, { partial: priority !== 'interactive' });
    // AniList just said it does not know this MAL id
    if (!skipAniList) scheduleIdResolution(ctx, id);
    return true;
}

function tmdbBackgroundAccess(ctx) {
    const creds = credentialsOf(ctx);
    const inst = creds.instance('tmdb');
    return Boolean((inst && inst.secret) || (creds.background('tmdb') || []).some((v) => v && v.secret));
}

async function refreshTmdbRow(ctx, row, { priority = 'refresh', generation = generationOf(ctx), ownUserId = null } = {}) {
    const interactive = priority === 'interactive';
    if (!settings(ctx).tmdb || (!interactive && !ownUserId && !tmdbBackgroundAccess(ctx))) {
        if (interactive) throw unavailable('tmdb');
        store.updateRow(ctx, row.id, { next_check_at: nowMs(ctx) + DAY_MS });
        return 'skipped';
    }
    let meta;
    try {
        const options = ownUserId ? { priority, userId: ownUserId, ownOnly: true } : { priority, userId: interactive && ctx.user ? ctx.user.id : null };
        meta = await getTmdb(ctx, row, options);
    } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        if (reopened(ctx, generation)) throw reopenedError();
        store.updateRow(ctx, row.id, { next_check_at: nowMs(ctx) + HOUR_MS });
        if (interactive) throw err;
        logger().debug(`TMDB refresh of anime ${row.id} failed:`, err.message);
        return 'failed';
    }
    if (reopened(ctx, generation)) throw reopenedError();
    if (!meta) {
        store.updateRow(ctx, row.id, { next_check_at: nowMs(ctx) + DAY_MS });
        return 'missing';
    }
    const images = await store.freshImages(ctx, meta, row);
    if (reopened(ctx, generation)) throw reopenedError();
    store.applySnapshot(ctx, row.id, meta, images, { partial: !interactive });
    return 'updated';
}

/** One id batch over AniList; a "max query complexity" answer splits it in halves (recursively). */
async function byIdsSplit(ctx, kind, rows) {
    try {
        return await call(ctx, 'anilist', { priority: 'refresh' }, (credential) => anilist.byIds(ctx, kind === 'mal'
            ? { mal: rows.map((r) => r.mal_id) }
            : { anilist: rows.map((r) => r.anilist_id) }, { credential }));
    } catch (err) {
        if (!(err instanceof SourceError) || err.kind !== 'complexity' || rows.length < 2) throw err;
        logger().info(`AniList: Abfrage mit ${rows.length} IDs zu komplex, sie wird geteilt`);
        const half = Math.ceil(rows.length / 2);
        const a = await byIdsSplit(ctx, kind, rows.slice(0, half));
        const b = await byIdsSplit(ctx, kind, rows.slice(half));
        return { metas: [...a.metas, ...b.metas], rate: b.rate || a.rate };
    }
}

/** Due rows in AniList id batches: anilist_id groups first, then MAL-only rows by idMal. */
function idGroups(rows) {
    const groups = [];
    const withAni = rows.filter((r) => r.anilist_id);
    const malOnly = rows.filter((r) => !r.anilist_id && r.mal_id);
    for (let i = 0; i < withAni.length; i += anilist.BATCH_SIZE) groups.push({ kind: 'anilist', rows: withAni.slice(i, i + anilist.BATCH_SIZE) });
    for (let i = 0; i < malOnly.length; i += anilist.BATCH_SIZE) groups.push({ kind: 'mal', rows: malOnly.slice(i, i + anilist.BATCH_SIZE) });
    return groups;
}

/**
 * Refreshes `rows` from the background share: AniList id batches, or one by one over MAL when AniList is off.
 * Stops (report.stopped) when AniList cannot serve, `shouldStop()` says so or the database was reopened.
 */
async function refreshRows(ctx, rows, report, options = {}) {
    const { generation, shouldStop = () => false } = options;
    const sourceRows = rows.filter((row) => !row.tmdb_id);
    if (sourceRows.length) await refreshSourceRows(ctx, sourceRows, report, options);
    for (const row of rows.filter((r) => r.tmdb_id)) {
        if (shouldStop()) break;
        let outcome;
        try {
            outcome = await refreshTmdbRow(ctx, row, { priority: 'refresh', generation });
        } catch (err) {
            if (!reopened(ctx, generation)) throw err;
            logger().info('Anime-Aktualisierung angehalten: die Datenbank wurde neu geöffnet');
            report.stopped = true;
            break;
        }
        if (outcome === 'updated') report.updated++;
        else if (outcome === 'missing') report.missing++;
    }
}

async function refreshSourceRows(ctx, rows, report, { generation, maxGroups = Infinity, pauseMs = 0, shouldStop = () => false, onMalOnlyMissing = () => {} } = {}) {
    if (!settings(ctx).anilist) {
        for (const row of rows) {
            if (shouldStop()) break;
            try {
                if (await refreshEntry(ctx, row.id, { priority: 'refresh', generation })) report.updated++;
                else report.missing++;
            } catch (err) {
                report.stopped = true;
                break;
            }
        }
        return;
    }
    let done = 0;
    for (const group of idGroups(rows)) {
        if (done >= maxGroups || shouldStop()) break;
        if (done > 0 && pauseMs) {
            await new Promise((r) => setTimeout(r, pauseMs));
            if (shouldStop()) break;
        }
        let result;
        try {
            result = await byIdsSplit(ctx, group.kind, group.rows);
        } catch (err) {
            if (!(err instanceof SourceError)) throw err;
            logger().info(`Anime-Aktualisierung angehalten: ${err.message}`);
            report.stopped = true;
            break;
        }
        done++;
        const byKey = new Map(result.metas.map((m) => [group.kind === 'mal' ? m.mal_id : m.anilist_id, m]));
        const updates = [];
        for (const row of group.rows) {
            const meta = byKey.get(group.kind === 'mal' ? row.mal_id : row.anilist_id);
            updates.push(meta ? { row, meta, images: await store.freshImages(ctx, meta, row) } : { row, meta: null });
        }
        if (reopened(ctx, generation)) {
            logger().info('Anime-Aktualisierung angehalten: die Datenbank wurde neu geöffnet');
            report.stopped = true;
            break;
        }
        const missing = [];
        ctx.db.transaction(() => {
            for (const u of updates) {
                if (u.meta) {
                    store.applySnapshot(ctx, u.row.id, u.meta, u.images, { partial: true });
                    report.updated++;
                } else {
                    store.updateRow(ctx, u.row.id, { next_check_at: nowMs(ctx) + DAY_MS });
                    report.missing++;
                    if (group.kind === 'mal') missing.push(u.row.id);
                }
            }
        });
        for (const id of missing) await onMalOnlyMissing(id);
    }
}

/** MAL-only entry AniList does not know: one refresh over the MAL side, from the background share. */
function scheduleMalRefresh(ctx, id) {
    const s = remember(ctx);
    if (!settings(ctx).mal) return false;
    return s.background.add(`refresh-mal:${id}`, 'refresh', () => refreshEntry(s.hostCtx, id, { priority: 'refresh', skipAniList: true }));
}

/** Rows by id that still have a source id. */
const rowsById = (ctx, ids) => ids
    .map((id) => ctx.db.prepare('SELECT * FROM animes WHERE id = ?').get(id))
    .filter((row) => row && (row.anilist_id || row.mal_id || row.tmdb_id));

function queueRefreshBatch(s, batch) {
    if (s.refreshOpen === batch) s.refreshOpen = null;
    clearTimeout(batch.timer);
    const release = () => { for (const id of batch.ids) s.refreshIds.delete(id); };
    const added = s.background.add(`refresh-batch:${++s.refreshSeq}`, 'refresh', async () => {
        try {
            const host = s.hostCtx;
            const generation = generationOf(host);
            const report = { updated: 0, missing: 0, stopped: false };
            await refreshRows(host, rowsById(host, batch.ids), report, {
                generation,
                onMalOnlyMissing: (id) => refreshEntry(host, id, { priority: 'refresh', skipAniList: true, generation })
                    .catch((err) => logger().debug(`MyAnimeList refresh of anime ${id} failed:`, err && err.message))
            });
        } finally {
            release();
        }
    });
    if (!added) release();
}

/**
 * Stale-while-revalidate: the ids go into one batched background refresh (up to 50 ids or 150 ms, one AniList
 * request per batch). False when the id is already waiting or being refreshed.
 */
function scheduleRefresh(ctx, id) {
    const s = remember(ctx);
    if (s.refreshIds.has(id)) return false;
    if (!s.refreshOpen) {
        const batch = { ids: [], timer: null };
        batch.timer = setTimeout(() => queueRefreshBatch(s, batch), BATCH_WAIT_MS);
        s.refreshOpen = batch;
    }
    const batch = s.refreshOpen;
    batch.ids.push(id);
    s.refreshIds.add(id);
    if (batch.ids.length >= anilist.BATCH_SIZE) queueRefreshBatch(s, batch);
    return true;
}

/** Missing second id: AniList by MAL id (batched), or a Jikan title search for an AniList entry without idMal. */
function scheduleIdResolution(ctx, id) {
    const row = ctx.db.prepare('SELECT id, anilist_id, mal_id, title_romaji, title FROM animes WHERE id = ?').get(id);
    if (!row || (row.anilist_id && row.mal_id) || (!row.anilist_id && !row.mal_id)) return false;
    const s = remember(ctx);
    const generation = generationOf(ctx);
    return s.background.add(`resolve:${id}`, 'prefetch', async () => {
        const host = s.hostCtx;
        if (!row.anilist_id) {
            const meta = await batcherFor('mal').add(Number(row.mal_id));
            if (meta && !reopened(host, generation)) store.applySnapshot(host, id, meta, {}, { partial: true });
            return;
        }
        if (!settings(host).mal) return;
        const name = row.title_romaji || row.title;
        const result = await call(host, 'jikan', { priority: 'prefetch' }, () => jikan.search(host, name, { limit: 3 }));
        const best = result.metas.find((m) => titleScore(name, allTitles(m)) >= 0.9);
        if (reopened(host, generation)) return;
        if (best && best.mal_id && !host.db.prepare('SELECT 1 FROM animes WHERE mal_id = ?').get(best.mal_id)) {
            store.updateRow(host, id, { mal_id: best.mal_id });
        }
    });
}

/** Manual "Aktualisieren": interactive, at most once per 60 s per entry (429 with retry_after otherwise). */
async function manualRefresh(ctx, id) {
    const s = remember(ctx);
    const generation = generationOf(ctx);
    const last = s.manualRefresh.get(id) || 0;
    const now = nowMs(ctx);
    if (now - last < MANUAL_REFRESH_MS) {
        const retry = Math.ceil((MANUAL_REFRESH_MS - (now - last)) / 1000);
        throw new HttpError(429, msg('Dieser Eintrag wurde gerade aktualisiert. Bitte in {seconds} s erneut versuchen.', { seconds: retry }), 'REFRESH_TOO_SOON', { retry_after: retry });
    }
    const leave = enterInteractive(ctx);
    s.manualRefresh.set(id, now);
    if (s.manualRefresh.size > 1000) s.manualRefresh.delete(s.manualRefresh.keys().next().value);
    try {
        return await refreshEntry(ctx, id, { priority: 'interactive', generation });
    } catch (err) {
        if (err instanceof SourceError) {
            throw new HttpError(503, 'Die Quellen sind gerade nicht erreichbar, der gespeicherte Stand bleibt. Bitte später erneut versuchen.', 'SOURCES_UNAVAILABLE');
        }
        throw err;
    } finally {
        leave();
    }
}

/** Without an instance or volunteer TMDb key: refreshes a TMDb entry older than 14 days with the caller's own key (once a day). */
function scheduleOwnTmdbRefresh(ctx, row) {
    if (!row || !row.tmdb_id || !ctx.user || !settings(ctx).tmdb) return false;
    const now = nowMs(ctx);
    if (row.meta_fetched_at && now - row.meta_fetched_at < OWN_TMDB_AGE_MS) return false;
    const userId = ctx.user.id;
    const own = credentialsOf(ctx).get(userId, 'tmdb');
    if (!own || !own.secret || tmdbBackgroundAccess(ctx)) return false;
    const s = remember(ctx);
    if (now - (s.ownTmdbRefresh.get(row.id) || 0) < DAY_MS) return false;
    s.ownTmdbRefresh.set(row.id, now);
    if (s.ownTmdbRefresh.size > 1000) s.ownTmdbRefresh.delete(s.ownTmdbRefresh.keys().next().value);
    const generation = generationOf(ctx);
    return s.background.add(`refresh-tmdb-own:${row.id}`, 'refresh', async () => {
        const host = s.hostCtx;
        const current = host.db.prepare('SELECT * FROM animes WHERE id = ?').get(row.id);
        if (!current || !current.tmdb_id || reopened(host, generation)) return;
        await refreshTmdbRow(host, current, { priority: 'refresh', generation, ownUserId: userId });
    });
}

/**
 * Refreshes due entries (next_check_at reached) in groups of 50 over AniList's id_in; `onlyAiring` is the hourly run.
 * Stops when AniList cannot serve (sweeps wait instead of spending MAL); MAL-only entries are queued for one MAL refresh.
 */
async function refreshDue(ctx, { onlyAiring = false, maxGroups = Infinity, pauseMs = 0, shouldStop = () => false } = {}) {
    remember(ctx);
    const generation = generationOf(ctx);
    try {
        const rows = ctx.db.prepare(`
            SELECT * FROM animes
            WHERE next_check_at IS NOT NULL AND next_check_at <= ? AND (anilist_id IS NOT NULL OR mal_id IS NOT NULL OR tmdb_id IS NOT NULL)
            ${onlyAiring ? 'AND next_airing_at IS NOT NULL' : ''}
            ORDER BY next_check_at LIMIT 2000
        `).all(nowMs(ctx));
        const report = { due: rows.length, updated: 0, missing: 0, stopped: false };
        if (rows.length) {
            await refreshRows(ctx, rows, report, { generation, maxGroups, pauseMs, shouldStop, onMalOnlyMissing: (id) => scheduleMalRefresh(ctx, id) });
        }
        return report;
    } finally {
        try {
            cache.prune(ctx);
        } catch (err) {
            logger().warn('api_cache prune failed:', err && err.message);
        }
    }
}

/**
 * Anime adaptations of a series (AniList relations ADAPTATION of type ANIME first, Jikan's as fallback), searched by
 * alt_title (romaji from Manga Passion), then title. Each with in_collection_id. Cached for a day.
 */
async function adaptationsOf(ctx, manga) {
    remember(ctx);
    const query = String(manga.alt_title || manga.title || '').trim();
    if (!query) return { results: [], source: null, cached: false };
    const key = `anime:adapt:${searchKey(query)}`;
    let body = null;
    let cached = false;
    const hit = cache.read(ctx, key);
    if (hit) {
        body = hit.value;
        cached = true;
    }
    if (!body) {
        const leave = enterInteractive(ctx);
        const userId = ctx.user ? ctx.user.id : null;
        try {
            body = await S().coalescer.run(key, async () => {
                const cfg = settings(ctx);
                const pick = (candidates) => {
                    const titles = [manga.alt_title, manga.title].filter(Boolean);
                    const scored = candidates
                        .map((c) => ({ c, score: Math.max(...titles.map((t) => titleScore(t, [c.title.romaji, c.title.english, c.title.native, ...(c.synonyms || [])].filter(Boolean)))) }))
                        .sort((a, b) => b.score - a.score);
                    return scored.length && scored[0].score >= 0.5 ? scored[0].c : null;
                };
                const errors = [];
                if (cfg.anilist) {
                    try {
                        const r = await call(ctx, 'anilist', { priority: 'interactive', userId }, (credential) => anilist.adaptations(ctx, query, { credential }));
                        const found = pick(r.candidates);
                        return { results: found ? found.relations.filter((x) => x.relation === 'ADAPTATION' && x.kind === 'ANIME') : [], source: 'anilist' };
                    } catch (err) {
                        if (!(err instanceof SourceError)) throw err;
                        errors.push(err);
                    }
                }
                if (cfg.mal) {
                    try {
                        const r = await call(ctx, 'jikan', { priority: 'interactive', userId }, async () => jikan.adaptations(ctx, query));
                        const found = pick(r.candidates);
                        return { results: found ? found.relations.filter((x) => x.relation === 'ADAPTATION' && x.kind === 'ANIME') : [], source: 'jikan' };
                    } catch (err) {
                        if (!(err instanceof SourceError)) throw err;
                        errors.push(err);
                    }
                }
                for (const err of errors) logger().warn('Anime adaptations lookup failed:', err.message);
                throw new HttpError(503, 'AniList und MyAnimeList sind gerade nicht erreichbar. Bitte später erneut versuchen.', 'SOURCES_UNAVAILABLE');
            });
            cache.write(ctx, key, body, cache.TTL.adaptations);
        } finally {
            leave();
        }
    }
    const byAni = ctx.db.prepare('SELECT id FROM animes WHERE anilist_id = ?');
    const byMal = ctx.db.prepare('SELECT id FROM animes WHERE mal_id = ?');
    const results = body.results.map((r) => ({
        ...r,
        in_collection_id: (r.anilist_id && byAni.get(r.anilist_id)?.id) || (r.mal_id && byMal.get(r.mal_id)?.id) || null
    }));
    return { results, source: body.source, cached };
}

const DEFAULT_STATE = (limit) => ({ limit, remaining: limit, reset_at: null, paused_until: null, circuit: 'closed', used_last_hour: 0, slow_recently: false });

/** Budget and circuit of both sources for the caller (own keys included), and whether the shared pool was slow lately. */
function sourcesState(ctx) {
    const s = remember(ctx);
    const cfg = settings(ctx);
    const now = nowMs(ctx);
    const creds = credentialsOf(ctx);
    const userId = ctx.user ? ctx.user.id : null;
    const side = malSide(ctx, userId);
    const describe = (provider, enabled) => {
        const options = bucketOptions(ctx, provider);
        const shared = s.budget.state(`shared:${provider}`, now) || DEFAULT_STATE(options.perMinute);
        const credProvider = provider === 'jikan' ? 'mal' : provider;
        const status = userId && creds.status ? creds.status(userId, credProvider) : null;
        const own = userId && creds.get(userId, credProvider);
        return {
            enabled,
            name: SOURCE_LABELS[provider],
            ...shared,
            own: own ? { ...(s.budget.state(`user:${userId}:${credProvider}`, now) || DEFAULT_STATE(options.perMinute)) } : null,
            key_disabled: Boolean(status && status.configured && status.last_error && !own)
        };
    };
    const anilistState = describe('anilist', cfg.anilist);
    const malState = describe(side, cfg.mal);
    const tmdbInstance = creds.instance('tmdb');
    const tmdbShared = Boolean(tmdbInstance && tmdbInstance.secret);
    const tmdbState = describe('tmdb', cfg.tmdb);
    const tmdbBudget = s.budget.state('shared:tmdb', now) || DEFAULT_STATE(bucketOptions(ctx, 'tmdb').perMinute);
    const instanceStatus = creds.status ? creds.status(null, 'tmdb') : null;
    return {
        anilist: { ...anilistState, available: Boolean(cfg.anilist) },
        mal: { ...malState, adapter: side, available: Boolean(cfg.mal) },
        tmdb: {
            enabled: Boolean(cfg.tmdb),
            name: SOURCE_LABELS.tmdb,
            own: tmdbState.own,
            key_disabled: tmdbState.key_disabled,
            available: Boolean(cfg.tmdb && (tmdbState.own || tmdbShared)),
            error: (instanceStatus && instanceStatus.last_error) || null,
            ...(tmdbShared ? tmdbBudget : {})
        },
        credential: {
            anilist: anilistState.own ? 'own' : 'shared',
            mal: malState.own ? 'own' : (side === 'mal' ? 'instance' : 'shared')
        },
        slow_recently: Boolean(anilistState.slow_recently || anilistState.paused_until || malState.paused_until),
        background_waiting: s.background.size()
    };
}

/** Live check of a key before it is stored: { label } or a SourceError (auth when the provider refuses it). */
async function validateCredential(ctx, provider, secret) {
    if (provider === 'anilist') {
        const viewer = await anilist.viewer(ctx, secret);
        return { label: viewer.name || `AniList-Konto ${viewer.id}` };
    }
    if (provider === 'mal') return mal.check(ctx, secret);
    if (provider === 'tmdb') return tmdb.check(ctx, secret);
    if (provider === 'google_books') {
        await requestJson(ctx, `https://www.googleapis.com/books/v1/volumes?q=isbn:9783551713629&key=${encodeURIComponent(secret)}`, {}, { label: 'Google Books' });
        return { label: `Schlüssel …${String(secret).slice(-4)}` };
    }
    throw new HttpError(400, 'Unbekannter Anbieter', 'UNKNOWN_PROVIDER');
}

/** A deduplicated background job by key; fn gets the host ctx (no caller, no abort signal). False when not queued. */
function runInBackground(ctx, key, priority, fn) {
    const s = remember(ctx);
    return s.background.add(key, priority, () => fn(s.hostCtx));
}

/** Drops the budget of a personal key (deleted or replaced). */
function forgetAccess(userId, provider) {
    S().budget.drop(`user:${userId}:${provider}`);
}

module.exports = {
    searchAnime, searchManga, getAnime, refreshEntry, manualRefresh, scheduleRefresh, scheduleIdResolution, scheduleMalRefresh, scheduleOwnTmdbRefresh, refreshDue,
    adaptationsOf, sourcesState, validateCredential, forgetAccess, resetGatewayState, call, poolDown, runInBackground, generationOf, spareSearch,
    spareDetail, tmdbLanguage, tmdbSeasons, state: () => S(), MANUAL_REFRESH_MS, SEARCH_GRACE_MS, SEARCH_SOURCES
};
