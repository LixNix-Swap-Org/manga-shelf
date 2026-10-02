import { useState } from 'react';
import { X, Coins, Calendar, ShoppingCart, CheckCircle2 } from 'lucide-react';

export default function GapFillModal({
  isOpen,
  gapNumber,
  onClose,
  manga,
  mangaId,
  mpGapMap,
  canEdit,
  onSuccess
}) {
  const [loading, setLoading] = useState(false);

  if (!isOpen || gapNumber === null) return null;

  const meta = mpGapMap?.get(String(gapNumber).toLowerCase());

  const handleFillGap = async (targetStatus = 'Fehlt') => {
    if (!canEdit) return;
    setLoading(true);
    try {
      const res = await fetch('/api/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: mangaId,
          volume_number: String(gapNumber),
          status: targetStatus,
          price: meta && meta.price !== null ? meta.price : null,
          release_date: meta && meta.release_date ? meta.release_date : null,
          cover_image: meta && meta.cover_image ? meta.cover_image : null,
          publisher: manga?.publisher || null,
          type: 'volume'
        })
      });
      if (res.ok) {
        onClose();
        if (onSuccess) await onSuccess();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Erfassen des Bandes');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 animate-fade-in overflow-y-auto"
      onClick={() => !loading && onClose()}
    >
      <div 
        className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl relative my-3 sm:my-8"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 font-black">
              +
            </div>
            <div>
              <h3 className="font-bold text-white text-base">Lücke erfassen: Band {gapNumber}</h3>
              <p className="text-xs text-slate-400">{manga?.title}</p>
            </div>
          </div>
          <button 
            type="button"
            onClick={onClose}
            disabled={loading}
            className="text-slate-400 hover:text-white p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-slate-300 mb-3 leading-relaxed">
          Dieser Band fehlt in deiner Sammlung. Wie möchtest du Band {gapNumber} erfassen?
        </p>

        {/* Manga Passion Volume Preview Card */}
        {meta && (
          <div className="mb-4 p-3 bg-slate-950/90 rounded-xl border border-slate-800 flex gap-3 items-center">
            {meta.cover_image && (
              <img 
                src={meta.cover_image} 
                alt={`Band ${gapNumber}`}
                className="w-12 h-16 object-cover rounded-lg border border-slate-700 shrink-0 shadow-md"
              />
            )}
            <div className="text-xs space-y-1 min-w-0 flex-1">
              <div className="font-bold text-white truncate flex items-center gap-1.5">
                <span>{manga?.title} – Band {gapNumber}</span>
              </div>
              {meta.price && (
                <div className="text-amber-400 font-mono font-bold text-xs flex items-center gap-1">
                  <Coins className="w-3 h-3 text-amber-400" />
                  <span>Offizieller Preis: {meta.price.toFixed(2).replace('.', ',')} €</span>
                </div>
              )}
              {meta.release_date && (
                <div className="text-slate-400 text-[11px] flex items-center gap-1">
                  <Calendar className="w-3 h-3 text-slate-500" />
                  <span>Erschienen: {meta.release_date}</span>
                  <span className={`text-[9px] px-1.5 py-0.2 rounded font-semibold ${meta.is_released ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300'}`}>
                    {meta.is_released ? 'Bereits im Handel' : 'Vorbestellbar'}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => handleFillGap('Fehlt')}
            className="w-full py-3 px-4 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/50 text-amber-200 font-semibold text-xs flex items-center justify-between transition-all group cursor-pointer"
          >
            <div className="flex items-center gap-2.5 text-left">
              <ShoppingCart className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
              <div>
                <div className="font-bold">Auf Einkaufsliste setzen</div>
                <div className="text-[11px] text-amber-400/80">Status: Fehlt noch (erscheint im Buchladen-Modus)</div>
              </div>
            </div>
            <span className="text-base font-bold text-amber-400">→</span>
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={() => handleFillGap('Vorhanden')}
            className="w-full py-3 px-4 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/50 text-emerald-200 font-semibold text-xs flex items-center justify-between transition-all group cursor-pointer"
          >
            <div className="flex items-center gap-2.5 text-left">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 group-hover:scale-110 transition-transform" />
              <div>
                <div className="font-bold">Direkt als im Besitz eintragen</div>
                <div className="text-[11px] text-emerald-400/80">Status: Vorhanden (steht bereits im Regal)</div>
              </div>
            </div>
            <span className="text-base font-bold text-emerald-400">→</span>
          </button>
        </div>

        <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-800">
          <button
            type="button"
            disabled={loading}
            onClick={onClose}
            className="btn-secondary text-xs"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}
