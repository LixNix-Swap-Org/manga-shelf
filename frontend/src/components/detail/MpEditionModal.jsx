import { useState, useEffect } from 'react';
import { Globe, X, Check, RefreshCw, Sparkles, Search } from 'lucide-react';

export default function MpEditionModal({
  isOpen,
  onClose,
  manga,
  mangaId,
  mpGapData,
  mpGapLoading,
  fetchMpGaps,
  handleSyncTotalVolumes,
  handleBatchAutofillManga,
  batchAutofilling,
  handleSelectMpEdition
}) {
  const [mpEditionSearchQuery, setMpEditionSearchQuery] = useState('');
  const [mpEditionSearchResults, setMpEditionSearchResults] = useState(null);
  const [searchingMpEditions, setSearchingMpEditions] = useState(false);

  const searchEditions = async (query) => {
    if (!query) return;
    setSearchingMpEditions(true);
    try {
      const res = await fetch(`/api/manga-passion/editions?title=${encodeURIComponent(query)}&publisher=${encodeURIComponent(manga?.publisher || '')}&total_volumes=${manga?.total_volumes || ''}`);
      if (res.ok) {
        const data = await res.json();
        setMpEditionSearchResults(data.candidates || []);
      }
    } catch (err) {
      alert('Fehler bei der Editionssuche');
    } finally {
      setSearchingMpEditions(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setMpEditionSearchQuery('');
    setMpEditionSearchResults(null);
    // the gap check no longer ships alternatives for an already linked edition: look them up when the dialog opens
    if (!mpGapData?.candidate_editions?.length) searchEditions(manga?.title);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSearchMpEditions = (e) => {
    if (e) e.preventDefault();
    return searchEditions(mpEditionSearchQuery.trim() || manga?.title);
  };

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      <div 
        className="glass-panel w-full max-w-lg rounded-2xl p-5 sm:p-6 border border-slate-700/80 shadow-2xl relative my-auto max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-sky-400" />
            <h3 className="font-bold text-white text-base">Deutsche Ausgabe synchronisieren</h3>
          </div>
          <button 
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto custom-scrollbar flex-1 py-4 pr-1 space-y-4">
          <p className="text-xs text-slate-300 leading-relaxed">
            Verbinde diese Reihe mit der offiziellen deutschen Edition auf Manga-Passion, um Bandzahlen, Lücken, Veröffentlichungsdaten und Preise automatisch abzugleichen.
          </p>

          {/* Currently linked edition */}
          {mpGapData?.edition && (
            <div className="p-3.5 bg-slate-950/80 rounded-xl border border-slate-800 space-y-2">
              <div className="text-[11px] uppercase font-bold text-slate-400 tracking-wider">Aktuell verknüpfte Edition</div>
              <div className="flex gap-3 items-center">
                {mpGapData.edition.cover_image && (
                  <img 
                    src={mpGapData.edition.cover_image} 
                    alt={mpGapData.edition.title}
                    className="w-12 h-16 object-cover rounded-lg border border-slate-700 shrink-0" 
                  />
                )}
                <div className="min-w-0 flex-1">
                  <h4 className="font-bold text-white text-sm truncate">{mpGapData.edition.title}</h4>
                  <p className="text-xs text-slate-400">
                    {mpGapData.edition.publisher} • {mpGapData.edition.total_volumes || '?'} Bände • Status: {mpGapData.edition.status}
                  </p>
                </div>
              </div>

              {/* Actions for current edition */}
              <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-800 text-xs">
                {mpGapData.discrepancy && (
                  <button
                    type="button"
                    onClick={() => handleSyncTotalVolumes(mpGapData.discrepancy.official_total)}
                    disabled={mpGapLoading}
                    className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Bandzahl auf {mpGapData.discrepancy.official_total} korrigieren</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => fetchMpGaps(mpGapData.edition.id, true)}
                  disabled={mpGapLoading}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${mpGapLoading ? 'animate-spin' : ''}`} />
                  <span>Daten neu laden</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleBatchAutofillManga(false)}
                  disabled={batchAutofilling || mpGapLoading}
                  className="px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer shadow-sm shadow-sky-900/30"
                  title="Füllt fehlende Erscheinungsdaten, Jahr, Seiten und Preise für alle Bände dieser Reihe aus"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${batchAutofilling ? 'animate-spin' : ''}`} />
                  <span>{batchAutofilling ? 'Fülle Bände aus...' : '⚡ Alle Bände mit Erscheinungsdaten anreichern'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Search other editions */}
          <div className="space-y-2">
            <div className="text-[11px] uppercase font-bold text-slate-400 tracking-wider">Andere deutsche Edition wählen</div>
            <form onSubmit={handleSearchMpEditions} className="flex gap-2">
              <input 
                type="text" 
                value={mpEditionSearchQuery}
                onChange={e => setMpEditionSearchQuery(e.target.value)}
                placeholder="Titel auf Manga-Passion suchen..."
                className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-brand-500"
              />
              <button
                type="submit"
                disabled={searchingMpEditions}
                className="btn-primary px-3 py-2 text-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Search className="w-3.5 h-3.5" />
                <span>Suchen</span>
              </button>
            </form>

            {/* Candidate / Search Results list */}
            <div className="space-y-2 pt-2">
              {(mpEditionSearchResults || mpGapData?.candidate_editions || []).map(candidate => {
                const isCurrent = mpGapData?.edition?.id === candidate.id;
                return (
                  <div 
                    key={candidate.id}
                    className={`p-3 rounded-xl border transition-all flex items-center justify-between gap-3 text-xs ${
                      isCurrent 
                        ? 'bg-brand-500/10 border-brand-500/40 text-brand-200' 
                        : 'bg-slate-950/60 hover:bg-slate-800/60 border-slate-800 text-slate-300'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-white truncate">{candidate.title}</div>
                      <div className="text-[11px] text-slate-400">
                        {candidate.publisher} • {candidate.total_volumes || candidate.numVolumes || '?'} Bände • Status: {candidate.status === 2 ? 'Abgeschlossen' : (candidate.status === 1 ? 'Laufend' : (candidate.status || 'Unbekannt'))}
                      </div>
                    </div>
                    <div>
                      {isCurrent ? (
                        <span className="text-[10px] font-bold uppercase bg-brand-500/20 text-brand-300 px-2 py-1 rounded-md border border-brand-500/30">
                          Aktiv
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleSelectMpEdition(candidate)}
                          disabled={mpGapLoading}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-brand-600 text-slate-200 hover:text-white rounded-lg transition-all font-medium border border-slate-700 cursor-pointer"
                        >
                          Übernehmen
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
