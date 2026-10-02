import { useState, useMemo, useRef } from 'react';

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
      shelfScrollRef.current.scrollBy({ left: offset, behavior: 'smooth' });
    }
  };

  // Smart Balanced Shelf Rows calculation for 'rows' mode AND auto-multi-row in 'fit' mode
  const AUTO_FIT_MULTIROW_THRESHOLD = 36; // beyond this, auto-fit becomes multi-row too

  const shelfRows = useMemo(() => {
    const count = spineShelfItems.length;

    // In 'fit' mode with few items: single row
    if (shelfMode === 'fit' && count <= AUTO_FIT_MULTIROW_THRESHOLD) {
      return [spineShelfItems];
    }

    // In 'scroll' mode: always single (horizontally scrollable) row
    if (shelfMode === 'scroll') {
      return [spineShelfItems];
    }

    // 'rows' mode OR 'fit' mode with many books → calculate balanced rows:
    // Optimal books per shelf plank based on scale:
    //  S = compact spines (~42px) → ~20 per row on a 900px shelf
    //  M = standard spines (~52px) → ~16 per row
    //  L = large spines (~66px) → ~12 per row
    const targetPerRow = shelfScale === 's' ? 20 : shelfScale === 'l' ? 12 : 16;

    if (count <= targetPerRow) {
      return [spineShelfItems];
    }

    // Compute balanced row count so rows are evenly filled
    const rowCount = Math.ceil(count / targetPerRow);
    const itemsPerRow = Math.ceil(count / rowCount);

    const rows = [];
    for (let i = 0; i < count; i += itemsPerRow) {
      rows.push(spineShelfItems.slice(i, i + itemsPerRow));
    }
    return rows;
  }, [spineShelfItems, shelfMode, shelfScale]);

  // Derived: is fit-mode actually rendering as multi-row (auto-rows)?
  const isFitMultiRow = shelfMode === 'fit' && spineShelfItems.length > AUTO_FIT_MULTIROW_THRESHOLD;

  return {
    shelfMode, shelfScale, focusedVolumeId, setFocusedVolumeId, shelfScrollRef,
    handleSetShelfMode, handleSetShelfScale, scrollShelf, shelfRows, isFitMultiRow
  };
}
