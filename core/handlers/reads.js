// Reading state per user: toggle, read up to volume X, personal reading statistics.
const { resolveTargetUser } = require('../lib/access');
const { badRequest, notFound } = require('../errors');
const { isBlank, parseFlag, isValidReadAt } = require('../lib/validate');

function toggleRead(ctx, { params, body }) {
    const volumeId = parseInt(params.id, 10);
    const vol = ctx.db.prepare('SELECT id FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) throw notFound('Band');
    const targetUserId = resolveTargetUser(ctx, body.user_id);
    // undo of "unread": the read comes back with its original date (previous_read_at of that answer)
    const readAt = body.read_at;
    if (!isBlank(readAt) && !isValidReadAt(readAt)) throw badRequest('Ungültiger Lesezeitpunkt (erwartet: JJJJ-MM-TT HH:MM:SS, UTC)');

    const existing = ctx.db.prepare('SELECT read_at FROM volume_reads WHERE volume_id = ? AND user_id = ?').get(volumeId, targetUserId);
    const explicitRead = body.read !== undefined ? body.read : body.is_read;
    const isRead = explicitRead !== undefined ? parseFlag(explicitRead) : !existing;
    let previousReadAt = null;
    if (isRead && !existing) {
        if (isBlank(readAt)) ctx.db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(volumeId, targetUserId);
        else ctx.db.prepare('INSERT INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, ?)').run(volumeId, targetUserId, readAt.trim());
    } else if (!isRead && existing) {
        ctx.db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
        previousReadAt = existing.read_at;
    }

    const readRows = ctx.db.prepare('SELECT vr.user_id, u.username, vr.read_at FROM volume_reads vr JOIN users u ON vr.user_id = u.id WHERE vr.volume_id = ?').all(volumeId);
    const readBy = readRows.map(r => r.user_id);

    const answer = { success: true, is_read: isRead, read_by: readBy, read_users: readRows };
    if (!isRead) answer.previous_read_at = previousReadAt;
    return { body: answer };
}

function batchRead(ctx, { body }) {
    const readParam = body.read !== undefined ? body.read : body.is_read;
    const read = readParam !== undefined ? parseFlag(readParam) : true;
    const { manga_id, up_to_volume, user_id } = body;
    const mId = parseInt(manga_id, 10);
    const maxVol = parseFloat(up_to_volume);

    if (!mId || isNaN(maxVol)) {
        throw badRequest('Ungültige Parameter');
    }
    const readAt = body.read_at;
    if (!isBlank(readAt) && !isValidReadAt(readAt)) throw badRequest('Ungültiger Lesezeitpunkt (erwartet: JJJJ-MM-TT HH:MM:SS, UTC)');
    const targetUserId = resolveTargetUser(ctx, user_id);
    if (!ctx.db.prepare('SELECT 1 FROM mangas WHERE id = ?').get(mId)) throw notFound('Manga');

    const volumes = ctx.db.prepare("SELECT id, volume_number, type FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").all(mId);
    const targetVols = volumes.filter(v => {
        if (v.type === 'schuber') return false;
        const num = parseFloat(v.volume_number);
        return !isNaN(num) && num <= maxVol;
    });

    const insertStmt = ctx.db.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, COALESCE(?, CURRENT_TIMESTAMP))');
    const readAtValue = isBlank(readAt) ? null : readAt.trim();
    const deleteStmt = ctx.db.prepare('DELETE FROM volume_reads WHERE volume_id = ? AND user_id = ? RETURNING read_at');

    // changed_ids: the entries whose read state this request flipped, so a client can undo exactly those;
    // previous_read_at (unread only) lets that undo restore the original dates
    const changedIds = [];
    const previousReadAt = {};
    ctx.db.transaction(() => {
        for (const v of targetVols) {
            if (read) {
                if (insertStmt.run(v.id, targetUserId, readAtValue).changes > 0) changedIds.push(v.id);
                continue;
            }
            const removed = deleteStmt.get(v.id, targetUserId);
            if (removed) {
                changedIds.push(v.id);
                previousReadAt[v.id] = removed.read_at;
            }
        }
    });

    const answer = { success: true, count: targetVols.length, changed_ids: changedIds };
    if (!read) answer.previous_read_at = previousReadAt;
    return { body: answer };
}

function userStats(ctx, { params }) {
    const userId = parseInt(params.id, 10);

    const user = ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user) throw notFound('Benutzer');

    const readVolumes = ctx.db.prepare(`
        SELECT strftime('%Y-%m-%dT%H:%M:%SZ', vr.read_at) AS read_at, v.id, v.volume_number, v.type, v.notes, v.pages,
               m.id as manga_id, m.title as manga_title, m.cover_image as manga_cover
        FROM volume_reads vr
        JOIN volumes v ON vr.volume_id = v.id
        JOIN mangas m ON v.manga_id = m.id
        WHERE vr.user_id = ? AND v.status = 'Vorhanden'
        ORDER BY vr.read_at DESC, v.id DESC
    `).all(userId);

    const totalVolumes = readVolumes.length;
    const totalPages = readVolumes.reduce((sum, v) => sum + (v.pages || 0), 0);

    const mangasReadMap = new Map();
    readVolumes.forEach(v => {
        if (!mangasReadMap.has(v.manga_id)) {
            mangasReadMap.set(v.manga_id, {
                id: v.manga_id,
                title: v.manga_title,
                cover_image: v.manga_cover,
                volumes: []
            });
        }
        mangasReadMap.get(v.manga_id).volumes.push({
            id: v.id,
            volume_number: v.volume_number,
            type: v.type,
            notes: v.notes,
            read_at: v.read_at
        });
    });

    const readMangas = Array.from(mangasReadMap.values());

    return {
        body: {
            user: { id: user.id, username: user.username },
            stats: {
                totalVolumes,
                totalPages,
                recentVolumes: readVolumes.slice(0, 10), // Last 10 read volumes for timeline
                readMangas
            }
        }
    };
}

module.exports = { toggleRead, batchRead, userStats };
