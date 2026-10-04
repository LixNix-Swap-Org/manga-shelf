// Series: list, detail, create, edit, delete (GET/POST /mangas, GET/PUT/DELETE /mangas/:id).
const { normalizePublisher } = require('../lib/publishers');
const { badRequest, notFound } = require('../errors');
const { MANGA_STATUSES, parseOptionalId, parseWishPriority } = require('../lib/validate');
const snapshot = require('../snapshot');
const { moveMangaToTrash } = require('../lib/trash');
const { normalizeTags, splitTags } = require('../lib/tags');

// Manga Passion reports an unknown run state as 'Unbekannt'
const MANGA_STATUS_ALIASES = { Unbekannt: 'Laufend' };

// whether the household still collects a series (separate from the publication status)
const COLLECTING_STATUSES = ['aktiv', 'pausiert', 'abgebrochen'];
const COLLECTING_ERROR = 'Ungültiger Sammelstatus (erlaubt: ' + COLLECTING_STATUSES.join(', ') + ')';

// strict: reject an over-long value (a cut URL is broken); otherwise cut it like the POST handler always did
const TEXT_FIELDS = {
    alt_title: { max: 300, label: 'Alternativtitel' },
    author: { max: 300, label: 'Autor' },
    publisher: { max: 300, label: 'Verlag' },
    language: { max: 50, label: 'Sprache' },
    tags: { max: 500, label: 'Tags' },
    description: { max: 10000, label: 'Beschreibung' },
    cover_image: { max: 2048, label: 'Cover', strict: true },
    banner_image: { max: 2048, label: 'Banner', strict: true }
};

const TOTAL_VOLUMES_ERROR = 'Gesamtbände muss eine ganze Zahl zwischen 1 und 5000 sein';

function cleanText(field, value) {
    const spec = TEXT_FIELDS[field];
    if (value === undefined || value === null) return { value: null };
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
        return { error: `${spec.label} muss ein Text sein` };
    }
    const text = String(value).trim();
    if (!text) return { value: null };
    if (text.length > spec.max) {
        if (spec.strict) return { error: `${spec.label} ist zu lang (maximal ${spec.max} Zeichen)` };
        return { value: text.slice(0, spec.max) };
    }
    return { value: text };
}

/** Comma-separated tags, normalized (German genres, unique, max. 500 characters); unchanged tags are left out on PUT. */
function readTags(value, stored) {
    if (value === null || value === '') return { value: null };
    if (typeof value !== 'string') return { error: 'Tags muss ein Text sein' };
    if (stored && typeof stored.tags === 'string' && value.trim() === stored.tags.trim()) return { value: undefined };
    return { value: normalizeTags(value) };
}

function parseSeriesStatus(value) {
    if (value === undefined || value === null || value === '') return { value: 'Laufend' };
    const status = typeof value === 'string' ? (MANGA_STATUS_ALIASES[value.trim()] || value.trim()) : null;
    if (!MANGA_STATUSES.includes(status)) {
        return { error: 'Ungültiger Status (erlaubt: ' + MANGA_STATUSES.join(', ') + ')' };
    }
    return { value: status };
}

/** null, '' and 0 clear the total; anything else must be a whole number from 1 to 5000. */
function parseTotalVolumes(value) {
    if (value === undefined || value === null) return { value: null };
    const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : null);
    if (text === '') return { value: null };
    if (text === null || !/^\d+$/.test(text)) return { error: TOTAL_VOLUMES_ERROR };
    const n = Number(text);
    if (n === 0) return { value: null };
    if (n > 5000) return { error: TOTAL_VOLUMES_ERROR };
    return { value: n };
}

/**
 * Validated manga columns from a request body; only fields present in the body are returned. With `stored` (PUT), a
 * text field sent back unchanged is left out, so a legacy value (e.g. a long data: cover) does not block other edits.
 */
function readMangaFields(body, stored = null) {
    const fields = {};
    for (const field of Object.keys(TEXT_FIELDS)) {
        if (body[field] === undefined) continue;
        if (field === 'tags') {
            const r = readTags(body.tags, stored);
            if (r.error) return { error: r.error };
            if (r.value !== undefined) fields.tags = r.value;
            continue;
        }
        if (stored && typeof body[field] === 'string' && typeof stored[field] === 'string'
            && body[field].trim() === stored[field].trim()) continue;
        const r = cleanText(field, body[field]);
        if (r.error) return { error: r.error };
        fields[field] = r.value;
    }
    if (fields.publisher !== undefined) fields.publisher = normalizePublisher(fields.publisher);
    if (body.total_volumes !== undefined) {
        const r = parseTotalVolumes(body.total_volumes);
        if (r.error) return { error: r.error };
        fields.total_volumes = r.value;
    }
    if (body.manga_passion_id !== undefined) {
        const r = parseOptionalId(body.manga_passion_id);
        if (r.error) return { error: 'Ungültige Manga-Passion-ID' };
        fields.manga_passion_id = r.value;
    }
    if (body.wish_priority !== undefined) {
        const r = parseWishPriority(body.wish_priority);
        if (r.error) return { error: 'Ungültige Wunsch-Priorität (leer oder 0 bis 3)' };
        fields.wish_priority = r.value;
    }
    if (body.collecting !== undefined && body.collecting !== null && body.collecting !== '') {
        const value = typeof body.collecting === 'string' ? body.collecting.trim().toLowerCase() : null;
        if (!COLLECTING_STATUSES.includes(value)) return { error: COLLECTING_ERROR };
        fields.collecting = value;
    }
    return { fields };
}

/** GET /tags: every tag of the collection with the number of series, most used first (suggestions, filter chips). */
function tags(ctx) {
    const counts = new Map();
    for (const row of ctx.db.prepare("SELECT tags FROM mangas WHERE tags IS NOT NULL AND TRIM(tags) <> ''").all()) {
        for (const tag of splitTags(row.tags)) {
            const key = tag.toLowerCase();
            const entry = counts.get(key);
            if (entry) entry.count++;
            else counts.set(key, { tag, count: 1 });
        }
    }
    const list = [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'de'));
    return { body: { tags: list } };
}

function list(ctx) {
    return { body: snapshot.listMangas(ctx, ctx.user.id) };
}

function create(ctx, { body }) {
    const { title } = body;
    if (!title || typeof title !== 'string' || !title.trim()) {
        throw badRequest('Titel darf nicht leer sein');
    }
    const cleanTitle = title.trim();
    if (cleanTitle.length > 300) {
        throw badRequest('Titel ist zu lang (maximal 300 Zeichen)');
    }
    const { fields, error } = readMangaFields(body);
    if (error) throw badRequest(error);
    const status = parseSeriesStatus(body.status);
    if (status.error) throw badRequest(status.error);

    const result = ctx.db.prepare(`
        INSERT INTO mangas (title, alt_title, author, publisher, language, status, tags, total_volumes, description, cover_image, banner_image, manga_passion_id, wish_priority, collecting, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        cleanTitle,
        fields.alt_title ?? null,
        fields.author ?? null,
        fields.publisher ?? null,
        fields.language || 'Deutsch',
        status.value,
        fields.tags ?? null,
        fields.total_volumes ?? null,
        fields.description ?? null,
        fields.cover_image ?? null,
        fields.banner_image ?? null,
        fields.manga_passion_id ?? null,
        fields.wish_priority ?? null,
        fields.collecting ?? 'aktiv',
        ctx.user.id
    );
    return { body: { success: true, id: Number(result.lastInsertRowid) } };
}

function detail(ctx, { params }) {
    const manga = snapshot.loadMangaDetail(ctx, params.id, ctx.user.id);
    if (!manga) throw notFound('Manga');
    return { body: manga };
}

// owned_volumes is derived from the volumes and never taken from the body
function update(ctx, { params, body }) {
    const manga = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(params.id);
    if (!manga) throw notFound('Manga');

    if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim()) {
            throw badRequest('Titel darf nicht leer sein');
        }
        if (body.title.trim().length > 300) {
            throw badRequest('Titel ist zu lang (maximal 300 Zeichen)');
        }
    }
    const { fields, error } = readMangaFields(body, manga);
    if (error) throw badRequest(error);
    // a stored status from before the whitelist may be sent back unchanged
    let status = manga.status || 'Laufend';
    if (body.status !== undefined && body.status !== manga.status) {
        const r = parseSeriesStatus(body.status);
        if (r.error) throw badRequest(r.error);
        status = r.value;
    }
    const pick = (field) => (fields[field] !== undefined ? fields[field] : manga[field]);

    ctx.db.prepare(`
        UPDATE mangas SET title = ?, alt_title = ?, author = ?, publisher = ?,
        language = ?, status = ?, tags = ?, total_volumes = ?,
        description = ?, cover_image = ?,
        banner_image = ?, manga_passion_id = ?, wish_priority = ?, collecting = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        body.title !== undefined ? body.title.trim() : manga.title,
        pick('alt_title') || null,
        pick('author') || null,
        fields.publisher !== undefined ? fields.publisher : (normalizePublisher(manga.publisher) || null),
        pick('language') || 'Deutsch',
        status,
        pick('tags') || null,
        pick('total_volumes') ?? null,
        pick('description') || null,
        pick('cover_image') || null,
        pick('banner_image') || null,
        pick('manga_passion_id') ?? null,
        pick('wish_priority') ?? null,
        pick('collecting') || 'aktiv',
        ctx.user.id,
        params.id
    );
    return { body: { success: true } };
}

/** The series goes to the trash (restorable for 30 days); `trash_id` is what POST /trash/:id/restore takes. */
function remove(ctx, { params }) {
    let trashId = null;
    ctx.db.transaction(() => {
        trashId = moveMangaToTrash(ctx, params.id);
    });
    if (!trashId) throw notFound('Manga');
    return { body: { success: true, trash_id: trashId } };
}

module.exports = { list, create, detail, update, remove, tags, readMangaFields, COLLECTING_STATUSES };
