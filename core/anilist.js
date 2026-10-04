// AniList media in the series-lookup shape (used by core/anime/anilist.js searchManga) and the description cleanup.
const { decodeHtmlEntities } = require('./isbnLookup');

const ANILIST_TIMEOUT_MS = 8000;

/** AniList text: line breaks kept, tags removed, then entities decoded (in this order, or "&lt;Twilight&gt;" would vanish as a tag). */
function cleanAniListDescription(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const text = decodeHtmlEntities(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return text || null;
}

function mapAniListMedia(m) {
    let author = null;
    if (m.staff?.edges) {
        const storyOrArt = m.staff.edges.find(e =>
            e.role?.toLowerCase().includes('story') ||
            e.role?.toLowerCase().includes('art') ||
            e.role?.toLowerCase().includes('original creator')
        );
        author = storyOrArt ? storyOrArt.node?.name?.full : m.staff.edges[0]?.node?.name?.full;
    }

    let status = 'Laufend';
    if (m.status === 'FINISHED') status = 'Abgeschlossen';
    else if (m.status === 'HIATUS') status = 'Pausiert';
    else if (m.status === 'CANCELLED') status = 'Abgebrochen';

    return {
        id: 'al_' + m.id,
        manga_passion_id: null,
        source: 'anilist',
        source_label: 'AniList',
        title: m.title?.english || m.title?.romaji,
        alt_title: m.title?.native || m.title?.romaji,
        author: author || null,
        publisher: null,
        description: cleanAniListDescription(m.description),
        cover_image: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
        banner_image: m.bannerImage || null,
        tags: Array.isArray(m.genres) ? m.genres.join(', ') : null,
        total_volumes: m.volumes || null,
        status: status
    };
}

module.exports = { cleanAniListDescription, mapAniListMedia, ANILIST_TIMEOUT_MS };
