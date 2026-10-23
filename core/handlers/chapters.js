// Chapter progress of webtoons and manhwa: each user's own "read up to chapter N" (PUT /mangas/:id/chapters).
const access = require('../lib/access');
const { msg, badRequest, notFound } = require('../errors');
const { parseWholeNumber, parseTrueFlag, MAX_CHAPTERS } = require('../lib/validate');

const CHAPTERS_ERROR = msg('Gelesene Kapitel muss eine ganze Zahl zwischen 0 und {max} sein', { max: MAX_CHAPTERS });

const chapterAboveTotal = (chapter, total) => badRequest(
    msg('Kapitel {chapter} gibt es bei dieser Reihe nicht (sie hat {total} Kapitel).', { chapter, total }),
    'CHAPTER_ABOVE_TOTAL', { total_chapters: total }
);

/** The caller's chapter of a series (0 without a row). */
const chaptersOf = (ctx, mangaId, userId) => ctx.db.prepare('SELECT chapters_read FROM chapter_progress WHERE manga_id = ? AND user_id = ?')
    .get(mangaId, userId)?.chapters_read || 0;

/**
 * { chapters_read } sets the own chapter (lower too, 0 removes the row) or { add } counts on; monotonic: true never goes
 * back. Above a known total only while it stays at or below the stored chapter (a total lowered later).
 * Viewer rights in the shelf are enough, like reading marks.
 */
function setChapters(ctx, { params, body }) {
    const mangaId = access.parseId(params.id);
    const manga = mangaId ? ctx.db.prepare('SELECT id, total_chapters FROM mangas WHERE id = ?').get(mangaId) : null;
    if (!manga) throw notFound('Manga');
    access.mangaAccess(ctx, manga.id, 'viewer');
    const absolute = body.chapters_read !== undefined;
    if (absolute === (body.add !== undefined)) throw badRequest('Entweder chapters_read oder add angeben');
    const amount = parseWholeNumber(absolute ? body.chapters_read : body.add);
    if (amount === null || amount > MAX_CHAPTERS || (!absolute && amount < 1)) throw badRequest(CHAPTERS_ERROR);
    const monotonic = parseTrueFlag(body.monotonic, false);
    const userId = ctx.user.id;

    let previous = 0;
    let next = 0;
    ctx.db.transaction(() => {
        previous = chaptersOf(ctx, manga.id, userId);
        next = absolute ? amount : previous + amount;
        if (monotonic) next = Math.max(next, previous);
        if (next > MAX_CHAPTERS) throw badRequest(CHAPTERS_ERROR);
        if (manga.total_chapters && next > manga.total_chapters && next > previous) throw chapterAboveTotal(next, manga.total_chapters);
        if (next === previous) return;
        if (next === 0) ctx.db.prepare('DELETE FROM chapter_progress WHERE manga_id = ? AND user_id = ?').run(manga.id, userId);
        else {
            ctx.db.prepare(`
                INSERT INTO chapter_progress (manga_id, user_id, chapters_read, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (manga_id, user_id) DO UPDATE SET chapters_read = excluded.chapters_read, updated_at = excluded.updated_at
            `).run(manga.id, userId, next);
        }
    });
    return { body: { success: true, manga_id: manga.id, chapters_read: next, previous, total_chapters: manga.total_chapters ?? null } };
}

module.exports = { setChapters, chaptersOf };
