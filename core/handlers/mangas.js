// Series: list, detail, create, edit, delete (GET/POST /mangas, GET/PUT/DELETE /mangas/:id).
const { normalizePublisher } = require('../lib/publishers');
const { msg, msgList, badRequest, notFound } = require('../errors');
const {
    parseLanguage, normalizeRegion, normalizeCurrency, isWorkKey, isManualWorkKey, manualWorkKey, preferredWorkKey, isMpLanguage,
    DEFAULT_LANGUAGE, DEFAULT_CURRENCY
} = require('../lib/language');
const { readProfile } = require('../lib/locales');
const { MANGA_STATUSES, parseOptionalId, parsePositiveInt, parseWishPriority } = require('../lib/validate');
const snapshot = require('../snapshot');
const { moveMangaToTrash } = require('../lib/trash');
const { normalizeTags, splitTags } = require('../lib/tags');

// Manga Passion reports an unknown run state as 'Unbekannt'
const MANGA_STATUS_ALIASES = { Unbekannt: 'Laufend' };

// whether the household still collects a series (separate from the publication status)
const COLLECTING_STATUSES = ['aktiv', 'pausiert', 'abgebrochen'];
const COLLECTING_ERROR = msg('Ungültiger Sammelstatus (erlaubt: {allowed})', { allowed: msgList(COLLECTING_STATUSES) });

// strict: reject an over-long value (a cut URL is broken); otherwise cut it like the POST handler always did
const TEXT_FIELDS = {
    alt_title: { max: 300 },
    author: { max: 300 },
    publisher: { max: 300 },
    tags: { max: 500 },
    description: { max: 10000 },
    cover_image: { max: 2048, strict: true },
    banner_image: { max: 2048, strict: true }
};
// one text per field (no German label as a parameter); the length texts only for the strict fields
const TEXT_TYPE_ERRORS = {
    alt_title: 'Alternativtitel muss ein Text sein',
    author: 'Autor muss ein Text sein',
    publisher: 'Verlag muss ein Text sein',
    language: 'Sprache muss ein Text sein',
    tags: 'Tags muss ein Text sein',
    description: 'Beschreibung muss ein Text sein',
    cover_image: 'Cover muss ein Text sein',
    banner_image: 'Banner muss ein Text sein'
};
const TEXT_LENGTH_ERRORS = {
    cover_image: 'Cover ist zu lang (maximal {max} Zeichen)',
    banner_image: 'Banner ist zu lang (maximal {max} Zeichen)'
};

const TOTAL_VOLUMES_ERROR = 'Gesamtbände muss eine ganze Zahl zwischen 1 und 5000 sein';
const EDITION_ERRORS = {
    language: 'Unbekannte Sprache',
    region: 'Ungültige Region (zwei Buchstaben, z. B. US)',
    currency: 'Ungültige Währung (drei Buchstaben, z. B. EUR)',
    work_key: 'Ungültiger Werk-Schlüssel'
};

/** language, region and currency of an edition from a body; only fields present are returned. */
function readEditionFields(body) {
    const fields = {};
    if (body.language !== undefined) {
        if (body.language !== null && typeof body.language !== 'string') return { error: TEXT_TYPE_ERRORS.language };
        const parsed = parseLanguage(body.language);
        if (!parsed) return { error: EDITION_ERRORS.language, code: 'LANGUAGE_INVALID' };
        fields.language = parsed.language;
        // a BCP-47 tag ('en-US') names the region unless the body sends one
        if (parsed.region && body.region === undefined) fields.region = parsed.region;
    }
    if (body.region !== undefined) {
        if (body.region === null || body.region === '') fields.region = null;
        else {
            const region = normalizeRegion(body.region);
            if (!region) return { error: EDITION_ERRORS.region };
            fields.region = region;
        }
    }
    if (body.currency !== undefined && body.currency !== null && body.currency !== '') {
        const currency = normalizeCurrency(body.currency);
        if (!currency) return { error: EDITION_ERRORS.currency };
        fields.currency = currency;
    }
    return { fields };
}

/** A fresh manual work key; random, so a key left behind by an unlink never pulls a series back into that group. */
const newManualWorkKey = (ctx) => manualWorkKey(ctx.randomId());

/** The edition language of the acting user's new series (users.default_language). */
const defaultLanguageOf = (ctx) => (ctx.user ? readProfile(ctx.db, ctx.user.id).default_language : DEFAULT_LANGUAGE);

function cleanText(field, value) {
    const spec = TEXT_FIELDS[field];
    if (value === undefined || value === null) return { value: null };
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
        return { error: TEXT_TYPE_ERRORS[field] };
    }
    const text = String(value).trim();
    if (!text) return { value: null };
    if (text.length > spec.max) {
        if (spec.strict) return { error: msg(TEXT_LENGTH_ERRORS[field], { max: spec.max }) };
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
        return { error: msg('Ungültiger Status (erlaubt: {allowed})', { allowed: msgList(MANGA_STATUSES) }) };
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
    const edition = readEditionFields(body);
    if (edition.error) return edition;
    Object.assign(fields, edition.fields);
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
    const { fields, error, code } = readMangaFields(body);
    if (error) throw badRequest(error, code);
    const status = parseSeriesStatus(body.status);
    if (status.error) throw badRequest(status.error);
    // a picked AniList/MyAnimeList hit names the work, so its editions find each other; manual groups only via /editions and /work
    let workKey = null;
    if (body.work_key !== undefined && body.work_key !== null && body.work_key !== '') {
        if (!isWorkKey(body.work_key) || isManualWorkKey(body.work_key)) throw badRequest(EDITION_ERRORS.work_key, 'WORK_KEY_INVALID');
        workKey = body.work_key;
    }
    const language = fields.language || defaultLanguageOf(ctx);

    const result = ctx.db.prepare(`
        INSERT INTO mangas (title, alt_title, author, publisher, language, region, currency, work_key, status, tags, total_volumes, description, cover_image, banner_image, manga_passion_id, wish_priority, collecting, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        cleanTitle,
        fields.alt_title ?? null,
        fields.author ?? null,
        fields.publisher ?? null,
        language,
        fields.region ?? null,
        fields.currency || DEFAULT_CURRENCY,
        workKey,
        status.value,
        fields.tags ?? null,
        fields.total_volumes ?? null,
        fields.description ?? null,
        fields.cover_image ?? null,
        fields.banner_image ?? null,
        // Manga Passion only knows German editions
        isMpLanguage(language) ? fields.manga_passion_id ?? null : null,
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
    const { fields, error, code } = readMangaFields(body, manga);
    if (error) throw badRequest(error, code);
    // a stored status from before the whitelist may be sent back unchanged
    let status = manga.status || 'Laufend';
    if (body.status !== undefined && body.status !== manga.status) {
        const r = parseSeriesStatus(body.status);
        if (r.error) throw badRequest(r.error);
        status = r.value;
    }
    const pick = (field) => (fields[field] !== undefined ? fields[field] : manga[field]);
    const language = fields.language === null ? defaultLanguageOf(ctx) : (pick('language') || DEFAULT_LANGUAGE);

    ctx.db.prepare(`
        UPDATE mangas SET title = ?, alt_title = ?, author = ?, publisher = ?,
        language = ?, region = ?, currency = ?, status = ?, tags = ?, total_volumes = ?,
        description = ?, cover_image = ?,
        banner_image = ?, manga_passion_id = ?, wish_priority = ?, collecting = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        body.title !== undefined ? body.title.trim() : manga.title,
        pick('alt_title') || null,
        pick('author') || null,
        fields.publisher !== undefined ? fields.publisher : (normalizePublisher(manga.publisher) || null),
        language,
        pick('region') ?? null,
        pick('currency') || DEFAULT_CURRENCY,
        status,
        pick('tags') || null,
        pick('total_volumes') ?? null,
        pick('description') || null,
        pick('cover_image') || null,
        pick('banner_image') || null,
        isMpLanguage(language) ? pick('manga_passion_id') ?? null : null,
        pick('wish_priority') ?? null,
        pick('collecting') || 'aktiv',
        ctx.user.id,
        params.id
    );
    return { body: { success: true } };
}

/**
 * POST /mangas/:id/editions: the same work in another language as a new series. Copies the descriptive fields of the
 * source; both share the source's work key (a fresh manual one when it has none).
 */
function createEdition(ctx, { params, body }) {
    const source = ctx.db.prepare('SELECT * FROM mangas WHERE id = ?').get(params.id);
    if (!source) throw notFound('Manga');
    if (body.language === undefined || body.language === null || body.language === '') {
        throw badRequest('Sprache ist erforderlich', 'LANGUAGE_INVALID');
    }
    const edition = readEditionFields(body);
    if (edition.error) throw badRequest(edition.error, edition.code);
    let title = source.title;
    if (body.title !== undefined && body.title !== null && body.title !== '') {
        if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest('Titel darf nicht leer sein');
        if (body.title.trim().length > 300) throw badRequest('Titel ist zu lang (maximal 300 Zeichen)');
        title = body.title.trim();
    }
    let publisher = null;
    if (body.publisher !== undefined) {
        const r = cleanText('publisher', body.publisher);
        if (r.error) throw badRequest(r.error);
        publisher = normalizePublisher(r.value) || null;
    }
    const workKey = source.work_key || newManualWorkKey(ctx);
    const { fields } = edition;
    const id = ctx.db.transaction(() => {
        if (!source.work_key) ctx.db.prepare('UPDATE mangas SET work_key = ? WHERE id = ?').run(workKey, source.id);
        return Number(ctx.db.prepare(`
            INSERT INTO mangas (title, alt_title, author, publisher, language, region, currency, work_key, status, tags, total_volumes,
                                description, cover_image, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Laufend', ?, ?, ?, ?, ?)
        `).run(title, source.alt_title, source.author, publisher, fields.language, fields.region ?? null, fields.currency || DEFAULT_CURRENCY,
            workKey, source.tags, source.total_volumes, source.description, source.cover_image, ctx.user.id).lastInsertRowid);
    });
    return { status: 201, body: { success: true, id, work_key: workKey } };
}

/**
 * PUT /mangas/:id/work { link_to }: joins the work of another series (both groups merge into one key: an AniList key
 * wins, else the target's) or, with null, takes this series out of its work.
 */
function linkWork(ctx, { params, body }) {
    const manga = ctx.db.prepare('SELECT id, work_key FROM mangas WHERE id = ?').get(params.id);
    if (!manga) throw notFound('Manga');
    if (body.link_to === undefined) throw badRequest('link_to ist erforderlich (Reihen-ID oder null)');
    let workKey = null;
    if (body.link_to === null || body.link_to === '') {
        ctx.db.transaction(() => {
            ctx.db.prepare('UPDATE mangas SET work_key = NULL WHERE id = ?').run(manga.id);
            // a manual group of one is no group: its key would otherwise wait for the next link
            if (isManualWorkKey(manga.work_key)) {
                const left = ctx.db.prepare('SELECT id FROM mangas WHERE work_key = ? LIMIT 2').all(manga.work_key);
                if (left.length === 1) ctx.db.prepare('UPDATE mangas SET work_key = NULL WHERE id = ?').run(left[0].id);
            }
        });
    } else {
        const targetId = parsePositiveInt(body.link_to);
        if (!targetId) throw badRequest('Ungültige Reihen-ID in link_to');
        if (targetId === manga.id) throw badRequest('Eine Reihe kann nicht mit sich selbst verknüpft werden');
        const target = ctx.db.prepare('SELECT id, work_key FROM mangas WHERE id = ?').get(targetId);
        if (!target) throw notFound('Manga');
        workKey = preferredWorkKey(manga.work_key, target.work_key) || newManualWorkKey(ctx);
        ctx.db.transaction(() => {
            const regroup = ctx.db.prepare('UPDATE mangas SET work_key = ? WHERE work_key = ?');
            for (const key of new Set([manga.work_key, target.work_key])) if (key && key !== workKey) regroup.run(workKey, key);
            ctx.db.prepare('UPDATE mangas SET work_key = ? WHERE id IN (?, ?)').run(workKey, manga.id, target.id);
        });
    }
    return { body: { success: true, work_key: workKey, editions: snapshot.loadEditions(ctx, { id: manga.id, work_key: workKey }) } };
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

module.exports = { list, create, detail, update, remove, tags, createEdition, linkWork, readMangaFields, COLLECTING_STATUSES };
