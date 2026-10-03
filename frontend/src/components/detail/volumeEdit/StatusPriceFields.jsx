import { X, Calendar, Coins, Bookmark, Check, Truck } from 'lucide-react';

/** Collector status switch and purchase price. */
export default function StatusPriceFields({
  editVolForm,
  setEditVolForm
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 sm:gap-3.5 items-end">
      <div className="sm:col-span-7">
        <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
          <Bookmark className="w-3.5 h-3.5 text-brand-400" /> Sammler-Status
        </label>
        {/* Segmented Switch Pill Control */}
        <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-950/90 rounded-xl border border-slate-800 shadow-inner">
          <button
            type="button"
            onClick={() => setEditVolForm({ ...editVolForm, status: 'Vorhanden' })}
            className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
              editVolForm.status === 'Vorhanden'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/40 ring-1 ring-emerald-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
            }`}
          >
            <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[2.5] shrink-0" />
            <span className="truncate">Im Besitz</span>
          </button>
          <button
            type="button"
            onClick={() => setEditVolForm({ ...editVolForm, status: 'Vorbestellt' })}
            className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
              editVolForm.status === 'Vorbestellt'
                ? 'bg-sky-500/20 text-sky-300 border border-sky-500/50 shadow-sm shadow-sky-950/40 ring-1 ring-sky-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
            }`}
          >
            <Truck className="w-3.5 h-3.5 text-sky-400 stroke-[2.5] shrink-0" />
            <span className="truncate">Vorbestellt</span>
          </button>
          <button
            type="button"
            onClick={() => setEditVolForm({ ...editVolForm, status: 'Erscheint bald' })}
            className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
              editVolForm.status === 'Erscheint bald'
                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50 shadow-sm shadow-purple-950/40 ring-1 ring-purple-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
            }`}
          >
            <Calendar className="w-3.5 h-3.5 text-purple-400 stroke-[2.5] shrink-0" />
            <span className="truncate">Erscheint bald</span>
          </button>
          <button
            type="button"
            onClick={() => setEditVolForm({ ...editVolForm, status: 'Fehlt' })}
            className={`py-2 px-1.5 rounded-lg text-[11px] sm:text-xs font-bold transition-all flex items-center justify-center gap-1 select-none truncate ${
              editVolForm.status === 'Fehlt'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/40 ring-1 ring-rose-500/30'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
            }`}
          >
            <X className="w-3.5 h-3.5 text-rose-400 stroke-[2.5] shrink-0" />
            <span className="truncate">Fehlt noch</span>
          </button>
        </div>
      </div>

      <div className="sm:col-span-5">
        <label className="block text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
          <Coins className="w-3.5 h-3.5" /> Kaufpreis (€)
        </label>
        <div className="relative">
          <input 
            type="text" 
            placeholder="0,00"
            className="input-field border-emerald-500/40 focus:border-emerald-500 font-mono font-bold text-emerald-300 pr-8 py-2.5 text-sm" 
            value={editVolForm.price} 
            onChange={e => setEditVolForm({ ...editVolForm, price: e.target.value })} 
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-emerald-500/70 font-bold pointer-events-none">€</span>
        </div>
      </div>
    </div>
  );
}
