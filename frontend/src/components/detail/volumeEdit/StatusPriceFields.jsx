import { useId } from 'react';
import { X, Calendar, Coins, Bookmark, Check, Truck, ShoppingCart } from 'lucide-react';
import { PRIORITY_OPTIONS } from '../../../utils/priority';

const PILL_IDLE = 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent';

// every status VOLUME_STATUSES (core/lib/validate.js) can store; 'Gelesen' is a read entry, not a status
const STATUS_OPTIONS = [
  { value: 'Vorhanden', label: 'Im Besitz', Icon: Check, iconClass: 'text-emerald-400', active: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/40 ring-1 ring-emerald-500/30' },
  { value: 'Bestellt', label: 'Bestellt', Icon: ShoppingCart, iconClass: 'text-amber-400', active: 'bg-amber-500/20 text-amber-300 border border-amber-500/50 shadow-sm shadow-amber-950/40 ring-1 ring-amber-500/30' },
  { value: 'Vorbestellt', label: 'Vorbestellt', Icon: Truck, iconClass: 'text-sky-400', active: 'bg-sky-500/20 text-sky-300 border border-sky-500/50 shadow-sm shadow-sky-950/40 ring-1 ring-sky-500/30' },
  { value: 'Erscheint bald', label: 'Erscheint bald', Icon: Calendar, iconClass: 'text-purple-400', active: 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-sm shadow-purple-950/40 ring-1 ring-purple-500/30' },
  { value: 'Fehlt', label: 'Fehlt noch', Icon: X, iconClass: 'text-rose-400', active: 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/40 ring-1 ring-rose-500/30' }
];

/** Collector status switch and purchase price. */
export default function StatusPriceFields({
  editVolForm,
  setEditVolForm,
  errors = {}
}) {
  const id = useId();
  const setField = (key) => (e) => {
    const value = e.target.value;
    setEditVolForm(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-3.5 items-end">
      <div className="sm:col-span-7">
        <span id={`${id}-status`} className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
          <Bookmark className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> Sammler-Status
        </span>
        {/* Segmented Switch Pill Control */}
        <div role="group" aria-labelledby={`${id}-status`} className="grid grid-cols-2 gap-1.5 p-1 bg-slate-950/90 rounded-xl border border-slate-800 shadow-inner">
          {STATUS_OPTIONS.map(({ value, label, Icon, iconClass, active }, i) => (
            <button
              key={value}
              type="button"
              aria-pressed={editVolForm.status === value}
              onClick={() => setEditVolForm(prev => ({ ...prev, status: value }))}
              className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
                i === STATUS_OPTIONS.length - 1 ? 'col-span-2' : ''
              } ${editVolForm.status === value ? active : PILL_IDLE}`}
            >
              <Icon className={`w-3.5 h-3.5 ${iconClass} stroke-[2.5] shrink-0`} aria-hidden="true" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="sm:col-span-5">
        <label htmlFor={`${id}-price`} className="block text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
          <Coins className="w-3.5 h-3.5" aria-hidden="true" /> Kaufpreis (€)
        </label>
        <div className="relative">
          <input
            id={`${id}-price`}
            type="text"
            inputMode="decimal"
            placeholder="0,00"
            aria-invalid={errors.price ? true : undefined}
            aria-describedby={errors.price ? `${id}-price-error` : undefined}
            className="input-field border-emerald-500/40 focus:border-emerald-500 font-mono font-bold text-emerald-300 pr-8 py-2.5 text-base sm:text-sm"
            value={editVolForm.price ?? ''}
            onChange={setField('price')}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-emerald-500/70 font-bold pointer-events-none" aria-hidden="true">€</span>
        </div>
        {errors.price && <p id={`${id}-price-error`} className="text-[11px] text-red-400 mt-1">{errors.price}</p>}
      </div>

      {editVolForm.status === 'Fehlt' && (
        <>
          <div className="sm:col-span-7">
            <label htmlFor={`${id}-priority`} className="block text-xs font-semibold text-slate-300 mb-1.5">Wunsch-Priorität</label>
            <select
              id={`${id}-priority`}
              className="input-field py-2.5 text-base sm:text-sm"
              value={editVolForm.priority ?? '0'}
              onChange={setField('priority')}
            >
              {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
            </select>
          </div>
          <div className="sm:col-span-5">
            <label htmlFor={`${id}-target-price`} className="block text-xs font-semibold text-slate-300 mb-1.5">Zielpreis (€)</label>
            <input
              id={`${id}-target-price`}
              type="text"
              inputMode="decimal"
              placeholder="max. Preis, z. B. gebraucht"
              aria-invalid={errors.target_price ? true : undefined}
              aria-describedby={errors.target_price ? `${id}-target-price-error` : undefined}
              className="input-field py-2.5 text-base sm:text-sm font-mono"
              value={editVolForm.target_price ?? ''}
              onChange={setField('target_price')}
            />
            {errors.target_price && <p id={`${id}-target-price-error`} className="text-[11px] text-red-400 mt-1">{errors.target_price}</p>}
          </div>
        </>
      )}
    </div>
  );
}
