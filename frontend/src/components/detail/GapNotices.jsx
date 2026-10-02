import { AlertTriangle, AlertCircle, Check, Sparkles, Search, ShoppingCart } from 'lucide-react';

/** Banners above the volume list: duplicate entries, Manga-Passion discrepancy and the detected gaps. */
export default function GapNotices({
  duplicateEntries, canEdit, showGaps, detectedGaps, detectedGapEntries, volumeFilter, volumeSearch,
  mpGapData, mpGapLoading, fillingGapLoading, handleSyncTotalVolumes, handleBatchFillGaps, handleSelectMpEdition, setShowMpEditionModal
}) {
  return (
    <>
      {/* The edition was only guessed (ambiguous search result) and is not stored until the user confirms it */}
      {mpGapData?.matched && mpGapData.link_confirmed === false && canEdit && (
        <div className="mb-4 p-3 bg-sky-500/10 border border-sky-500/40 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-sky-100">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-sky-300 shrink-0" />
            <div>
              <div className="font-bold text-sky-200">Manga-Passion-Edition nicht bestätigt</div>
              <div className="text-[11px] text-sky-100/90 leading-tight">
                Vorschlag: <em>{mpGapData.edition?.title}</em> ({mpGapData.total_official_volumes} Bände). Stimmt das nicht, zeigt der Abgleich falsche Lücken. „Bestätigen“ verknüpft die Edition und übernimmt Bandzahl und Status.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleSelectMpEdition(mpGapData.edition)}
              disabled={mpGapLoading}
              className="px-3 py-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold rounded-lg text-xs transition-all shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Edition bestätigen</span>
            </button>
            <button
              type="button"
              onClick={() => setShowMpEditionModal(true)}
              className="px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-all cursor-pointer"
            >
              Andere wählen
            </button>
          </div>
        </div>
      )}

    {/* Duplicate entries (same type and number more than once), e.g. from an accidental double click */}
    {duplicateEntries.length > 0 && canEdit && (
      <div className="mb-4 p-3 bg-rose-500/10 border border-rose-500/40 rounded-xl flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-rose-200">
        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
        <span>
          <strong>Doppelte Einträge:</strong> {duplicateEntries.map(d => `${d.label} (${d.count}×)`).join(', ')}
          {' '}– überzählige Bände kannst du über das ✕ an der Karte löschen.
        </span>
      </div>
    )}

    {/* Collection Gap Notice Banner (Shown in all view modes if gaps detected) */}
    {showGaps && detectedGaps.length > 0 && (volumeFilter === 'ALL' || volumeFilter === 'Fehlt') && !volumeSearch && (
      <div className="mb-4 space-y-2">
        {/* Discrepancy warning banner if AniList total differs from German Edition total */}
        {mpGapData?.discrepancy && canEdit && (
          <div className="p-3 bg-amber-500/15 border border-amber-500/40 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200 shadow-md">
            <div className="flex items-center gap-2.5">
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
              <div>
                <div className="font-bold text-amber-300">Sammlungs-Info korrigieren (Manga-Passion Abgleich)</div>
                <div className="text-[11px] text-amber-200/90 leading-tight">
                  {mpGapData.discrepancy.message}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleSyncTotalVolumes(mpGapData.discrepancy.official_total)}
                disabled={mpGapLoading}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Auf {mpGapData.discrepancy.official_total} Bände anpassen</span>
              </button>
            </div>
          </div>
        )}

        {/* Main Gaps Banner */}
        <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              <strong>{detectedGaps.length} Lücke{detectedGaps.length === 1 ? '' : 'n'} entdeckt:</strong> {detectedGaps.slice(0, 8).map(g => typeof g === 'number' ? `Band ${g}` : (String(g).startsWith('Band') ? g : (String(g).match(/^\d+/) ? `Band ${g}` : g))).join(', ')}{detectedGaps.length > 8 ? ` (+ ${detectedGaps.length - 8} weitere)` : ''}{detectedGapEntries.some(e => e.type !== 'volume') ? ` · davon ${detectedGapEntries.filter(e => e.type !== 'volume').length} Sonderausgaben/Schuber` : ''}
              {mpGapData?.edition && (
                <span className="ml-1.5 text-amber-300/80 text-[11px]">
                  (geprüft mit Manga-Passion: <em>{mpGapData.edition.title}</em>, {mpGapData.total_official_volumes} Bände)
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setShowMpEditionModal(true);
              }}
              className="px-2.5 py-1 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer"
              title="Manga-Passion Edition prüfen oder wechseln"
            >
              <Search className="w-3 h-3 text-brand-400" />
              <span>Manga-Passion Edition</span>
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => handleBatchFillGaps('Fehlt')}
                disabled={fillingGapLoading}
                className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 rounded-lg text-amber-200 font-semibold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {fillingGapLoading ? (
                  <div className="w-3 h-3 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ShoppingCart className="w-3 h-3 text-amber-300" />
                )}
                <span>{fillingGapLoading ? 'Wird übertragen...' : 'Alle auf Einkaufsliste'}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
