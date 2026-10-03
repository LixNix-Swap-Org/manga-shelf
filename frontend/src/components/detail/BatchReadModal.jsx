import { useState } from 'react';
import { BookCheck, X, CheckCheck } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';

export default function BatchReadModal({
  isOpen,
  onClose,
  mangaId,
  readers = [],
  selectedReaderId,
  setSelectedReaderId,
  user,
  onSuccess
}) {
  const [batchReadUpTo, setBatchReadUpTo] = useState('');
  const [batchReadAction, setBatchReadAction] = useState(true);
  const [loading, setLoading] = useState(false);

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  const handleBatchRead = async (e) => {
    e.preventDefault();
    if (!batchReadUpTo || isNaN(parseFloat(batchReadUpTo))) {
      alert('Bitte eine gültige Band-Nummer eingeben');
      return;
    }
    setLoading(true);
    try {
      const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
      const res = await fetch('/api/volumes/batch-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: mangaId,
          up_to_volume: parseFloat(batchReadUpTo),
          read: batchReadAction,
          is_read: batchReadAction,
          user_id: effUserId
        })
      });
      if (res.ok) {
        setBatchReadUpTo('');
        onClose();
        if (onSuccess) await onSuccess();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Aktualisieren des Lesestatus');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Lesestatus setzen"
      tabIndex={-1}
      className="outline-none fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 animate-fade-in overflow-y-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass-panel w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-6 border border-slate-700/80 shadow-2xl relative my-3 sm:my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <BookCheck className="w-4 h-4 text-emerald-400" /> Lesestatus in Serie festlegen
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-400 mb-4">
          Markiere mehrere Bände bis zu einer bestimmten Band-Nummer mit einem Klick als gelesen oder ungelesen.
        </p>

        <form onSubmit={handleBatchRead} className="space-y-4">
          {readers.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">Leser</label>
              <select
                className="input-field bg-slate-950 text-xs"
                value={selectedReaderId}
                onChange={e => setSelectedReaderId(e.target.value)}
              >
                {readers.map(r => (
                  <option key={r.user_id} value={r.user_id}>
                    {r.display_name || r.username} ({r.read_count} gelesen)
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Aktion</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setBatchReadAction(true)}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 transition-all ${
                  batchReadAction 
                    ? 'bg-emerald-600/30 border-emerald-500 text-emerald-300 shadow-sm' 
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <BookCheck className="w-3.5 h-3.5 text-emerald-400" /> Als Gelesen markieren
              </button>
              <button
                type="button"
                onClick={() => setBatchReadAction(false)}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 transition-all ${
                  !batchReadAction 
                    ? 'bg-rose-600/30 border-rose-500 text-rose-300 shadow-sm' 
                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                }`}
              >
                <X className="w-3.5 h-3.5 text-rose-400" /> Als Ungelesen markieren
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">Bis einschließlich Band-Nummer</label>
            <input 
              type="number" 
              step="any"
              min="1" 
              required 
              placeholder="z. B. 12"
              className="input-field" 
              value={batchReadUpTo} 
              onChange={e => setBatchReadUpTo(e.target.value)} 
            />
            <span className="text-[11px] text-slate-500 mt-1 block">
              Alle vorhandenen Bände von Band 1 bis zu dieser Nummer erhalten den gewählten Status.
            </span>
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
              <CheckCheck className="w-3.5 h-3.5" /> {loading ? 'Wird angewendet...' : 'Anwenden'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
