import { Link } from 'react-router-dom';
import { 
  Globe, Package, ExternalLink, Calendar, ChevronLeft, ChevronRight,
  ChevronDown, Star, RefreshCw, Search, X, BookOpen, BookmarkCheck,
  Check, Wallet, Truck, Bookmark, AlertTriangle, Building2, CheckCircle2, ShoppingCart, Coins, Clock
} from 'lucide-react';

export default function ReleaseRadarView({
  radarSubView,
  setRadarSubView,
  radarData,
  loadingRadar,
  fetchReleaseRadar,
  radarTimeframe,
  setRadarTimeframe,
  mpData,
  loadingMp,
  fetchMangaPassionReleases,
  mpYear,
  setMpYear,
  mpMonth,
  setMpMonth,
  handlePrevMonth,
  handleNextMonth,
  handleCurrentMonth,
  mpPrintOnly,
  setMpPrintOnly,
  mpMySeriesOnly,
  setMpMySeriesOnly,
  mpPublisherFilter,
  setMpPublisherFilter,
  mpSearch,
  setMpSearch,
  canEdit,
  handleImportMangaPassion,
  importingMpId,
  handleMarkDelivered,
  markingDeliveredId,
  failedImages,
  setFailedImages,
  setActiveMainView,
  GERMAN_MONTHS,
  formatGermanDate
}) {
      // Filter Manga Passion items
      const filteredMpItems = (mpData?.items || []).filter(item => {
        if (mpPrintOnly && item.is_digital) return false;
        if (mpMySeriesOnly && !item.in_collection) return false;
        if (mpPublisherFilter !== 'ALL' && item.publisher.toLowerCase() !== mpPublisherFilter.toLowerCase()) return false;
        if (mpSearch) {
          const q = mpSearch.toLowerCase();
          const matchTitle = (item.title || '').toLowerCase().includes(q);
          const matchPub = (item.publisher || '').toLowerCase().includes(q);
          const matchVol = String(item.volume_number || '').toLowerCase().includes(q);
          if (!matchTitle && !matchPub && !matchVol) return false;
        }
        return true;
      });

      // Group filtered items by date
      const mpDateGroups = [];
      const dateMap = new Map();
      filteredMpItems.forEach(item => {
        const dKey = item.date || 'Ohne Datum';
        if (!dateMap.has(dKey)) dateMap.set(dKey, []);
        dateMap.get(dKey).push(item);
      });
      Array.from(dateMap.keys()).sort().forEach(dKey => {
        mpDateGroups.push({
          dateKey: dKey,
          dateLabel: dKey !== 'Ohne Datum' ? formatGermanDate(dKey) : 'Erscheinungsdatum unbestätigt',
          items: dateMap.get(dKey)
        });
      });

      return (
        <div className="space-y-6 animate-fade-in">
          {/* Sub-View Switcher: Manga Passion Kalender vs. Persönlicher Vorbestellungs-Radar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-1.5 bg-slate-900/90 rounded-2xl border border-slate-800 shadow-inner">
            <div className="flex items-center gap-1.5 p-1 bg-slate-950/80 rounded-xl border border-slate-800/80 w-full sm:w-auto">
              <button
                onClick={() => setRadarSubView('passion')}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                  radarSubView === 'passion'
                    ? 'bg-gradient-to-r from-sky-600 to-brand-600 text-white shadow-md shadow-sky-600/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Globe className="w-3.5 h-3.5 text-sky-400" />
                <span>Deutsche Neuheiten (Manga Passion)</span>
                {mpData && (
                  <span className="bg-sky-500/20 text-sky-200 text-[10px] px-2 py-0.5 rounded-full font-mono font-bold">
                    {mpPrintOnly ? mpData.print_count : mpData.total_items}
                  </span>
                )}
              </button>
              <button
                onClick={() => setRadarSubView('personal')}
                className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                  radarSubView === 'personal'
                    ? 'bg-gradient-to-r from-sky-600 to-brand-600 text-white shadow-md shadow-sky-600/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Package className="w-3.5 h-3.5 text-sky-400" />
                <span>Meine Vorbestellungen & Budget</span>
                {radarData && radarData.total_releases > 0 && (
                  <span className="bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 rounded-full font-mono font-bold">
                    {radarData.total_releases}
                  </span>
                )}
              </button>
            </div>

            {radarSubView === 'passion' && (
              <div className="flex items-center gap-2 px-2 text-xs text-slate-400">
                <span className="hidden md:inline">Live-Daten via:</span>
                <a 
                  href={`https://www.manga-passion.de/manga?year=${mpYear}&month=${mpMonth}`} 
                  target="_blank" 
                  rel="noreferrer" 
                  className="text-sky-400 hover:text-sky-300 flex items-center gap-1 hover:underline font-medium"
                >
                  manga-passion.de <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>

          {/* VIEW A: MANGA PASSION MONATSKALENDER */}
          {radarSubView === 'passion' && (
            <div className="space-y-6">
              {/* Month Navigator Header Bar */}
              <div className="glass-panel p-4 sm:p-5 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 bg-gradient-to-r from-slate-900/90 via-slate-900/70 to-sky-950/30">
                <div className="flex items-center justify-between sm:justify-start gap-2">
                  <button
                    onClick={handlePrevMonth}
                    disabled={loadingMp}
                    className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1 shrink-0"
                    title="Vorheriger Monat"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span className="hidden sm:inline">Voriger Monat</span>
                  </button>

                  <div className="flex items-center gap-1.5 sm:gap-2 px-3 py-1.5 bg-slate-950/80 border border-slate-800 rounded-xl shadow-inner">
                    <Calendar className="w-4 h-4 text-sky-400 shrink-0" />
                    
                    {/* Month selector */}
                    <label className="relative inline-flex items-center cursor-pointer group">
                      <select
                        value={mpMonth}
                        onChange={(e) => {
                          const m = Number(e.target.value);
                          setMpMonth(m);
                          fetchMangaPassionReleases(mpYear, m);
                        }}
                        className="seamless-select text-sm sm:text-base font-bold text-white group-hover:text-sky-300 pr-4 py-0.5 cursor-pointer transition-colors"
                      >
                        {GERMAN_MONTHS.map((name, idx) => (
                          <option key={idx + 1} value={idx + 1} className="bg-slate-900 text-white">
                            {name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-sky-300 pointer-events-none absolute right-0 transition-colors" />
                    </label>

                    {/* Year selector */}
                    <label className="relative inline-flex items-center cursor-pointer group">
                      <select
                        value={mpYear}
                        onChange={(e) => {
                          const y = Number(e.target.value);
                          setMpYear(y);
                          fetchMangaPassionReleases(y, mpMonth);
                        }}
                        className="seamless-select text-sm sm:text-base font-bold text-sky-400 group-hover:text-sky-300 pr-4 py-0.5 cursor-pointer transition-colors"
                      >
                        {[2024, 2025, 2026, 2027, 2028, 2029].map(y => (
                          <option key={y} value={y} className="bg-slate-900 text-white">
                            {y}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3 h-3 text-sky-400/70 group-hover:text-sky-300 pointer-events-none absolute right-0 transition-colors" />
                    </label>
                  </div>

                  <button
                    onClick={handleNextMonth}
                    disabled={loadingMp}
                    className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1 shrink-0"
                    title="Nächster Monat"
                  >
                    <span className="hidden sm:inline">Nächster Monat</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
                  <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Neuerscheinungen</p>
                    <p className="text-base sm:text-lg font-extrabold text-sky-400 font-mono">
                      {loadingMp ? '...' : (mpPrintOnly ? (mpData?.print_count || 0) : (mpData?.total_items || 0))}
                      <span className="text-xs text-slate-400 font-normal ml-1">
                        {mpPrintOnly ? 'Print' : 'Gesamt'}
                      </span>
                    </p>
                  </div>

                  <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
                      <Star className="w-3 h-3 text-amber-400" /> In deiner Sammlung
                    </p>
                    <p className="text-base sm:text-lg font-extrabold text-amber-400 font-mono">
                      {loadingMp ? '...' : (mpData?.user_series_count || 0)}
                      <span className="text-xs text-slate-400 font-normal ml-1">Bände</span>
                    </p>
                  </div>

                  <button
                    onClick={() => fetchMangaPassionReleases(mpYear, mpMonth, true)}
                    disabled={loadingMp}
                    className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 shrink-0"
                    title="Manga-Passion Daten neu laden (Cache umgehen)"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingMp ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Manga Passion Filters Bar */}
              <div className="glass-panel p-3.5 sm:p-4 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3">
                <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full md:w-72 shadow-inner">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    placeholder="Reihe, Band oder Verlag..."
                    className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 text-xs"
                    value={mpSearch}
                    onChange={e => setMpSearch(e.target.value)}
                  />
                  {mpSearch && (
                    <button onClick={() => setMpSearch('')} className="text-slate-500 hover:text-white">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setMpPrintOnly(!mpPrintOnly)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 shrink-0 ${
                      mpPrintOnly
                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/40 shadow-sm font-semibold'
                        : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <BookOpen className="w-3.5 h-3.5 text-sky-400" />
                    <span>Nur Print-Bände</span>
                  </button>

                  <button
                    onClick={() => setMpMySeriesOnly(!mpMySeriesOnly)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-all flex items-center gap-1.5 shrink-0 ${
                      mpMySeriesOnly
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm font-semibold'
                        : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <Star className="w-3.5 h-3.5 text-amber-400" />
                    <span>Nur meine Reihen ({mpData?.user_series_count || 0})</span>
                  </button>

                  {mpData && mpData.publishers && mpData.publishers.length > 0 && (
                    <label className="flex items-center gap-1.5 bg-slate-950/70 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-3 py-2 text-xs cursor-pointer transition-all shadow-sm group">
                      <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                      <select
                        value={mpPublisherFilter}
                        onChange={e => setMpPublisherFilter(e.target.value)}
                        className="seamless-select filter-chip-select font-medium text-slate-200 group-hover:text-white cursor-pointer"
                      >
                        <option value="ALL" className="bg-slate-900 text-white">Alle Verlage</option>
                        {mpData.publishers.map(p => (
                          <option key={p.name} value={p.name} className="bg-slate-900 text-white">
                            {p.name} ({p.count})
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
                    </label>
                  )}

                  {(mpSearch || mpPublisherFilter !== 'ALL' || !mpPrintOnly || mpMySeriesOnly) && (
                    <button
                      onClick={() => {
                        setMpSearch('');
                        setMpPublisherFilter('ALL');
                        setMpPrintOnly(true);
                        setMpMySeriesOnly(false);
                      }}
                      className="btn-secondary text-xs py-2 px-3 text-slate-400 hover:text-white"
                    >
                      Filter zurücksetzen
                    </button>
                  )}
                </div>
              </div>

              {/* Loading State */}
              {loadingMp && (
                <div className="glass-panel p-12 rounded-2xl border border-slate-800/80 text-center">
                  <RefreshCw className="w-8 h-8 text-sky-400 animate-spin mx-auto mb-3" />
                  <p className="text-sm font-semibold text-white">Lade Neuerscheinungen von Manga Passion...</p>
                  <p className="text-xs text-slate-400 mt-1">Erscheinungstermine, Bände und Preise werden abgeglichen</p>
                </div>
              )}

              {/* Empty State */}
              {!loadingMp && mpDateGroups.length === 0 && (
                <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-4 text-sky-400">
                    <Calendar className="w-8 h-8" />
                  </div>
                  <h3 className="text-base font-bold text-white mb-1">Keine Neuerscheinungen für diese Auswahl</h3>
                  <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">
                    Für {GERMAN_MONTHS[mpMonth - 1]} {mpYear} wurden mit den aktiven Filtern keine Bände gefunden. Probiere einen anderen Monat oder setze die Filter zurück.
                  </p>
                  {(mpSearch || mpPublisherFilter !== 'ALL' || mpMySeriesOnly) && (
                    <button
                      onClick={() => {
                        setMpSearch('');
                        setMpPublisherFilter('ALL');
                        setMpPrintOnly(true);
                        setMpMySeriesOnly(false);
                      }}
                      className="btn-primary text-xs px-4 py-2"
                    >
                      Filter zurücksetzen
                    </button>
                  )}
                </div>
              )}

              {/* Grouped by Date Timeline */}
              {!loadingMp && mpDateGroups.length > 0 && (
                <div className="space-y-8">
                  {mpDateGroups.map(group => (
                    <div key={group.dateKey} className="space-y-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-800/80">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500/20 to-brand-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 shadow-sm">
                            <Calendar className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="text-base font-bold text-white flex items-center gap-2">
                              <span>{group.dateLabel}</span>
                              <span className="text-xs font-mono font-normal text-slate-400">
                                ({group.items.length} {group.items.length === 1 ? 'Band' : 'Bände'})
                              </span>
                            </h3>
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3.5 sm:gap-4">
                        {group.items.map(item => {
                          const isOwned = item.user_volume_status === 'Vorhanden';
                          const isPreordered = item.user_volume_status === 'Vorbestellt';
                          const isMissing = item.user_volume_status === 'Fehlt';

                          return (
                            <div
                              key={item.id}
                              className={`glass-card rounded-2xl p-3.5 border transition-all flex flex-col justify-between group relative ${
                                isOwned
                                  ? 'border-emerald-500/40 bg-gradient-to-b from-emerald-950/20 via-slate-900/60 to-slate-900/80 shadow-emerald-950/20'
                                  : isPreordered
                                  ? 'border-sky-500/40 bg-gradient-to-b from-sky-950/20 via-slate-900/60 to-slate-900/80 shadow-sky-950/20'
                                  : item.in_collection
                                  ? 'border-brand-500/40 bg-gradient-to-b from-brand-950/20 via-slate-900/60 to-slate-900/80 shadow-brand-950/20'
                                  : 'border-slate-800/80 hover:border-slate-700 bg-slate-900/60'
                              }`}
                            >
                              <div>
                                <div className="flex items-center justify-between gap-1.5 mb-2.5">
                                  {isOwned ? (
                                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1">
                                      <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
                                      <span>Im Regal</span>
                                    </span>
                                  ) : isPreordered ? (
                                    <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1">
                                      <Package className="w-2.5 h-2.5 text-sky-400" />
                                      <span>Vorbestellt</span>
                                    </span>
                                  ) : isMissing ? (
                                    <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1">
                                      <ShoppingCart className="w-2.5 h-2.5 text-amber-400" />
                                      <span>Einkaufsliste</span>
                                    </span>
                                  ) : item.in_collection ? (
                                    <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] font-bold px-2 py-0.5 rounded-lg flex items-center gap-1" title="Diese Reihe steht bereits in deiner Sammlung">
                                      <Star className="w-2.5 h-2.5 text-brand-400" />
                                      <span>Reihe im Regal</span>
                                    </span>
                                  ) : (
                                    <span className="text-[10px] text-slate-500 font-medium px-1">
                                      Neuheit
                                    </span>
                                  )}

                                  {item.is_digital && (
                                    <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 text-[9px] font-bold px-1.5 py-0.5 rounded-md">
                                      eBook
                                    </span>
                                  )}
                                </div>

                                <div className="flex gap-3">
                                  <div className="shrink-0 relative overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-md">
                                    {item.cover_image && !failedImages[`radar-${item.id || item.manga_passion_id || item.title}`] ? (
                                      <img
                                        src={item.cover_image}
                                        alt={item.title}
                                        loading="lazy"
                                        onError={() => setFailedImages(prev => ({ ...prev, [`radar-${item.id || item.manga_passion_id || item.title}`]: true }))}
                                        className="w-16 h-24 sm:w-18 sm:h-26 object-cover group-hover:scale-105 transition-transform duration-300"
                                      />
                                    ) : (
                                      <div className="w-16 h-24 sm:w-18 sm:h-26 bg-slate-800 rounded-xl flex items-center justify-center text-slate-600">
                                        <BookOpen className="w-6 h-6" />
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex-1 min-w-0">
                                    {item.in_collection && item.user_manga_id ? (
                                      <Link
                                        to={`/manga/${item.user_manga_id}`}
                                        className="text-xs sm:text-sm font-bold text-white hover:text-sky-300 truncate block transition-colors leading-snug"
                                        title={`${item.title} (In deiner Sammlung ansehen)`}
                                      >
                                        {item.title}
                                      </Link>
                                    ) : (
                                      <span 
                                        className="text-xs sm:text-sm font-bold text-white truncate block leading-snug"
                                        title={item.title}
                                      >
                                        {item.title}
                                      </span>
                                    )}

                                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                      <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                                        Band {item.volume_number}
                                      </span>
                                    </div>

                                    <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                                      <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                                      <span className="truncate">{item.publisher}</span>
                                    </p>

                                    <p className="text-[11px] text-slate-300 mt-1 flex items-center gap-1 font-mono">
                                      <Calendar className="w-3 h-3 text-sky-400 shrink-0" />
                                      <span>
                                        {item.date ? item.date.split('-').reverse().join('.') : 'Datum offen'}
                                      </span>
                                    </p>
                                  </div>
                                </div>
                              </div>

                              <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                                <div className="font-mono">
                                  {item.price > 0 ? (
                                    <span className="text-sm font-extrabold text-emerald-400">
                                      {item.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                                    </span>
                                  ) : (
                                    <span className="text-xs text-slate-500">Preis k.A.</span>
                                  )}
                                </div>

                                <div className="flex items-center gap-1.5">
                                  {isOwned ? (
                                    <Link
                                      to={`/manga/${item.user_manga_id}`}
                                      className="p-1 px-2.5 rounded-xl bg-emerald-500/20 text-emerald-300 text-xs font-semibold flex items-center gap-1 hover:bg-emerald-500/30 transition-colors"
                                    >
                                      <span>Im Regal</span> ↗
                                    </Link>
                                  ) : (
                                    <>
                                      {canEdit && (
                                        <>
                                          {!isPreordered && (
                                            <button
                                              type="button"
                                              disabled={importingMpId === item.id}
                                              onClick={() => handleImportMangaPassion(item, 'Vorbestellt')}
                                              className="bg-sky-600/20 hover:bg-sky-600 text-sky-300 hover:text-white border border-sky-500/40 hover:border-sky-500 py-1 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all active:scale-95 shadow-sm"
                                              title="Diesen Band als vorbestellt in deine Sammlung übernehmen"
                                            >
                                              {importingMpId === item.id ? (
                                                <RefreshCw className="w-3 h-3 animate-spin" />
                                              ) : (
                                                <Package className="w-3 h-3 text-sky-400" />
                                              )}
                                              <span>Vorbestellen</span>
                                            </button>
                                          )}
                                          {!isMissing && !isPreordered && (
                                            <button
                                              type="button"
                                              disabled={importingMpId === item.id}
                                              onClick={() => handleImportMangaPassion(item, 'Fehlt')}
                                              className="bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 py-1 px-2 rounded-xl text-xs font-medium flex items-center gap-1 transition-all active:scale-95"
                                              title="Diesen Band auf die Einkaufsliste setzen"
                                            >
                                              <ShoppingCart className="w-3 h-3 text-slate-400" />
                                            </button>
                                          )}
                                        </>
                                      )}
                                      {item.in_collection && item.user_manga_id && (
                                        <Link
                                          to={`/manga/${item.user_manga_id}`}
                                          className="p-1 px-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white text-xs transition-colors"
                                          title="Zu den Manga-Details"
                                        >
                                          ↗
                                        </Link>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* VIEW B: PERSÖNLICHER VORBESTELLUNGS- & BUDGET-RADAR */}
          {radarSubView === 'personal' && (
            <div className="space-y-6">
              {/* Release Radar Summary Card */}
              <div className="glass-panel p-5 sm:p-6 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gradient-to-r from-slate-900/90 via-slate-900/70 to-sky-950/30">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
                    <Package className="w-6 h-6 text-sky-400" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white flex items-center gap-2">
                      <span>Meine Vorbestellungen & Lieferungen</span>
                      {radarData && (
                        <span className="bg-sky-500/20 text-sky-300 text-xs px-2.5 py-0.5 rounded-full border border-sky-500/30 font-mono font-bold">
                          {radarData.total_releases} {radarData.total_releases === 1 ? 'Band' : 'Bände'}
                        </span>
                      )}
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Verfolge deine offenen Vorbestellungen und behalte dein geplantes Manga-Budget im Blick
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 w-full md:w-auto">
                  <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
                      <Package className="w-3 h-3 text-sky-400" /> Vorbestellt ({radarData ? radarData.preordered_count : 0})
                    </p>
                    <p className="text-base sm:text-lg font-extrabold text-sky-400 font-mono">
                      {radarData ? radarData.preordered_budget.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00'} €
                    </p>
                  </div>

                  <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
                    <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
                      <Coins className="w-3 h-3 text-emerald-400" /> Gesamt geplant
                    </p>
                    <p className="text-base sm:text-lg font-extrabold text-emerald-400 font-mono">
                      {radarData ? radarData.total_budget.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00'} €
                    </p>
                  </div>

                  <button
                    onClick={fetchReleaseRadar}
                    disabled={loadingRadar}
                    className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 shrink-0"
                    title="Release-Radar aktualisieren"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingRadar ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Personal Filters Bar */}
              <div className="glass-panel p-3.5 sm:p-4 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3">
                <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full md:w-72 shadow-inner">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    placeholder="Reihe oder Verlag suchen..."
                    className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 text-xs"
                    value={radarSearch}
                    onChange={e => setRadarSearch(e.target.value)}
                  />
                  {radarSearch && (
                    <button onClick={() => setRadarSearch('')} className="text-slate-500 hover:text-white">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs overflow-x-auto">
                    {[
                      { id: 'ALL', label: 'Alle Status' },
                      { id: 'Vorbestellt', label: '📦 Vorbestellt' },
                      { id: 'Erscheint bald', label: '⏳ Erscheint bald' },
                    ].map(st => (
                      <button
                        key={st.id}
                        onClick={() => setRadarStatusFilter(st.id)}
                        className={`px-3 py-1.5 rounded-lg font-medium transition-all shrink-0 ${
                          radarStatusFilter === st.id
                            ? 'bg-sky-600 text-white shadow-sm font-semibold'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {st.label}
                      </button>
                    ))}
                  </div>

                  {radarData && radarData.publishers && radarData.publishers.length > 0 && (
                    <label className="flex items-center gap-1.5 bg-slate-950/70 hover:bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-3 py-2 text-xs cursor-pointer transition-all shadow-sm group">
                      <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                      <select
                        value={radarPublisherFilter}
                        onChange={e => setRadarPublisherFilter(e.target.value)}
                        className="seamless-select filter-chip-select font-medium text-slate-200 group-hover:text-white cursor-pointer"
                      >
                        <option value="ALL" className="bg-slate-900 text-white">Alle Verlage</option>
                        {radarData.publishers.map(p => (
                          <option key={p.publisher} value={p.publisher} className="bg-slate-900 text-white">
                            {p.publisher} ({p.count})
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
                    </label>
                  )}

                  {(radarSearch || radarPublisherFilter !== 'ALL' || radarStatusFilter !== 'ALL') && (
                    <button
                      onClick={() => {
                        setRadarSearch('');
                        setRadarPublisherFilter('ALL');
                        setRadarStatusFilter('ALL');
                      }}
                      className="btn-secondary text-xs py-2 px-3 text-slate-400 hover:text-white"
                    >
                      Filter zurücksetzen
                    </button>
                  )}
                </div>
              </div>

              {/* Empty State when no personal releases found */}
              {(!radarData || radarData.total_releases === 0) && (
                <div className="glass-panel p-10 rounded-2xl border border-slate-800/80 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-4 text-sky-400">
                    <Package className="w-8 h-8" />
                  </div>
                  <h3 className="text-base font-bold text-white mb-1">Keine anstehenden Vorbestellungen eingetragen</h3>
                  <p className="text-xs text-slate-400 max-w-md mx-auto mb-5 leading-relaxed">
                    Du hast aktuell keine Bände mit dem Status <strong>„Vorbestellt“</strong> oder <strong>„Erscheint bald“</strong> in deiner Sammlung. Wechsle zum Reiter <strong>„Deutsche Neuheiten“</strong>, um Neuerscheinungen mit 1 Klick vorzubestellen!
                  </p>
                  <button
                    onClick={() => setRadarSubView('passion')}
                    className="btn-primary text-xs px-4 py-2"
                  >
                    Zu den deutschen Neuheiten
                  </button>
                </div>
              )}

              {/* Monthly Groups Timeline for Personal Releases */}
              {radarData && radarData.groups && radarData.groups.length > 0 && (
                <div className="space-y-8">
                  {radarData.groups.map(group => {
                    const visibleItems = group.items.filter(item => {
                      const matchPub = radarPublisherFilter === 'ALL' || 
                        item.effective_publisher.toLowerCase() === radarPublisherFilter.toLowerCase();
                      const matchStatus = radarStatusFilter === 'ALL' || 
                        item.status === radarStatusFilter;
                      const matchSearch = !radarSearch || 
                        item.manga_title.toLowerCase().includes(radarSearch.toLowerCase()) || 
                        String(item.volume_number).includes(radarSearch) ||
                        (item.effective_publisher && item.effective_publisher.toLowerCase().includes(radarSearch.toLowerCase()));
                      return matchPub && matchStatus && matchSearch;
                    });

                    if (visibleItems.length === 0) return null;

                    const groupTotalVisible = visibleItems.reduce((sum, it) => sum + (it.price || 0), 0);
                    const groupPreorderedVisible = visibleItems.filter(it => ['Vorbestellt', 'Bestellt'].includes(it.status)).length;

                    return (
                      <div key={group.key} className="space-y-3.5">
                        <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-800/80">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500/20 to-brand-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400 shadow-sm">
                              <Calendar className="w-4 h-4" />
                            </div>
                            <div>
                              <h3 className="text-base font-bold text-white flex items-center gap-2">
                                <span>{group.label}</span>
                                <span className="text-xs font-mono font-normal text-slate-400">
                                  ({visibleItems.length} {visibleItems.length === 1 ? 'Band' : 'Bände'})
                                </span>
                              </h3>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 text-xs">
                            {groupPreorderedVisible > 0 && (
                              <span className="inline-flex items-center gap-1 bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold px-2.5 py-1 rounded-xl">
                                <Package className="w-3 h-3 text-sky-400" />
                                <span>{groupPreorderedVisible} Vorbestellt</span>
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono font-bold px-2.5 py-1 rounded-xl">
                              <Coins className="w-3 h-3 text-emerald-400" />
                              <span>{groupTotalVisible.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
                          {visibleItems.map(item => {
                            const isPreordered = ['Vorbestellt', 'Bestellt'].includes(item.status);
                            const isComingSoon = item.status === 'Erscheint bald';
                            const displayTitle = item.type === 'schuber' ? `Schuber ${item.volume_number}` :
                              item.type === 'special_edition' ? `Band ${item.volume_number} (Special Edition)` :
                              item.type === 'special' ? `Special ${item.volume_number}` :
                              `Band ${item.volume_number}`;

                            return (
                              <div
                                key={item.id}
                                className={`glass-card rounded-2xl p-3.5 border transition-all flex flex-col justify-between group relative ${
                                  isPreordered 
                                    ? 'border-sky-500/40 bg-gradient-to-b from-sky-950/20 via-slate-900/60 to-slate-900/80 hover:border-sky-500/70 shadow-lg shadow-sky-950/20' 
                                    : isComingSoon
                                    ? 'border-purple-500/40 bg-gradient-to-b from-purple-950/20 via-slate-900/60 to-slate-900/80 hover:border-purple-500/70 shadow-lg shadow-purple-950/20'
                                    : 'border-slate-800/80 hover:border-slate-700 bg-slate-900/60'
                                }`}
                              >
                                <div>
                                  <div className="flex items-center justify-between gap-1.5 mb-2.5">
                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border flex items-center gap-1 shrink-0 ${
                                      isPreordered
                                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/50'
                                        : isComingSoon
                                        ? 'bg-purple-500/20 text-purple-300 border-purple-500/50'
                                        : 'bg-slate-800 text-slate-300 border-slate-700'
                                    }`}>
                                      {isPreordered ? <Package className="w-2.5 h-2.5" /> : <Clock className="w-2.5 h-2.5" />}
                                      <span>{item.status}</span>
                                    </span>

                                    {item.countdown_label && (
                                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-lg border truncate ${
                                        item.days_until === 0
                                          ? 'bg-emerald-500/25 border-emerald-500/60 text-emerald-300 animate-pulse'
                                          : item.days_until > 0 && item.days_until <= 7
                                          ? 'bg-sky-500/20 border-sky-500/40 text-sky-200'
                                          : item.days_until < 0
                                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                          : 'bg-slate-800/80 border-slate-700/60 text-slate-400'
                                      }`}>
                                        {item.countdown_label}
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex gap-3">
                                    <Link 
                                      to={`/manga/${item.manga_id}`}
                                      className="shrink-0 relative group/thumb overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-md"
                                    >
                                      {item.vol_cover || item.manga_cover ? (
                                        <img
                                          src={item.vol_cover || item.manga_cover}
                                          alt={item.manga_title}
                                          className="w-16 h-24 sm:w-18 sm:h-26 object-cover group-hover/thumb:scale-105 transition-transform duration-300"
                                        />
                                      ) : (
                                        <div className="w-16 h-24 bg-slate-800 rounded-xl flex items-center justify-center text-slate-600">
                                          <BookOpen className="w-6 h-6" />
                                        </div>
                                      )}
                                    </Link>

                                    <div className="flex-1 min-w-0">
                                      <Link
                                        to={`/manga/${item.manga_id}`}
                                        className="text-xs sm:text-sm font-bold text-white hover:text-brand-300 truncate block transition-colors leading-snug"
                                        title={item.manga_title}
                                      >
                                        {item.manga_title}
                                      </Link>

                                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                                        <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                                          {displayTitle}
                                        </span>
                                      </div>

                                      <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                                        <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                                        <span className="truncate">{item.effective_publisher}</span>
                                      </p>

                                      {item.release_date && (
                                        <p className="text-[11px] text-slate-300 mt-1 flex items-center gap-1 font-mono">
                                          <Calendar className="w-3 h-3 text-sky-400 shrink-0" />
                                          <span>
                                            {item.release_date.split('-').length === 3 
                                              ? `${item.release_date.split('-')[2]}.${item.release_date.split('-')[1]}.${item.release_date.split('-')[0]}`
                                              : item.release_date}
                                          </span>
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                </div>

                                <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                                  <div className="font-mono">
                                    {item.price > 0 ? (
                                      <span className="text-sm font-extrabold text-emerald-400">
                                        {item.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                                      </span>
                                    ) : (
                                      <span className="text-xs text-slate-500">Preis n.a.</span>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-1.5">
                                    <Link
                                      to={`/manga/${item.manga_id}`}
                                      className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors text-xs"
                                      title="Zu den Manga-Details"
                                    >
                                      Details ↗
                                    </Link>

                                    {canEdit && (
                                      <button
                                        type="button"
                                        onClick={() => handleMarkDelivered(item)}
                                        disabled={markingDeliveredId === item.id}
                                        className="bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 hover:border-emerald-500 py-1 px-2.5 rounded-xl text-xs font-semibold flex items-center gap-1 transition-all active:scale-95 shadow-sm"
                                        title="Band als geliefert/erhalten markieren (Status wird auf 'Vorhanden' gesetzt)"
                                      >
                                        {markingDeliveredId === item.id ? (
                                          <RefreshCw className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                                        )}
                                        <span>Geliefert</span>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      );
}
