// The undo of one POST /api/volumes/:id/owners answer, shared by the editor's owners field and the quick un-own.
const hasKey = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Body that reverses one owners answer: an un-own comes back with the removed row's price and date, a buy goes again;
 * both put the volume's purchase date back (previous_purchase_date). null when the answer cannot be reversed.
 */
export function ownersUndoBody(data, wasOwned, target = {}) {
  const restoreDate = hasKey(data, 'previous_purchase_date') ? { previous_purchase_date: data.previous_purchase_date ?? null } : {};
  if (!wasOwned) return { owned: false, ...target, ...restoreDate };
  const removed = data?.removed_owner;
  if (!removed) return null;
  const lent = removed.lent_to_user_id
    ? { user_id: removed.lent_to_user_id, ...(removed.lent_at ? { at: removed.lent_at } : {}) }
    : (removed.lent_to_name ? { name: removed.lent_to_name, ...(removed.lent_at ? { at: removed.lent_at } : {}) } : null);
  return {
    owned: true,
    ...target,
    ...(removed.price !== null && removed.price !== undefined ? { price: removed.price } : {}),
    ...(removed.purchase_date ? { purchase_date: removed.purchase_date } : {}),
    ...(removed.condition ? { condition: removed.condition } : {}),
    ...(lent ? { lent } : {}),
    // further copies of the person come back too (migration 56)
    ...(Array.isArray(data.removed_extra_copies) && data.removed_extra_copies.length ? { extra_copies: data.removed_extra_copies } : {}),
    ...restoreDate
  };
}
