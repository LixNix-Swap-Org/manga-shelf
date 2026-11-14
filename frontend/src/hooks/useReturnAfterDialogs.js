import { useCallback, useEffect, useRef } from 'react';
import { onDialogsChange, openDialogCount } from './useDialogA11y';

// a dialog that closes and another that opens in the same step dip to 0 for a moment; only a lasting 0 counts
const SETTLE_MS = 60;
// an entry that opened no dialog (or not in time, e.g. offline) does not leave the return armed for a later dialog
const ARM_TIMEOUT_MS = 10000;

/**
 * "Zurück zur Verwaltung": `arm()` before an entry of a hub opens its own dialog; once that dialog (and every dialog it
 * opened) has closed, `reopen` runs, unless the page changed meanwhile (an entry that opened a series stays there).
 */
export default function useReturnAfterDialogs(reopen) {
  const armedRef = useRef(null);
  const reopenRef = useRef(reopen);
  useEffect(() => { reopenRef.current = reopen; });

  useEffect(() => {
    let settle = null;
    const off = onDialogsChange((count) => {
      const armed = armedRef.current;
      if (!armed) return;
      if (count > 0) {
        armed.seen = true;
        clearTimeout(settle);
        return;
      }
      if (!armed.seen) return;
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (armedRef.current !== armed || openDialogCount() > 0) return;
        armedRef.current = null;
        clearTimeout(armed.timer);
        if (window.location.pathname === armed.path) reopenRef.current();
      }, SETTLE_MS);
    });
    return () => {
      off();
      clearTimeout(settle);
      if (armedRef.current) clearTimeout(armedRef.current.timer);
    };
  }, []);

  return useCallback(() => {
    if (armedRef.current) clearTimeout(armedRef.current.timer);
    const armed = { path: window.location.pathname, seen: false, timer: null };
    armed.timer = setTimeout(() => { if (armedRef.current === armed && !armed.seen) armedRef.current = null; }, ARM_TIMEOUT_MS);
    armedRef.current = armed;
  }, []);
}
