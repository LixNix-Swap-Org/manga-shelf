import { useEffect, useRef, useState } from 'react';

export const PULL_THRESHOLD_PX = 70;
export const FOREGROUND_REFRESH_MS = 60 * 1000;

const isStandalone = (win) => Boolean(
  win?.matchMedia?.('(display-mode: standalone)').matches || win?.navigator?.standalone === true
);

/** A touch inside a dialog or inside content that is scrolled down scrolls that content, it does not pull the page. */
export function touchScrollsContent(target) {
  let el = target && typeof target.closest === 'function' ? target : target?.parentElement ?? null;
  if (!el) return false;
  if (el.closest('[role="dialog"], [aria-modal="true"]')) return true;
  for (; el && el !== el.ownerDocument?.documentElement && el !== el.ownerDocument?.body; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

/**
 * Pull-to-refresh for the installed app (a browser tab has its own): a downward drag of at least `threshold` px that
 * starts at the very top of the page, outside dialogs and scrolled content, calls `onRefresh`. Returns
 * { pullDistance, refreshing } for the indicator.
 */
export default function usePullToRefresh(onRefresh, { threshold = PULL_THRESHOLD_PX, enabled = true, win = globalThis.window } = {}) {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  const busyRef = useRef(false);

  useEffect(() => {
    if (!enabled || !win || !isStandalone(win)) return undefined;
    let startY = null;
    let distance = 0;
    const reset = () => {
      startY = null;
      distance = 0;
      setPullDistance(0);
    };
    const onStart = (e) => {
      if (busyRef.current || win.scrollY > 0 || e.touches?.length !== 1 || touchScrollsContent(e.target)) return;
      startY = e.touches[0].clientY;
      distance = 0;
    };
    const onMove = (e) => {
      if (startY === null) return;
      if (win.scrollY > 0) {
        reset();
        return;
      }
      distance = Math.max(0, e.touches[0].clientY - startY);
      setPullDistance(Math.min(distance, threshold * 1.5));
    };
    const onEnd = async () => {
      if (startY === null) return;
      const pulled = distance;
      reset();
      if (pulled < threshold) return;
      busyRef.current = true;
      setRefreshing(true);
      try {
        await onRefreshRef.current?.();
      } finally {
        busyRef.current = false;
        setRefreshing(false);
      }
    };
    const passive = { passive: true };
    win.addEventListener('touchstart', onStart, passive);
    win.addEventListener('touchmove', onMove, passive);
    win.addEventListener('touchend', onEnd);
    win.addEventListener('touchcancel', reset);
    return () => {
      win.removeEventListener('touchstart', onStart, passive);
      win.removeEventListener('touchmove', onMove, passive);
      win.removeEventListener('touchend', onEnd);
      win.removeEventListener('touchcancel', reset);
    };
  }, [enabled, threshold, win]);

  return { pullDistance, refreshing };
}

/** Calls `onForeground` when the page becomes visible again after being hidden for at least `minHiddenMs`. */
export function useForegroundRefresh(onForeground, { minHiddenMs = FOREGROUND_REFRESH_MS, enabled = true, doc = globalThis.document, now = Date.now } = {}) {
  const callbackRef = useRef(onForeground);
  callbackRef.current = onForeground;

  useEffect(() => {
    if (!enabled || !doc) return undefined;
    let hiddenAt = doc.visibilityState === 'hidden' ? now() : null;
    const onChange = () => {
      if (doc.visibilityState === 'hidden') {
        hiddenAt = now();
        return;
      }
      const away = hiddenAt === null ? 0 : now() - hiddenAt;
      hiddenAt = null;
      if (away >= minHiddenMs) callbackRef.current?.();
    };
    doc.addEventListener('visibilitychange', onChange);
    return () => doc.removeEventListener('visibilitychange', onChange);
  }, [enabled, minHiddenMs, doc, now]);
}
