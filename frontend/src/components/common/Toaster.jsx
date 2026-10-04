import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { dismiss, subscribe } from '../../utils/notify';
import { rich } from '../../i18n/react.jsx';
import { t as tr } from '../../i18n/index.js';

const MAX_TOASTS = 4;
const MAX_UNDO_TOASTS = 3;
// landscape phones: the newest two stay visible, the others wait hidden (their timers and undo windows keep running)
const SHORT_SCREEN = '(max-height: 500px)';
const MAX_VISIBLE_SHORT = 2;
// phones and short screens with the selection bar on screen: only the newest toast, so the selection stays visible
const COMPACT_SCREEN = '(max-width: 639px), (max-height: 500px)';
const MAX_VISIBLE_WITH_BAR = 1;
const BULK_BAR_ID = 'bulk-action-bar';
// time left after the pointer or focus leaves a toast whose timer had nearly run out
const MIN_RESUME_MS = 1500;

const KIND_STYLE = {
  error: { Icon: CircleAlert, box: 'border-red-500/50 bg-red-950/95 text-red-100', icon: 'text-red-300', action: 'text-red-200' },
  success: { Icon: CircleCheck, box: 'border-emerald-500/40 bg-slate-900/95 text-slate-100', icon: 'text-emerald-400', action: 'text-emerald-300' },
  info: { Icon: Info, box: 'border-slate-700 bg-slate-900/95 text-slate-100', icon: 'text-sky-400', action: 'text-sky-300' }
};

const isTimed = (duration) => Number.isFinite(duration) && duration > 0;

const oldest = (items, max) => items.slice(0, Math.max(0, items.length - max));

/**
 * Caps the toasts without an action and the timed ones with an action (undo toasts), oldest first. An evicted undo is
 * committed: its change stays. A toast whose action waits for the user (duration 0, e.g. 'Neu laden') is never evicted.
 */
export function trimToasts(list, max = MAX_TOASTS, maxUndo = MAX_UNDO_TOASTS) {
  const evicted = new Set([
    ...oldest(list.filter((t) => !t.action), max),
    ...oldest(list.filter((t) => t.action && isTimed(t.duration)), maxUndo)
  ].map((t) => t.id));
  return evicted.size ? list.filter((t) => !evicted.has(t.id)) : list;
}

const mediaQuery = (query) => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null);

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => Boolean(mediaQuery(query)?.matches));
  useEffect(() => {
    const mql = mediaQuery(query);
    if (!mql) return undefined;
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

/** Distance from the viewport bottom to the top of the series page's selection bar while it is on screen, else 0. */
function useBulkBarOffset(active) {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!active || typeof document === 'undefined') {
      setOffset(0);
      return undefined;
    }
    let observed = null;
    let frame = 0;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;
    function measure() {
      const bar = document.getElementById(BULK_BAR_ID);
      if (bar !== observed) {
        if (observed) resize?.unobserve(observed);
        if (bar) resize?.observe(bar);
        observed = bar;
      }
      const rect = bar?.getBoundingClientRect();
      const visible = rect && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
      setOffset(visible ? Math.ceil(window.innerHeight - rect.top) : 0);
    }
    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }
    measure();
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
    mutations?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      mutations?.disconnect();
      resize?.disconnect();
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [active]);
  return offset;
}

function Toast({ toast, onClose, hidden = false }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(toast.duration);
  const paused = hovered || focused;
  const { Icon, box, icon, action } = KIND_STYLE[toast.kind] || KIND_STYLE.info;

  useEffect(() => {
    if (paused || !isTimed(toast.duration)) return undefined;
    const started = Date.now();
    const timer = setTimeout(() => onClose(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(MIN_RESUME_MS, remaining.current - (Date.now() - started));
    };
  }, [paused, toast.id, toast.duration, onClose]);

  const runAction = () => {
    onClose(toast.id);
    toast.action.onClick();
  };

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : undefined}
      data-toast={toast.kind}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose(toast.id);
      }}
      className={`pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-2xl backdrop-blur-md animate-fade-in ${box}${hidden ? ' hidden' : ''}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="break-words" aria-live={toast.updated ? 'off' : undefined}>{toast.message}</p>
        {toast.ref && <p className="mt-0.5 text-[11px] opacity-75">{rich('Fehler-ID: {ref}', { ref: <span className="font-mono">{toast.ref}</span> })}</p>}
      </div>
      {toast.action && (
        <button type="button" onClick={runAction} className={`hit-44 shrink-0 font-semibold underline hover:text-white ${action}`}>{/* i18n-ignore: the label is translated where the toast is created */}
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onClose(toast.id)}
        aria-label={tr('Meldung schließen')}
        title={tr('Schließen (Esc)')}
        className="hit-44 -m-1 shrink-0 rounded p-1 text-slate-400 hover:text-white"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Toasts of utils/notify.js, mounted once in App; info/success use a polite live region, errors role=alert. An evicted
 * toast fires notify's dismiss event so a deferred change (undo) commits at once.
 */
export default function Toaster() {
  const [toasts, setToasts] = useState([]);
  const listRef = useRef([]);

  const apply = useCallback((next) => {
    listRef.current = next;
    setToasts(next);
  }, []);

  const close = useCallback((id) => {
    if (listRef.current.some((t) => t.id === id)) apply(listRef.current.filter((t) => t.id !== id));
  }, [apply]);

  useEffect(() => subscribe((event) => {
    if (event.type === 'dismiss') {
      close(event.id);
      return;
    }
    if (event.type === 'update') {
      if (listRef.current.some((t) => t.id === event.id)) {
        apply(listRef.current.map((t) => (t.id === event.id ? { ...t, message: event.message, ref: event.ref, updated: true } : t)));
      }
      return;
    }
    const { toast } = event;
    const kept = listRef.current.filter((t) => !(t.kind === toast.kind && t.message === toast.message && !t.action && !toast.action));
    const next = trimToasts([...kept, toast]);
    apply(next);
    for (const t of kept) if (!next.includes(t)) dismiss(t.id);
  }), [apply, close]);

  const short = useMediaQuery(SHORT_SCREEN);
  const compact = useMediaQuery(COMPACT_SCREEN);
  const barOffset = useBulkBarOffset(toasts.length > 0);
  const maxVisible = barOffset && compact ? MAX_VISIBLE_WITH_BAR : short ? MAX_VISIBLE_SHORT : 0;
  const shown = maxVisible ? new Set(toasts.slice(-maxVisible)) : null;
  const toastOf = (t) => <Toast key={t.id} toast={t} onClose={close} hidden={Boolean(shown) && !shown.has(t)} />;
  const polite = toasts.filter((t) => t.kind !== 'error');
  const errors = toasts.filter((t) => t.kind === 'error');

  // z-[70]: above the tool dialogs (z-[60]); the stack sits above the selection bar while one is shown
  return (
    <div
      style={barOffset ? { bottom: `calc(${barOffset}px + 0.5rem)` } : undefined}
      className="pointer-events-none fixed inset-x-0 z-[70] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-[max(1rem,env(safe-area-inset-right))] sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:bottom-[calc(var(--toast-offset,4.5rem)+env(safe-area-inset-bottom))]"
    >
      <div className="flex w-full max-w-md flex-col gap-2 sm:max-w-sm">
        {errors.map(toastOf)}
      </div>
      <div role="status" aria-live="polite" className="flex max-h-[40vh] w-full max-w-md flex-col justify-end gap-2 overflow-y-clip sm:max-w-sm">
        {polite.map(toastOf)}
      </div>
    </div>
  );
}
