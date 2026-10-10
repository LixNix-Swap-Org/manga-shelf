import { useCallback, useEffect, useRef, useState } from 'react';

export const SEARCH_SCOPE_KEY = 'mangashelf_search_scope';
export const ONLINE_MIN_CHARS = 3;
export const ONLINE_DEBOUNCE_MS = 600;

const readScope = () => {
  try {
    return window.localStorage.getItem(SEARCH_SCOPE_KEY) === 'online' ? 'online' : 'collection';
  } catch (_) {
    return 'collection';
  }
};

const writeScope = (value) => {
  try { window.localStorage.setItem(SEARCH_SCOPE_KEY, value); } catch (_) {}
};

const NO_QUERY = { query: '', seq: 0 };
const cleared = (prev) => (prev.query ? { query: '', seq: prev.seq } : prev);
let submits = 0;
const submitted = (query) => {
  submits += 1;
  return { query, seq: submits };
};

/** Search scope of the header (per device) and the online query; only onTyped and submitOnline ever start a lookup. */
export default function useSearchScope({ enabled = true } = {}) {
  const [scope, setScopeState] = useState(readScope);
  const [online, setOnline] = useState(NO_QUERY);
  const [pending, setPending] = useState(false);
  const timerRef = useRef(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onlineRef = useRef(online.query);
  onlineRef.current = online.query;

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPending(false);
  }, []);

  const submitOnline = useCallback((value) => {
    stopTimer();
    const query = String(value ?? '').trim();
    if (!enabledRef.current || query.length < ONLINE_MIN_CHARS) return;
    setOnline(submitted(query));
  }, [stopTimer]);

  const clearOnline = useCallback(() => {
    stopTimer();
    setOnline(cleared);
  }, [stopTimer]);

  const onTyped = useCallback((value) => {
    if (!enabledRef.current) return;
    const query = String(value ?? '').trim();
    if (scopeRef.current !== 'online') {
      setOnline((prev) => (prev.query === query ? prev : cleared(prev)));
      return;
    }
    if (query.length < ONLINE_MIN_CHARS) {
      clearOnline();
      return;
    }
    if (query === onlineRef.current) {
      stopTimer();
      return;
    }
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setPending(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPending(false);
      setOnline(submitted(query));
    }, ONLINE_DEBOUNCE_MS);
  }, [clearOnline, stopTimer]);

  const setScope = useCallback((next) => {
    const value = next === 'online' ? 'online' : 'collection';
    writeScope(value);
    setScopeState(value);
    if (value === 'collection') clearOnline();
  }, [clearOnline]);

  useEffect(() => () => clearTimeout(timerRef.current), []);
  useEffect(() => {
    if (!enabled) clearOnline();
  }, [enabled, clearOnline]);

  return { scope, setScope, onlineQuery: online.query, onlineSeq: online.seq, pending, onTyped, submitOnline, clearOnline };
}
