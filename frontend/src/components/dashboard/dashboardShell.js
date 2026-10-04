import { scanSeriesTitle } from '../../utils/scanHelpers';

// Vite always defines it; the guard keeps tests that render without Vite's define working.
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export const MAIN_VIEWS = ['shelf', 'shopping', 'radar', 'anime'];

const readView = (search) => {
  try {
    return new URLSearchParams(search || '').get('view');
  } catch (_) {
    return null;
  }
};

/** `?view=` of a start URL: a main view, or 'stats' (opens the statistics dialog over the shelf). */
export const parseInitialView = (search) => {
  const view = readView(search);
  if (view !== 'shelf' && MAIN_VIEWS.includes(view)) return { mainView: view, openStats: false };
  return { mainView: 'shelf', openStats: view === 'stats' };
};

/**
 * Query string for a main view; other parameters (the shelf filters) are kept, the shelf has no `view`, and `add`
 * (open the anime dialog for a series on arrival) never survives a view change.
 */
export const viewSearch = (search, view) => {
  let params;
  try {
    params = new URLSearchParams(search || '');
  } catch (_) {
    params = new URLSearchParams();
  }
  params.delete('add');
  if (view === 'shelf' || !MAIN_VIEWS.includes(view)) params.delete('view');
  else params.set('view', view);
  const query = params.toString();
  return query ? `?${query}` : '';
};

/** Header quick toggles: a second tap on the active view returns to the shelf. */
export const nextQuickView = (current, target) => (current === target ? 'shelf' : target);

export const formatBadgeCount = (n) => {
  const value = Number(n) || 0;
  return value > 99 ? '99+' : String(value);
};

const isVisitorRole = (role) => role === 'visitor' || role === 'guest';

/** Visible role name; offline mode demotes everybody to read-only and says so. */
export const roleLabel = (user) => {
  if (!user) return '';
  if (user.offline) return 'Offline';
  if (user.role === 'admin') return 'Admin';
  if (user.role === 'editor') return 'Editor';
  if (isVisitorRole(user.role)) return 'Gast';
  return user.role ? String(user.role) : '';
};

export const roleBadgeClass = (user) => {
  if (!user || user.offline || isVisitorRole(user.role)) return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
  if (user.role === 'admin') return 'bg-brand-500/20 text-brand-300 border-brand-500/40';
  return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
};

export const SCAN_OFFLINE_MESSAGE = 'Die ISBN-Suche braucht eine Verbindung zum Server.';
export const SCAN_FAILED_MESSAGE = 'ISBN-Suche fehlgeschlagen (Server nicht erreichbar).';

/**
 * What the dashboard does with an answer of /api/lookup/isbn:
 * navigate (one series matches), choose (several candidates), prefill (unknown series, editor),
 * notice (unknown series, read-only user), notFound (no catalogue data), error.
 */
export const scanDashboardAction = ({ ok, data, canEdit }) => {
  if (!ok || !data) {
    return { type: 'error', message: (data && typeof data.error === 'string' && data.error) || SCAN_FAILED_MESSAGE };
  }
  if (data.found && data.matched_manga) return { type: 'navigate', manga: data.matched_manga };
  const candidates = Array.isArray(data.matched_candidates) ? data.matched_candidates.filter((c) => c && c.id != null) : [];
  if (candidates.length === 1) return { type: 'navigate', manga: candidates[0] };
  if (candidates.length > 1) return { type: 'choose', candidates, book: data.book || null };
  if (data.found && data.book) {
    if (canEdit) return { type: 'prefill', book: data.book };
    const name = scanSeriesTitle(data.book);
    return { type: 'notice', message: name ? `Nicht in der Sammlung: ${name}` : 'Diese Reihe ist nicht in der Sammlung.' };
  }
  return {
    type: 'notFound',
    message: (typeof data.message === 'string' && data.message) || 'Keine Daten zu dieser ISBN gefunden.',
    canAdd: Boolean(canEdit)
  };
};
