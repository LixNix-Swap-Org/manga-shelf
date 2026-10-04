import { TriangleAlert, CircleAlert, Check, Sparkles, Search, ShoppingCart } from 'lucide-react';
import { formatCount } from '../../utils/format';

const DUPLICATE_HINTS = {
  grid: 'überzählige Einträge kannst du über das Löschen-Symbol („Band löschen“) an der Karte entfernen.',
  list: 'überzählige Einträge kannst du über das Papierkorb-Symbol in der Zeile entfernen.',
  spine: 'überzählige Einträge kannst du im Band-Editor über „Band löschen“ entfernen (Buchrücken anklicken).'
};

/** Where the delete control for a duplicate lives in the current view (✕ means "Fehlt" in the list, so it is never named). */
export function duplicateHint(volumeViewMode) {
  return DUPLICATE_HINTS[volumeViewMode] || 'überzählige Einträge kannst du im Band-Editor über „Band löschen“ entfernen.';
}

const gapLabel = (g) => {
  if (typeof g === 'number') return `Band ${g}`;
  const s = String(g);
  if (s.startsWith('Band')) return s;
  return /^\d+/.test(s) ? `Band ${s}` : s;
};

/** Banners above the volume list: edition confirmation, duplicate entries, Manga-Passion discrepancy and the detected gaps. */
export default function GapNotices({
  duplicateEntries = [], canEdit, isOffline = false, showGaps, detectedGaps = [], detectedGapEntries = [],
  volumeFilter, volumeSearch = '', gapsAllowedByFilters, volumeViewMode,
  mpGapData, mpGapLoading, mpGapNotice, fillingGapLoading, canSyncVolumeCount, gapEditionUnconfirmed,
  handleSyncTotalVolumes, handleBatchFillGaps, handleSelectMpEdition, setShowMpEditionModal, collecting = 'aktiv'
}) {
  const searching = Boolean(String(volumeSearch ?? '').trim());
  const gapsVisible = gapsAllowedByFilters ?? ((volumeFilter === 'ALL' || volumeFilter === 'Fehlt') && !searching);
  const gapsFound = showGaps && detectedGaps.length > 0 && gapsVisible;
  // a series the household no longer collects offers no gap imports
  const dropped = collecting === 'abgebrochen';
  const showGapBanner = gapsFound && !dropped;
  const unconfirmed = gapEditionUnconfirmed ?? Boolean(mpGapData?.matched && mpGapData.link_confirmed === false);
  // a guessed edition shows only the confirm banner: confirming already takes over its volume count
  const showDiscrepancy = Boolean(canEdit && !isOffline && canSyncVolumeCount && mpGapData?.discrepancy && !searching);
  const officialTotal = mpGapData?.total_official_volumes;
  const extraGapCount = detectedGapEntries.filter(e => e.type !== 'volume').length;

  return (
    <>
      {mpGapData?.matched && unconfirmed && canEdit && !isOffline && (
        <div className="mb-4 p-3 bg-sky-500/10 border border-sky-500/40 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-sky-100">
          <div className="flex items-center gap-2.5">
            <CircleAlert className="w-5 h-5 text-sky-300 shrink-0" aria-hidden="true" />
            <div>
              <div className="font-bold text-sky-200">Manga-Passion-Edition nicht bestätigt</div>
              <div className="text-[11px] text-sky-100/90 leading-tight">
                Vorschlag: <em>{mpGapData.edition?.title || 'unbekannte Edition'}</em>{officialTotal ? ` (${formatCount(officialTotal, 'Band', 'Bände')})` : ''}. Stimmt das nicht, zeigt der Abgleich falsche Lücken. „Bestätigen“ verknüpft die Edition und übernimmt Bandzahl und Status.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleSelectMpEdition(mpGapData.edition)}
              disabled={mpGapLoading || !mpGapData.edition?.id}
              className="px-3 py-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold rounded-lg text-xs transition-all shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
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

      {duplicateEntries.length > 0 && canEdit && (
        <div role="status" className="mb-4 p-3 bg-rose-500/10 border border-rose-500/40 rounded-xl flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-rose-200">
          <TriangleAlert className="w-4 h-4 text-rose-400 shrink-0" aria-hidden="true" />
          <span>
            <strong>Doppelte Einträge:</strong> {duplicateEntries.map(d => `${d.label} (${d.count}×)`).join(', ')}
            {' '}– {duplicateHint(volumeViewMode)}
          </span>
        </div>
      )}

      {/* reported by the gap check whether or not gaps exist (e.g. all 11 volumes of the German edition owned, stored total 22) */}
      {showDiscrepancy && (
        <div className="mb-4 p-3 bg-amber-500/15 border border-amber-500/40 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200 shadow-md">
          <div className="flex items-center gap-2.5">
            <CircleAlert className="w-5 h-5 text-amber-400 shrink-0" aria-hidden="true" />
            <div>
              <div className="font-bold text-amber-300">Sammlungs-Info korrigieren (Manga-Passion-Abgleich)</div>
              <div className="text-[11px] text-amber-200/90 leading-tight">
                {mpGapData.discrepancy.message}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleSyncTotalVolumes()}
              disabled={mpGapLoading}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs transition-all shadow-sm flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Auf {formatCount(mpGapData.discrepancy.official_total, 'Band', 'Bände')} anpassen</span>
            </button>
          </div>
        </div>
      )}

      {showGapBanner && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
            <span>
              <strong>{formatCount(detectedGaps.length, 'Lücke', 'Lücken')} entdeckt:</strong> {detectedGaps.slice(0, 8).map(gapLabel).join(', ')}{detectedGaps.length > 8 ? ` (+ ${detectedGaps.length - 8} weitere)` : ''}{extraGapCount > 0 ? ` · davon ${formatCount(extraGapCount, 'Sonderausgabe/Schuber', 'Sonderausgaben/Schuber')}` : ''}
              {mpGapData?.matched && mpGapData.edition?.title && (
                <span className="ml-1.5 text-amber-300/80 text-[11px]">
                  (geprüft mit Manga Passion: <em>{mpGapData.edition.title}</em>{officialTotal ? `, ${formatCount(officialTotal, 'Band', 'Bände')}` : ''})
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isOffline && (
              <button
                type="button"
                onClick={() => setShowMpEditionModal(true)}
                className="px-2.5 py-1 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                title={canEdit ? 'Manga-Passion-Edition prüfen oder wechseln' : 'Manga-Passion-Edition ansehen'}
              >
                <Search className="w-3 h-3 text-brand-400" aria-hidden="true" />
                <span>Manga-Passion-Edition</span>
              </button>
            )}
            {canEdit && !isOffline && (
              <button
                type="button"
                onClick={() => handleBatchFillGaps('Fehlt')}
                disabled={fillingGapLoading || unconfirmed}
                title={unconfirmed ? 'Erst die Manga-Passion-Edition bestätigen' : undefined}
                className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 rounded-lg text-amber-200 font-semibold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {fillingGapLoading ? (
                  <div aria-hidden="true" className="w-3 h-3 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ShoppingCart className="w-3 h-3 text-amber-300" aria-hidden="true" />
                )}
                <span>{fillingGapLoading ? 'Wird übertragen...' : 'Alle auf Einkaufsliste'}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {gapsFound && dropped && (
        <p id="gap-notice-dropped" className="mb-4 text-[11px] text-slate-400 flex items-center gap-1.5">
          <CircleAlert className="w-3.5 h-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span>Nicht mehr gesammelt: {formatCount(detectedGaps.length, 'Lücke wird', 'Lücken werden')} nicht angezeigt.</span>
        </p>
      )}

      {mpGapNotice && !isOffline && (
        <p role="status" className="mb-4 -mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
          <CircleAlert className="w-3.5 h-3.5 shrink-0 text-slate-400" aria-hidden="true" />
          <span>{mpGapNotice}</span>
        </p>
      )}
    </>
  );
}
