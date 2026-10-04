import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export const MAIN_ID = 'inhalt';
export const APP_TITLE = 'Manga Shelf';
const DEFAULT_TITLE = 'Manga Shelf & Tracker';

export function pageTitle(title) {
  const clean = typeof title === 'string' ? title.trim() : '';
  return clean ? `${clean} – ${APP_TITLE}` : DEFAULT_TITLE;
}

/** `null`/`undefined` (still loading) keeps the current title, so a navigation never flashes the generic one. */
export function useDocumentTitle(title) {
  useEffect(() => {
    if (title == null) return;
    document.title = pageTitle(title);
  }, [title]);
}

function stickyHeaderHeight() {
  const header = document.querySelector('[data-sticky-header]');
  if (!header) return 0;
  const { position } = window.getComputedStyle(header);
  return position === 'sticky' || position === 'fixed' ? Math.ceil(header.getBoundingClientRect().height) : 0;
}

function focusQuietly(el) {
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/**
 * Ref for the page's h1: after a client-side navigation to another path (not on the page the visit started on)
 * focus moves to it once `ready` is true, so screen readers announce the new page.
 */
export function usePageHeading(ready = true) {
  const ref = useRef(null);
  const location = useLocation();
  const handled = useRef(null);

  useEffect(() => {
    if (!ready || !ref.current || handled.current === location.pathname) return;
    handled.current = location.pathname;
    if (location.key === 'default') return;
    // a dialog or field the user already moved into keeps its focus
    const active = document.activeElement;
    if (active && active !== document.body && !active.closest?.('a[href], button')) return;
    focusQuietly(ref.current);
  }, [ready, location.pathname, location.key]);

  return ref;
}

export function SkipLink({ target = MAIN_ID, children = 'Zum Inhalt springen' }) {
  const onClick = (e) => {
    const el = document.getElementById(target);
    if (!el) return;
    e.preventDefault();
    focusQuietly(el);
    const offset = stickyHeaderHeight();
    const { top } = el.getBoundingClientRect();
    if (top >= offset && top < window.innerHeight) return;
    el.style.scrollMarginTop = offset ? `${offset}px` : '';
    el.scrollIntoView({ block: 'start' });
  };
  return (
    <a
      href={`#${target}`}
      onClick={onClick}
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-[max(0.75rem,env(safe-area-inset-top))] focus:z-[70] focus:rounded-xl focus:bg-slate-900 focus:px-4 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-white focus:shadow-2xl focus:border focus:border-brand-400"
    >
      {children}
    </a>
  );
}
