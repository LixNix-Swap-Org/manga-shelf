// Tags of anime entries (migration 49): one row per person and tag in anime_tags. Everybody sees every tag of an entry
// (the shared chip list of the Anime tab); a person removes only the tags they added and the old ones from before
// migration 49 (user_id NULL, nobody's own), an admin any. So nobody can take away what someone else added.
const { badRequest, msg } = require('../errors');

const MAX_TAGS = 20;
const MAX_TAG = 30;

const fold = (name) => name.toLowerCase();

/** A list of tag names as PUT /anime/:id takes them: null or [] is none, else at most 20 names of 1 to 30 characters. */
function parseTags(value) {
    if (value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_TAGS) throw badRequest(msg('Tags müssen eine Liste mit höchstens {max} Namen sein', { max: MAX_TAGS }));
    const seen = new Set();
    const tags = [];
    for (const raw of value) {
        const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
        if (!name || name.length > MAX_TAG) throw badRequest(msg('Ein Tag hat 1 bis {max} Zeichen', { max: MAX_TAG }));
        if (!seen.has(fold(name))) { seen.add(fold(name)); tags.push(name); }
    }
    return tags;
}

/** The tag rows of one entry or (no id) of all entries, oldest first: [{ anime_id, user_id, tag }]. */
const tagRows = (db, animeId) => (animeId === undefined
    ? db.prepare('SELECT anime_id, user_id, tag FROM anime_tags ORDER BY anime_id, id').all()
    : db.prepare('SELECT anime_id, user_id, tag FROM anime_tags WHERE anime_id = ? ORDER BY id').all(animeId));

/** Whether `user` may take away a tag row: their own, an old one without owner, or any as admin. */
const mayRemove = (user, row) => Boolean(user) && (row.user_id === null || row.user_id === user.id || user.role === 'admin');

/**
 * { tags, removable_tags } of one entry for `user`: every name once (first spelling, oldest first) and those of them the
 * user may remove (only when every row of that name is theirs to remove, so the chip really goes).
 */
function tagFields(rows, user) {
    const byName = new Map();
    for (const row of rows) {
        const key = fold(row.tag);
        if (!byName.has(key)) byName.set(key, { name: row.tag, removable: true });
        if (!mayRemove(user, row)) byName.get(key).removable = false;
    }
    const all = [...byName.values()];
    return { tags: all.map((t) => t.name), removable_tags: all.filter((t) => t.removable).map((t) => t.name) };
}

/** tagFields for every entry: Map anime_id -> { tags, removable_tags }. */
function tagFieldsByAnime(db, user) {
    const byAnime = new Map();
    for (const row of tagRows(db)) {
        if (!byAnime.has(row.anime_id)) byAnime.set(row.anime_id, []);
        byAnime.get(row.anime_id).push(row);
    }
    const out = new Map();
    for (const [id, rows] of byAnime) out.set(id, tagFields(rows, user));
    return out;
}

const NO_TAGS = Object.freeze({ tags: [], removable_tags: [] });

/**
 * Applies a tag change of PUT /anime/:id for `user` inside the caller's transaction: `tags` (the whole list as the user
 * wants to see it: what they may remove and is missing goes, what is new becomes theirs) or `add` / `remove` (one change,
 * so two people tagging at once both keep theirs). A name someone else added stays. More than 20 names afterwards is 400.
 * Returns true when something was written.
 */
function changeTags(db, animeId, user, { tags, add, remove } = {}) {
    const rows = tagRows(db, animeId);
    const added = tags !== undefined ? parseTags(tags) : (add === undefined ? [] : parseTags(add));
    let removed;
    if (tags !== undefined) {
        const keep = new Set(added.map(fold));
        removed = new Set(rows.filter((r) => !keep.has(fold(r.tag))).map((r) => fold(r.tag)));
    } else {
        removed = new Set((remove === undefined ? [] : parseTags(remove)).map(fold));
    }
    let changes = 0;
    const drop = db.prepare('DELETE FROM anime_tags WHERE id = ?');
    for (const row of db.prepare('SELECT id, user_id, tag FROM anime_tags WHERE anime_id = ?').all(animeId)) {
        if (removed.has(fold(row.tag)) && mayRemove(user, row)) changes += drop.run(row.id).changes;
    }
    const left = new Set(db.prepare('SELECT tag FROM anime_tags WHERE anime_id = ?').all(animeId).map((r) => fold(r.tag)));
    const insert = db.prepare('INSERT OR IGNORE INTO anime_tags (anime_id, user_id, tag) VALUES (?, ?, ?)');
    for (const name of added) {
        if (left.has(fold(name))) continue;
        changes += insert.run(animeId, user.id, name).changes;
        left.add(fold(name));
    }
    if (left.size > MAX_TAGS) throw badRequest(msg('Tags müssen eine Liste mit höchstens {max} Namen sein', { max: MAX_TAGS }));
    return changes > 0;
}

module.exports = { MAX_TAGS, MAX_TAG, parseTags, tagFields, tagFieldsByAnime, tagRows, changeTags, NO_TAGS };
