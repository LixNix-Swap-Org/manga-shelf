import { ArrowUpDown, Building2, ChevronDown, LayoutGrid, List, X } from 'lucide-react';

/** Status tabs, publisher/sort filters and view-mode toggle. Purely presentational; all state and handlers come in via props. */
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
  viewMode
}) {
  return (
    <div className="flex flex-col xl:flex-row flex-wrap items-stretch xl:items-center justify-between gap-3 mb-6 p-2.5 sm:p-3 bg-slate-950/70 rounded-2xl border border-slate-800/80">
      {/* Status Tabs with Count Badges */}
      <div className="w-full xl:w-auto flex items-center gap-1.5 p-1 bg-slate-900/90 rounded-xl border border-slate-800 text-xs overflow-x-auto no-scrollbar">
        {[
          { id: 'ALL', label: 'Alle', count: filterCounts.ALL },
          { id: 'Laufend', label: 'Laufend', count: filterCounts.Laufend },
          { id: 'Abgeschlossen', label: 'Abgeschlossen', count: filterCounts.Abgeschlossen },
          { id: 'UNREAD', label: 'Ungelesen', count: filterCounts.UNREAD },
          { id: 'READ_ALL', label: 'Gelesen', count: filterCounts.READ_ALL },
          { id: 'Pausiert', label: 'Pausiert', count: filterCounts.Pausiert },
          { id: 'Geplant', label: 'Geplant', count: filterCounts.Geplant },
        ].filter(tab => tab.id === 'ALL' || tab.count > 0).map(tab => (
          <button
            key={tab.id}
            onClick={() => setStatusFilter(tab.id)}
            className={`px-2.5 sm:px-3 py-1.5 rounded-lg font-medium transition-all whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              statusFilter === tab.id 
                ? 'bg-brand-600 text-white shadow-sm' 
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
            }`}
          >
            <span>{tab.label}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono font-bold leading-none ${
              statusFilter === tab.id ? 'bg-brand-700/90 text-white' : 'bg-slate-800 text-slate-400'
            }`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Publisher, Sort, Reset & View Mode Controls */}
      <div className="w-full xl:w-auto flex flex-wrap items-center justify-between xl:justify-start gap-2 text-xs">
        {/* Publisher Filter */}
        <label className="flex-1 sm:flex-initial min-w-0 flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
          <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
          <select
            id="filter-publisher-select"
            value={publisherFilter}
            onChange={e => setPublisherFilter(e.target.value)}
            className="filter-chip-select font-medium text-slate-200 group-hover:text-white truncate max-w-[100px] sm:max-w-none"
          >
            <option value="ALL">Alle Verlage</option>
            {availablePublishers.map(pub => (
              <option key={pub} value={pub}>{pub}</option>
            ))}
          </select>
          <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
        </label>

        {/* Sort Control */}
        <label className="flex-1 sm:flex-initial min-w-0 flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
          <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="filter-chip-select font-medium text-slate-200 group-hover:text-white truncate max-w-[130px] sm:max-w-none"
          >
            <option value="newest_first">✨ Zuletzt hinzugefügt</option>
            <option value="title_asc">🔤 Titel (A → Z)</option>
            <option value="title_desc">🔤 Titel (Z → A)</option>
            <option value="progress_desc">📈 Fortschritt (Höchster %)</option>
            <option value="progress_asc">📖 Ungelesen zuerst</option>
            <option value="volumes_desc">📚 Meiste Bände</option>
            <option value="value_desc">💰 Höchster Wert (€)</option>
            <option value="publisher_asc">🏢 Verlag (A → Z)</option>
            <option value="oldest_first">⏳ Zuerst hinzugefügt</option>
          </select>
          <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
        </label>

        {/* Reset Filter Button (visible when filter active) */}
        {(statusFilter !== 'ALL' || publisherFilter !== 'ALL' || search) && (
          <button
            onClick={() => {
              setStatusFilter('ALL');
              setPublisherFilter('ALL');
              setSearch('');
            }}
            className="btn-secondary py-1.5 px-2.5 text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 border-sky-500/30 shrink-0"
            title="Alle Filter und Suche zurücksetzen"
          >
            <X className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Zurücksetzen</span>
          </button>
        )}

        {/* View Mode Toggle: Grid vs List */}
        <div className="flex items-center bg-slate-900/90 border border-slate-800 p-0.5 rounded-xl shadow-sm shrink-0">
          <button
            id="btn-view-grid"
            type="button"
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded-lg transition-all ${
              viewMode === 'grid'
                ? 'bg-brand-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
            title="Plakative Rasteransicht"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
          <button
            id="btn-view-list"
            type="button"
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-lg transition-all ${
              viewMode === 'list'
                ? 'bg-brand-600 text-white shadow'
                : 'text-slate-400 hover:text-white'
            }`}
            title="Kompakte Listenansicht"
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="text-xs text-slate-400 ml-1 hidden sm:inline">
          {filtered.length} {filtered.length === 1 ? 'Manga' : 'Mangas'}
        </div>
      </div>
    </div>

  );
}
