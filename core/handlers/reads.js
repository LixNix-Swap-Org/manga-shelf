// Reading state per user: toggle, read up to volume X, personal reading statistics.
const access = require('../lib/access');
const { resolveTargetUser } = access;
const { badRequest, notFound } = require('../errors');
const { isBlank, parseFlag, isValidReadAt } = require('../lib/validate');
const { addRead, removeRead, readOf } = require('../lib/marks');

function toggleRead(ctx, { params, body }) {
    const volumeId = parseInt(params.id, 10);
    const vol = ctx.db.prepare('SELECT id FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) throw notFound('Band');
    const targetUserId = resolveTargetUser(ctx, body.user_id, access.volumeAccess(ctx, volumeId, 'viewer'));
    // undo of "unread": the read comes back with its original date (previous_read_at of that answer)
    const readAt = body.read_at;
    if (!isBlank(readAt) && !isValidReadAt(readAt)) throw badRequest('Ungültiger Lesezeitpunkt (erwartet: JJJJ-MM-TT HH:MM:SS, UTC)');

    const existing = readOf(ctx.db, volumeId, targetUserId);
    const explicitRead = body.read !== undefined ? body.read : body.is_read;
    const isRead = explicitRead !== undefined ? parseFlag(explicitRead) : !existing;
    let previousReadAt = null;
    if (isRead && !existing) {
        addRead(ctx.db, volumeId, targetUserId, isBlank(readAt) ? undefined : readAt.trim());
    } else if (!isRead && existing) {
        removeRead(ctx.db, volumeId, targetUserId);
        previousReadAt = existing.read_at;
    }

    const readRows = ctx.db.prepare('SELECT vr.user_id, u.username, vr.read_at FROM shelf_volume_reads vr JOIN users u ON vr.user_id = u.id WHERE vr.volume_id = ?').all(volumeId);
    const readBy = readRows.map(r => r.user_id);

    const answer = { success: true, is_read: isRead, read_by: readBy, read_users: readRows };
    if (!isRead) answer.previous_read_at = previousReadAt;
    return { body: answer };
}

function batchRead(ctx, { body }) {
    const readParam = body.read !== undefined ? body.read : body.is_read;
    const read = readParam !== undefined ? parseFlag(readParam) : true;
    const { manga_id, up_to_volume, user_id } = body;
    const mId = access.parseId(manga_id);
    const maxVol = parseFloat(up_to_volume);

    if (!mId || isNaN(maxVol)) {
        throw badRequest('Ungültige Parameter');
    }
    const readAt = body.read_at;
    if (!isBlank(readAt) && !isValidReadAt(readAt)) throw badRequest('Ungültiger Lesezeitpunkt (erwartet: JJJJ-MM-TT HH:MM:SS, UTC)');
    const targetUserId = resolveTargetUser(ctx, user_id, access.mangaAccess(ctx, mId, 'viewer'));

    const volumes = ctx.db.prepare("SELECT id, volume_number, type FROM volumes WHERE manga_id = ? AND status = 'Vorhanden'").all(mId);
    const targetVols = volumes.filter(v => {
        if (v.type === 'schuber') return false;
        const num = parseFloat(v.volume_number);
        return !isNaN(num) && num <= maxVol;
    });

    const readAtValue = isBlank(readAt) ? undefined : readAt.trim();

    // changed_ids: the entries whose read state this request flipped, so a client can undo exactly those;
    // previous_read_at (unread only) lets that undo restore the original dates
    const changedIds = [];
    const previousReadAt = {};
    ctx.db.transaction(() => {
        for (const v of targetVols) {
            if (read) {
                if (addRead(ctx.db, v.id, targetUserId, readAtValue)) changedIds.push(v.id);
                continue;
            }
            const removed = removeRead(ctx.db, v.id, targetUserId);
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

// another account only for an admin or a member of a shared shelf; anyone else gets 404 as for an unknown id
function userStats(ctx, { params }) {
    const userId = access.parseId(params.id);

    const user = userId && ctx.db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user || !access.canSeeUser(ctx, user.id)) throw notFound('Benutzer');

    const scope = access.inShelves('m.shelf_id', access.accessibleShelfIds(ctx));
    const rows = ctx.db.prepare(`
        SELECT strftime('%Y-%m-%dT%H:%M:%SZ', vr.read_at) AS read_at, v.id, v.volume_number, v.type, v.notes, v.pages,
               v.catalog_volume_id, COALESCE(m.catalog_series_id, -m.id) AS edition,
               m.id as manga_id, m.title as manga_title, m.cover_image as manga_cover
        FROM shelf_volume_reads vr
        JOIN volumes v ON vr.volume_id = v.id
        JOIN mangas m ON v.manga_id = m.id
        WHERE vr.user_id = ? AND v.status = 'Vorhanden' AND ${scope.sql}
        ORDER BY vr.read_at DESC, v.id DESC
    `).all(userId, ...scope.params);

    // A read is stored once per catalog volume; an edition in two of the user's shelves shows it on both rows. Each
    // catalog volume counts once (its first row), and its series is listed under the first row met of its edition.
    const seenVolumes = new Set();
    const editionOf = new Map();
    const readVolumes = [];
    for (const { catalog_volume_id: catalogVolume, edition, ...v } of rows) {
        if (seenVolumes.has(catalogVolume)) continue;
        seenVolumes.add(catalogVolume);
        editionOf.set(v, edition);
        readVolumes.push(v);
    }

    const totalVolumes = readVolumes.length;
    const totalPages = readVolumes.reduce((sum, v) => sum + (v.pages || 0), 0);

    const mangasReadMap = new Map();
    readVolumes.forEach(v => {
        const edition = editionOf.get(v);
        if (!mangasReadMap.has(edition)) {
            mangasReadMap.set(edition, {
                id: v.manga_id,
                title: v.manga_title,
                cover_image: v.manga_cover,
                volumes: []
            });
        }
        mangasReadMap.get(edition).volumes.push({
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
