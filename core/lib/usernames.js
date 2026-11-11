// Usernames ignore case in every alphabet: "Jörg", "JÖRG" and "jörg" are one account. SQLite's COLLATE NOCASE folds
// ASCII only, so a lookup by name asks the index first and falls back to comparing folded names (NFKC, lower case).
// An exact match (as typed, or in NFC) wins if old data holds two spellings.

const foldUsername = (name) => String(name ?? '').trim().normalize('NFKC').toLowerCase();

/**
 * The account row for a typed name, or undefined. `columns` is the SELECT list. Written as IN, not as two NOCASE
 * equalities joined by OR: SQLite 3.47 (Node 22.13) turns that OR into a case-sensitive lookup.
 */
function findUserByName(db, name, columns = '*') {
    const typed = String(name ?? '').trim();
    if (!typed) return undefined;
    const direct = db.prepare(`SELECT ${columns} FROM users WHERE (username COLLATE NOCASE) IN (?, ?) ORDER BY (username = ?) DESC, id ASC LIMIT 1`)
        .get(typed, typed.normalize('NFC'), typed);
    if (direct) return direct;
    const folded = foldUsername(typed);
    const hit = db.prepare('SELECT id, username FROM users ORDER BY id').all().find(u => foldUsername(u.username) === folded);
    return hit ? db.prepare(`SELECT ${columns} FROM users WHERE id = ?`).get(hit.id) : undefined;
}

/** Whether two names are the same account name (see foldUsername). */
const sameUsername = (a, b) => typeof a === 'string' && typeof b === 'string' && foldUsername(a) === foldUsername(b);

module.exports = { foldUsername, findUserByName, sameUsername };
