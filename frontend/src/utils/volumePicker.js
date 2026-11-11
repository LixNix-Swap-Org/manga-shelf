/** Most volumes the picker in "Neuer Manga" shows (the same limit as one POST /api/volumes/batch). */
export const MAX_PICKED_VOLUMES = 300;

/** The count the picker shows: a typed count wins, else the volumes released so far, else the planned total. */
export function pickerCount({ typed, released, total }) {
  const value = String(typed ?? '').trim() !== '' ? typed : (released || total || 0);
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PICKED_VOLUMES) : 0;
}

/**
 * The batch requests for the picked volumes: runs of consecutive numbers with one status each. Picked numbers are
 * "Vorhanden", the others up to `count` "Fehlt" when `missingRest` is set. Nothing picked creates nothing. `skip` is the
 * scanned volume's number, which is created on its own with its details.
 */
export function volumeRuns({ count, owned, missingRest, skip = null }) {
  const n = Math.min(Math.floor(Number(count)) || 0, MAX_PICKED_VOLUMES);
  const picked = owned instanceof Set ? owned : new Set(owned || []);
  if (n <= 0 || ![...picked].some((v) => v >= 1 && v <= n)) return [];
  const skipped = Number(String(skip ?? '').trim());
  const runs = [];
  let current = null;
  for (let i = 1; i <= n; i += 1) {
    const status = i === skipped ? null : picked.has(i) ? 'Vorhanden' : (missingRest ? 'Fehlt' : null);
    if (status && current && current.status === status && current.to === i - 1) {
      current.to = i;
    } else if (status) {
      current = { from: i, to: i, status };
      runs.push(current);
    } else {
      current = null;
    }
  }
  return runs;
}

/** Picks every number from `from` to `to` (in either order) and keeps the rest of `owned`. */
export function pickRange(owned, from, to) {
  const next = new Set(owned);
  for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) next.add(i);
  return next;
}
