// Shelf page count and scroll positions of this tab (MangaCollectionGrid, MangaDetail): the next user starts at the top.
export const VIEW_STATE_KEYS = ['mangashelf_shelf_count', 'mangashelf_shelf_scroll', 'mangashelf_detail_scroll'];

let ending = false;

export function clearViewState() {
  try {
    for (const key of VIEW_STATE_KEYS) window.sessionStorage.removeItem(key);
  } catch (_) { /* storage unavailable */ }
}

/** Logout or session end: the pages that unmount afterwards must not write their positions back. */
export function endViewSession() {
  ending = true;
  clearViewState();
}

export function startViewSession() {
  ending = false;
}

export const viewSessionEnding = () => ending;
