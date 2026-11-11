// Pure helpers of the series page (MangaDetail.jsx): scroll positions per history entry, duplicate entries and the
// target of "Zurück". MangaDetail re-exports them, so imports from '../MangaDetail' keep working.
import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { viewSessionEnding } from '../../utils/viewState';
import { inferVolumeType, regularVolumeNumber, getVolumeDisplayTitle } from '../../utils/volumeHelpers';

export const DETAIL_SCROLL_KEY = 'mangashelf_detail_scroll';
const MAX_SCROLL_ENTRIES = 30;

function readScrollPositions() {
  try {
    const map = JSON.parse(window.sessionStorage.getItem(DETAIL_SCROLL_KEY));
    return map && typeof map === 'object' ? map : {};
  } catch (_) {
    return {};
  }
}

/**
 * A series opened by a link starts at the top (the shelf may have been scrolled far down); Back / Forward to a
 * history entry returns to where that entry was left. Positions are kept per entry for this tab.
 */
export function useDetailScroll(ready) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const handled = useRef(null);

  useLayoutEffect(() => {
    if (!ready || handled.current === location.key) return;
    handled.current = location.key;
    const target = navigationType === 'POP' ? Number(readScrollPositions()[location.key]) || 0 : 0;
    if (window.scrollY !== target) window.scrollTo(0, target);
  }, [ready, location.key, navigationType]);

  useLayoutEffect(() => {
    const entryKey = location.key;
    let y = window.scrollY;
    const onScroll = () => { y = window.scrollY; };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (viewSessionEnding()) return;
      const map = readScrollPositions();
      delete map[entryKey];
      map[entryKey] = Math.round(y);
      const keys = Object.keys(map);
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SCROLL_ENTRIES))) delete map[old];
      try { window.sessionStorage.setItem(DETAIL_SCROLL_KEY, JSON.stringify(map)); } catch (_) { /* storage unavailable */ }
    };
  }, [location.key]);
}

/** Same type and number more than once; "Band 5" and "5" are the same regular volume (the server rejects that pair too). */
export function findDuplicateEntries(volumes) {
  const groups = new Map();
  for (const v of volumes || []) {
    const type = inferVolumeType(v);
    const regular = type === 'volume' ? regularVolumeNumber(v) : null;
    const key = `${type}:${regular !== null ? regular : String(v.volume_number ?? '').trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) || []), v]);
  }
  return [...groups.values()].filter(g => g.length > 1).map(g => ({ label: getVolumeDisplayTitle(g[0]), count: g.length }));
}

/** Where "Zurück zur Übersicht" leads: the in-app page that linked here (e.g. the shopping list), else the shelf. */
export function backLinkTarget(state) {
  const from = state?.from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return '/';
  return from;
}

