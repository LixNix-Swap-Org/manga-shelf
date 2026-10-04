// Genres/tags of a series (mangas.tags, comma-separated). Mirrors core/lib/tags.js; test/tags.test.js keeps the maps equal.
// i18n-ignore: stored genre values; shown through genreLabel (utils/enumLabels.js GENRE_NAMES)
export const GENRE_DE = {
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

/** One tag for display and filtering: spaces collapsed, an English genre in German; '' for nothing. */
export function normalizeTag(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return (GENRE_DE[text.toLowerCase()] || text).slice(0, MAX_TAG_LENGTH).trim();
}

/** Tags of a series (text or list): normalized, case-insensitively unique, in their first order. */
export function splitTags(value) {
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

export const tagKey = (tag) => normalizeTag(tag).toLowerCase();

export const joinTags = (tags) => splitTags(tags).join(', ');

/** Tags of the collection with series counts, most used first: [{ tag, count }]. */
export function collectTags(mangas) {
  const counts = new Map();
  for (const m of mangas || []) {
    for (const tag of splitTags(m?.tags)) {
      const key = tag.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'de'));
}

/** Every wanted tag (keys or names) is among the series' tags. */
export function hasAllTags(m, wanted) {
  if (!wanted || wanted.length === 0) return true;
  const own = new Set(splitTags(m?.tags).map((t) => t.toLowerCase()));
  return wanted.every((t) => own.has(tagKey(t)));
}
