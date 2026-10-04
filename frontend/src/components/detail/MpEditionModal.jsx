// Dialog to inspect, confirm, refresh or switch the Manga Passion edition linked to a series.
import { useState, useEffect, useRef } from 'react';
import { Globe, X, Check, RefreshCw, Sparkles, Search, CircleAlert } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { readApiError } from '../../hooks/useVolumeActions';
import { canFixVolumeCount, isGapEditionUnconfirmed } from '../../utils/volumeHelpers';
import { apiFetch, readJson, assetImgProps, TIMEOUTS } from '../../utils/api';
import { formatCount } from '../../utils/format';
import { t } from '../../i18n/index.js';
import { mangaStatusLabel } from '../../utils/enumLabels';

// i18n
const EDITION_STATUS = { 1: 'Laufend', 2: 'Abgeschlossen' };

/**
 * Which actions the edition dialog offers. Writing actions need edit rights; autofill only runs on a stored edition,
 * so a guessed one offers "Edition bestätigen" instead.
 */
export function mpModalActions({ canEdit, isOffline, mpGapData }) {
  const write = Boolean(canEdit) && !isOffline;
  const unconfirmed = isGapEditionUnconfirmed(mpGapData) || mpGapData?.link_confirmed === false;
  const hasEdition = Boolean(mpGapData?.edition?.id);
  return {
    fixCount: write && canFixVolumeCount(mpGapData),
    autofill: write && hasEdition && !unconfirmed,
    confirm: write && hasEdition && unconfirmed,
    select: write,
    reload: !isOffline && hasEdition,
    search: !isOffline
  };
}

export default function MpEditionModal({
  isOpen,
  onClose,
  manga,
  mpGapData,
  mpGapLoading,
  mpGapNotice,
  fetchMpGaps,
  handleSyncTotalVolumes,
  handleBatchAutofillManga,
  batchAutofilling,
  handleSelectMpEdition,
  canEdit = false,
  isOffline = false
}) {
  const [mpEditionSearchQuery, setMpEditionSearchQuery] = useState('');
  const [mpEditionSearchResults, setMpEditionSearchResults] = useState(null);
  const [searchingMpEditions, setSearchingMpEditions] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchSeqRef = useRef(0);

  const searchEditions = async (query) => {
    if (!query || isOffline) return;
    const seq = ++searchSeqRef.current;
    setSearchingMpEditions(true);
    setSearchError('');
    try {
      const params = new URLSearchParams({
        title: query,
        publisher: manga?.publisher || '',
        total_volumes: manga?.total_volumes ? String(manga.total_volumes) : ''
      });
      const res = await apiFetch(`/api/manga-passion/editions?${params}`, { timeout: TIMEOUTS.lookup });
      if (seq !== searchSeqRef.current) return;
      if (res.ok) {
        const data = await readJson(res);
        if (seq !== searchSeqRef.current) return;
        setMpEditionSearchResults(Array.isArray(data?.candidates) ? data.candidates : []);
      } else {
        const message = await readApiError(res, t('Editionssuche fehlgeschlagen'));
        if (seq === searchSeqRef.current) setSearchError(message);
      }
    } catch (err) {
      if (seq === searchSeqRef.current) setSearchError(err?.isTimeout ? t('Editionssuche: {message}', { message: err.message }) : t('Editionssuche nicht möglich (Netzwerkfehler).'));
    } finally {
      if (seq === searchSeqRef.current) setSearchingMpEditions(false);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      searchSeqRef.current++;
      setSearchingMpEditions(false);
      return;
    }
    setMpEditionSearchQuery('');
    setMpEditionSearchResults(null);
    setSearchError('');
    // the gap check no longer ships alternatives for an already linked edition: look them up when the dialog opens
    if (!isOffline && !mpGapData?.candidate_editions?.length) searchEditions(manga?.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [isOpen]);

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  // the edition was only guessed by the search and is not stored until the user confirms it
  const unconfirmed = mpGapData?.link_confirmed === false;
  const actions = mpModalActions({ canEdit, isOffline, mpGapData });
  const readOnly = !actions.select;
  const candidates = mpEditionSearchResults || mpGapData?.candidate_editions || [];

  const handleSearchMpEditions = (e) => {
    if (e) e.preventDefault();
    return searchEditions(mpEditionSearchQuery.trim() || manga?.title);
  };

  // a guessed edition is reloaded through the search path: an explicit edition_id would only preview it
  const handleReload = () => fetchMpGaps(unconfirmed ? null : mpGapData.edition.id, true);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('Manga-Passion-Edition wählen')}
      tabIndex={-1}
      className="outline-none dialog-overlay z-50 bg-black/80 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="dialog-box glass-panel max-w-lg rounded-2xl p-5 sm:p-6 short:p-4 border border-slate-700/80 shadow-2xl relative max-h-[90vh] supports-[height:100dvh]:max-h-[90dvh] short:max-h-none flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-sky-400" aria-hidden="true" />
            <h2 className="font-bold text-white text-base">{readOnly ? t('Manga-Passion-Edition ansehen') : t('Deutsche Ausgabe synchronisieren')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('Schließen')}
            title={t('Schließen')}
            className="hit-44 text-slate-400 hover:text-white p-1 rounded-lg"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-y-auto short:overflow-visible custom-scrollbar flex-1 py-4 pr-1 space-y-4">
          <p className="text-xs text-slate-300 leading-relaxed">
            {readOnly
              ? t('Die offizielle deutsche Edition auf Manga Passion liefert Bandzahlen, Lücken, Veröffentlichungsdaten und Preise dieser Reihe.')
              : t('Verbinde diese Reihe mit der offiziellen deutschen Edition auf Manga-Passion, um Bandzahlen, Lücken, Veröffentlichungsdaten und Preise automatisch abzugleichen.')}
          </p>

          {isOffline && (
            <p className="text-xs text-slate-400 bg-slate-900/80 border border-slate-800 rounded-xl p-2.5">
              {t('Offline nicht verfügbar: Der Manga-Passion-Abgleich braucht eine Verbindung.')}
            </p>
          )}
          {!isOffline && readOnly && (
            <p className="text-xs text-slate-400 bg-slate-900/80 border border-slate-800 rounded-xl p-2.5">
              {t('Nur Leseansicht: Nur Bearbeiter können die Edition ändern.')}
            </p>
          )}
          {mpGapNotice && (
            <p role="status" className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <CircleAlert className="w-3.5 h-3.5 shrink-0 text-slate-400" aria-hidden="true" />
              <span>{mpGapNotice}</span>
            </p>
          )}

          {/* Currently linked (or only suggested) edition */}
          {mpGapData?.edition && (
            <div className="p-3.5 bg-slate-950/80 rounded-xl border border-slate-800 space-y-2">
              <div className="text-[11px] uppercase font-bold text-slate-400 tracking-wider">{unconfirmed ? t('Vorgeschlagene Edition (noch nicht bestätigt)') : t('Aktuell verknüpfte Edition')}</div>
              <div className="flex gap-3 items-center">
                {mpGapData.edition.cover_image && (
                  <img
                    {...assetImgProps(mpGapData.edition.cover_image)}
                    alt={mpGapData.edition.title}
                    className="w-12 h-16 object-cover rounded-lg border border-slate-700 shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold text-white text-sm truncate">{mpGapData.edition.title}</h3>
                  <p className="text-xs text-slate-400">
                    {[mpGapData.edition.publisher, (mpGapData.edition.total_volumes ? formatCount(mpGapData.edition.total_volumes, 'Band', 'Bände') : t('? Bände')), mpGapData.edition.status ? t('Status: {status}', { status: mangaStatusLabel(mpGapData.edition.status) }) : null].filter(Boolean).join(' • ')}
                  </p>
                </div>
              </div>

              {(actions.fixCount || actions.reload || actions.autofill || actions.confirm) && (
                <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-800 text-xs">
                  {actions.fixCount && (
                    <button
                      type="button"
                      onClick={() => handleSyncTotalVolumes()}
                      disabled={mpGapLoading}
                      className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t('Bandzahl auf {official_total} korrigieren', { official_total: mpGapData.discrepancy.official_total })}</span>
                    </button>
                  )}
                  {actions.confirm && (
                    <button
                      type="button"
                      onClick={() => handleSelectMpEdition(mpGapData.edition)}
                      disabled={mpGapLoading}
                      className="px-3 py-1.5 bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t('Edition bestätigen')}</span>
                    </button>
                  )}
                  {actions.reload && (
                    <button
                      type="button"
                      onClick={handleReload}
                      disabled={mpGapLoading}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${mpGapLoading ? 'animate-spin' : ''}`} aria-hidden="true" />
                      <span>{t('Daten neu laden')}</span>
                    </button>
                  )}
                  {actions.autofill && (
                    <button
                      type="button"
                      onClick={() => handleBatchAutofillManga()}
                      disabled={batchAutofilling || mpGapLoading}
                      className="px-3 py-1.5 bg-sky-700 hover:bg-sky-800 text-white font-semibold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer shadow-sm shadow-sky-900/30 disabled:opacity-50"
                      title={t('Füllt fehlende Erscheinungsdaten, Jahr, Seiten und Preise für alle Bände dieser Reihe aus')}
                    >
                      <Sparkles className={`w-3.5 h-3.5 ${batchAutofilling ? 'animate-spin' : ''}`} aria-hidden="true" />
                      {batchAutofilling ? <span>{t('Fülle Bände aus...')}</span> : (
                        <span>{t('Alle Bände mit Erscheinungsdaten anreichern')}</span>
                      )}
                    </button>
                  )}
                </div>
              )}
              {canEdit && !isOffline && unconfirmed && (
                <p className="text-[11px] text-slate-400">{t('Bände anreichern geht erst, wenn die Edition bestätigt ist.')}</p>
              )}
            </div>
          )}

          {/* Search other editions */}
          {actions.search && (
            <div className="space-y-2">
              <div className="text-[11px] uppercase font-bold text-slate-400 tracking-wider">{readOnly ? t('Deutsche Editionen suchen') : t('Andere deutsche Edition wählen')}</div>
              <form onSubmit={handleSearchMpEditions} className="flex gap-2">
                <input
                  type="text"
                  value={mpEditionSearchQuery}
                  onChange={e => setMpEditionSearchQuery(e.target.value)}
                  placeholder={t('Titel bei Manga Passion suchen...')}
                  aria-label={t('Titel bei Manga Passion suchen')}
                  className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-base sm:text-xs text-white placeholder-slate-400 outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-400"
                />
                <button
                  type="submit"
                  disabled={searchingMpEditions}
                  className="btn-primary px-3 py-2 text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <Search className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('Suchen')}</span>
                </button>
              </form>

              <div className="space-y-2 pt-2" aria-live="polite">
                {searchingMpEditions && (
                  <p className="text-xs text-slate-400 flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> {t('Suche Editionen...')}
                  </p>
                )}
                {!searchingMpEditions && searchError && (
                  <p role="alert" className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-xl p-2.5">{searchError}</p>
                )}
                {!searchingMpEditions && !searchError && mpEditionSearchResults && mpEditionSearchResults.length === 0 && (
                  <p className="text-xs text-slate-400">{t('Keine Editionen gefunden.')}</p>
                )}
                {candidates.map(candidate => {
                  const isCurrent = mpGapData?.edition?.id === candidate.id;
                  const status = mangaStatusLabel(EDITION_STATUS[candidate.status] || candidate.status) || t('Unbekannt');
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
                          {candidate.publisher} • {(candidate.total_volumes || candidate.numVolumes) ? formatCount(candidate.total_volumes || candidate.numVolumes, 'Band', 'Bände') : t('? Bände')} • {t('Status: {status}', { status })}
                        </div>
                      </div>
                      <div>
                        {isCurrent && !unconfirmed ? (
                          <span className="text-[10px] font-bold uppercase bg-brand-500/20 text-brand-300 px-2 py-1 rounded-md border border-brand-500/30">
                            {t('Aktiv')}
                          </span>
                        ) : actions.select ? (
                          <button
                            type="button"
                            onClick={() => handleSelectMpEdition(candidate)}
                            disabled={mpGapLoading}
                            className="px-2.5 py-1 bg-slate-800 hover:bg-brand-700 text-slate-200 hover:text-white rounded-lg transition-all font-medium border border-slate-700 cursor-pointer disabled:opacity-50"
                          >
                            {isCurrent ? t('Bestätigen') : t('Übernehmen')}
                          </button>
                        ) : isCurrent ? (
                          <span className="text-[10px] font-semibold text-slate-400">{t('Vorschlag')}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold cursor-pointer"
          >
            {t('Schließen')}
          </button>
        </div>
      </div>
    </div>
  );
}
