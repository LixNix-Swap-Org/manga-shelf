// Optimistic changes (outbox): a read / owned / status toggle applied to a series detail and to its row in the series
// list the way the server would apply it, with the aggregates (values, progress, reader_stats) recomputed.
import { getVolumeProgressCounts } from './volumeHelpers.js';

const OWNED = 'Vorhanden';
const same = (a, b) => String(a) === String(b);
const priceOf = (v) => (typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0));
const round2 = (n) => Math.round(n * 100) / 100;

function usernameOf(detail, userId, me) {
  if (me && same(me.id, userId)) return me.username ?? '';
  return detail?.reader_stats?.find((r) => same(r.user_id, userId))?.username ?? '';
}

/** The volume after the change; null when the change does not apply (unknown kind). */
export function patchVolume(vol, change, { detail, me } = {}) {
  const target = change.targetUserId ?? me?.id;
  const meId = me?.id;
  if (change.kind === 'read') {
    const readers = (vol.read_users || []).filter((u) => !same(u.user_id ?? u.id, target));
    if (change.value) readers.push({ id: target, user_id: target, username: usernameOf(detail, target, me) });
    const readBy = readers.map((u) => u.user_id ?? u.id);
    return { ...vol, read_users: readers, read_by: readBy, is_read: meId !== undefined ? readBy.some((id) => same(id, meId)) : vol.is_read };
  }
  if (change.kind === 'owned' || change.kind === 'purchase') {
    const owners = (vol.owners || []).filter((o) => !same(o.user_id, target));
    const wantOwned = change.kind === 'purchase' ? true : Boolean(change.value);
    if (wantOwned) {
      const purchaseDate = change.purchase_date || vol.purchase_date || null;
      owners.push({ user_id: target, username: usernameOf(detail, target, me), price: vol.price ?? null, purchase_date: purchaseDate });
    }
    let status = vol.status;
    if (owners.length && status !== OWNED) status = OWNED;
    else if (!owners.length && status === OWNED) status = 'Fehlt';
    const next = { ...vol, owners, status, owned_by_me: meId !== undefined ? owners.some((o) => same(o.user_id, meId)) : vol.owned_by_me };
    if (status !== OWNED) next.purchase_date = null;
    else if (!vol.purchase_date && wantOwned && change.purchase_date) next.purchase_date = change.purchase_date;
    return next;
  }
  if (change.kind === 'status') {
    const status = change.value;
    if (status === OWNED) {
      const owners = vol.owners?.length || meId === undefined
        ? vol.owners || []
        : [{ user_id: meId, username: me?.username ?? '', price: vol.price ?? null, purchase_date: vol.purchase_date ?? null }];
      return { ...vol, status, owners, owned_by_me: owners.some((o) => same(o.user_id, meId)) };
    }
    return { ...vol, status, owners: [], owned_by_me: false };
  }
  return null;
}

/** owned_volumes, values, wished and reader_stats of a detail from its volumes (same rules as core/snapshot.js). */
export function recomputeDetail(detail) {
  const volumes = detail.volumes || [];
  let total = 0;
  let full = 0;
  let owned = 0;
  const reads = new Map();
  for (const v of volumes) {
    const p = priceOf(v);
    full += p;
    if (v.status !== OWNED) continue;
    total += p;
    owned++;
    for (const id of v.read_by || (v.read_users || []).map((u) => u.user_id ?? u.id)) {
      reads.set(String(id), (reads.get(String(id)) || 0) + 1);
    }
  }
  const next = { ...detail, owned_volumes: owned, total_value: round2(total), full_value: round2(full) };
  if ('wish_priority' in detail) {
    next.wished = detail.wish_priority !== null && detail.wish_priority !== undefined && owned === 0 ? 1 : 0;
  } else if ('wished' in detail) {
    next.wished = owned === 0 ? detail.wished : 0;
  }
  if (Array.isArray(detail.reader_stats)) {
    next.reader_stats = detail.reader_stats.map((r) => {
      const count = reads.get(String(r.user_id)) || 0;
      return {
        ...r,
        read_count: count,
        total_owned: owned,
        unread_count: owned - count,
        percentage: owned > 0 ? Math.min(100, Math.round((count / owned) * 100)) : 0
      };
    });
  }
  return next;
}

/** The detail with the change applied to one volume and the aggregates recomputed; the same object when nothing matched. */
export function applyVolumeChange(detail, change, me) {
  if (!detail || !Array.isArray(detail.volumes)) return detail;
  let changed = false;
  const volumes = detail.volumes.map((v) => {
    if (!same(v.id, change.volumeId)) return v;
    const next = patchVolume(v, change, { detail, me });
    if (!next) return v;
    changed = true;
    return next;
  });
  return changed ? recomputeDetail({ ...detail, volumes }) : detail;
}

/** The series row of the list with the aggregates GET /api/mangas derives from the volumes, taken from a patched detail. */
export function applyDetailToListRow(row, detail, me) {
  if (!row || !detail || !same(row.id, detail.id)) return row;
  const volumes = detail.volumes || [];
  const counts = getVolumeProgressCounts(volumes);
  const meId = me?.id;
  const readOwned = meId === undefined
    ? row.read_volume_count
    : volumes.filter((v) => v.status === OWNED && (v.read_by || []).some((id) => same(id, meId))).length;
  return {
    ...row,
    owned_volumes: counts.owned_volumes,
    regular_owned: counts.regular_owned,
    max_regular_number: counts.max_regular_number,
    extras_owned: counts.extras_owned,
    total_value: detail.total_value ?? row.total_value,
    read_volume_count: readOwned,
    missing_count: volumes.filter((v) => v.status === 'Fehlt').length,
    preorder_count: volumes.filter((v) => v.status === 'Vorbestellt' || v.status === 'Bestellt').length,
    ...(detail.collecting !== undefined ? { collecting: detail.collecting } : {}),
    ...(detail.wished !== undefined ? { wished: detail.wished } : {})
  };
}

export const applyDetailToList = (list, detail, me) => (Array.isArray(list)
  ? list.map((row) => applyDetailToListRow(row, detail, me))
  : list);
