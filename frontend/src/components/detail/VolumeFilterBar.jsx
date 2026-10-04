import { ArrowUpDown, BookCheck, BookOpen, Calendar, Check, ListChecks, BuildingComplex, ChevronDown, Eye, EyeOff, Funnel, Globe, Hourglass, LayoutGrid, Library, List, Package, RotateCcw, Search, Sparkles, Truck, X } from 'lucide-react';
import { CONDITION_NONE, READ_FILTER, UNREAD_FILTER } from '../../utils/volumeHelpers';
import { mpPillText } from './volumeViewHelpers';
import { formatCount } from '../../utils/format';
import { t } from '../../i18n/index.js';
import { payloadText } from '../../i18n/serverText.js';
import { rich } from '../../i18n/react.jsx';
import { conditionLabel } from '../../utils/enumLabels';


/** View-mode switcher, gap/Manga-Passion pills, status/type filters, search and sort. Purely presentational; all state and handlers come in via props. */
export default function VolumeFilterBar({
  availablePublishers,
  baseVolumesForType,
  conditionsList,
  currentReaderReadCount,
  currentReaderUnreadCount,
  detectedGaps,
  gapsAllowedByFilters = true,
  handleResetFilters,
  handleSetVolumeViewMode,
  handleToggleShowGaps,
  hasActiveFilters,
  isOffline = false,
  missingCount,
  mpGapData,
  mpGapError,
  mpGapLoading,
  mpEnabled = true,
  ownedCount,
  preorderedCount,
  regularVolumeCount,
  schuberCount,
  setShowMpEditionModal,
  setVolumeConditionFilter,
  setVolumeFilter,
  setVolumePublisherFilter,
  setVolumeSearch,
  setVolumeSort,
  setVolumeTypeFilter,
  showGaps,
  specialCount,
  specialEditionCount,
  upcomingCount,
  volumeConditionFilter,
  volumeFilter,
  volumePublisherFilter,
  volumeSearch,
  volumeSort,
  volumeTypeFilter,
  volumeViewMode,
  volumes,
  canSelect = false,
  selectionMode = false,
  onToggleSelectionMode
}) {
  const showTypeChip = (type, count) => count > 0 || volumeTypeFilter === type;
  const showTypeRow = specialEditionCount > 0 || schuberCount > 0 || specialCount > 0 || volumeTypeFilter !== 'ALL';
  const visibleGapCount = showGaps && gapsAllowedByFilters ? detectedGaps.length : 0;
  return (
    <div className="flex flex-col gap-3 mb-6 p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800/80 shadow-lg">
      {/* Top Bar: View Mode Switcher + Gap Indicator */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800/60">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
            <Library className="w-3.5 h-3.5 text-brand-400" />
            {t('Ansicht:')}
          </span>
          <div role="group" aria-label={t('Ansicht')} className="flex items-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 text-xs">
            <button
              type="button"
              aria-pressed={volumeViewMode === 'grid'}
              onClick={() => handleSetVolumeViewMode('grid')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                volumeViewMode === 'grid'
                  ? 'bg-brand-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={t('Kachelansicht mit Coverbildern')}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>{t('Karten')}</span>
            </button>
            <button
              type="button"
              aria-pressed={volumeViewMode === 'spine'}
              onClick={() => handleSetVolumeViewMode('spine')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                volumeViewMode === 'spine'
                  ? 'bg-brand-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={t('3D-Buchrückenansicht / Echtes Manga-Regal')}
            >
              <Library className="w-3.5 h-3.5" />
              <span>{t('Regal')}</span>
            </button>
            <button
              type="button"
              aria-pressed={volumeViewMode === 'list'}
              onClick={() => handleSetVolumeViewMode('list')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                volumeViewMode === 'list'
                  ? 'bg-brand-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title={t('Kompakte Listenansicht')}
            >
              <List className="w-3.5 h-3.5" />
              <span>{t('Liste')}</span>
            </button>
          </div>
          {canSelect && (
            <button
              type="button"
              id="btn-volume-select-mode"
              aria-pressed={selectionMode}
              onClick={onToggleSelectionMode}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 border ${
                selectionMode
                  ? 'bg-brand-600/30 text-white border-brand-400/70 shadow-sm'
                  : 'bg-slate-900 text-slate-300 border-slate-800 hover:text-white'
              }`}
              title={t('Mehrere Bände auswählen und gemeinsam ändern')}
            >
              <ListChecks className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t('Auswählen')}</span>
            </button>
          )}
        </div>

        {/* Gap detection toggle & Manga Passion pill */}
        <div className="flex items-center gap-2">
          {detectedGaps.length > 0 && (
            <button
              type="button"
              aria-pressed={showGaps}
              onClick={handleToggleShowGaps}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 border ${
                showGaps
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-sm shadow-amber-950/40'
                  : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-300'
              }`}
              title={showGaps ? t('Lücken-Erkennung in Regal & Karten aktiv (Klicken zum Ausblenden)') : t('Lücken-Erkennung ausgeblendet (Klicken zum Aktivieren)')}
            >
              {showGaps ? <Eye className="w-3.5 h-3.5 text-amber-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
              <span>{rich('Lücken: {missing}', { missing: <strong>{t('{count} fehlend', { count: detectedGaps.length })}</strong> })}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${showGaps ? 'bg-amber-400/20 text-amber-300' : 'bg-slate-800 text-slate-400'}`}>
                {showGaps ? t('AN') : t('AUS')}
              </span>
            </button>
          )}

          {/* Manga Passion Pill / Discrepancy indicator (no check offline, German editions only) */}
          {!isOffline && mpEnabled && (
            <button
              type="button"
              onClick={() => {
                setShowMpEditionModal(true);
              }}
              className={`px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 border ${
                mpGapData?.discrepancy 
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-300 hover:bg-amber-500/25 shadow-sm' 
                  : mpGapData?.matched
                    ? 'bg-slate-900/90 border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                    : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-300'
              }`}
              title={mpGapError || mpGapData?.unavailable
                ? t('Manga Passion: {reason}', { reason: mpGapError || payloadText(mpGapData, 'message') || t('nicht erreichbar') })
                : t('Klicken für Manga-Passion-Editionsabgleich')}
            >
              <Globe className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">{t('Manga Passion:')}</span>
              <span className="font-semibold text-white truncate max-w-[130px]">
                {mpPillText({ mpGapData, mpGapLoading, mpGapError })}
              </span>
              {mpGapData?.discrepancy && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-amber-500/30 text-amber-200">
                  {t('{official} statt {stored}', { official: mpGapData.discrepancy.official_total, stored: mpGapData.discrepancy.db_total })}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">

        {/* Status Filter Tabs */}
        <div role="group" aria-label={t('Status-Filter')} className="flex flex-wrap items-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 text-xs">
          <button
            type="button"
            aria-pressed={volumeFilter === 'ALL'}
            onClick={() => setVolumeFilter('ALL')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
              volumeFilter === 'ALL' 
                ? 'bg-brand-700 text-white shadow-sm' 
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('Alle ({count})', { count: volumes.length })}
          </button>
          <button
            type="button"
            aria-pressed={volumeFilter === 'Vorhanden'}
            onClick={() => setVolumeFilter('Vorhanden')}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
              volumeFilter === 'Vorhanden' 
                ? 'bg-emerald-700 text-white shadow-sm' 
                : 'text-emerald-400 hover:text-emerald-300'
            }`}
          >
            <Check className="w-3 h-3" aria-hidden="true" /> {t('Im Besitz ({count})', { count: ownedCount })}
          </button>
          <button
            type="button"
            aria-pressed={volumeFilter === 'Fehlt'}
            onClick={() => setVolumeFilter('Fehlt')}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
              volumeFilter === 'Fehlt' 
                ? 'bg-amber-700 text-white shadow-sm' 
                : 'text-amber-400 hover:text-amber-300'
            }`}
          >
            <X className="w-3 h-3" aria-hidden="true" /> {visibleGapCount > 0
              ? t('Fehlt noch ({missing} + {gaps})', { missing: missingCount, gaps: formatCount(visibleGapCount, 'Lücke', 'Lücken') })
              : t('Fehlt noch ({missing})', { missing: missingCount })}
          </button>
          {preorderedCount > 0 && (
            <button
              type="button"
              aria-pressed={volumeFilter === 'Vorbestellt'}
              onClick={() => setVolumeFilter('Vorbestellt')}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
                volumeFilter === 'Vorbestellt' 
                  ? 'bg-sky-700 text-white shadow-sm' 
                  : 'text-sky-400 hover:text-sky-300'
              }`}
            >
              <Truck className="w-3 h-3" aria-hidden="true" /> {t('Vorbestellt ({count})', { count: preorderedCount })}
            </button>
          )}
          {upcomingCount > 0 && (
            <button
              type="button"
              aria-pressed={volumeFilter === 'Erscheint bald'}
              onClick={() => setVolumeFilter('Erscheint bald')}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
                volumeFilter === 'Erscheint bald' 
                  ? 'bg-purple-700 text-white shadow-sm' 
                  : 'text-purple-400 hover:text-purple-300'
              }`}
            >
              <Calendar className="w-3 h-3" aria-hidden="true" /> {t('Erscheint bald ({count})', { count: upcomingCount })}
            </button>
          )}
          <button
            type="button"
            aria-pressed={volumeFilter === READ_FILTER}
            onClick={() => setVolumeFilter(READ_FILTER)}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
              volumeFilter === READ_FILTER 
                ? 'bg-teal-700 text-white shadow-sm' 
                : 'text-teal-400 hover:text-teal-300'
            }`}
          >
            <BookCheck className="w-3 h-3" aria-hidden="true" /> {t('Gelesen ({count})', { count: currentReaderReadCount })}
          </button>
          <button
            type="button"
            aria-pressed={volumeFilter === UNREAD_FILTER}
            onClick={() => setVolumeFilter(UNREAD_FILTER)}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
              volumeFilter === UNREAD_FILTER 
                ? 'bg-rose-700 text-white shadow-sm' 
                : 'text-rose-400 hover:text-rose-300'
            }`}
            title={t('Im Besitz, aber noch nicht gelesen (Stapel ungelesener Bücher)')}
          >
            <Hourglass className="w-3 h-3" aria-hidden="true" /> {t('Ungelesen / SuB ({count})', { count: currentReaderUnreadCount })}
          </button>
        </div>

        {/* Search & Sort Controls */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Verlag Filter Dropdown */}
          <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
            <BuildingComplex className="w-3.5 h-3.5 text-brand-400 shrink-0" />
            <select
              aria-label={t('Verlag filtern')}
              value={volumePublisherFilter}
              onChange={e => setVolumePublisherFilter(e.target.value)}
              className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
            >
              <option value="ALL">{t('Alle Verlage')}</option>
              {availablePublishers.map(pub => (
                <option key={pub} value={pub}>{pub}</option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
          </label>

          {/* Zustand Filter Dropdown */}
          <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
            <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <select
              aria-label={t('Zustand filtern')}
              value={volumeConditionFilter}
              onChange={e => setVolumeConditionFilter(e.target.value)}
              className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
            >
              <option value="ALL">{t('Alle Zustände')}</option>
              {conditionsList.map(c => (
                <option key={c} value={c}>{conditionLabel(c)}</option>
              ))}
              <option value={CONDITION_NONE}>{t('Ohne Zustand')}</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
          </label>

          {/* Sort Dropdown */}
          <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
            <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <select
              aria-label={t('Sortierung')}
              value={volumeSort}
              onChange={e => setVolumeSort(e.target.value)}
              className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
            >
              <option value="number_asc">{t('Band-Nr. (1 → 99)')}</option>
              <option value="number_desc">{t('Band-Nr. (99 → 1)')}</option>
              <option value="publisher_asc">{t('Verlag (A → Z)')}</option>
              <option value="publisher_desc">{t('Verlag (Z → A)')}</option>
              <option value="price_desc">{t('Preis (Höchster zuerst)')}</option>
              <option value="price_asc">{t('Preis (Niedrigster zuerst)')}</option>
              <option value="year_desc">{t('Erscheinungsjahr (Neueste)')}</option>
              <option value="year_asc">{t('Erscheinungsjahr (Älteste)')}</option>
              <option value="condition">{t('Zustand')}</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
          </label>

          {/* Fast search input */}
          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input 
              type="text" 
              placeholder={t('Suchen...')} 
              aria-label={t('Bände durchsuchen')}
              value={volumeSearch}
              onChange={e => setVolumeSearch(e.target.value)}
              className="bg-transparent border-0 text-base sm:text-xs text-white placeholder-slate-400 focus:outline-none w-24 sm:w-32 py-1"
            />
            {volumeSearch && (
              <button
                type="button"
                onClick={() => setVolumeSearch('')}
                className="p-1.5 -m-1 rounded-md text-slate-400 hover:text-white"
                aria-label={t('Suche löschen')}
                title={t('Suche löschen')}
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Reset Filters Button (visible when filters are active) */}
          {hasActiveFilters && (
            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 text-xs font-medium transition-all shadow-sm cursor-pointer"
              title={t('Alle Filter zurücksetzen')}
              aria-label={t('Alle Filter zurücksetzen')}
            >
              <RotateCcw className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">{t('Filter zurücksetzen')}</span>
            </button>
          )}

        </div>
      </div>

      {/* Optional Type Filter Chips (if manga contains Special Editions, Schuber or Specials) */}
      {showTypeRow && (
        <div role="group" aria-label={t('Typ-Filter')} className="flex flex-wrap items-center gap-1.5 pt-2.5 border-t border-slate-800/60 text-xs">
          <span className="text-[11px] text-slate-400 font-semibold mr-1 flex items-center gap-1">
            <Funnel className="w-3 h-3 text-brand-400" /> {t('Typ:')}
          </span>
          <button
            type="button"
            aria-pressed={volumeTypeFilter === 'ALL'}
            onClick={() => setVolumeTypeFilter('ALL')}
            className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
              volumeTypeFilter === 'ALL'
                ? 'bg-slate-700 text-white shadow-sm'
                : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            {t('Alle ({count})', { count: baseVolumesForType.length })}
          </button>
          <button
            type="button"
            aria-pressed={volumeTypeFilter === 'volume'}
            onClick={() => setVolumeTypeFilter('volume')}
            className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
              volumeTypeFilter === 'volume'
                ? 'bg-brand-700 text-white shadow-sm'
                : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 border border-slate-800'
            }`}
          >
            <BookOpen className="w-3 h-3 text-brand-400" /> {t('Nur Bände ({count})', { count: regularVolumeCount })}
          </button>
          {showTypeChip('special_edition', specialEditionCount) && (
            <button
              type="button"
              aria-pressed={volumeTypeFilter === 'special_edition'}
              onClick={() => setVolumeTypeFilter('special_edition')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
                volumeTypeFilter === 'special_edition'
                  ? 'bg-fuchsia-700 text-white shadow-sm ring-1 ring-fuchsia-400'
                  : 'bg-fuchsia-950/40 text-fuchsia-300 hover:bg-fuchsia-900/50 border border-fuchsia-800/50'
              }`}
            >
              <Sparkles className="w-3 h-3 text-fuchsia-400" aria-hidden="true" /> {t('Special Editions ({count})', { count: specialEditionCount })}
            </button>
          )}
          {showTypeChip('schuber', schuberCount) && (
            <button
              type="button"
              aria-pressed={volumeTypeFilter === 'schuber'}
              onClick={() => setVolumeTypeFilter('schuber')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
                volumeTypeFilter === 'schuber'
                  ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-400'
                  : 'bg-indigo-950/40 text-indigo-300 hover:bg-indigo-900/50 border border-indigo-800/50'
              }`}
            >
              <Package className="w-3 h-3 text-indigo-400" aria-hidden="true" /> {t('Nur Schuber ({count})', { count: schuberCount })}
            </button>
          )}
          {showTypeChip('special', specialCount) && (
            <button
              type="button"
              aria-pressed={volumeTypeFilter === 'special'}
              onClick={() => setVolumeTypeFilter('special')}
              className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
                volumeTypeFilter === 'special'
                  ? 'bg-amber-700 text-white shadow-sm ring-1 ring-amber-400'
                  : 'bg-amber-950/40 text-amber-300 hover:bg-amber-900/50 border border-amber-800/50'
              }`}
            >
              <Sparkles className="w-3 h-3 text-amber-400" aria-hidden="true" /> {t('Specials ({count})', { count: specialCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
