import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { dismiss, subscribe } from '../../utils/notify';

const MAX_TOASTS = 4;
const MAX_UNDO_TOASTS = 3;
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

function Toast({ toast, onClose }) {
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
      className={`pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm shadow-2xl backdrop-blur-md animate-fade-in ${box}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="break-words" aria-live={toast.updated ? 'off' : undefined}>{toast.message}</p>
        {toast.ref && <p className="mt-0.5 text-[11px] opacity-75">Fehler-ID: <span className="font-mono">{toast.ref}</span></p>}
      </div>
      {toast.action && (
        <button type="button" onClick={runAction} className={`shrink-0 font-semibold underline hover:text-white ${action}`}>
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onClose(toast.id)}
        aria-label="Meldung schließen"
        title="Schließen (Esc)"
        className="-m-1 shrink-0 rounded p-1 text-slate-400 hover:text-white"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Toasts of utils/notify.js; mounted once in App. Info and success go to a polite live region, errors are role=alert.
 * A toast evicted by the caps is announced with notify's dismiss event, so a caller that defers its change until the
 * undo window ends can commit it at once.
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

  const polite = toasts.filter((t) => t.kind !== 'error');
  const errors = toasts.filter((t) => t.kind === 'error');

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end"
      style={{ bottom: 'calc(4.5rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <div className="flex w-full max-w-md flex-col gap-2 sm:w-96">
        {errors.map((t) => <Toast key={t.id} toast={t} onClose={close} />)}
      </div>
      <div role="status" aria-live="polite" className="flex max-h-[40vh] w-full max-w-md flex-col justify-end gap-2 overflow-y-clip sm:w-96">
        {polite.map((t) => <Toast key={t.id} toast={t} onClose={close} />)}
      </div>
    </div>
  );
}
