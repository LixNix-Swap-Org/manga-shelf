import { useCallback, useEffect, useMemo, useState } from 'react';

function readSaved(storageKey) {
  if (!storageKey) return null;
  try {
    return JSON.parse(window.sessionStorage.getItem(storageKey));
  } catch (_) {
    return null;
  }
}

/**
 * Renders a long list in pages: the first `step` items, one more page whenever the sentinel element comes within
 * `rootMargin` of the viewport, or on showMore(). A new `resetKey` (search, filter, sort) starts at one page again.
 * With `storageKey` the count of the current resetKey is kept in sessionStorage, so coming back renders as much as
 * before and the scroll position can be restored. Without IntersectionObserver only showMore() adds pages.
 */
export default function useProgressiveList(items, { step = 60, resetKey = '', storageKey = null, rootMargin = '1200px' } = {}) {
  const [state, setState] = useState(() => {
    const saved = readSaved(storageKey);
    const count = saved && saved.key === resetKey && Number.isInteger(saved.count) && saved.count > step ? saved.count : step;
    return { key: resetKey, count };
  });
  let current = state;
  if (state.key !== resetKey) {
    current = { key: resetKey, count: step };
    setState(current);
  }
  const { count } = current;
  const total = items.length;
  const hasMore = total > count;

  const visible = useMemo(() => (hasMore ? items.slice(0, count) : items), [items, count, hasMore]);

  const showMore = useCallback(() => setState((s) => ({ key: s.key, count: s.count + step })), [step]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify({ key: current.key, count }));
    } catch (_) { /* storage unavailable */ }
  }, [storageKey, current.key, count]);

  const [sentinel, setSentinel] = useState(null);
  useEffect(() => {
    if (!sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return undefined;
    // observe() reports the current state at once, so a sentinel that stays in range keeps adding pages
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showMore();
    }, { rootMargin });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, hasMore, count, rootMargin, showMore]);

  return { visible, total, shown: visible.length, hasMore, showMore, sentinelRef: setSentinel };
}
