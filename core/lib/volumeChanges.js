// "Zuletzt geändert von" (migration 55): volumes.updated_by / updated_at name the account that last changed a volume
// through the app (its fields, status, ownership or copy details; not reading marks, which belong to each person).

/** Marks the volumes as changed by the caller now. Ids that are gone are ignored. */
function touchVolumes(ctx, ids) {
    const userId = ctx.user?.id;
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger))];
    if (!userId || list.length === 0) return;
    const stmt = ctx.db.prepare('UPDATE volumes SET updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    for (const id of list) stmt.run(userId, id);
}

module.exports = { touchVolumes };
