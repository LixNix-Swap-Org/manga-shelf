import { useRef } from 'react';
import BarcodeScannerButton from '../common/BarcodeScannerButton';
import { BookOpen, Calendar, ChartColumn, CloudUpload, Download, FileSpreadsheet, Lock, LogOut, Menu, Plus, Search, ShoppingCart, Users, X } from 'lucide-react';
import { APP_VERSION, formatBadgeCount, nextQuickView, roleBadgeClass, roleLabel } from './dashboardShell';

const SEARCH_PLACEHOLDER = 'Titel, Autor, Verlag oder Tag suchen...';

/** Top navbar with search, quick controls, action buttons and mobile drawer. Purely presentational; all state and handlers come in via props. */
export default function DashboardHeader({
  activeMainView,
  canEdit,
  handleBarcodeDetected,
  handleInstallClick,
  handleOpenCsvModal,
  handleOpenModal,
  handleOpenPasswordModal,
  handleOpenRestoreModal,
  handleOpenStats,
  handleOpenUsersModal,
  headingRef,
  isInstallable,
  isInstalledApp,
  isOfflineMode,
  isVisitor,
  mobileMenuOpen,
  onLogout,
  radarData,
  search,
  searchInputRef,
  setMobileMenuOpen,
  setSearch,
  setView,
  shoppingData,
  user
}) {
  const menuToggleRef = useRef(null);
  const isAdmin = user?.role === 'admin';
  // export for every logged-in user, import for editors; admins have it in the backup dialog
  const showCsvEntry = Boolean(user) && !isAdmin && !user.offline && Boolean(handleOpenCsvModal);
  const missingCount = shoppingData?.total_missing || 0;
  const releaseCount = radarData?.total_releases || 0;

  // the menu item that opens a dialog unmounts with the menu; the toggle then becomes the dialog's opener
  const runFromMenu = (action) => {
    menuToggleRef.current?.focus();
    setMobileMenuOpen(false);
    action();
  };

  return (
    <header data-sticky-header="" className="sticky top-0 z-30 glass-panel border-b border-slate-800/80 mb-8 px-4 sm:px-6 lg:px-8 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
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
                <h1 ref={headingRef} tabIndex={-1} className="focus:outline-none text-lg sm:text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent leading-tight truncate">
                  MangaShelf
                </h1>
                <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md bg-slate-800/80 text-slate-400 border border-slate-700/60 leading-none shrink-0">
                  v{APP_VERSION}
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-slate-400 flex items-center gap-1.5 mt-0.5 truncate">
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${isOfflineMode ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400 animate-pulse'} inline-block shrink-0`}></span>
                <span className="truncate">{isOfflineMode ? 'Offline-Modus' : 'Sammlung & Tracker'}</span>
              </p>
            </div>
          </div>

          {/* Tablet & Mobile Quick Controls (< xl) */}
          <div className="flex xl:hidden items-center gap-1 sm:gap-1.5 shrink-0">
            <button 
              id="btn-mobile-shopping"
              type="button"
              aria-pressed={activeMainView === 'shopping'}
              aria-label={missingCount > 0 ? `Einkaufsliste, ${missingCount} fehlend` : 'Einkaufsliste'}
              onClick={() => setView(nextQuickView(activeMainView, 'shopping'))}
              className={`p-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all relative flex items-center gap-1.5 text-xs shrink-0 ${
                activeMainView === 'shopping'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'btn-secondary text-slate-300'
              }`}
              title="Einkaufsliste umschalten"
            >
              <ShoppingCart className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Einkauf</span>
              {missingCount > 0 && (
                <span aria-hidden="true" className="bg-emerald-500 text-slate-950 font-bold text-[9px] h-4 min-w-4 px-1 rounded-full flex items-center justify-center font-mono shrink-0">
                  {formatBadgeCount(missingCount)}
                </span>
              )}
            </button>

            <button 
              id="btn-mobile-radar"
              type="button"
              aria-pressed={activeMainView === 'radar'}
              aria-label={releaseCount > 0 ? `Release-Radar, ${releaseCount} Termine` : 'Release-Radar'}
              onClick={() => setView(nextQuickView(activeMainView, 'radar'))}
              className={`p-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all relative flex items-center gap-1.5 text-xs shrink-0 ${
                activeMainView === 'radar'
                  ? 'bg-sky-500/20 text-sky-300 border-sky-500/50 shadow-sm'
                  : 'btn-secondary text-slate-300'
              }`}
              title="Release-Radar umschalten"
            >
              <Calendar className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Radar</span>
              {releaseCount > 0 && (
                <span aria-hidden="true" className="bg-sky-500 text-slate-950 font-bold text-[9px] h-4 min-w-4 px-1 rounded-full flex items-center justify-center font-mono shrink-0">
                  {formatBadgeCount(releaseCount)}
                </span>
              )}
            </button>

            {canEdit && (
              <button 
                type="button"
                onClick={handleOpenModal}
                aria-label="Neuen Manga anlegen"
                className="hidden sm:flex btn-primary text-xs py-2 px-3 items-center gap-1.5 shadow-sm shrink-0"
                title="Neuen Manga anlegen"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">Neuer Manga</span>
              </button>
            )}

            <button 
              id="btn-mobile-menu-toggle"
              ref={menuToggleRef}
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="btn-secondary p-1.5 sm:p-2 text-slate-300 hover:text-white shrink-0"
              title={mobileMenuOpen ? 'Menü schließen' : 'Menü öffnen'}
              aria-label={mobileMenuOpen ? 'Menü schließen' : 'Menü öffnen'}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-menu-drawer"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" aria-hidden="true" /> : <Menu className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
        </div>

        {/* Search bar: Full width on < xl, Centered & spacious on >= xl */}
        <div 
          onClick={(e) => {
            // the scanner's button and its hidden file input must not raise the keyboard
            if (e.target instanceof Element && e.target.closest('button, input[type="file"]')) return;
            searchInputRef.current?.focus();
          }}
          className="flex items-center gap-2.5 bg-slate-950/80 border border-slate-700/80 hover:border-slate-600 rounded-xl px-3.5 py-2.5 w-full xl:flex-1 xl:max-w-xs 2xl:max-w-md xl:min-w-[200px] 2xl:min-w-[280px] focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all cursor-text shadow-inner"
        >
          <Search className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" aria-hidden="true" />
          <input 
            ref={searchInputRef}
            id="main-search-input"
            type="text" 
            aria-label="Sammlung durchsuchen"
            placeholder={activeMainView === 'shelf' ? SEARCH_PLACEHOLDER : 'In der Sammlung suchen...'}
            className="w-full min-w-0 bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm" 
            value={search} 
            onChange={e => {
              // the header search always searches the collection: typing on another view shows the shelf
              if (activeMainView !== 'shelf') setView('shelf');
              setSearch(e.target.value);
            }} 
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
                className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 shrink-0 transition-colors"
                title="Suche zurücksetzen"
                aria-label="Suche zurücksetzen"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {/* Desktop Action buttons (>= xl) */}
        <div className="hidden xl:flex items-center gap-1.5 2xl:gap-2 shrink-0 flex-nowrap justify-end min-w-0">
          <button 
            id="btn-open-stats"
            type="button"
            onClick={handleOpenStats} 
            disabled={isOfflineMode}
            className="btn-secondary flex items-center gap-1.5 text-xs text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10 shadow-sm py-2 px-2.5 2xl:px-3 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
            title={isOfflineMode ? 'Offline nicht verfügbar' : 'Statistik- & Finanz-Dashboard öffnen'}
          >
            <ChartColumn className="w-4 h-4 text-emerald-400 shrink-0" /> 
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

          {showCsvEntry && (
            <button
              id="btn-open-csv"
              type="button"
              onClick={handleOpenCsvModal}
              className="btn-secondary flex items-center gap-1.5 text-xs text-slate-200 hover:text-emerald-400 transition-colors py-2 px-2.5 2xl:px-3 whitespace-nowrap"
              title={canEdit ? 'Sammlung als CSV exportieren oder aus CSV importieren' : 'Sammlung als CSV exportieren'}
            >
              <FileSpreadsheet className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>CSV</span>
            </button>
          )}

          {isAdmin && (
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
                <CloudUpload className="w-4 h-4 text-emerald-400 shrink-0" /> 
                <span>Backups</span>
              </button>
            </>
          )}

          <div aria-hidden="true" className="h-6 w-[1px] bg-slate-800 mx-0.5 shrink-0"></div>

          <div className="flex items-center gap-1.5 text-xs bg-slate-800/60 px-2 py-1.5 2xl:px-2.5 rounded-xl border border-slate-700/50 shrink-0">
            <span className="text-slate-400 hidden 2xl:inline">Angemeldet:</span>
            <span className="font-semibold text-slate-200 truncate max-w-[90px] 2xl:max-w-none">{user?.username}</span>
            <span className={`${roleBadgeClass(user)} border text-[10px] px-1.5 py-px rounded font-mono font-bold uppercase shrink-0`}>
              {roleLabel(user)}
            </span>
          </div>

          {!user?.offline && (
            <button
              id="btn-change-password"
              onClick={handleOpenPasswordModal}
              className="btn-secondary p-2 text-slate-300 hover:text-brand-300 transition-colors shrink-0"
              title="Eigenes Passwort ändern"
              aria-label="Eigenes Passwort ändern"
            >
              <Lock className="w-4 h-4" />
            </button>
          )}

          <button 
            id="btn-logout"
            type="button"
            onClick={onLogout} 
            className="btn-secondary p-2 text-slate-300 hover:text-red-400 transition-colors shrink-0" 
            title="Abmelden"
            aria-label="Abmelden"
          >
            <LogOut className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

      </div>

      {/* Dropdown Menu Drawer for < xl */}
      {mobileMenuOpen && (
        <div id="mobile-menu-drawer" className="xl:hidden mt-3 pt-3 border-t border-slate-800/80 space-y-2 animate-fade-in max-w-[1720px] 2xl:max-w-[1840px] mx-auto">
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Angemeldet als:</span>
              <span className="font-bold text-white">{user?.username}</span>
            </div>
            <span className={`${roleBadgeClass(user)} border text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold`}>
              {roleLabel(user)}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button 
              id="btn-mobile-menu-stats"
              type="button"
              onClick={() => runFromMenu(handleOpenStats)}
              disabled={isOfflineMode}
              className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-emerald-300 border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChartColumn className="w-4 h-4 text-emerald-400" /> Statistiken
            </button>

            <button 
              id="btn-mobile-menu-radar"
              type="button"
              onClick={() => {
                setMobileMenuOpen(false);
                setView('radar');
              }}
              className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-sky-300 border-sky-500/30"
            >
              <Calendar className="w-4 h-4 text-sky-400" /> Release-Radar
            </button>

            {canEdit && (
              <button 
                id="btn-mobile-menu-add"
                type="button"
                onClick={() => runFromMenu(handleOpenModal)}
                className="btn-primary text-xs py-2 px-3 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" /> Neuer Manga
              </button>
            )}

            {showCsvEntry && (
              <button
                id="btn-mobile-menu-csv"
                type="button"
                onClick={() => runFromMenu(handleOpenCsvModal)}
                className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-slate-200 hover:text-emerald-400"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-400" aria-hidden="true" /> CSV
              </button>
            )}

            {isAdmin && (
              <>
                <button 
                  id="btn-mobile-menu-users"
                  type="button"
                  onClick={() => runFromMenu(handleOpenUsersModal)}
                  className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-slate-200"
                >
                  <Users className="w-4 h-4 text-brand-400" /> Benutzer
                </button>

                <button 
                  id="btn-mobile-menu-backups"
                  type="button"
                  onClick={() => runFromMenu(handleOpenRestoreModal)}
                  className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-slate-200 hover:text-emerald-400"
                >
                  <CloudUpload className="w-4 h-4 text-emerald-400" /> Backups
                </button>
              </>
            )}
          </div>

          {isInstallable && !isInstalledApp && (
            <button
              id="btn-mobile-install-pwa"
              type="button"
              onClick={() => runFromMenu(handleInstallClick)}
              className="w-full btn-secondary text-xs py-2 text-brand-300 bg-brand-500/10 border-brand-500/40 hover:bg-brand-500/20 flex items-center justify-center gap-2 font-medium"
            >
              <Download className="w-4 h-4 text-brand-400" /> MangaShelf als App installieren
            </button>
          )}

          {!user?.offline && (
            <button
              id="btn-mobile-menu-password"
              type="button"
              onClick={() => runFromMenu(handleOpenPasswordModal)}
              className="w-full btn-secondary text-xs py-2 text-slate-200 flex items-center justify-center gap-2"
            >
              <Lock className="w-4 h-4 text-brand-400" /> Passwort ändern
            </button>
          )}

          <button 
            id="btn-mobile-menu-logout"
            type="button"
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
