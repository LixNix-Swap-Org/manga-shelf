// Ownership per user (POST /volumes/:id/owners): several people can own the same volume.
const {
    OWNED_STATUS, isLegacyReadStatus, addOwner, listOwners, syncStatusWithOwners, convertLegacyRead, purchaseDateFromRemainingOwners
} = require('../lib/owners');
const { hasCopy, hasOwner, claimHouseholdCopy, updateCopy, removeCopy } = require('../lib/copies');
const { resolveTargetUser, volumeAccess } = require('../lib/access');
const { badRequest, notFound } = require('../errors');
const { isBlank, parsePrice, parseFlag, isValidDate, parseDate, parseCondition } = require('../lib/validate');
const { FIELD_ERRORS, DATE_ERROR } = require('./volumes');
const { readLending } = require('./copies');

function toggleOwner(ctx, { params, body }) {
    const volumeId = parseInt(params.id, 10);
    const vol = ctx.db.prepare('SELECT id, manga_id, status, price, purchase_date, condition FROM volumes WHERE id = ?').get(volumeId);
    if (!vol) throw notFound('Band');
    // Everyone changes only their own ownership; admins may enter it for others who belong to the volume's shelf
    const targetUserId = resolveTargetUser(ctx, body.user_id, volumeAccess(ctx, volumeId, 'editor'));
    const ownerPrice = parsePrice(body.price);
    if (ownerPrice.error) throw badRequest(FIELD_ERRORS.price);
    if (!isValidDate(body.purchase_date)) throw badRequest(DATE_ERROR);
    const hasCondition = Object.prototype.hasOwnProperty.call(body, 'condition');
    const ownerCondition = hasCondition ? parseCondition(body.condition) : null;
    if (ownerCondition?.error) throw badRequest('Ungültiger Zustand');
    const hasLent = Object.prototype.hasOwnProperty.call(body, 'lent');
    const ownerLent = hasLent ? readLending(ctx, body.lent, targetUserId) : null;
    // undo of a toggle: the volume date as the earlier answer reported it (previous_purchase_date)
    const restoreDate = Object.prototype.hasOwnProperty.call(body, 'previous_purchase_date') ? parseDate(body.previous_purchase_date) : null;
    if (restoreDate?.error) throw badRequest(DATE_ERROR);

    let status;
    let removedOwner = null;
    ctx.db.transaction(() => {
        const isOwner = () => hasCopy(ctx.db, volumeId, targetUserId);
        const wasOwner = isOwner();
        const hadOwners = hasOwner(ctx.db, volumeId);
        const wantOwned = body.owned !== undefined ? parseFlag(body.owned) : !wasOwner;
        const hasExplicitPrice = ownerPrice.value !== null && ownerPrice.value !== undefined;
        const hasExplicitDate = !isBlank(body.purchase_date);
        const ownerPriceValue = ownerPrice.value ?? vol.price;
        const ownerDate = hasExplicitDate ? String(body.purchase_date).trim() : vol.purchase_date;
        const ownerCondValue = hasCondition ? ownerCondition.value : vol.condition;
        // a legacy 'Gelesen' row is converted while its owners are still there (else the target becomes its owner)
        convertLegacyRead(ctx.db, volumeId, targetUserId);
        const ownsNow = isOwner();
        if (wantOwned && !wasOwner) {
            if (ownsNow) {
                updateCopy(ctx.db, volumeId, targetUserId, {
                    price: ownerPriceValue,
                    purchase_date: ownerDate,
                    ...(hasCondition ? { condition: ownerCondValue } : {})
                });
            } else if (!hasOwner(ctx.db, volumeId) && claimHouseholdCopy(ctx.db, volumeId, targetUserId)) {
                const copy = ctx.db.prepare('SELECT purchase_price, purchase_date, condition FROM volume_copies WHERE volume_id = ? AND owner_user_id = ?')
                    .get(volumeId, targetUserId);
                updateCopy(ctx.db, volumeId, targetUserId, {
                    price: hasExplicitPrice ? ownerPrice.value : (copy?.purchase_price ?? vol.price),
                    purchase_date: hasExplicitDate ? ownerDate : (copy?.purchase_date ?? vol.purchase_date),
                    condition: hasCondition ? ownerCondValue : (copy?.condition ?? vol.condition)
                });
            } else {
                addOwner(ctx.db, volumeId, targetUserId, {
                    price: ownerPriceValue,
                    purchase_date: ownerDate,
                    condition: ownerCondValue,
                    ...(ownerLent || {})
                });
            }
            if (ownerLent) {
                ctx.db.prepare('UPDATE volume_copies SET lent_to_user_id = ?, lent_to_name = ?, lent_at = ? WHERE volume_id = ? AND owner_user_id = ?')
                    .run(ownerLent.lent_to_user_id, ownerLent.lent_to_name, ownerLent.lent_at, volumeId, targetUserId);
            }
        } else if (!wantOwned && ownsNow) {
            removedOwner = ctx.db.prepare(
                'SELECT user_id, price, purchase_date, condition, lent_to_user_id, lent_to_name, lent_at FROM volume_owners WHERE volume_id = ? AND user_id = ?'
            ).get(volumeId, targetUserId);
            removeCopy(ctx.db, volumeId, targetUserId);
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
