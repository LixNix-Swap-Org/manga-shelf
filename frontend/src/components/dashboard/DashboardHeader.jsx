import BarcodeScannerButton from '../common/BarcodeScannerButton';
import { BarChart3, BookOpen, Calendar, Download, LogOut, Menu, Plus, Search, ShoppingCart, UploadCloud, Users, X } from 'lucide-react';

/** Top navbar with search, quick controls, action buttons and mobile drawer. Purely presentational; all state and handlers come in via props. */
export default function DashboardHeader({
  activeMainView,
  canEdit,
  fetchReleaseRadar,
  fetchShoppingList,
  handleBarcodeDetected,
  handleInstallClick,
  handleOpenModal,
  handleOpenRestoreModal,
  handleOpenStats,
  handleOpenUsersModal,
  isInstallable,
  isInstalledApp,
  isOfflineMode,
  isVisitor,
  mobileMenuOpen,
  onLogout,
  radarData,
  search,
  searchInputRef,
  setActiveMainView,
  setMobileMenuOpen,
  setSearch,
  shoppingData,
  user
}) {
  return (
    <header className="sticky top-0 z-30 glass-panel border-b border-slate-800/80 mb-8 px-4 sm:px-6 lg:px-8 py-3">
      <div className="max-w-[1720px] 2xl:max-w-[1840px] mx-auto flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-3 sm:gap-4 min-w-0">

        {/* Top Bar for Mobile & Tablet / Left item for Desktop */}
        <div className="flex items-center justify-between gap-3 w-full xl:w-auto shrink-0 min-w-0">
          {/* Logo & Title */}
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center shadow-lg shadow-brand-500/30 shrink-0">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <h1 className="text-lg sm:text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent leading-tight truncate">
                  MangaShelf
                </h1>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md bg-slate-800/80 text-slate-400 border border-slate-700/60 leading-none shrink-0">
                  v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2.8.2'}
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-slate-400 flex items-center gap-1.5 mt-0.5 truncate">
                <span className={`w-1.5 h-1.5 rounded-full ${isOfflineMode ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400 animate-pulse'} inline-block shrink-0`}></span>
                <span className="truncate">{isOfflineMode ? 'Offline-Modus' : 'Sammlung & Tracker'}</span>
              </p>
            </div>
          </div>

          {/* Tablet & Mobile Quick Controls (< xl) */}
          <div className="flex xl:hidden items-center gap-1 sm:gap-1.5 shrink-0">
            <button 
              id="btn-mobile-shopping"
              onClick={() => {
                const next = activeMainView === 'shelf' ? 'shopping' : 'shelf';
                setActiveMainView(next);
                if (next === 'shopping') fetchShoppingList();
              }}
              className={`p-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all relative flex items-center gap-1.5 text-xs shrink-0 ${
                activeMainView === 'shopping'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'btn-secondary text-slate-300'
              }`}
              title="Einkaufsliste umschalten"
            >
              <ShoppingCart className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="hidden sm:inline">Einkauf</span>
              {shoppingData && shoppingData.total_missing > 0 && (
                <span className="bg-emerald-500 text-slate-950 font-bold text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-mono shrink-0">
                  {shoppingData.total_missing}
                </span>
              )}
            </button>

            <button 
              id="btn-mobile-radar"
              onClick={() => {
                const next = activeMainView === 'radar' ? 'shelf' : 'radar';
                setActiveMainView(next);
                if (next === 'radar') fetchReleaseRadar();
              }}
              className={`p-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all relative flex items-center gap-1.5 text-xs shrink-0 ${
                activeMainView === 'radar'
                  ? 'bg-sky-500/20 text-sky-300 border-sky-500/50 shadow-sm'
                  : 'btn-secondary text-slate-300'
              }`}
              title="Release-Radar umschalten"
            >
              <Calendar className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="hidden sm:inline">Radar</span>
              {radarData && radarData.total_releases > 0 && (
                <span className="bg-sky-500 text-slate-950 font-bold text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-mono shrink-0">
                  {radarData.total_releases}
                </span>
              )}
            </button>

            {canEdit && (
              <button 
                onClick={handleOpenModal}
                className="hidden sm:flex btn-primary text-xs py-2 px-3 items-center gap-1.5 shadow-sm shrink-0"
                title="Neuen Manga anlegen"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Neuer Manga</span>
              </button>
            )}

            <button 
              id="btn-mobile-menu-toggle"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="btn-secondary p-1.5 sm:p-2 text-slate-300 hover:text-white shrink-0"
              title="Menü öffnen"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Search bar: Full width on < xl, Centered & spacious on >= xl */}
        <div 
          onClick={() => searchInputRef.current?.focus()}
          className="flex items-center gap-2.5 bg-slate-950/80 border border-slate-700/80 hover:border-slate-600 rounded-xl px-3.5 py-2.5 w-full xl:flex-1 xl:max-w-xs 2xl:max-w-md xl:min-w-[200px] 2xl:min-w-[280px] focus-within:ring-2 focus-within:ring-brand-500/50 focus-within:border-brand-500 transition-all cursor-text shadow-inner"
        >
          <Search className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" />
          <input 
            ref={searchInputRef}
            id="main-search-input"
            type="text" 
            placeholder="Titel, Autor oder Verlag suchen..." 
            className="w-full min-w-0 bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-sm" 
            value={search} 
            onChange={e => setSearch(e.target.value)} 
          />
          <div className="shrink-0 flex items-center gap-1">
            <BarcodeScannerButton compact onDetected={handleBarcodeDetected} />
            {search && (
              <button 
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSearch('');
                  searchInputRef.current?.focus();
                }}
                className="text-slate-400 hover:text-white p-0.5 rounded hover:bg-slate-800 shrink-0 transition-colors"
                title="Suche zurücksetzen"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Desktop Action buttons (>= xl) */}
        <div className="hidden xl:flex items-center gap-1.5 2xl:gap-2 shrink-0 flex-nowrap justify-end min-w-0">
          <button 
            id="btn-open-stats"
            onClick={handleOpenStats} 
            className="btn-secondary flex items-center gap-1.5 text-xs text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10 shadow-sm py-2 px-2.5 2xl:px-3 whitespace-nowrap"
            title="Statistik- & Finanz-Dashboard öffnen"
          >
            <BarChart3 className="w-4 h-4 text-emerald-400 shrink-0" /> 
            <span>Statistiken<span className="hidden 2xl:inline"> & Finanzen</span></span>
          </button>

          {canEdit && (
            <button 
              id="btn-open-add-manga"
              onClick={handleOpenModal} 
              className="btn-primary flex items-center gap-1.5 text-xs shadow-md py-2 px-2.5 2xl:px-3 whitespace-nowrap"
            >
              <Plus className="w-4 h-4 shrink-0" /> 
              <span>Neuer Manga</span>
            </button>
          )}

          {isInstallable && !isInstalledApp && (
            <button
              id="btn-install-pwa"
              onClick={handleInstallClick}
              className="btn-secondary flex items-center gap-1.5 text-xs text-brand-300 hover:text-white border-brand-500/40 bg-brand-500/10 hover:bg-brand-500/20 py-2 px-2.5 2xl:px-3 shadow-sm transition-all whitespace-nowrap"
              title="Manga Shelf als native App auf deinem Gerät installieren"
            >
              <Download className="w-4 h-4 text-brand-400 shrink-0" />
              <span className="hidden 2xl:inline">App installieren</span>
            </button>
          )}

          {user?.role === 'admin' && (
            <>
              <button
                id="btn-open-users"
                onClick={handleOpenUsersModal}
                className="btn-secondary flex items-center gap-1.5 text-xs text-slate-200 py-2 px-2.5 2xl:px-3 whitespace-nowrap"
                title="Benutzer anlegen und verwalten"
              >
                <Users className="w-4 h-4 text-brand-400 shrink-0" /> 
                <span>Benutzer</span>
              </button>

              <button
                id="btn-open-backups"
                onClick={handleOpenRestoreModal}
                className="btn-secondary flex items-center gap-1.5 text-xs text-slate-200 hover:text-emerald-400 transition-colors py-2 px-2.5 2xl:px-3 whitespace-nowrap"
                title="Backup-Zentrale, automatische Snapshots, ZIP-Download & Wiederherstellung"
              >
                <UploadCloud className="w-4 h-4 text-emerald-400 shrink-0" /> 
                <span>Backups</span>
              </button>
            </>
          )}

          <div className="h-6 w-[1px] bg-slate-800 mx-0.5 shrink-0"></div>

          <div className="flex items-center gap-1.5 text-xs bg-slate-800/60 px-2 py-1.5 2xl:px-2.5 rounded-xl border border-slate-700/50 shrink-0">
            <span className="text-slate-400 hidden 2xl:inline">User:</span>
            <span className="font-semibold text-slate-200 truncate max-w-[90px] 2xl:max-w-none">{user?.username}</span>
            {user?.role === 'admin' ? (
              <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] px-1.5 py-0.2 rounded font-mono font-bold uppercase shrink-0">
                Admin
              </span>
            ) : isVisitor ? (
              <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] px-1.5 py-0.2 rounded font-mono font-bold uppercase shrink-0">
                Gast
              </span>
            ) : (
              <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] px-1.5 py-0.2 rounded font-mono font-bold uppercase shrink-0">
                Editor
              </span>
            )}
          </div>

          <button 
            id="btn-logout"
            onClick={onLogout} 
            className="btn-secondary p-2 text-slate-300 hover:text-red-400 transition-colors shrink-0" 
            title="Abmelden"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>

      </div>

      {/* Dropdown Menu Drawer for < xl */}
      {mobileMenuOpen && (
        <div className="xl:hidden mt-3 pt-3 border-t border-slate-800/80 space-y-2 animate-fade-in max-w-[1720px] 2xl:max-w-[1840px] mx-auto">
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Angemeldet als:</span>
              <span className="font-bold text-white">{user?.username}</span>
            </div>
            <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold">
              {user?.role}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button 
              id="btn-mobile-menu-stats"
              onClick={() => { setMobileMenuOpen(false); handleOpenStats(); }}
              className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-emerald-300 border-emerald-500/30"
            >
              <BarChart3 className="w-4 h-4 text-emerald-400" /> Statistiken
            </button>

            <button 
              id="btn-mobile-menu-radar"
              onClick={() => { 
                setMobileMenuOpen(false); 
                setActiveMainView('radar'); 
                fetchReleaseRadar(); 
              }}
              className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-sky-300 border-sky-500/30"
            >
              <Calendar className="w-4 h-4 text-sky-400" /> Release-Radar
            </button>

            {canEdit && (
              <button 
                id="btn-mobile-menu-add"
                onClick={() => { setMobileMenuOpen(false); handleOpenModal(); }}
                className="btn-primary text-xs py-2 px-3 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Neuer Manga
              </button>
            )}

            {user?.role === 'admin' && (
              <>
                <button 
                  id="btn-mobile-menu-users"
                  onClick={() => { setMobileMenuOpen(false); handleOpenUsersModal(); }}
                  className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-slate-200"
                >
                  <Users className="w-4 h-4 text-brand-400" /> Benutzer
                </button>

                <button 
                  id="btn-mobile-menu-backups"
                  onClick={() => { setMobileMenuOpen(false); handleOpenRestoreModal(); }}
                  className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-slate-200 hover:text-emerald-400"
                >
                  <UploadCloud className="w-4 h-4 text-emerald-400" /> Backups
                </button>
              </>
            )}
          </div>

          {isInstallable && !isInstalledApp && (
            <button
              id="btn-mobile-install-pwa"
              onClick={() => { setMobileMenuOpen(false); handleInstallClick(); }}
              className="w-full btn-secondary text-xs py-2 text-brand-300 bg-brand-500/10 border-brand-500/40 hover:bg-brand-500/20 flex items-center justify-center gap-2 font-medium"
            >
              <Download className="w-4 h-4 text-brand-400" /> MangaShelf als App installieren
            </button>
          )}

          <button 
            id="btn-mobile-menu-logout"
            onClick={onLogout} 
            className="w-full btn-secondary text-xs py-2 text-red-300 hover:bg-red-950/40 border-red-900/40 flex items-center justify-center gap-2"
          >
            <LogOut className="w-4 h-4 text-red-400" /> Abmelden
          </button>
        </div>
      )}
    </header>
  );
}
