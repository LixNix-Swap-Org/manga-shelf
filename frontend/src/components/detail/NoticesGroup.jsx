import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { t } from '../../i18n/index.js';

const STORAGE_KEY = 'mangashelf_detail_notices_open';

function readOpen() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function storeOpen(open) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? '1' : '0');
  } catch {
    // private mode: the choice holds until the page is left
  }
}

const sameLabels = (a, b) => a.length === b.length && a.every((label, i) => label === b[i]);

/**
 * "Hinweise (n)" above the volumes: from two notices on (elements with `data-notice="<short label>"` among the
 * children) they fold into one row with a badge per notice; a badge opens the row and jumps to its notice. One notice
 * shows as before. Folded notices stay mounted, so a notice that loads later (volumes in another shelf) still counts.
 * Status lines without `data-notice` always stay visible. Open or folded is remembered on this device.
 */
export default function NoticesGroup({ children }) {
  const listRef = useRef(null);
  const listId = useId();
  const [labels, setLabels] = useState([]);
  const [open, setOpen] = useState(readOpen);
  const pendingJump = useRef(null);

  const readLabels = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    const next = Array.from(node.querySelectorAll('[data-notice]')).map((el) => el.dataset.notice || '');
    setLabels((prev) => (sameLabels(prev, next) ? prev : next));
  }, []);

  useLayoutEffect(() => {
    readLabels();
    const node = listRef.current;
    if (!node || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(readLabels);
    observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-notice'] });
    return () => observer.disconnect();
  }, [readLabels]);

  const grouped = labels.length >= 2;
  const folded = grouped && !open;

  useLayoutEffect(() => {
    if (folded || pendingJump.current === null) return;
    const target = listRef.current?.querySelectorAll('[data-notice]')[pendingJump.current];
    pendingJump.current = null;
    if (!target) return;
    target.scrollIntoView?.({ block: 'center' });
    const action = target.querySelector('button:not([disabled])');
    (action || target).focus?.({ preventScroll: true });
  });

  const setOpenStored = (value) => {
    setOpen(value);
    storeOpen(value);
  };
  const jumpTo = (index) => {
    pendingJump.current = index;
    setOpenStored(true);
  };

  return (
    <div id="detail-notices">
      {grouped && (
        <div className="mb-3 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            id="btn-detail-notices"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpenStored(!open)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-semibold text-slate-200 hover:text-white hover:bg-slate-800"
          >
            <Info className="w-3.5 h-3.5 text-sky-300" aria-hidden="true" />
            {t('Hinweise ({count})', { count: labels.length })}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {folded && labels.map((label, i) => (
            <button
              key={`${i}-${label}`}
              type="button"
              onClick={() => jumpTo(i)}
              className="px-2.5 py-1 rounded-lg bg-slate-800/80 border border-slate-700 text-slate-200 hover:text-white hover:border-slate-500"
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div id={listId} ref={listRef} className={folded ? 'notices-folded' : undefined}>
        {children}
      </div>
    </div>
  );
}
