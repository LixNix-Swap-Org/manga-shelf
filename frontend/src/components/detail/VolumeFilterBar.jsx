import { ArrowUpDown, BookCheck, BookOpen, Calendar, Check, ListChecks, BuildingComplex, ChevronDown, Eye, EyeOff, Funnel, Globe, Hourglass, LayoutGrid, Library, List, Package, RotateCcw, Search, Sparkles, Truck, X } from 'lucide-react';
import { CONDITION_NONE } from '../../utils/volumeHelpers';
import { mpPillText } from './volumeViewHelpers';
import { formatCount } from '../../utils/format';


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
            Ansicht:
          </span>
          <div role="group" aria-label="Ansicht" className="flex items-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 text-xs">
            <button
              type="button"
              aria-pressed={volumeViewMode === 'grid'}
              onClick={() => handleSetVolumeViewMode('grid')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                volumeViewMode === 'grid'
                  ? 'bg-brand-700 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Kachelansicht mit Coverbildern"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>Karten</span>
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
              title="3D-Buchrückenansicht / Echtes Manga-Regal"
            >
              <Library className="w-3.5 h-3.5" />
              <span>Regal</span>
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
              title="Kompakte Listenansicht"
            >
              <List className="w-3.5 h-3.5" />
              <span>Liste</span>
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
              title="Mehrere Bände auswählen und gemeinsam ändern"
            >
              <ListChecks className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Auswählen</span>
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
              title={showGaps ? 'Lücken-Erkennung in Regal & Karten aktiv (Klicken zum Ausblenden)' : 'Lücken-Erkennung ausgeblendet (Klicken zum Aktivieren)'}
            >
              {showGaps ? <Eye className="w-3.5 h-3.5 text-amber-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
              <span>Lücken: <strong>{detectedGaps.length} fehlend</strong></span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${showGaps ? 'bg-amber-400/20 text-amber-300' : 'bg-slate-800 text-slate-400'}`}>
                {showGaps ? 'AN' : 'AUS'}
              </span>
            </button>
          )}

          {/* Manga Passion Pill / Discrepancy indicator (no check offline) */}
          {!isOffline && (
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
                ? `Manga Passion: ${mpGapError || mpGapData.message || 'nicht erreichbar'}`
                : 'Klicken für Manga-Passion-Editionsabgleich'}
            >
              <Globe className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">Manga Passion:</span>
              <span className="font-semibold text-white truncate max-w-[130px]">
                {mpPillText({ mpGapData, mpGapLoading, mpGapError })}
              </span>
              {mpGapData?.discrepancy && (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-amber-500/30 text-amber-200">
                  {mpGapData.discrepancy.official_total} statt {mpGapData.discrepancy.db_total}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">

        {/* Status Filter Tabs */}
        <div role="group" aria-label="Status-Filter" className="flex flex-wrap items-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 text-xs">
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
            Alle ({volumes.length})
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
            <Check className="w-3 h-3" aria-hidden="true" /> Im Besitz ({ownedCount})
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
            <X className="w-3 h-3" aria-hidden="true" /> Fehlt noch ({missingCount}{visibleGapCount > 0 ? ` + ${formatCount(visibleGapCount, 'Lücke', 'Lücken')}` : ''})
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
              <Truck className="w-3 h-3" aria-hidden="true" /> Vorbestellt ({preorderedCount})
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
              <Calendar className="w-3 h-3" aria-hidden="true" /> Erscheint bald ({upcomingCount})
            </button>
          )}
          <button
            type="button"
            aria-pressed={volumeFilter === 'Gelesen'}
            onClick={() => setVolumeFilter('Gelesen')}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
              volumeFilter === 'Gelesen' 
                ? 'bg-teal-700 text-white shadow-sm' 
                : 'text-teal-400 hover:text-teal-300'
            }`}
          >
            <BookCheck className="w-3 h-3" aria-hidden="true" /> Gelesen ({currentReaderReadCount})
          </button>
          <button
            type="button"
            aria-pressed={volumeFilter === 'Ungelesen'}
            onClick={() => setVolumeFilter('Ungelesen')}
            className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg font-medium transition-all ${
              volumeFilter === 'Ungelesen' 
                ? 'bg-rose-700 text-white shadow-sm' 
                : 'text-rose-400 hover:text-rose-300'
            }`}
            title="Im Besitz, aber noch nicht gelesen (Stapel ungelesener Bücher)"
          >
            <Hourglass className="w-3 h-3" aria-hidden="true" /> Ungelesen / SuB ({currentReaderUnreadCount})
          </button>
        </div>

        {/* Search & Sort Controls */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Verlag Filter Dropdown */}
          <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
            <BuildingComplex className="w-3.5 h-3.5 text-brand-400 shrink-0" />
            <select
              aria-label="Verlag filtern"
              value={volumePublisherFilter}
              onChange={e => setVolumePublisherFilter(e.target.value)}
              className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
            >
              <option value="ALL">Alle Verlage</option>
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
              aria-label="Zustand filtern"
              value={volumeConditionFilter}
              onChange={e => setVolumeConditionFilter(e.target.value)}
              className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
            >
              <option value="ALL">Alle Zustände</option>
              {conditionsList.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value={CONDITION_NONE}>Ohne Zustand</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
          </label>

          {/* Sort Dropdown */}
          <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
            <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <select
              aria-label="Sortierung"
              value={volumeSort}
              onChange={e => setVolumeSort(e.target.value)}
              className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
            >
              <option value="number_asc">Band-Nr. (1 → 99)</option>
              <option value="number_desc">Band-Nr. (99 → 1)</option>
              <option value="publisher_asc">Verlag (A → Z)</option>
              <option value="publisher_desc">Verlag (Z → A)</option>
              <option value="price_desc">Preis (Höchster zuerst)</option>
              <option value="price_asc">Preis (Niedrigster zuerst)</option>
              <option value="year_desc">Erscheinungsjahr (Neueste)</option>
              <option value="year_asc">Erscheinungsjahr (Älteste)</option>
              <option value="condition">Zustand</option>
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
          </label>

          {/* Fast search input */}
          <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-400">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input 
              type="text" 
              placeholder="Suchen..." 
              aria-label="Bände durchsuchen"
              value={volumeSearch}
              onChange={e => setVolumeSearch(e.target.value)}
              className="bg-transparent border-0 text-base sm:text-xs text-white placeholder-slate-400 focus:outline-none w-24 sm:w-32 py-1"
            />
            {volumeSearch && (
              <button
                type="button"
                onClick={() => setVolumeSearch('')}
                className="p-1.5 -m-1 rounded-md text-slate-400 hover:text-white"
                aria-label="Suche löschen"
                title="Suche löschen"
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
              title="Alle Filter zurücksetzen"
              aria-label="Alle Filter zurücksetzen"
            >
              <RotateCcw className="w-3.5 h-3.5 text-brand-400" />
              <span className="hidden sm:inline">Filter zurücksetzen</span>
            </button>
          )}

        </div>
      </div>

      {/* Optional Type Filter Chips (if manga contains Special Editions, Schuber or Specials) */}
      {showTypeRow && (
        <div role="group" aria-label="Typ-Filter" className="flex flex-wrap items-center gap-1.5 pt-2.5 border-t border-slate-800/60 text-xs">
          <span className="text-[11px] text-slate-400 font-semibold mr-1 flex items-center gap-1">
            <Funnel className="w-3 h-3 text-brand-400" /> Typ:
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
            Alle ({baseVolumesForType.length})
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
            <BookOpen className="w-3 h-3 text-brand-400" /> Nur Bände ({regularVolumeCount})
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
              <Sparkles className="w-3 h-3 text-fuchsia-400" aria-hidden="true" /> Special Editions ({specialEditionCount})
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
              <Package className="w-3 h-3 text-indigo-400" aria-hidden="true" /> Nur Schuber ({schuberCount})
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
              <Sparkles className="w-3 h-3 text-amber-400" aria-hidden="true" /> Specials ({specialCount})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
