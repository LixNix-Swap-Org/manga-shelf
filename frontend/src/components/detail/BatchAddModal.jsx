import { useState } from 'react';
import { Layers, X, Bookmark, Check, Coins, Plus } from 'lucide-react';

export default function BatchAddModal({ isOpen, onClose, manga, mangaId, onSuccess }) {
  const [batchFrom, setBatchFrom] = useState('1');
  const [batchTo, setBatchTo] = useState('10');
  const [batchStatus, setBatchStatus] = useState('Vorhanden');
  const [batchPrice, setBatchPrice] = useState('');
  const [batchPublisher, setBatchPublisher] = useState('');
  const [batchCondition, setBatchCondition] = useState('');
  const [batchReleaseYear, setBatchReleaseYear] = useState('');
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleBatchAdd = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/volumes/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: mangaId,
          from: batchFrom,
          to: batchTo,
          status: batchStatus,
          default_price: batchPrice ? batchPrice.trim() : null,
          publisher: batchPublisher ? batchPublisher.trim() : null,
          condition: batchCondition ? batchCondition.trim() : null,
          release_year: batchReleaseYear ? batchReleaseYear.trim() : null
        })
      });
      if (res.ok) {
        setBatchPrice('');
        setBatchPublisher('');
        setBatchCondition('');
        setBatchReleaseYear('');
        onClose();
        if (onSuccess) await onSuccess();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Hinzufügen mehrerer Bände');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 animate-fade-in overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass-panel w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-6 border border-slate-700/80 shadow-2xl relative my-3 sm:my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Layers className="w-4 h-4 text-brand-400" /> Bände in Serie hinzufügen
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4">
          Fügt automatisch alle Bände in einem Zahlenbereich hinzu. Bereits vorhandene Bände werden übersprungen.
        </p>

        <form onSubmit={handleBatchAdd} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Von Band</label>
              <input 
                type="number" 
                min="1" 
                required 
                className="input-field" 
                value={batchFrom} 
                onChange={e => setBatchFrom(e.target.value)} 
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Bis Band</label>
              <input 
                type="number" 
                min="1" 
                required 
                className="input-field" 
                value={batchTo} 
                onChange={e => setBatchTo(e.target.value)} 
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                <Bookmark className="w-3.5 h-3.5 text-brand-400" /> Startstatus
              </label>
              <div className="grid grid-cols-2 p-1 bg-slate-950/90 rounded-xl border border-slate-800 gap-1.5 shadow-inner">
                <button
                  type="button"
                  onClick={() => setBatchStatus('Vorhanden')}
                  className={`py-2 px-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 select-none ${
                    batchStatus === 'Vorhanden'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/30'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[2.5]" />
                  <span>Im Regal</span>
                </button>
                <button
                  type="button"
                  onClick={() => setBatchStatus('Fehlt')}
                  className={`py-2 px-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 select-none ${
                    batchStatus === 'Fehlt'
                      ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/30'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  <X className="w-3.5 h-3.5 text-rose-400 stroke-[2.5]" />
                  <span>Fehlt noch</span>
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
                <Coins className="w-3.5 h-3.5" /> Preis pro Band (€)
              </label>
              <div className="relative">
                <input 
                  type="text" 
                  placeholder="z. B. 7,99 (optional)"
                  className="input-field text-xs font-mono text-emerald-300 pr-8 py-2.5 border-emerald-500/40 focus:border-emerald-500 font-bold"
                  value={batchPrice} 
                  onChange={e => setBatchPrice(e.target.value)} 
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-emerald-500/70 font-bold pointer-events-none">€</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Verlag (optional)</label>
              <input 
                type="text" 
                placeholder={manga?.publisher || 'z. B. Carlsen'}
                className="input-field text-xs"
                value={batchPublisher} 
                onChange={e => setBatchPublisher(e.target.value)} 
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Zustand (optional)</label>
              <select 
                className="input-field bg-slate-950 text-xs"
                value={batchCondition} 
                onChange={e => setBatchCondition(e.target.value)}
              >
                <option value="">-- Keine Angabe --</option>
                <option value="Neuwertig">Neuwertig</option>
                <option value="Sehr gut">Sehr gut</option>
                <option value="Gut">Gut</option>
                <option value="Akzeptabel">Akzeptabel</option>
                <option value="Mängelexemplar">Mängelexemplar</option>
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t border-slate-800">
            <button 
              type="button" 
              onClick={onClose} 
              className="btn-secondary text-xs"
              disabled={loading}
            >
              Abbrechen
            </button>
            <button type="submit" disabled={loading} className="btn-primary text-xs flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> {loading ? 'Wird generiert...' : 'Bände generieren'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
