import { useRef, useEffect, useCallback } from 'react';

/**
 * Returns begin(): each call aborts the previous request of this component and hands out { signal, isCurrent }.
 * Unmounting aborts the running one, so a slow answer for a previous id can never overwrite the current one.
 */
export default function useLatestRequest() {
  const currentRef = useRef(null);

  useEffect(() => () => {
    currentRef.current?.controller?.abort();
    currentRef.current = null;
  }, []);

  return useCallback(() => {
    currentRef.current?.controller?.abort();
    const entry = { controller: typeof AbortController !== 'undefined' ? new AbortController() : null };
    currentRef.current = entry;
    return { signal: entry.controller?.signal, isCurrent: () => currentRef.current === entry };
  }, []);
}
