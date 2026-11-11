// "Gemerkte Filter": a person's saved combinations of the collection filters, with the account on every device.
//   GET    /saved-filters        own list, oldest first
//   POST   /saved-filters        { label, filters } -> the list; the same filters again keep the one entry, beyond
//                                 SAVED_FILTER_LIMIT the oldest goes
//   DELETE /saved-filters/:id    only an own entry
const { badRequest, notFound } = require('../errors');
const { parsePositiveInt } = require('../lib/validate');

const SAVED_FILTER_LIMIT = 8;
const LABEL_MAX = 120;
// the fields of the collection filter (frontend/src/components/dashboard/SavedFilters.jsx filterSnapshot)
const TEXT_FIELDS = ['status', 'publisher', 'collect', 'author', 'lang', 'shelf', 'person', 'sort', 'group'];
const TEXT_MAX = 200;

function cleanFilters(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Ungültige Filter', 'SAVED_FILTER');
    const out = {};
    for (const field of TEXT_FIELDS) {
        const value = input[field];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string' && typeof value !== 'number') throw badRequest('Ungültige Filter', 'SAVED_FILTER');
        out[field] = String(value).slice(0, TEXT_MAX);
    }
    const tags = input.tags === undefined || input.tags === null ? [] : input.tags;
    if (!Array.isArray(tags) || tags.length > 50 || tags.some((tag) => typeof tag !== 'string')) throw badRequest('Ungültige Filter', 'SAVED_FILTER');
    out.tags = tags.map((tag) => tag.slice(0, TEXT_MAX));
    return out;
}

// key order fixed, so the same choice compares equal however the client ordered it
const canonical = (filters) => JSON.stringify(Object.fromEntries(Object.keys(filters).sort().map((key) => [key, filters[key]])));

function listOf(ctx) {
    return ctx.db.prepare('SELECT id, label, filters, created_at FROM saved_filters WHERE user_id = ? ORDER BY id').all(ctx.user.id)
        .map((row) => {
            let filters;
            try { filters = JSON.parse(row.filters); } catch (e) { filters = {}; }
            return { id: row.id, label: row.label, filters, created_at: row.created_at };
        });
}

function list(ctx) {
    return { body: { items: listOf(ctx), limit: SAVED_FILTER_LIMIT } };
}

function add(ctx, { body }) {
    const label = typeof body?.label === 'string' ? body.label.trim().slice(0, LABEL_MAX) : '';
    if (!label) throw badRequest('Bitte einen Namen für den Filter angeben', 'SAVED_FILTER');
    const filters = canonical(cleanFilters(body.filters));
    const existing = ctx.db.prepare('SELECT id FROM saved_filters WHERE user_id = ? AND filters = ?').get(ctx.user.id, filters);
    if (!existing) {
        ctx.db.prepare('INSERT INTO saved_filters (user_id, label, filters, created_at) VALUES (?, ?, ?, ?)')
            .run(ctx.user.id, label, filters, new Date(ctx.now()).toISOString());
        // beyond the limit the oldest go
        ctx.db.prepare(`DELETE FROM saved_filters WHERE user_id = ? AND id NOT IN (
            SELECT id FROM saved_filters WHERE user_id = ? ORDER BY id DESC LIMIT ?)`).run(ctx.user.id, ctx.user.id, SAVED_FILTER_LIMIT);
    }
    return { status: existing ? 200 : 201, body: { items: listOf(ctx), limit: SAVED_FILTER_LIMIT } };
}

function remove(ctx, { params }) {
    const id = parsePositiveInt(params.id);
    if (!id) throw badRequest('Ungültige ID', 'SAVED_FILTER');
    const gone = ctx.db.prepare('DELETE FROM saved_filters WHERE id = ? AND user_id = ?').run(id, ctx.user.id).changes;
    if (!gone) throw notFound('Gemerkter Filter');
    return { body: { items: listOf(ctx), limit: SAVED_FILTER_LIMIT } };
}

module.exports = { list, add, remove, SAVED_FILTER_LIMIT, cleanFilters };
