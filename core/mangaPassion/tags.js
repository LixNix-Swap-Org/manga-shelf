// Genres of a linked series that has none ("Genres nachladen"): the stored edition, then the Manga Passion cache, the
// API only when neither knows the edition.
const { normalizeTags } = require('../lib/tags');
const { HttpError, notFound, conflict } = require('../errors');
const client = require('./client');

const { toEditionId, readCache, getEditionInfo } = client;
// a cached 404 expires like getEditionInfo's own entry (client.js EDITION_CACHE_TTL_MS); edition data stays usable at any age
const NOT_FOUND_TTL_MS = client.EDITION_CACHE_TTL_MS || 12 * 60 * 60 * 1000;

const hasTags = (value) => typeof value === 'string' && value.trim() !== '';

function storedEdition(json) {
  if (typeof json !== 'string' || !json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The edition as already known locally: { edition, source } or null (an edition without tags still counts). */
function knownEdition(ctx, manga, editionId) {
  const stored = storedEdition(manga.manga_passion_edition_data);
  if (stored && toEditionId(stored.id) === editionId && hasTags(stored.tags)) return { edition: stored, source: 'edition_data' };
  for (const key of [`mp_edition_vols_${editionId}`, `mp_edition_info_${editionId}`]) {
    const cached = readCache(ctx, key, Infinity);
    if (cached?.edition) return { edition: cached.edition, source: 'cache' };
  }
  if (stored && toEditionId(stored.id) === editionId) return { edition: stored, source: 'edition_data' };
  return null;
}

/** Fills empty tags from the linked edition; existing tags are never replaced. */
async function fillTagsFromEdition(ctx, mangaId) {
  const select = () => ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(mangaId);
  const manga = select();
  if (!manga) throw notFound('Manga');
  if (hasTags(manga.tags)) return { success: true, updated: false, source: null, tags: manga.tags, manga };
  const editionId = toEditionId(manga.manga_passion_id);
  if (!editionId) throw conflict('Die Reihe ist nicht mit Manga Passion verknüpft', 'MP_NOT_LINKED');

  let known = knownEdition(ctx, manga, editionId);
  const cachedNotFound = () => [`mp_edition_vols_${editionId}`, `mp_edition_info_${editionId}`]
    .some((key) => readCache(ctx, key, NOT_FOUND_TTL_MS)?.notFound);
  if (!known) {
    if (cachedNotFound()) throw new HttpError(404, 'Edition auf Manga-Passion nicht gefunden', 'MP_EDITION_NOT_FOUND');
    await ctx.limit('lookup');
    const edition = await getEditionInfo(ctx, editionId);
    if (!edition) {
      if (cachedNotFound()) throw new HttpError(404, 'Edition auf Manga-Passion nicht gefunden', 'MP_EDITION_NOT_FOUND');
      throw new HttpError(503, 'Manga Passion ist gerade nicht erreichbar', 'MP_UNAVAILABLE');
    }
    known = { edition, source: 'manga_passion' };
  }

  const tags = normalizeTags(known.edition.tags);
  if (!tags) return { success: true, updated: false, source: known.source, tags: null, manga };
  const info = ctx.db.prepare(`
    UPDATE mangas SET tags = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND (tags IS NULL OR TRIM(tags) = '')
  `).run(tags, ctx.user?.id ?? null, mangaId);
  const updated = select();
  return { success: true, updated: info.changes === 1, source: known.source, tags: updated.tags, manga: updated };
}

module.exports = { fillTagsFromEdition, hasTags };
