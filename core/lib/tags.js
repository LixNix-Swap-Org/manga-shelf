// Genres/tags of a series: stored as comma-separated TEXT in mangas.tags. English catalogue genres (Manga Passion,
// AniList) are shown in German; Shounen/Seinen/Shoujo/Josei stay as target groups. frontend/src/utils/tags.js mirrors
// this map (test/tags.test.js keeps both equal).
const GENRE_DE = {
    'action': 'Action',
    'adventure': 'Abenteuer',
    'comedy': 'Komödie',
    'cooking': 'Kochen',
    'gourmet': 'Kochen',
    'crime': 'Krimi',
    'detective': 'Krimi',
    'drama': 'Drama',
    'fantasy': 'Fantasy',
    'historical': 'Historisch',
    'history': 'Historisch',
    'horror': 'Horror',
    'mahou shoujo': 'Magical Girl',
    'magical girl': 'Magical Girl',
    'martial arts': 'Kampfkunst',
    'medical': 'Medizin',
    'military': 'Militär',
    'music': 'Musik',
    'mystery': 'Mystery',
    'psychological': 'Psychologisch',
    'romance': 'Romantik',
    'school': 'Schule',
    'school life': 'Schule',
    'sci-fi': 'Science-Fiction',
    'science fiction': 'Science-Fiction',
    'slice of life': 'Alltag',
    'sports': 'Sport',
    'supernatural': 'Übernatürlich',
    'thriller': 'Thriller',
    'tragedy': 'Tragödie',
    'boys love': 'Boys Love',
    'shounen ai': 'Boys Love',
    'yaoi': 'Boys Love',
    'girls love': 'Girls Love',
    'shoujo ai': 'Girls Love',
    'yuri': 'Girls Love',
    'shounen': 'Shounen',
    'shonen': 'Shounen',
    'shōnen': 'Shounen',
    'shoujo': 'Shoujo',
    'shojo': 'Shoujo',
    'shōjo': 'Shoujo',
    'seinen': 'Seinen',
    'josei': 'Josei'
};

const MAX_TAG_LENGTH = 40;
const MAX_TAGS = 30;
const MAX_TAGS_TEXT = 500;

/** One tag as stored: spaces collapsed, an English genre in German, at most 40 characters; '' for nothing. */
function normalizeTag(value) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return (GENRE_DE[text.toLowerCase()] || text).slice(0, MAX_TAG_LENGTH).trim();
}

/** Tags of a comma-separated text or an array: normalized, case-insensitively unique, in their first order. */
function splitTags(value) {
    const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/);
    const seen = new Set();
    const tags = [];
    for (const part of parts) {
        const tag = normalizeTag(part);
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
        if (tags.length >= MAX_TAGS) break;
    }
    return tags;
}

/** Storage form (", " separated, cut at whole tags to 500 characters) or null without tags. */
function normalizeTags(value) {
    let text = '';
    for (const tag of splitTags(value)) {
        const next = text ? `${text}, ${tag}` : tag;
        if (next.length > MAX_TAGS_TEXT) break;
        text = next;
    }
    return text || null;
}

module.exports = { GENRE_DE, MAX_TAG_LENGTH, MAX_TAGS, splitTags, normalizeTag, normalizeTags };
