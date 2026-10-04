import { useEffect, useRef, useState } from 'react';
import { BookCheck, BookX, Calendar, Check, CircleCheck, Coins, ListChecks, Tag, Trash, X } from 'lucide-react';
import { currencySymbol, formatCount, formatNumber } from '../../utils/format';
import { localDateString } from '../../hooks/useVolumeActions';
import { t } from '../../i18n/index.js';
import { rich } from '../../i18n/react.jsx';
import { statusLabel } from '../../utils/enumLabels.js';

// i18n
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

export const bulkDeleteConfirmText = (count) => t('{count} wirklich löschen? Der Lesestatus aller Benutzer für diese Bände wird ebenfalls gelöscht. Direkt danach lässt sich das noch rückgängig machen.', { count: formatCount(count, 'Band', 'Bände') });

// Sticky bar of the selection mode: a button's request goes to onApply(change, doneText); doneText is translated here and
// handleBulkEdit shows it as given. `readerId` is the reader whose "Gelesen" state changes (the selected reader when allowed).
export default function BulkActionBar({
  count, visibleCount, allVisibleSelected, onSelectAllVisible, onClear, onClose, onApply, busy = false, userId, readerId, currency = 'EUR',
  confirmDelete = (text) => window.confirm(text)
}) {
  const barRef = useRef(null);
  useScrollPaddingAbove(barRef);
  const [panel, setPanel] = useState(null);
  const [status, setStatus] = useState('Vorhanden'); // i18n-ignore: stored status value
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
    if (confirmDelete(bulkDeleteConfirmText(count))) apply({ delete: true }, t('gelöscht'));
  };

  const button = 'btn-secondary text-xs py-2 px-3 min-h-[40px] flex shrink-0 items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed';
  const panelButton = (name) => `${button} ${panel === name ? '!border-brand-400 text-white' : ''}`;

  return (
    <div
      ref={barRef}
      id="bulk-action-bar"
      role="region"
      aria-label={t('Sammelbearbeitung')}
      className="sticky bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-30 my-4 p-3 rounded-2xl border border-brand-500/50 bg-slate-950/95 backdrop-blur shadow-2xl shadow-brand-950/40 space-y-3 max-sm:space-y-2 short:space-y-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 max-sm:flex-nowrap">
        <p className="min-w-0 text-sm max-sm:text-xs max-sm:leading-tight font-bold text-white flex items-center gap-2" aria-live="polite">
          <ListChecks className="w-4 h-4 text-brand-400 max-sm:hidden" aria-hidden="true" />
          {count === 0 ? t('Keine Bände ausgewählt') : t('{count} ausgewählt', { count: formatCount(count, 'Band', 'Bände') })}
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
            {allVisibleSelected
              ? t('Auswahl aufheben')
              : <span>{rich('Alle {visible} ({count})', { visible: <span className="max-sm:hidden">{t('sichtbaren')}</span>, count: visibleCount })}</span>}
          </button>
          <button type="button" onClick={onClose} className={`${button} max-sm:px-2.5`} aria-label={t('Auswahl beenden')} title={t('Auswahl beenden')}>
            <X className="w-4 h-4 sm:w-3.5 sm:h-3.5" aria-hidden="true" /> <span className="max-sm:hidden">{t('Fertig')}</span>
          </button>
        </div>
      </div>

      <div data-bulk-actions className="flex flex-wrap items-center gap-2 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:-mx-3 max-sm:px-3 short:flex-nowrap short:overflow-x-auto short:-mx-3 short:px-3 custom-scrollbar">
        <button
          type="button"
          id="btn-bulk-owned"
          disabled={disabled}
          onClick={() => apply({ owners: { add: [userId] }, set: { purchase_date: localDateString() } }, t('als vorhanden (mir) markiert'))}
          className={`${button} text-emerald-300 border-emerald-500/40`}
        >
          <Check className="w-3.5 h-3.5" aria-hidden="true" /> {t('Als vorhanden (mir)')}
        </button>
        <button type="button" disabled={disabled} aria-expanded={panel === 'status'} onClick={() => togglePanel('status')} className={panelButton('status')}>
          <Tag className="w-3.5 h-3.5" aria-hidden="true" /> {t('Status…')}
        </button>
        <button type="button" disabled={disabled} aria-expanded={panel === 'price'} onClick={() => togglePanel('price')} className={panelButton('price')}>
          <Coins className="w-3.5 h-3.5" aria-hidden="true" /> {t('Preis…')}
        </button>
        <button type="button" disabled={disabled} aria-expanded={panel === 'date'} onClick={() => togglePanel('date')} className={panelButton('date')}>
          <Calendar className="w-3.5 h-3.5" aria-hidden="true" /> {t('Kaufdatum…')}
        </button>
        <button type="button" disabled={disabled} onClick={() => apply({ read: { read: true, user_id: reader } }, t('als gelesen markiert'))} className={button}>
          <BookCheck className="w-3.5 h-3.5" aria-hidden="true" /> {t('Gelesen')}
        </button>
        <button type="button" disabled={disabled} onClick={() => apply({ read: { read: false, user_id: reader } }, t('als ungelesen markiert'))} className={button}>
          <BookX className="w-3.5 h-3.5" aria-hidden="true" /> {t('Ungelesen')}
        </button>
        <button type="button" id="btn-bulk-delete" disabled={disabled} onClick={remove} className={`${button} text-rose-300 border-rose-800/60`}>
          <Trash className="w-3.5 h-3.5" aria-hidden="true" /> {t('Löschen')}
        </button>
      </div>

      {panel === 'status' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); apply({ set: { status } }, t('auf „{status}“ gesetzt', { status: statusLabel(status) })); }}
        >
          <label htmlFor="bulk-status" className="text-xs text-slate-400">{t('Neuer Status')}</label>
          <select id="bulk-status" value={status} onChange={(e) => setStatus(e.target.value)} className="input-field text-base sm:text-xs py-2 w-auto">
            {BULK_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
          <button type="submit" disabled={disabled} className="btn-primary text-xs py-2 px-3 disabled:opacity-40">{t('Übernehmen')}</button>
        </form>
      )}
      {panel === 'price' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); apply({ set: { price: price.trim() } }, price.trim() ? t('mit Preis {price} {symbol} gespeichert', { price: price.trim(), symbol: currencySymbol(currency) }) : t('ohne Preis gespeichert')); }}
        >
          <label htmlFor="bulk-price" className="text-xs text-slate-400">{t('Preis in {symbol}', { symbol: currencySymbol(currency) })}</label>
          <input id="bulk-price" type="text" inputMode="decimal" placeholder={formatNumber(7.5, 2, { fixed: true })} value={price} onChange={(e) => setPrice(e.target.value)} className="input-field text-base sm:text-xs py-2 w-28" />
          <button type="submit" disabled={disabled} className="btn-primary text-xs py-2 px-3 disabled:opacity-40">{t('Übernehmen')}</button>
        </form>
      )}
      {panel === 'date' && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); apply({ set: { purchase_date: date } }, date ? t('mit neuem Kaufdatum gespeichert') : t('ohne Kaufdatum gespeichert')); }}
        >
          <label htmlFor="bulk-date" className="text-xs text-slate-400">{t('Kaufdatum')}</label>
          <input id="bulk-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input-field text-base sm:text-xs py-2 w-auto" />
          <button type="submit" disabled={disabled} className="btn-primary text-xs py-2 px-3 disabled:opacity-40">{t('Übernehmen')}</button>
        </form>
      )}
    </div>
  );
}
