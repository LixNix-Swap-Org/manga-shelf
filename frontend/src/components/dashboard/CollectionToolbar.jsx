import { ArrowUpDown, BuildingComplex, ChevronDown, Languages, Layers, LayoutGrid, List, ListFilter, Tag, UserPen, X } from 'lucide-react';
import { COLLECT_FILTERS, GROUP_OPTIONS, SORT_OPTIONS, collectFilterLabel, getStatusTabs } from '../../utils/collectionHelpers';
import { formatCount } from '../../utils/format';
import { t as tr } from '../../i18n/index.js';
import { genreLabel } from '../../utils/enumLabels.js';
import { languageName } from '../../utils/editions';

// columns below xl: two chips per row (phones fill the row), four from lg; content-sized in one row from xl. The select
// truncates inside its chip.
export const CHIP_LABEL = 'basis-[calc(50%-0.25rem)] grow sm:grow-0 lg:basis-[calc(25%-0.375rem)] xl:basis-auto min-w-0 flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group';
const CHIP_SELECT = 'font-medium text-slate-200 group-hover:text-white truncate min-w-0 w-full xl:w-auto';
const VIEW_TOGGLE = 'hit-44 p-1.5 rounded-lg transition-all [@media(pointer:coarse)]:p-2.5 [@media(pointer:coarse)]:px-[15px]';

/**
 * Status tabs, filter/sort/grouping selects, author and genre chips, view-mode toggle; presentational, state via props.
 * The genre filter (AND over tags) shows when `setTagFilter` is given; `availableTags` is [{ tag, count }]. The edition
 * language chip shows when the collection holds more than one language (`availableLanguages` [{ code, count }]).
 */
export default function CollectionToolbar({
  availablePublishers,
  filterCounts,
  filtered,
  publisherFilter,
  search,
  setPublisherFilter,
  setSearch,
  setSortBy,
  setStatusFilter,
  setViewMode,
  sortBy,
  statusFilter,
  statusTabs,
  viewMode,
  collectFilter = 'ALL',
  setCollectFilter,
  collectCounts = null,
  authorFilter = '',
  setAuthorFilter,
  groupBy = 'none',
  setGroupBy,
  availableTags = [],
  tagFilter = [],
  setTagFilter,
  availableLanguages = [],
  languageFilter = 'ALL',
  setLanguageFilter
}) {
  const tabs = statusTabs || getStatusTabs(filterCounts || {}, statusFilter);
  const chosenTags = Array.isArray(tagFilter) ? tagFilter : [];
  const chosenKeys = new Set(chosenTags.map(t => t.toLowerCase()));
  const tagOptions = availableTags.filter(t => !chosenKeys.has(t.tag.toLowerCase()));
  const filtersActive = statusFilter !== 'ALL' || publisherFilter !== 'ALL' || collectFilter !== 'ALL' || Boolean(authorFilter) || Boolean(search)
    || chosenTags.length > 0 || languageFilter !== 'ALL';
  const showLanguages = Boolean(setLanguageFilter) && (availableLanguages.length > 1 || languageFilter !== 'ALL');
  return (
    <div className="flex flex-col xl:flex-row flex-wrap items-stretch xl:items-center justify-between gap-3 mb-6 p-2.5 sm:p-3 bg-slate-950/70 rounded-2xl border border-slate-800/80">
      {/* Status Tabs with Count Badges */}
      <div role="group" aria-label={tr('Status-Filter')} className="w-full xl:w-auto flex items-center gap-1.5 p-1 bg-slate-900/90 rounded-xl border border-slate-800 text-xs overflow-x-auto no-scrollbar">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={statusFilter === tab.id}
            onClick={() => setStatusFilter(tab.id)}
            className={`px-2.5 sm:px-3 py-1.5 rounded-lg font-medium transition-all whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              statusFilter === tab.id 
                ? 'bg-brand-700 text-white shadow-sm' 
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <span>{tr(tab.label)}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono font-bold leading-none ${
              statusFilter === tab.id ? 'bg-brand-900/90 text-white' : 'bg-slate-800 text-slate-400'
            }`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Publisher, Sort, Reset & View Mode Controls */}
      <div className="w-full xl:w-auto flex flex-wrap items-center xl:justify-start gap-2 text-xs">
        {/* Publisher Filter */}
        <label className={CHIP_LABEL}>
          <BuildingComplex className="w-3.5 h-3.5 text-brand-400 shrink-0" />
          <select
            id="filter-publisher-select"
            aria-label={tr('Verlag filtern')}
            value={publisherFilter}
            onChange={e => setPublisherFilter(e.target.value)}
            className={`filter-chip-select ${CHIP_SELECT}`}
          >
            <option value="ALL">{tr('Alle Verlage')}</option>
            {availablePublishers.map(pub => (
              <option key={pub} value={pub}>{pub}</option>
            ))}
          </select>
          <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
        </label>

        {setCollectFilter && (
          <label className={CHIP_LABEL}>
            <ListFilter className="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true" />
            <select
              id="filter-collect-select"
              aria-label={tr('Sammelstand filtern')}
              value={collectFilter}
              onChange={e => setCollectFilter(e.target.value)}
              className={`filter-chip-select ${CHIP_SELECT}`}
            >
              {COLLECT_FILTERS.map(f => (
                <option key={f.id} value={f.id}>
                  {collectFilterLabel(f)}{collectCounts && f.id !== 'ALL' ? ` (${collectCounts[f.id] || 0})` : ''}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" aria-hidden="true" />
          </label>
        )}

        {setTagFilter && (availableTags.length > 0 || chosenTags.length > 0) && (
          <label className={CHIP_LABEL}>
            <Tag className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" aria-hidden="true" />
            <select
              id="filter-tag-select"
              aria-label={tr('Genre filtern')}
              value=""
              onChange={e => { if (e.target.value) setTagFilter([...chosenTags, e.target.value]); }}
              className={`filter-chip-select ${CHIP_SELECT}`}
            >
              <option value="">{chosenTags.length ? tr('Weiteres Genre…') : tr('Alle Genres')}</option>
              {tagOptions.map(t => <option key={t.tag} value={t.tag}>{genreLabel(t.tag)} ({t.count})</option>)}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" aria-hidden="true" />
          </label>
        )}

        {showLanguages && (
          <label className={CHIP_LABEL}>
            <Languages className="w-3.5 h-3.5 text-teal-400 shrink-0" aria-hidden="true" />
            <select
              id="filter-language-select"
              aria-label={tr('Sprache filtern')}
              value={languageFilter}
              onChange={e => setLanguageFilter(e.target.value)}
              className={`filter-chip-select ${CHIP_SELECT}`}
            >
              <option value="ALL">{tr('Alle Sprachen')}</option>
              {availableLanguages.map(l => <option key={l.code} value={l.code}>{languageName(l.code)} ({l.count})</option>)}
              {languageFilter !== 'ALL' && !availableLanguages.some(l => l.code === languageFilter) && (
                <option value={languageFilter}>{languageName(languageFilter)}</option>
              )}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" aria-hidden="true" />
          </label>
        )}

        {setTagFilter && chosenTags.map(tag => (
          <button
            key={tag}
            type="button"
            onClick={() => setTagFilter(chosenTags.filter(t => t !== tag))}
            className="tag-filter-chip flex items-center gap-1.5 min-w-0 max-w-full rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/15 px-2.5 py-1.5 text-fuchsia-200 hover:bg-fuchsia-500/25 shrink-0"
            title={tr('Genre-Filter entfernen')}
            aria-label={tr('Genre-Filter „{tag}“ entfernen', { tag: genreLabel(tag) })}
          >
            <Tag className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate max-w-[140px]">{genreLabel(tag)}</span>
            <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          </button>
        ))}

        {/* Sort Control */}
        <label className={CHIP_LABEL}>
          <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <select
            aria-label={tr('Sortierung')}
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className={`filter-chip-select ${CHIP_SELECT}`}
          >
            {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{tr(o.label)}</option>)}
          </select>
          <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
        </label>

        {setGroupBy && (
          <label className={CHIP_LABEL}>
            <Layers className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" aria-hidden="true" />
            <select
              id="group-by-select"
              aria-label={tr('Gruppieren')}
              value={groupBy}
              onChange={e => setGroupBy(e.target.value)}
              className={`filter-chip-select ${CHIP_SELECT}`}
            >
              {GROUP_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.value === 'none' ? tr(o.label) : tr('Gruppieren: {label}', { label: tr(o.label) })}</option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" aria-hidden="true" />
          </label>
        )}

        {authorFilter && setAuthorFilter && (
          <button
            type="button"
            id="author-filter-chip"
            onClick={() => setAuthorFilter('')}
            className="flex items-center gap-1.5 min-w-0 max-w-full rounded-xl border border-brand-500/40 bg-brand-500/15 px-2.5 py-1.5 text-brand-200 hover:bg-brand-500/25 shrink-0"
            title={tr('Autor-Filter entfernen')}
            aria-label={tr('Autor-Filter „{authorFilter}“ entfernen', { authorFilter })}
          >
            <UserPen className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate max-w-[160px]">{authorFilter}</span>
            <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          </button>
        )}

        {/* Reset Filter Button (visible when filter active) */}
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setStatusFilter('ALL');
              setPublisherFilter('ALL');
              setCollectFilter?.('ALL');
              setAuthorFilter?.('');
              setTagFilter?.([]);
              setLanguageFilter?.('ALL');
              setSearch('');
            }}
            className="btn-secondary py-1.5 px-2.5 text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 border-sky-500/30 shrink-0"
            title={tr('Alle Filter und Suche zurücksetzen')}
            aria-label={tr('Filter und Suche zurücksetzen')}
          >
            <X className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{tr('Zurücksetzen')}</span>
          </button>
        )}

        <div className="basis-full xl:basis-auto flex items-center justify-between gap-2">
          <div role="group" aria-label={tr('Ansicht')} className="flex items-center bg-slate-900/90 border border-slate-800 p-0.5 rounded-xl shadow-sm shrink-0">
            <button
              id="btn-view-grid"
              type="button"
              aria-pressed={viewMode === 'grid'}
              aria-label={tr('Rasteransicht')}
              onClick={() => setViewMode('grid')}
              className={`${VIEW_TOGGLE} ${
                viewMode === 'grid'
                  ? 'bg-brand-700 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
              title={tr('Plakative Rasteransicht')}
            >
              <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            <button
              id="btn-view-list"
              type="button"
              aria-pressed={viewMode === 'list'}
              aria-label={tr('Listenansicht')}
              onClick={() => setViewMode('list')}
              className={`${VIEW_TOGGLE} ${
                viewMode === 'list'
                  ? 'bg-brand-700 text-white shadow'
                  : 'text-slate-400 hover:text-white'
              }`}
              title={tr('Kompakte Listenansicht')}
            >
              <List className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>

          <div className="text-xs text-slate-400 ml-1 hidden sm:inline">
            {formatCount(filtered.length, 'Manga', 'Mangas')}
          </div>
        </div>
      </div>
    </div>

  );
}
