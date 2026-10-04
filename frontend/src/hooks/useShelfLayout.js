import { useState, useMemo, useRef, useCallback } from 'react';
import { getVolumeBadge } from '../components/detail/volumeViewHelpers';

const prefersReducedMotion = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const PRESET_PER_ROW = { s: 20, m: 16, l: 12 };
// min-w of the spines in ShelfSpine.jsx: rows / fit-multirow per scale, and single-row Auto-Fit
const ROW_MIN_WIDTH = {
  s: { volume: 20, special_edition: 24, schuber: 36, gap: 20 },
  m: { volume: 22, special_edition: 26, schuber: 40, gap: 20 },
  l: { volume: 26, special_edition: 30, schuber: 50, gap: 20 }
};
const FIT_MIN_WIDTH = { volume: 18, special_edition: 24, schuber: 32, gap: 18 };
const SM_QUERY = '(min-width: 640px)';
// gap-1 sm:gap-1.5 on the shelf rows
const rowGap = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(SM_QUERY).matches ? 6 : 4);

const kindOf = (item) => {
  if (item.isGap) return 'gap';
  const type = getVolumeBadge(item.volume).type;
  return type === 'schuber' || type === 'special_edition' ? type : 'volume';
};

const rowWidth = (widths, gap) => widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * gap;

/** Whether the items fit on one Auto-Fit row of the given width. */
export function fitsOneFitRow(items, width, gap) {
  return !width || rowWidth(items.map((item) => FIT_MIN_WIDTH[kindOf(item)]), gap) <= width;
}

/**
 * Balanced shelf rows. The scale preset caps the spines per row; with a measured width the rows also never get wider
 * than the shelf (the spines' min widths plus the gaps).
 */
export function splitShelfRows(items, { scale = 'm', width = 0, gap = 4 } = {}) {
  const count = items.length;
  if (count === 0) return [items];
  const preset = PRESET_PER_ROW[scale] || PRESET_PER_ROW.m;
  const mins = ROW_MIN_WIDTH[scale] || ROW_MIN_WIDTH.m;
  const target = width > 0 ? Math.min(preset, Math.max(4, Math.floor((width + gap) / (mins.volume + gap)))) : preset;
  const widths = width > 0 ? items.map((item) => mins[kindOf(item)]) : null;
  for (let rowCount = Math.max(1, Math.ceil(count / target)); ; rowCount++) {
    const perRow = Math.ceil(count / rowCount);
    const rows = [];
    for (let i = 0; i < count; i += perRow) rows.push(i);
    const fits = !widths || perRow <= 1 || rows.every((start) => rowWidth(widths.slice(start, start + perRow), gap) <= width);
    if (fits) return rows.map((start) => items.slice(start, start + perRow));
  }
}

/** Spine-shelf layout: mode (fit/rows/scroll), scale presets, balanced rows and keyboard focus. */
export default function useShelfLayout(spineShelfItems) {
  // 3D Shelf scaling and layout modes: 'fit' (Auto-Fit) | 'rows' (Mehrzeilig) | 'scroll' (Horizontal scrollen)
  const [shelfMode, setShelfMode] = useState(() => {
    return localStorage.getItem('mangashelf_shelf_mode') || 'rows';
  });
  // Shelf scale presets: 's' (Kompakt) | 'm' (Standard) | 'l' (Groß)
  const [shelfScale, setShelfScale] = useState(() => {
    return localStorage.getItem('mangashelf_shelf_scale') || 'm';
  });
  const [focusedVolumeId, setFocusedVolumeId] = useState(null);
  const shelfScrollRef = useRef(null);

  const handleSetShelfMode = (mode) => {
    setShelfMode(mode);
    localStorage.setItem('mangashelf_shelf_mode', mode);
  };

  const handleSetShelfScale = (scale) => {
    setShelfScale(scale);
    localStorage.setItem('mangashelf_shelf_scale', scale);
  };

  const scrollShelf = (offset) => {
    if (shelfScrollRef.current) {
      shelfScrollRef.current.scrollBy({ left: offset, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  };

  const [shelfBox, setShelfBox] = useState({ width: 0, gap: 4 });
  const observerRef = useRef(null);
  const shelfMeasureRef = useCallback((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.floor(entries[entries.length - 1]?.contentRect?.width || 0);
      const gap = rowGap();
      setShelfBox((box) => (box.width === width && box.gap === gap ? box : { width, gap }));
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  // beyond this, Auto-Fit becomes multi-row too; so does a phone shelf the spines do not fit on in one row
  const AUTO_FIT_MULTIROW_THRESHOLD = 36;
  const isFitMultiRow = shelfMode === 'fit'
    && (spineShelfItems.length > AUTO_FIT_MULTIROW_THRESHOLD || !fitsOneFitRow(spineShelfItems, shelfBox.width, shelfBox.gap));

  const shelfRows = useMemo(() => {
    if (shelfMode === 'scroll' || (shelfMode === 'fit' && !isFitMultiRow)) return [spineShelfItems];
    return splitShelfRows(spineShelfItems, { scale: shelfScale, width: shelfBox.width, gap: shelfBox.gap });
  }, [spineShelfItems, shelfMode, shelfScale, isFitMultiRow, shelfBox]);

  return {
    shelfMode, shelfScale, focusedVolumeId, setFocusedVolumeId, shelfScrollRef,
    handleSetShelfMode, handleSetShelfScale, scrollShelf, shelfRows, isFitMultiRow, shelfMeasureRef
  };
}
