import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import BarcodeScannerButton from '../common/BarcodeScannerButton';
import BottomNav, { useIsNarrow } from '../common/BottomNav';
import { isAppMode, isLocalMode } from '../../utils/api';
import useConnection from '../../app/useConnection';
import { LOCAL_SERVER_NAME } from '../../app/connection';
import { getCoverOrigin } from '../../utils/coverOrigin';
import { BookOpen, Calendar, ChartColumn, ChevronDown, Download, Globe, LogOut, Menu, Plus, Search, Settings, ShieldCheck, Tv, X } from 'lucide-react';
import { APP_VERSION, roleBadgeClass, roleLabel } from './dashboardShell';
import { adminSections } from './adminSections';
import QuickAccessPanel, { quickAccessEntries, quickOptionId, QUICK_LISTBOX_ID } from './QuickAccess';
import { getRecentSeries } from '../../utils/recentSeries';
import { t } from '../../i18n/index.js';

const SystemModal = lazy(() => import('../modals/SystemModal'));
const BackupExportModal = lazy(() => import('../modals/BackupExportModal'));
const AdminCenter = lazy(() => import('./AdminCenter'));

const QUICK_SHORTCUTS = 'Control+K Meta+K'; // i18n-ignore: key names (aria-keyshortcuts syntax)
// i18n
const SEARCH_PLACEHOLDER = 'Titel, Autor, Tag, ISBN oder Notiz suchen...';
// BarcodeScannerButton's look plus the touch hit area
const HEADER_SCAN_CLASS = 'hit-44 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600/80 hover:bg-indigo-600 active:bg-indigo-700 text-white transition shadow-sm active:scale-95 disabled:opacity-50';

// i18n
const PILL_STATE = {
  online: { dot: 'bg-emerald-400', text: 'verbunden' },
  connecting: { dot: 'bg-sky-400 animate-pulse', text: 'verbinde…' },
  offline: { dot: 'bg-amber-400 animate-pulse', text: 'offline' }
};

/** Name of the device entry in the UI language ('Auf diesem Gerät' or 'Auf diesem Gerät · Felix'). */
const localServerName = (name) => (typeof name === 'string' && name.startsWith(LOCAL_SERVER_NAME)
  ? `${t(LOCAL_SERVER_NAME)}${name.slice(LOCAL_SERVER_NAME.length)}`
  : name);

/** App build: server name and connection state; opens the server screen. */
function ConnectionPill() {
  const { state, server } = useConnection();
  const look = PILL_STATE[state] || PILL_STATE.offline;
  // the device entry carries the German LOCAL_SERVER_NAME ('Auf diesem Gerät · <profile>'): only that part is translated
  const name = server?.local ? localServerName(server.name) : (server?.name || t('Kein Server'));
  // without a server the collection lives on the device: no connection state to report
  const local = Boolean(server?.local) || isLocalMode();
  return (
    <Link
      to="/server"
      id="btn-connection-pill"
      className="inline-flex items-center gap-1.5 min-w-0 max-w-full rounded-full border border-slate-700/70 bg-slate-900/70 px-2 py-0.5 hover:border-brand-500/60 hover:text-slate-200"
      aria-label={local ? t('{name}. Server wechseln', { name }) : t('Server {name}, {text}. Server wechseln', { name, text: t(look.text) })}
      title={t('Server wechseln oder Verbindung prüfen')}
    >
      <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${local ? 'bg-slate-400' : look.dot}`}></span>
      <span className="min-w-0 truncate">{name}</span>
      {!local && <span className="text-slate-400 shrink-0" aria-hidden="true">· {t(look.text)}</span>}
    </Link>
  );
}

/** An outcome of App's status check that opens the collection (as on the device screen). */
export const opensCollection = (outcome) => ['local', 'online', 'offline'].includes(outcome?.status);

/** Standalone mode: a restore runs App's reload (onLocalReplaced), then the shelf or, without a profile, the device screen. */
function LocalBackupDialog({ onClose, onLocalReplaced }) {
  const navigate = useNavigate();
  const onReplaced = async () => {
    onClose();
    const outcome = await onLocalReplaced?.();
    if (opensCollection(outcome)) navigate('/', { replace: true });
    else navigate('/server');
  };
  return <BackupExportModal onClose={onClose} onReplaced={onReplaced} />;
}

/**
 * Publishes the sticky header's height as `--sticky-header-h` on <html> (index.css turns it into scroll-padding-top, so
 * keyboard focus never lands under the header); 0 while the header scrolls with the page (short: screens).
 */
function useStickyHeaderHeight(headerRef) {
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return undefined;
    const root = document.documentElement;
    const update = () => {
      const sticky = window.getComputedStyle(header).position === 'sticky';
      root.style.setProperty('--sticky-header-h', `${sticky ? Math.ceil(header.getBoundingClientRect().height) : 0}px`);
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(header);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty('--sticky-header-h');
    };
  }, [headerRef]);
}

/**
 * Touch scrolling closes an untouched search field (like a native keyboardDismissMode): while it has focus, iPadOS
 * offsets the layout viewport and the sticky header slides under the status bar.
 */
function useBlurSearchOnScroll(searchInputRef, headerRef, typedRef) {
  useEffect(() => {
    const onTouchMove = (e) => {
      const input = searchInputRef.current;
      if (!input || document.activeElement !== input || typedRef.current) return;
      if (headerRef.current?.contains(e.target)) return;
      input.blur();
    };
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => window.removeEventListener('touchmove', onTouchMove);
  }, [searchInputRef, headerRef, typedRef]);
}

function useCoverPreconnect(active, pending) {
  const linkRef = useRef(null);
  useEffect(() => {
    const drop = () => {
      linkRef.current?.remove();
      linkRef.current = null;
    };
    if (!active) {
      drop();
      return;
    }
    if (!pending) return;
    const origin = getCoverOrigin();
    if (!origin) {
      drop();
      return;
    }
    if (!linkRef.current) {
      linkRef.current = document.createElement('link');
      linkRef.current.rel = 'preconnect';
    }
    linkRef.current.setAttribute('href', origin);
    if (!linkRef.current.isConnected) document.head.appendChild(linkRef.current);
  }, [active, pending]);
  useEffect(() => () => {
    linkRef.current?.remove();
    linkRef.current = null;
  }, []);
}

/** Top navbar with search, quick controls, action buttons and mobile drawer. Purely presentational: state and handlers via props. */
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
  handleOpenTool,
  handleOpenUsersModal,
  headingRef,
  isInstallable,
  isInstalledApp,
  isOfflineMode,
  isVisitor,
  mangas = [],
  todoCount = 0,
  mobileMenuOpen,
  onLogout,
  onLocalReplaced,
  onOpenSeries,
  radarData,
  search,
  searchInputRef,
  searchScope = null,
  setMobileMenuOpen,
  setSearch,
  setView,
  shoppingData,
  user
}) {
  const menuToggleRef = useRef(null);
  const headerRef = useRef(null);
  const searchTypedRef = useRef(false);
  useStickyHeaderHeight(headerRef);
  useBlurSearchOnScroll(searchInputRef, headerRef, searchTypedRef);
  // phones: quick toggles and menu button live in the bottom navigation, the menu opens as a bottom sheet
  const narrow = useIsNarrow();
  const isAdmin = user?.role === 'admin';
  // export for every logged-in user, import for editors; admins have it in the backup dialog
  const showCsvEntry = Boolean(user) && !isAdmin && !user.offline && Boolean(handleOpenCsvModal);
  const missingCount = shoppingData?.total_missing || 0;
  const releaseCount = radarData?.total_releases || 0;
  // the system page lives here so the admin menu needs no new prop; rendered into body (the header's backdrop filter
  // would anchor a fixed dialog)
  const [systemOpen, setSystemOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const accountRef = useRef(null);
  const accountButtonRef = useRef(null);
  // without a server: no users, snapshots or system page (adminSections); the backup entry exports/imports a ZIP on the device
  const local = isLocalMode();
  // the tools need the server; shelves are shared between accounts, so they mean nothing on the device alone (adminSections)
  const toolsAvailable = !isOfflineMode && !user?.offline;
  const [backupOpen, setBackupOpen] = useState(false);
  const openBackups = local ? () => setBackupOpen(true) : handleOpenRestoreModal;
  const logoutLabel = local ? t('Sammlung schließen') : t('Abmelden');
  const accountLabel = local ? t('Sprache, Privatsphäre und Dienste') : t('Sprache, Privatsphäre, Dienste und Konto');
  const showScope = Boolean(searchScope) && !user?.offline;
  const searchOnline = showScope && searchScope.scope === 'online';
  useCoverPreconnect(searchOnline, Boolean(searchScope?.pending));
  let searchPlaceholder = activeMainView === 'shelf' ? t(SEARCH_PLACEHOLDER) : t('In der Sammlung suchen...');
  if (searchOnline) searchPlaceholder = t('Sammlung und online suchen…');

  // a plain disclosure: a click or focus outside closes it; Escape closes it, hands focus back to the trigger and is
  // consumed (preventDefault), so the dashboard does not also clear the search
  useEffect(() => {
    if (!accountOpen) return undefined;
    const outside = (e) => accountRef.current && !accountRef.current.contains(e.target);
    const onDocClick = (e) => {
      if (outside(e)) setAccountOpen(false);
    };
    const onFocusIn = (e) => {
      if (outside(e)) setAccountOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setAccountOpen(false);
      accountButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDocClick);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocClick);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountOpen]);

  // an entry of the account menu: the menu closes, its button becomes the opener of the dialog the entry opens
  const fromAccountMenu = (action) => {
    accountButtonRef.current?.focus();
    setAccountOpen(false);
    action();
  };
  const adminEntries = adminSections({
    local,
    offline: Boolean(user?.offline),
    isAdmin,
    canEdit,
    toolsAvailable,
    onAccount: handleOpenPasswordModal,
    onUsers: handleOpenUsersModal,
    onShelves: () => handleOpenTool?.('shelves'),
    onBackups: openBackups,
    onCsv: showCsvEntry ? handleOpenCsvModal : null,
    onCleanup: () => handleOpenTool?.('cleanup'),
    onTrash: () => handleOpenTool?.('trash'),
    onPublishers: () => handleOpenTool?.('publishers'),
    onSystem: () => setSystemOpen(true),
    onInstall: isInstallable && !isInstalledApp ? handleInstallClick : null
  });

  // quick access: the search field opens a list of series and actions (Ctrl+K / Cmd+K focuses it)
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickIndex, setQuickIndex] = useState(-1);
  const quickActions = useMemo(() => {
    const list = [];
    if (canEdit) list.push({ id: 'add', label: t('Neuer Manga'), hint: t('Aktion'), run: handleOpenModal });
    list.push({ id: 'scan', label: t('Band scannen'), hint: t('Aktion'), run: () => document.getElementById('btn-header-scan')?.click() });
    list.push({ id: 'stats', label: t('Statistiken'), hint: t('Seite'), run: handleOpenStats });
    list.push({ id: 'view-shelf', label: t('Sammlung'), hint: t('Ansicht'), run: () => setView('shelf') });
    list.push({ id: 'view-shopping', label: t('Einkaufsliste'), hint: t('Ansicht'), run: () => setView('shopping') });
    list.push({ id: 'view-anime', label: t('Anime'), hint: t('Ansicht'), run: () => setView('anime') });
    list.push({ id: 'view-radar', label: t('Radar'), hint: t('Ansicht'), run: () => setView('radar') });
    if (todoCount > 0) {
      list.push({
        id: 'todo',
        label: t('Zu erledigen ({count})', { count: todoCount }),
        hint: t('Sammlung'),
        run: () => {
          setView('shelf');
          setTimeout(() => {
            const list = document.getElementById('todo-list');
            list?.scrollIntoView?.({ block: 'start' });
            list?.focus?.({ preventScroll: true });
          }, 0);
        }
      });
    }
    list.push({ id: 'admin', label: t('Verwaltung'), hint: t('Seite'), run: () => setAdminOpen(true) });
    for (const section of adminEntries) {
      for (const entry of section.entries) list.push({ id: entry.id, label: entry.label, hint: section.title, run: entry.run });
    }
    return list;
  }, [canEdit, handleOpenModal, handleOpenStats, setView, adminEntries, todoCount]);
  const quick = useMemo(
    () => (quickOpen ? quickAccessEntries({ query: search, mangas, recentIds: getRecentSeries(user?.id), actions: quickActions }) : { sections: [], items: [] }),
    [quickOpen, search, mangas, user?.id, quickActions]
  );
  const activeQuick = quickIndex >= 0 && quickIndex < quick.items.length ? quickIndex : -1;
  useEffect(() => { setQuickIndex(-1); }, [search, quickOpen]);

  const chooseQuick = (item) => {
    setQuickOpen(false);
    searchInputRef.current?.blur();
    if (search) setSearch('');
    if (item.kind === 'series') onOpenSeries?.(item.manga.id);
    else item.run?.();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'k') return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
      setQuickOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchInputRef]);

  // on phones the menu sits fixed above the bottom navigation, outside the header (its backdrop filter would anchor it)
  const sheet = (drawer) => (narrow
    ? createPortal(
      <>
        <div aria-hidden="true" className="fixed inset-0 z-30 bg-black/50" onClick={() => setMobileMenuOpen(false)} />
        {drawer}
      </>,
      document.body
    )
    : drawer);

  // the menu item that opens a dialog unmounts with the menu; the toggle then becomes the dialog's opener
  const runFromMenu = (action) => {
    menuToggleRef.current?.focus();
    setMobileMenuOpen(false);
    action();
  };

  return (
    <header ref={headerRef} data-sticky-header="" className="sticky short:static top-0 z-30 glass-panel border-b border-slate-800/80 mb-8 px-4 sm:px-6 lg:px-8 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
      <div className="max-w-[1720px] 2xl:max-w-[1840px] mx-auto flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-3 sm:gap-4 min-w-0">

        {/* Top Bar for Mobile & Tablet / Left item for Desktop */}
        <div className="flex items-center justify-between gap-3 w-full xl:w-auto shrink-0 min-w-0">
          {/* Logo & Title */}
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center shadow-lg shadow-brand-500/30 shrink-0">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                <h1 ref={headingRef} tabIndex={-1} className="focus:outline-none text-lg sm:text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent leading-tight truncate">
                  MangaShelf
                </h1>
                <span id="app-version-badge" className="min-w-0 truncate text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md bg-slate-800/80 text-slate-400 border border-slate-700/60 leading-none">{/* i18n-ignore: version number */}
                  v{APP_VERSION}
                </span>
              </div>
              {isAppMode() ? (
                <p className="text-[11px] sm:text-xs text-slate-400 flex items-center gap-1.5 mt-0.5 min-w-0">
                  <ConnectionPill />
                </p>
              ) : (
                <p className="text-[11px] sm:text-xs text-slate-400 flex items-center gap-1.5 mt-0.5 truncate">
                  <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${isOfflineMode ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400 animate-pulse'} inline-block shrink-0`}></span>
                  <span className="truncate">{isOfflineMode ? t('Offline-Modus') : t('Sammlung & Tracker')}</span>
                </p>
              )}
            </div>
          </div>

          {/* sm to xl: add and menu; the views are the tabs below the header (phones: the bottom navigation) */}
          {!narrow && (
          <div className="flex xl:hidden items-center gap-1 sm:gap-1.5 shrink-0">
            {canEdit && (
              <button 
                type="button"
                id="btn-header-add-manga"
                onClick={handleOpenModal}
                className="hit-44 hidden sm:flex btn-primary text-xs py-2 px-3 items-center gap-1.5 shadow-sm shrink-0"
                title={t('Neuen Manga anlegen')}
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>{t('Neuer Manga')}</span>
              </button>
            )}

            <button 
              id="btn-mobile-menu-toggle"
              ref={menuToggleRef}
              type="button"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="hit-44 btn-secondary p-1.5 sm:p-2 text-slate-300 hover:text-white shrink-0"
              title={mobileMenuOpen ? t('Menü schließen') : t('Menü öffnen')}
              aria-label={mobileMenuOpen ? t('Menü schließen') : t('Menü öffnen')}
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-menu-drawer"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" aria-hidden="true" /> : <Menu className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
          )}
        </div>

        {/* Search bar: Full width on < xl, Centered & spacious on >= xl */}
        <div 
          id="main-search-box"
          onClick={(e) => {
            // the scanner's button and its hidden file input must not raise the keyboard
            if (e.target instanceof Element && e.target.closest('button, input[type="file"]')) return;
            searchInputRef.current?.focus();
          }}
          className="relative flex items-center gap-2.5 bg-slate-950/80 border border-slate-700/80 hover:border-slate-600 rounded-xl px-3.5 w-full xl:flex-1 xl:max-w-xs 2xl:max-w-md xl:min-w-[150px] 2xl:min-w-[280px] focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all cursor-text shadow-inner"
        >
          <Search className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" aria-hidden="true" />
          <input 
            ref={searchInputRef}
            id="main-search-input"
            type="text" 
            role="combobox"
            aria-expanded={quickOpen}
            aria-controls={quickOpen ? QUICK_LISTBOX_ID : undefined}
            aria-autocomplete="list"
            aria-activedescendant={activeQuick >= 0 ? quickOptionId(activeQuick) : undefined}
            aria-keyshortcuts={QUICK_SHORTCUTS}
            aria-label={t('Sammlung durchsuchen')}
            placeholder={searchPlaceholder}
            className="w-full min-w-0 bg-transparent border-0 px-0 py-2.5 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm" 
            value={search} 
            onFocus={() => { searchTypedRef.current = false; setQuickOpen(true); }}
            onBlur={() => setQuickOpen(false)}
            onChange={e => {
              searchTypedRef.current = true;
              // the header search always searches the collection: typing on another view shows the shelf
              if (activeMainView !== 'shelf') setView('shelf');
              setSearch(e.target.value);
              searchScope?.onTyped(e.target.value);
            }} 
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!quickOpen) { setQuickOpen(true); return; }
                const n = quick.items.length;
                if (!n) return;
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setQuickIndex(activeQuick < 0 ? (step > 0 ? 0 : n - 1) : (activeQuick + step + n) % n);
                return;
              }
              if (e.key === 'Enter' && quickOpen && activeQuick >= 0) {
                e.preventDefault();
                chooseQuick(quick.items[activeQuick]);
                return;
              }
              if (e.key !== 'Enter' || !searchOnline) return;
              e.preventDefault();
              if (activeMainView !== 'shelf') setView('shelf');
              searchScope.submitOnline(e.currentTarget.value);
            }}
          />
          <div className="shrink-0 flex items-center gap-1">
            {!search && !quickOpen && (
              <kbd aria-hidden="true" className="hidden xl:inline-flex items-center px-1.5 py-0.5 rounded border border-slate-700 text-[10px] font-semibold text-slate-400 whitespace-nowrap">{t('Strg K')}</kbd>
            )}
            <BarcodeScannerButton compact id="btn-header-scan" onDetected={handleBarcodeDetected} className={HEADER_SCAN_CLASS} />
            {showScope && (
              <button
                id="btn-search-scope"
                type="button"
                onClick={() => searchScope.setScope(searchOnline ? 'collection' : 'online')}
                className={`hit-44 p-1 rounded shrink-0 transition-colors ${searchOnline ? 'text-sky-300 bg-sky-500/15 hover:bg-sky-500/25' : 'text-slate-400 hover:text-white hover:bg-slate-800'}`}
                aria-pressed={searchOnline}
                aria-label={t('Online mitsuchen')}
                title={searchOnline ? t('Sucht in der Sammlung und online') : t('Sucht nur in der Sammlung')}
              >
                <Globe className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
            {search && (
              <button 
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSearch('');
                  searchTypedRef.current = false;
                  searchInputRef.current?.focus();
                }}
                className="hit-44 text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 shrink-0 transition-colors"
                title={t('Suche zurücksetzen')}
                aria-label={t('Suche zurücksetzen')}
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>
          {quickOpen && (() => {
            const panel = (
              <QuickAccessPanel
                sections={quick.sections}
                activeIndex={activeQuick}
                onChoose={chooseQuick}
                onHover={setQuickIndex}
                onClose={() => searchInputRef.current?.blur()}
                narrow={narrow}
              />
            );
            // phones: full screen below the header, outside it (its backdrop filter would anchor a fixed panel)
            return narrow ? createPortal(panel, document.body) : panel;
          })()}
        </div>

        {/* Desktop actions (>= xl): add, statistics, install and the account menu; everything else is in "Verwaltung" */}
        <div className="hidden xl:flex items-center gap-1.5 2xl:gap-2 shrink-0 flex-nowrap justify-end min-w-0">
          {canEdit && (
            <button
              id="btn-open-add-manga"
              type="button"
              onClick={handleOpenModal}
              className="btn-primary flex items-center gap-1.5 text-xs shadow-md py-2 px-2.5 2xl:px-3 whitespace-nowrap"
            >
              <Plus className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{t('Neuer Manga')}</span>
            </button>
          )}

          <button
            id="btn-open-stats"
            type="button"
            onClick={handleOpenStats}
            disabled={isOfflineMode}
            className="btn-secondary flex items-center gap-1.5 text-xs text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10 shadow-sm py-2 px-2.5 2xl:px-3 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
            title={isOfflineMode ? t('Offline nicht verfügbar') : t('Statistik- & Finanz-Dashboard öffnen')}
          >
            <ChartColumn className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
            <span>{t('Statistiken')}</span>
          </button>

          {isInstallable && !isInstalledApp && (
            <button
              id="btn-install-pwa"
              type="button"
              onClick={handleInstallClick}
              className="btn-secondary flex items-center gap-1.5 text-xs text-brand-300 hover:text-white border-brand-500/40 bg-brand-500/10 hover:bg-brand-500/20 py-2 px-2.5 2xl:px-3 shadow-sm transition-all whitespace-nowrap"
              title={t('Manga Shelf als native App auf deinem Gerät installieren')}
              aria-label={t('App installieren')}
            >
              <Download className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" />
            </button>
          )}

          <div ref={accountRef} className="relative">
            <button
              id="btn-account-menu"
              ref={accountButtonRef}
              type="button"
              onClick={() => setAccountOpen((prev) => !prev)}
              aria-expanded={accountOpen}
              aria-controls={accountOpen ? 'account-menu' : undefined}
              aria-label={t('Konto-Menü von {name}', { name: user?.username || '' })}
              title={t('Konto-Menü')}
              className="flex items-center gap-1.5 rounded-xl border border-slate-700/60 bg-slate-800/60 hover:border-brand-500/60 pl-1 pr-2 py-1 shrink-0"
            >
              <span aria-hidden="true" className="w-7 h-7 rounded-full bg-brand-500/25 border border-brand-400/60 text-brand-200 text-xs font-bold flex items-center justify-center uppercase">{(user?.username || '?').slice(0, 1)}</span>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${accountOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            {accountOpen && (
              <div id="account-menu" className="absolute right-0 mt-2 w-72 glass-panel border border-slate-700/80 rounded-2xl shadow-2xl p-2 z-50 animate-fade-in">
                <div className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs">
                  <span className="text-slate-400 truncate">{t('Angemeldet als:')} <span className="font-semibold text-slate-100">{user?.username}</span></span>
                  <span className={`${roleBadgeClass(user)} border text-[10px] px-1.5 py-px rounded font-mono font-bold uppercase shrink-0`}>{roleLabel(user)}</span>
                </div>
                <button id="btn-open-admin" type="button" onClick={() => fromAccountMenu(() => setAdminOpen(true))} className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm text-slate-100 hover:bg-slate-800/80">
                  <ShieldCheck className="w-4 h-4 text-brand-300" aria-hidden="true" /> {t('Verwaltung')}
                </button>
                {!user?.offline && (
                  <button id="btn-change-password" type="button" onClick={() => fromAccountMenu(handleOpenPasswordModal)} className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm text-slate-100 hover:bg-slate-800/80" title={accountLabel}>
                    <Settings className="w-4 h-4 text-brand-300" aria-hidden="true" /> {t('Einstellungen')}
                  </button>
                )}
                <div aria-hidden="true" className="my-1 border-t border-slate-800" />
                <button id="btn-logout" type="button" onClick={() => fromAccountMenu(onLogout)} className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm text-red-300 hover:bg-red-950/40">
                  <LogOut className="w-4 h-4 text-red-400" aria-hidden="true" /> {logoutLabel}
                </button>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Dropdown Menu Drawer for < xl (a bottom sheet above the bottom navigation on phones) */}
      {mobileMenuOpen && sheet(
        <nav
          id="mobile-menu-drawer"
          aria-label={t('Menü')}
          className={narrow
            ? 'fixed inset-x-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-slate-700/80 bg-slate-950/[0.98] p-4 space-y-2 animate-fade-in shadow-2xl'
            : 'xl:hidden mt-3 pt-3 border-t border-slate-800/80 space-y-2 animate-fade-in max-w-[1720px] 2xl:max-w-[1840px] mx-auto'}
          style={narrow ? { bottom: 'calc(3.5rem + env(safe-area-inset-bottom))' } : undefined}
        >
          <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">{t('Angemeldet als:')}</span>
              <span className="font-bold text-white">{user?.username}</span>
            </div>
            <span className={`${roleBadgeClass(user)} border text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold`}>
              {roleLabel(user)}
            </span>
          </div>

          <button
            id="btn-mobile-menu-anime"
            type="button"
            onClick={() => {
              setMobileMenuOpen(false);
              setView('anime');
            }}
            className="w-full btn-secondary text-sm py-3 px-3 flex items-center justify-center gap-2 text-fuchsia-100 border-fuchsia-500/40 bg-fuchsia-500/10"
          >
            <Tv className="w-5 h-5 text-fuchsia-400" aria-hidden="true" /> {t('Anime')}
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button
              id="btn-mobile-menu-stats"
              type="button"
              onClick={() => runFromMenu(handleOpenStats)}
              disabled={isOfflineMode}
              className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-emerald-300 border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChartColumn className="w-4 h-4 text-emerald-400" aria-hidden="true" /> {t('Statistiken')}
            </button>

            {canEdit ? (
              <button
                id="btn-mobile-menu-add"
                type="button"
                onClick={() => runFromMenu(handleOpenModal)}
                className="btn-primary text-xs py-2 px-3 flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" aria-hidden="true" /> {t('Neuer Manga')}
              </button>
            ) : (
              <button
                id="btn-mobile-menu-radar"
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setView('radar');
                }}
                className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-sky-300 border-sky-500/30"
              >
                <Calendar className="w-4 h-4 text-sky-400" aria-hidden="true" /> {t('Radar')}
              </button>
            )}
          </div>

          <button
            id="btn-mobile-menu-admin"
            type="button"
            onClick={() => runFromMenu(() => setAdminOpen(true))}
            className="w-full btn-secondary text-xs py-2 text-slate-200 flex items-center justify-center gap-2"
          >
            <ShieldCheck className="w-4 h-4 text-brand-400" aria-hidden="true" /> {t('Verwaltung')}
          </button>

          {!user?.offline && (
            <button
              id="btn-mobile-menu-password"
              type="button"
              onClick={() => runFromMenu(handleOpenPasswordModal)}
              className="w-full btn-secondary text-xs py-2 text-slate-200 flex items-center justify-center gap-2"
            >
              <Settings className="w-4 h-4 text-brand-400" /> {t('Einstellungen')}
            </button>
          )}

          <button 
            id="btn-mobile-menu-logout"
            type="button"
            onClick={onLogout} 
            className="w-full btn-secondary text-xs py-2 text-red-300 hover:bg-red-950/40 border-red-900/40 flex items-center justify-center gap-2"
          >
            <LogOut className="w-4 h-4 text-red-400" /> {logoutLabel}
          </button>
        </nav>
      )}
      {adminOpen && createPortal(
        <Suspense fallback={null}>
          <AdminCenter sections={adminEntries} onClose={() => setAdminOpen(false)} />
        </Suspense>,
        document.body
      )}
      {systemOpen && createPortal(
        <Suspense fallback={null}>
          <SystemModal isOpen onClose={() => setSystemOpen(false)} />
        </Suspense>,
        document.body
      )}
      {backupOpen && createPortal(
        <Suspense fallback={null}>
          <LocalBackupDialog onClose={() => setBackupOpen(false)} onLocalReplaced={onLocalReplaced} />
        </Suspense>,
        document.body
      )}
      <BottomNav
        narrow={narrow}
        activeMainView={activeMainView}
        setView={setView}
        missingCount={missingCount}
        releaseCount={releaseCount}
        onScan={handleBarcodeDetected}
        mobileMenuOpen={mobileMenuOpen}
        setMobileMenuOpen={setMobileMenuOpen}
        menuToggleRef={menuToggleRef}
      />
    </header>
  );
}
