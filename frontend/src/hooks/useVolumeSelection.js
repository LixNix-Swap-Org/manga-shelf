import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Ids from `a` to `b` (both included) in the order of `orderedIds`; just [b] when either is not in the list. */
export function rangeBetween(orderedIds, a, b) {
  const from = orderedIds.findIndex((id) => String(id) === String(a));
  const to = orderedIds.findIndex((id) => String(id) === String(b));
  if (from === -1 || to === -1) return [b];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return orderedIds.slice(start, end + 1);
}

/**
 * Multi-select of volumes on the detail page: a selection mode, toggling one volume, Shift for the range since the
 * last click (in the visible order), all visible ones, clear. Ids of volumes that disappear are dropped.
 */
export default function useVolumeSelection({ volumes = [] } = {}) {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const anchorRef = useRef(null);

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const existing = new Set(volumes.map((v) => v.id));
      const next = new Set([...prev].filter((id) => existing.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [volumes]);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelected(new Set());
  }, []);

  const exit = useCallback(() => {
    setActive(false);
    clear();
  }, [clear]);

  const toggleMode = useCallback(() => {
    if (active) exit();
    else setActive(true);
  }, [active, exit]);

  /** Toggles one volume; with `range` every volume between the last clicked one and this one gets its new state. */
  const toggle = useCallback((id, { range = false, orderedIds = [] } = {}) => {
    const anchor = anchorRef.current;
    anchorRef.current = id;
    setSelected((prev) => {
      const next = new Set(prev);
      const select = !prev.has(id);
      const ids = range && anchor !== null ? rangeBetween(orderedIds, anchor, id) : [id];
      for (const one of ids) {
        if (select) next.add(one);
        else next.delete(one);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ids) => setSelected(new Set(ids)), []);

  const isSelected = useCallback((id) => selected.has(id), [selected]);
  const ids = useMemo(() => [...selected], [selected]);

  return { active, selected, ids, count: selected.size, isSelected, toggle, selectAll, clear, toggleMode, exit };
}
