import { useEffect, useRef, useState } from 'react';
import { BookCheck, BookX, Calendar, Check, CircleCheck, Coins, ListChecks, Tag, Trash, X } from 'lucide-react';
import { formatCount } from '../../utils/format';
import { localDateString } from '../../hooks/useVolumeActions';

export const BULK_STATUSES = ['Vorhanden', 'Fehlt', 'Vorbestellt', 'Erscheint bald', 'Bestellt'];

/** Keyboard focus and anchor jumps stop above the sticky bar (and the phone's detail bar below it) while it is shown. */
function useScrollPaddingAbove(ref) {
  useEffect(() => {
    const bar = ref.current;
    const root = document.documentElement;
    if (!bar) return undefined;
    const apply = () => {
      const height = Math.ceil(bar.getBoundingClientRect().height);
      root.style.setProperty('scroll-padding-bottom', `calc(${height}px + 0.75rem + 5.5rem + env(safe-area-inset-bottom))`);
    };
    apply();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('scroll-padding-bottom');
    };
  }, [ref]);
}

export const bulkDeleteConfirmText = (count) => `${formatCount(count, 'Band', 'Bände')} wirklich löschen? Der Lesestatus aller Benutzer für diese Bände wird ebenfalls gelöscht. Direkt danach lässt sich das noch rückgängig machen.`;

/**
 * Sticky bar of the selection mode: the request a button stands for goes to onApply(change, doneText).
 * `readerId` is the reader whose state "Gelesen" changes (the selected reader when the user may change it).
 */
export default function BulkActionBar({
  count, visibleCount, allVisibleSelected, onSelectAllVisible, onClear, onClose, onApply, busy = false, userId, readerId,
  confirmDelete = (text) => window.confirm(text)
}) {
  const barRef = useRef(null);
  useScrollPaddingAbove(barRef);
  const [panel, setPanel] = useState(null);
  const [status, setStatus] = useState('Vorhanden');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(() => localDateString());
  const disabled = busy || count === 0;
  const reader = readerId ?? userId;

  const apply = async (change, text) => {
    const ok = await onApply(change, text);
    if (ok) setPanel(null);
  };
  const togglePanel = (name) => setPanel((p) => (p === name ? null : name));
  const remove = () => {
    if (confirmDelete(bulkDeleteConfirmText(count))) apply({ delete: true }, 'gelöscht');
  };

  const button = 'btn-secondary text-xs py-2 px-3 min-h-[40px] flex shrink-0 items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed';
  const panelButton = (name) => `${button} ${panel === name ? '!border-brand-400 text-white' : ''}`;

  return (
    <div
      ref={barRef}
      id="bulk-action-bar"
      role="region"
      aria-label="Sammelbearbeitung"
      className="sticky bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-30 my-4 p-3 rounded-2xl border border-brand-500/50 bg-slate-950/95 backdrop-blur shadow-2xl shadow-brand-950/40 space-y-3 max-sm:space-y-2 short:space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 max-sm:flex-nowrap">
        <p className="min-w-0 text-sm max-sm:text-xs max-sm:leading-tight font-bold text-white flex items-center gap-2" aria-live="polite">
          <ListChecks className="w-4 h-4 text-brand-400 max-sm:hidden" aria-hidden="true" />
          {count === 0 ? 'Keine Bände ausgewählt' : `${formatCount(count, 'Band', 'Bände')} ausgewählt`}
        </p>
        <div className="flex flex-wrap items-center gap-2 max-sm:shrink-0 max-sm:flex-nowrap">
          <button
            type="button"
            id="btn-bulk-select-visible"
            onClick={allVisibleSelected ? onClear : onSelectAllVisible}
            disabled={busy || visibleCount === 0}
            className={`${button} max-sm:px-2.5`}
          >
            <CircleCheck className="w-3.5 h-3.5" aria-hidden="true" />
            {allVisibleSelected ? 'Auswahl aufheben' : <span>Alle <span className="max-sm:hidden">sichtbaren</span> ({visibleCount})</span>}
          </button>
          <button type="button" onClick={onClose} className={`${button} max-sm:px-2.5`} aria-label="Auswahl beenden" title="Auswahl beenden">
            <X className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" /> <span className="max-sm:hidden">Fertig</span>
          </button>
        </div>
      </div>

      <div data-bulk-actions className="flex flex-wrap items-center gap-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:-mx-3 max-sm:px-3 short:flex-nowrap short:overflow-x-auto short:-mx-3 short:px-3 custom-scrollbar">
        <button
          type="button"
          id="btn-bulk-owned"
          disabled={disabled}
          onClick={() => apply({ owners: { add: [userId] }, set: { purchase_date: localDateString() } }, 'als vorhanden (mir) markiert')}
          className={`${button} text-emerald-300 border-emerald-500/40`}
        >
          <Check className="w-3.5 h-3.5" aria-hidden="true" /> Als vorhanden (mir)
        </button>
        <button type="button" disabled={disabled} aria-expanded={panel === 'status'} onClick={() => togglePanel('status')} className={panelButton('status')}>
          <Tag className="w-3.5 h-3.5" aria-hidden="true" /> Status…
        </button>
        <button type="button" disabled={disabled} aria-expanded={panel === 'price'} onClick={() => togglePanel('price')} className={panelButton('price')}>
          <Coins className="w-3.5 h-3.5" aria-hidden="true" /> Preis…
        </button>
        <button type="button" disabled={disabled} aria-expanded={panel === 'date'} onClick={() => togglePanel('date')} className={panelButton('date')}>
          <Calendar className="w-3.5 h-3.5" aria-hidden="true" /> Kaufdatum…
        </button>
        <button type="button" disabled={disabled} onClick={() => apply({ read: { read: true, user_id: reader } }, 'als gelesen markiert')} className={button}>
          <BookCheck className="w-3.5 h-3.5" aria-hidden="true" /> Gelesen
        </button>
        <button type="button" disabled={disabled} onClick={() => apply({ read: { read: false, user_id: reader } }, 'als ungelesen markiert')} className={button}>
          <BookX className="w-3.5 h-3.5" aria-hidden="true" /> Ungelesen
        </button>
        <button type="button" id="btn-bulk-delete" disabled={disabled} onClick={remove} className={`${button} text-rose-300 border-rose-800/60`}>
          <Trash className="w-3.5 h-3.5" aria-hidden="true" /> Löschen
        </button>
      </div>

      {panel === 'status' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); apply({ set: { status } }, `auf „${status}“ gesetzt`); }}
        >
          <label htmlFor="bulk-status" className="text-xs text-slate-400">Neuer Status</label>
          <select id="bulk-status" value={status} onChange={(e) => setStatus(e.target.value)} className="input-field text-base sm:text-xs py-2 w-auto">
            {BULK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="submit" disabled={disabled} className="btn-primary text-xs py-2 px-3 disabled:opacity-40">Übernehmen</button>
        </form>
      )}
      {panel === 'price' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); apply({ set: { price: price.trim() } }, price.trim() ? `mit Preis ${price.trim()} € gespeichert` : 'ohne Preis gespeichert'); }}
        >
          <label htmlFor="bulk-price" className="text-xs text-slate-400">Preis in €</label>
          <input id="bulk-price" type="text" inputMode="decimal" placeholder="7,50" value={price} onChange={(e) => setPrice(e.target.value)} className="input-field text-base sm:text-xs py-2 w-28" />
          <button type="submit" disabled={disabled} className="btn-primary text-xs py-2 px-3 disabled:opacity-40">Übernehmen</button>
        </form>
      )}
      {panel === 'date' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); apply({ set: { purchase_date: date } }, date ? 'mit neuem Kaufdatum gespeichert' : 'ohne Kaufdatum gespeichert'); }}
        >
          <label htmlFor="bulk-date" className="text-xs text-slate-400">Kaufdatum</label>
          <input id="bulk-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input-field text-base sm:text-xs py-2 w-auto" />
          <button type="submit" disabled={disabled} className="btn-primary text-xs py-2 px-3 disabled:opacity-40">Übernehmen</button>
        </form>
      )}
    </div>
  );
}
