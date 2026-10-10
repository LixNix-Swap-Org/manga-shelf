const fs = require('fs');
const path = require('path');
const download = require('./download');
const { versionFromTag, compareVersions } = require('./version');
const { API_BASE, DOWNLOAD_BASE, RELEASE_PAGE_BASE, SUMS_NAME, BUNDLE_NAME, markerName, RELEASES_TTL_MS } = require('./constants');
const log = require('../../utils/logger').child('update');

const PER_PAGE = 30;
const MAX_PAGES = 3;
const WANTED = 10;
const MAX_BODY_CHARS = 64 * 1024;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,199}$/;
const ADMIN_NOTES_HEADING = /^###\s+Before updating\s*$/im;
const CACHE_FORMAT = 1;
const RETRY_MS = 5 * 60 * 1000;

let memory = null;

const cacheFile = (dataDir) => path.join(dataDir, 'cache', 'releases.json');

function readCache(dataDir) {
    try {
        const data = JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8'));
        if (!data || data.format !== CACHE_FORMAT || !Array.isArray(data.releases)) return null;
        return { ...data, releases: data.releases.map(normalizeCached).filter(Boolean) };
    } catch (e) {
        return null;
    }
}

function writeCache(dataDir, data) {
    try {
        const file = cacheFile(dataDir);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify({ ...data, format: CACHE_FORMAT }));
        fs.renameSync(tmp, file);
    } catch (e) {
        log.warn('[Update] Versionsliste konnte nicht zwischengespeichert werden:', e);
    }
}

function normalizeAsset(raw, tag) {
    if (!raw || typeof raw.name !== 'string' || !ASSET_NAME.test(raw.name)) return null;
    const url = `${DOWNLOAD_BASE}${tag}/${encodeURIComponent(raw.name)}`;
    if (raw.browser_download_url !== url) return null;
    const size = Number.isSafeInteger(raw.size) && raw.size >= 0 ? raw.size : null;
    const digest = typeof raw.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(raw.digest) ? raw.digest : null;
    return { name: raw.name, size, url, digest };
}

/** A published release in the shape the updater uses, or null (draft, pre-release, loose tag). */
function normalizeRelease(raw) {
    if (!raw || typeof raw !== 'object' || raw.draft !== false || raw.prerelease !== false) return null;
    const version = versionFromTag(raw.tag_name);
    if (!version) return null;
    const tag = `v${version}`;
    const assets = [];
    const seen = new Set();
    for (const a of Array.isArray(raw.assets) ? raw.assets.slice(0, 200) : []) {
        const asset = normalizeAsset(a, tag);
        if (asset && !seen.has(asset.name)) {
            seen.add(asset.name);
            assets.push(asset);
        }
    }
    return {
        version,
        tag,
        published_at: typeof raw.published_at === 'string' ? raw.published_at : null,
        html_url: `${RELEASE_PAGE_BASE}${tag}`,
        body: typeof raw.body === 'string' ? raw.body.slice(0, MAX_BODY_CHARS) : '',
        assets
    };
}

function normalizeCached(r) {
    if (!r || versionFromTag(r.tag) !== r.version) return null;
    return normalizeRelease({
        draft: false,
        prerelease: false,
        tag_name: r.tag,
        published_at: r.published_at,
        body: r.body,
        assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, digest: a.digest, browser_download_url: a.url }))
    });
}

const byVersionDesc = (a, b) => compareVersions(b.version, a.version);

/** The `### Before updating` block of a release text, or null. */
function adminNotes(body) {
    if (typeof body !== 'string') return null;
    const m = ADMIN_NOTES_HEADING.exec(body);
    if (!m) return null;
    const rest = body.slice(m.index + m[0].length);
    const end = rest.search(/^#{1,3}\s/m);
    const text = (end < 0 ? rest : rest.slice(0, end)).trim();
    return text || null;
}

/** Adds signed / installable / reason / has_admin_notes for this server (`current`, `assetName`). */
function decorate(release, { current, assetName }) {
    const names = new Set(release.assets.map((a) => a.name));
    const signed = names.has(SUMS_NAME) && names.has(BUNDLE_NAME) && names.has(markerName(release.version));
    const order = compareVersions(release.version, current);
    let reason = null;
    if (order === 0) reason = 'installed';
    else if (order === null || order < 0) reason = 'older';
    else if (!signed) reason = 'unsigned';
    else if (!assetName || !names.has(assetName)) reason = 'no_asset';
    return { ...release, signed, installable: reason === null, reason, has_admin_notes: adminNotes(release.body) !== null };
}

function rateLimitUntil(err, now) {
    const status = err && err.httpStatus;
    if (status !== 403 && status !== 429) return null;
    const headers = err.headers || {};
    const retryAfter = Number.parseInt(headers['retry-after'], 10);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return now + retryAfter * 1000;
    const reset = Number.parseInt(headers['x-ratelimit-reset'], 10);
    if (headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset)) return Math.max(now, reset * 1000);
    return status === 429 ? now + 60 * 1000 : null;
}

const view = (cache, error) => ({
    releases: cache ? cache.releases : [],
    fetched_at: cache && cache.fetched_at ? new Date(cache.fetched_at).toISOString() : null,
    error: error || null,
    next_try_at: cache && cache.next_try_at ? new Date(cache.next_try_at).toISOString() : null
});

/** { releases, fetched_at, error, next_try_at }; fetches when stale or forced, never before a rate-limit reset. */
async function listReleases({ dataDir, force = false, now = Date.now(), transport = {}, fetchJson = download.fetchJson } = {}) {
    if (!memory && dataDir) memory = readCache(dataDir);
    const cache = memory;
    if (cache && cache.next_try_at && now < cache.next_try_at) return view(cache, 'RATE_LIMITED');
    if (cache && !force && cache.error && cache.retry_at && now < cache.retry_at) return view(cache, cache.error);
    if (cache && !force && cache.fetched_at && now - cache.fetched_at < RELEASES_TTL_MS && !cache.error) return view(cache, null);
    try {
        const found = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const data = await fetchJson(`${API_BASE}/releases?per_page=${PER_PAGE}&page=${page}`, transport);
            if (!Array.isArray(data)) throw Object.assign(new Error('unexpected answer'), { reason: 'shape' });
            for (const raw of data) {
                const release = normalizeRelease(raw);
                if (release && !found.some((r) => r.version === release.version)) found.push(release);
            }
            if (data.length < PER_PAGE || found.length >= WANTED) break;
        }
        memory = { releases: found.sort(byVersionDesc), fetched_at: now, next_try_at: null, retry_at: null, error: null };
        if (dataDir) writeCache(dataDir, memory);
        return view(memory, null);
    } catch (err) {
        const until = rateLimitUntil(err, now);
        const code = until ? 'RATE_LIMITED' : 'GITHUB_UNAVAILABLE';
        log.warn(`[Update] Versionsliste nicht abrufbar (${code})`);
        memory = { releases: cache ? cache.releases : [], fetched_at: cache ? cache.fetched_at : null, next_try_at: until, retry_at: now + RETRY_MS, error: code };
        if (dataDir) writeCache(dataDir, memory);
        return view(memory, code);
    }
}

/** Fresh copy of one release (GET /releases/tags/v<version>), or null when it is not published under a strict tag. */
async function fetchRelease(version, { transport = {}, fetchJson = download.fetchJson } = {}) {
    const data = await fetchJson(`${API_BASE}/releases/tags/v${version}`, transport);
    const release = normalizeRelease(data);
    return release && release.version === version ? release : null;
}

/** The newest cached release ({ version, html_url, published_at }) without any network call, or null. */
function cachedLatest(dataDir) {
    if (!memory && dataDir) memory = readCache(dataDir);
    const newest = memory && memory.releases[0];
    if (!newest) return null;
    return { version: newest.version, html_url: newest.html_url, published_at: newest.published_at, fetched_at: memory.fetched_at ? new Date(memory.fetched_at).toISOString() : null };
}

function resetCache() {
    memory = null;
}

module.exports = { normalizeRelease, decorate, adminNotes, listReleases, fetchRelease, cachedLatest, resetCache, rateLimitUntil };
