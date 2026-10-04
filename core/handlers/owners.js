// Ownership per user (POST /volumes/:id/owners): several people can own the same volume.
const {
    OWNED_STATUS, isLegacyReadStatus, addOwner, listOwners, syncStatusWithOwners, convertLegacyRead, purchaseDateFromRemainingOwners
} = require('../lib/owners');
const { resolveTargetUser } = require('../lib/access');
const { badRequest, notFound } = require('../errors');
const { isBlank, parsePrice, parseFlag, isValidDate, parseDate } = require('../lib/validate');
const { FIELD_ERRORS, DATE_ERROR } = require('./volumes');

function toggleOwner(ctx, { params, body }) {
    const volumeId = parseInt(params.id, 10);
    const vol = ctx.db.prepare('SELECT id, manga_id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) throw notFound('Band');
    // Jeder ändert nur den eigenen Besitz; Admins dürfen für andere eintragen
    const targetUserId = resolveTargetUser(ctx, body.user_id);
    const ownerPrice = parsePrice(body.price);
    if (ownerPrice.error) throw badRequest(FIELD_ERRORS.price);
    if (!isValidDate(body.purchase_date)) throw badRequest(DATE_ERROR);
    // undo of a toggle: the volume date as the earlier answer reported it (previous_purchase_date)
    const restoreDate = Object.prototype.hasOwnProperty.call(body, 'previous_purchase_date') ? parseDate(body.previous_purchase_date) : null;
    if (restoreDate?.error) throw badRequest(DATE_ERROR);

    let status;
    let removedOwner = null;
    ctx.db.transaction(() => {
        const isOwner = () => Boolean(ctx.db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? AND user_id = ?').get(volumeId, targetUserId));
        const wasOwner = isOwner();
        const hadOwners = Boolean(ctx.db.prepare('SELECT 1 FROM volume_owners WHERE volume_id = ? LIMIT 1').get(volumeId));
        const wantOwned = body.owned !== undefined ? parseFlag(body.owned) : !wasOwner;
        const ownerPriceValue = ownerPrice.value ?? vol.price;
        const ownerDate = isBlank(body.purchase_date) ? vol.purchase_date : String(body.purchase_date).trim();
        // a legacy 'Gelesen' row is converted while its owners are still there (else the target becomes its owner)
        convertLegacyRead(ctx.db, volumeId, targetUserId);
        const ownsNow = isOwner();
        if (wantOwned && !wasOwner) {
            if (ownsNow) {
                ctx.db.prepare('UPDATE volume_owners SET price = ?, purchase_date = ? WHERE volume_id = ? AND user_id = ?')
                    .run(ownerPriceValue, ownerDate, volumeId, targetUserId);
            } else {
                addOwner(ctx.db, volumeId, targetUserId, { price: ownerPriceValue, purchase_date: ownerDate, condition: vol.condition });
            }
        } else if (!wantOwned && ownsNow) {
            removedOwner = ctx.db.prepare('SELECT user_id, price, purchase_date, condition FROM volume_owners WHERE volume_id = ? AND user_id = ?')
                .get(volumeId, targetUserId);
            ctx.db.prepare('DELETE FROM volume_owners WHERE volume_id = ? AND user_id = ?').run(volumeId, targetUserId);
        }
        status = syncStatusWithOwners(ctx.db, volumeId);
        if (removedOwner && status === OWNED_STATUS) purchaseDateFromRemainingOwners(ctx.db, volumeId);
        // stats, CSV and the edit form read volumes.purchase_date: the first purchase fills it, never overwrites it
        const becameOwned = wantOwned && !hadOwners && vol.status !== OWNED_STATUS && !isLegacyReadStatus(vol.status);
        if (becameOwned && status === OWNED_STATUS && !isBlank(ownerDate)) {
            ctx.db.prepare("UPDATE volumes SET purchase_date = ? WHERE id = ? AND (purchase_date IS NULL OR TRIM(purchase_date) = '')")
                .run(ownerDate, volumeId);
        }
        if (restoreDate) ctx.db.prepare('UPDATE volumes SET purchase_date = ? WHERE id = ?').run(restoreDate.value, volumeId);
    });

    const owners = listOwners(ctx.db, volumeId);
    return {
        body: {
            success: true,
            status,
            owners,
            owned_by_me: owners.some(o => o.user_id === ctx.user.id),
            purchase_date: ctx.db.prepare('SELECT purchase_date FROM volumes WHERE id = ?').get(volumeId)?.purchase_date ?? null,
            previous_purchase_date: vol.purchase_date,
            removed_owner: removedOwner
        }
    };
}

module.exports = { toggleOwner };
