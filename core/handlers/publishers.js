// Publisher names and aliases: GET /publishers, POST /publishers/merge, DELETE /publishers/aliases/:alias.
const { badRequest, notFound } = require('../errors');
const { normalizePublisher, resolvePublisher, publisherKey, loadPublisherAliases, isKnownPublisher } = require('../lib/publishers');

const MAX_NAME = 300;
const MAX_FROM = 50;

/** Every stored spelling with its series and volume counts, plus the stored aliases. */
function list(ctx) {
    const byName = new Map();
    const add = (name, field, count) => {
        const entry = byName.get(name) || { name, series_count: 0, volume_count: 0 };
        entry[field] += count;
        byName.set(name, entry);
    };
    for (const r of ctx.db.prepare("SELECT publisher AS name, count(*) AS n FROM mangas WHERE publisher IS NOT NULL AND TRIM(publisher) <> '' GROUP BY publisher").all()) {
        add(r.name, 'series_count', r.n);
    }
    for (const r of ctx.db.prepare("SELECT publisher AS name, count(*) AS n FROM volumes WHERE publisher IS NOT NULL AND TRIM(publisher) <> '' GROUP BY publisher").all()) {
        add(r.name, 'volume_count', r.n);
    }
    const publishers = [...byName.values()]
        .map(p => {
            const canonical = normalizePublisher(p.name);
            return { ...p, canonical, known: isKnownPublisher(canonical), outdated: canonical !== p.name };
        })
        .sort((a, b) => (b.series_count + b.volume_count) - (a.series_count + a.volume_count) || a.name.localeCompare(b.name, 'de'));
    const aliases = ctx.db.prepare('SELECT alias, canonical, created_at FROM publisher_aliases ORDER BY canonical COLLATE NOCASE, alias').all();
    return { body: { publishers, aliases } };
}

function cleanName(value) {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\s+/g, ' ').trim();
    return text && text.length <= MAX_NAME ? text : null;
}

/** Rows whose publisher resolves to `target` with `aliases` take that spelling; returns the changed row counts. */
function rewriteRows(ctx, aliases, target) {
    const changed = {};
    for (const table of ['mangas', 'volumes']) {
        changed[table] = 0;
        const rows = ctx.db.prepare(`SELECT DISTINCT publisher FROM ${table} WHERE publisher IS NOT NULL AND TRIM(publisher) <> ''`).all();
        const update = ctx.db.prepare(`UPDATE ${table} SET publisher = ? WHERE publisher = ?`);
        for (const { publisher } of rows) {
            if (publisher === target) continue;
            if (resolvePublisher(publisher, aliases) === target) changed[table] += update.run(target, publisher).changes;
        }
    }
    return changed;
}

/**
 * { from: name | [names], to: name }: every spelling in `from` becomes an alias of `to` and all series and volumes
 * with one of them are rewritten, in one transaction. A rename is a merge into a new name. Aliases that pointed at a
 * merged name follow; an alias of `to` itself is dropped (it is canonical now).
 */
function merge(ctx, { body }) {
    const to = cleanName(body.to);
    if (!to) throw badRequest('Ziel-Verlag fehlt oder ist zu lang (maximal 300 Zeichen)');
    const rawFrom = Array.isArray(body.from) ? body.from : [body.from];
    if (rawFrom.length === 0 || rawFrom.length > MAX_FROM) throw badRequest(`Bitte 1 bis ${MAX_FROM} Verlage zum Zusammenführen angeben`);
    const from = rawFrom.map(cleanName);
    if (from.some(f => !f)) throw badRequest('Ungültiger Verlagsname');
    const toKey = publisherKey(to);

    let changed = null;
    ctx.db.transaction(() => {
        const upsert = ctx.db.prepare('INSERT INTO publisher_aliases (alias, canonical) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET canonical = excluded.canonical');
        const follow = ctx.db.prepare('UPDATE publisher_aliases SET canonical = ? WHERE lower(canonical) = ?');
        for (const name of from) {
            const key = publisherKey(name);
            follow.run(to, key);
            if (key !== toKey) upsert.run(key, to);
        }
        follow.run(to, toKey);
        ctx.db.prepare('DELETE FROM publisher_aliases WHERE alias = ?').run(toKey);
        const aliases = new Map(ctx.db.prepare('SELECT alias, canonical FROM publisher_aliases').all().map(r => [r.alias, r.canonical]));
        changed = rewriteRows(ctx, aliases, to);
        // exact spellings of the target ("carlsen manga" -> "Carlsen Manga") are rewritten as well
        for (const table of ['mangas', 'volumes']) {
            changed[table] += ctx.db.prepare(`UPDATE ${table} SET publisher = ? WHERE lower(trim(publisher)) = ? AND publisher <> ?`).run(to, toKey, to).changes;
        }
    });
    loadPublisherAliases(ctx.db);
    return { body: { success: true, to, updated_series: changed.mangas, updated_volumes: changed.volumes } };
}

function removeAlias(ctx, { params }) {
    const key = publisherKey(String(params.alias || ''));
    if (!key) throw badRequest('Ungültiger Alias');
    if (ctx.db.prepare('DELETE FROM publisher_aliases WHERE alias = ?').run(key).changes === 0) throw notFound('Alias');
    loadPublisherAliases(ctx.db);
    return { body: { success: true } };
}

module.exports = { list, merge, removeAlias };
