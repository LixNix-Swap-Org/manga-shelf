// Streaming links: which services are recognised (exact host allowlist, also the SSRF guard of resolve-link), how a
// shared link or share text is read, and the helpers for the og:title of a fetched page. Shared with the frontend.
const MAX_URL = 2048;
const LOCALE = '(?:[a-z]{2}(?:-[a-z]{2})?\\/)?';

const SERVICES = [
    {
        id: 'crunchyroll',
        label: 'Crunchyroll',
        hosts: ['www.crunchyroll.com', 'crunchyroll.com', 'm.crunchyroll.com'],
        canonicalHost: 'www.crunchyroll.com',
        externalLinkSite: 'Crunchyroll',
        patterns: [
            { kind: 'episode', re: new RegExp(`^\\/${LOCALE}watch\\/([A-Z0-9]{6,20})(?:\\/([a-z0-9-]{1,200}))?\\/?$`, 'i') },
            { kind: 'series', re: new RegExp(`^\\/${LOCALE}series\\/([A-Z0-9]{6,20})(?:\\/([a-z0-9-]{1,200}))?\\/?$`, 'i') },
            { kind: 'legacy', re: new RegExp(`^\\/${LOCALE}([a-z0-9-]{1,200})\\/(episode-\\d{1,4}(?:-[a-z0-9-]{0,200})?-(\\d{4,10}))\\/?$`, 'i') }
        ],
        searchUrl: (title) => `https://www.crunchyroll.com/search?q=${encodeURIComponent(String(title || '').trim())}`,
        seriesUrl: (id) => `https://www.crunchyroll.com/series/${encodeURIComponent(String(id).toUpperCase())}`
    }
];

const findService = (id) => SERVICES.find((s) => s.id === id) || null;

/** A parsed https URL on an allowlisted host, or null. */
function parseAllowed(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_URL) return null;
    let url;
    try { url = new URL(raw); } catch (_) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const service = SERVICES.find((s) => s.hosts.includes(host));
    return service ? { url, service } : null;
}

const isAllowedUrl = (raw) => Boolean(parseAllowed(raw));

const episodeFromSlug = (slug) => {
    const m = /(?:^|-)episode-(\d{1,4})(?:-|$)/i.exec(String(slug || ''));
    return m ? Number(m[1]) : null;
};

/** The link a URL stands for: { service, kind, id, slug, url (canonical), episodeHint, seriesSlug } or null. */
function linkOf(raw) {
    const parsed = parseAllowed(raw);
    if (!parsed) return null;
    const { url, service } = parsed;
    let path;
    try { path = decodeURIComponent(url.pathname); } catch (_) { return null; }
    for (const pattern of service.patterns) {
        const m = pattern.re.exec(path);
        if (!m) continue;
        const base = `https://${service.canonicalHost}`;
        if (pattern.kind === 'legacy') {
            const seriesSlug = m[1].toLowerCase();
            const slug = m[2].toLowerCase();
            return { service: service.id, kind: 'legacy', id: m[3], slug, url: `${base}/${seriesSlug}/${slug}`, episodeHint: episodeFromSlug(slug), seriesSlug };
        }
        const id = m[1].toUpperCase();
        const slug = m[2] ? m[2].toLowerCase() : null;
        const segment = pattern.kind === 'episode' ? 'watch' : 'series';
        return {
            service: service.id,
            kind: pattern.kind,
            id,
            slug,
            url: `${base}/${segment}/${id}${slug ? `/${slug}` : ''}`,
            episodeHint: pattern.kind === 'episode' ? episodeFromSlug(slug) : null,
            seriesSlug: null
        };
    }
    return null;
}

const URL_RE = /https?:\/\/[^\s<>"'„“”«»]+/gi;

/** The first recognised streaming link in a text (a bare URL or a share text). */
function detectLink(text) {
    if (typeof text !== 'string' || !text) return null;
    for (const m of text.slice(0, 10000).match(URL_RE) || []) {
        // share texts end sentences right after the link
        const link = linkOf(m.replace(/[.,;:!?)\]}]+$/, ''));
        if (link) return link;
    }
    return null;
}

const stripUrls = (text) => String(text || '').slice(0, 10000).replace(URL_RE, ' ');

const EPISODE_RE = /(?:\b(?:Folge|Episode|Ep\.?)\s*(\d{1,4})\b|\bS\d{1,2}\s*E(\d{1,4})\b|\bE(\d{1,4})\b)/i;

/** Episode number from a share text or page title ('Folge 7', 'Episode 7', 'Ep. 7', 'E7', 'S1 E7'); links are ignored. */
function episodeFromText(text) {
    const m = EPISODE_RE.exec(stripUrls(text));
    if (!m) return null;
    const n = Number(m[1] || m[2] || m[3]);
    return n > 0 ? n : null;
}

const BOILERPLATE = [
    /^(?:jetzt\s+)?(?:schau(?:e)?(?:\s+dir)?|watch|sieh\s+dir)\s+/i,
    /\s+(?:auf|on|bei)\s+crunchyroll\b.*$/i,
    /\s*[-|–—]\s*crunchyroll\b.*$/i,
    /\s+an!?$/i
];

const trimEdges = (t) => t.replace(/^[\s"'„“”«»]+|[\s"'„“”«»,:;\-–—|]+$/g, '').trim();

/** Series title from a share text or og:title: the part before the episode marker, without service boilerplate. */
function seriesTitleFromText(text) {
    let t = stripUrls(text).replace(/\s+/g, ' ').trim();
    const marker = EPISODE_RE.exec(t);
    if (marker) t = t.slice(0, marker.index);
    // 'Schau dir X an: Folge 7': the closing ' an' only matches once the ': ' before the marker is gone
    t = trimEdges(t);
    for (const re of BOILERPLATE) t = t.replace(re, '');
    t = trimEdges(t);
    return t.length >= 2 && t.length <= 200 ? t : null;
}

const titleFromSlug = (slug) => {
    const t = String(slug || '').replace(/-+/g, ' ').trim();
    return t.length >= 2 ? t : null;
};

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(text) {
    return String(text ?? '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, code) => {
        if (code[0] === '#') {
            const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
        }
        const named = NAMED[code.toLowerCase()];
        return named === undefined ? all : named;
    });
}

const metaContent = (html, attr, name) => {
    const tags = String(html).match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const key = new RegExp(`\\b${attr}\\s*=\\s*["']${name}["']`, 'i');
        if (!key.test(tag)) continue;
        const m = /\bcontent\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
        if (m) return m[2] !== undefined ? m[2] : m[3];
    }
    return null;
};

/** og:title of a page head, else its <title>; decoded, null when neither exists. */
function parseOgTitle(html) {
    if (typeof html !== 'string') return null;
    const head = html.slice(0, 300000);
    const og = metaContent(head, 'property', 'og:title') || metaContent(head, 'name', 'twitter:title');
    const title = og !== null ? og : (/<title[^>]*>([^<]*)<\/title>/i.exec(head) || [])[1];
    const text = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : '';
    return text || null;
}

/** The first Crunchyroll series id the page links to. */
function parseSeriesId(html) {
    const m = /\/series\/([A-Z0-9]{6,20})(?=[/"'?#])/.exec(String(html || '').slice(0, 300000));
    return m ? m[1] : null;
}

module.exports = {
    SERVICES, MAX_URL, findService, detectLink, linkOf, isAllowedUrl, episodeFromText, episodeFromSlug, seriesTitleFromText,
    titleFromSlug, decodeEntities, parseOgTitle, parseSeriesId
};
