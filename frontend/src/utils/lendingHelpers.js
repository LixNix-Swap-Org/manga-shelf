const LAST_BORROWER_KEY = 'mangashelf_last_borrower';

/**
 * Who may change a copy: its owner, any editor for a household copy, an admin every copy.
 */
export const canChangeCopy = (copy, user, canEdit) =>
  Boolean(canEdit && user) &&
  (copy.owner_user_id === null || copy.owner_user_id === user.id || user.role === 'admin');

/**
 * Retrieve the remembered last borrower for the active user from localStorage.
 * Checks both user-scoped key and fallback global key, supporting both JSON objects and plain strings.
 */
export function getLastBorrower(userId) {
  try {
    const raw =
      globalThis.localStorage?.getItem(`${LAST_BORROWER_KEY}:${userId ?? 'local'}`) ||
      globalThis.localStorage?.getItem('manga_shelf_last_borrower');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
      if (typeof parsed === 'string' && parsed.trim()) return { name: parsed.trim() };
    } catch (_) {
      if (typeof raw === 'string' && raw.trim()) return { name: raw.trim() };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Remember the last borrower in localStorage (both user-scoped and global keys).
 */
export function rememberLastBorrower(userId, borrower) {
  try {
    if (!borrower) return;
    const payload = typeof borrower === 'string' ? { name: borrower } : borrower;
    const json = JSON.stringify(payload);
    globalThis.localStorage?.setItem(`${LAST_BORROWER_KEY}:${userId ?? 'local'}`, json);
    if (payload?.name) {
      globalThis.localStorage?.setItem('manga_shelf_last_borrower', payload.name);
    }
  } catch (_) {
    /* storage unavailable or blocked */
  }
}

/**
 * Select the most suitable unlent copy for quick-lending:
 * 1. Current user's own unlent copy
 * 2. Household unlent copy
 * 3. Any unlent copy (if user is admin / has permission)
 */
export function selectQuickLendCopy(vol, user, canEdit) {
  const copies = vol?.copies || [];
  const unlent = copies.filter((c) => !c.lent_to && canChangeCopy(c, user, canEdit));
  if (unlent.length === 0) return null;

  // 1. Current user's own unlent copy
  const own = unlent.find((c) => c.owner_user_id === user?.id);
  if (own) return own;

  // 2. Household unlent copy
  const household = unlent.find((c) => c.owner_user_id === null);
  if (household) return household;

  // 3. First available unlent copy
  return unlent[0];
}
