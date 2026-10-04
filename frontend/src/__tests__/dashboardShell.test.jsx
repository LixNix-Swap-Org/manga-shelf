import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';
import {
  APP_VERSION, parseInitialView, viewSearch, nextQuickView, formatBadgeCount, roleLabel, scanDashboardAction,
  SCAN_FAILED_MESSAGE
} from '../components/dashboard/dashboardShell';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import DashboardFooter from '../components/dashboard/DashboardFooter';
import MangaCollectionGrid, { visibleSections } from '../components/dashboard/MangaCollectionGrid';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';
import MainViewSwitcher from '../components/dashboard/MainViewSwitcher';
import { SORT_OPTIONS, getStatusBadge } from '../utils/collectionHelpers';

describe('view parameter', () => {
  it('maps ?view= to a main view or the statistics dialog', () => {
    expect(parseInitialView('?view=shopping')).toEqual({ mainView: 'shopping', openStats: false });
    expect(parseInitialView('?view=radar')).toEqual({ mainView: 'radar', openStats: false });
    expect(parseInitialView('?view=stats')).toEqual({ mainView: 'shelf', openStats: true });
    expect(parseInitialView('?view=nonsense')).toEqual({ mainView: 'shelf', openStats: false });
    expect(parseInitialView('')).toEqual({ mainView: 'shelf', openStats: false });
  });

  it('writes ?view= for shopping and radar and drops it for the shelf, keeping other parameters', () => {
    expect(viewSearch('', 'shopping')).toBe('?view=shopping');
    expect(viewSearch('?view=shopping', 'radar')).toBe('?view=radar');
    expect(viewSearch('?view=radar', 'shelf')).toBe('');
    expect(viewSearch('?view=stats&x=1', 'shelf')).toBe('?x=1');
  });

  it('knows the anime tab; ?add= never survives a view change, the shelf filters do', () => {
    expect(parseInitialView('?view=anime&add=4')).toEqual({ mainView: 'anime', openStats: false });
    expect(viewSearch('?view=anime&add=4', 'anime')).toBe('?view=anime');
    expect(viewSearch('?view=anime&add=4', 'shelf')).toBe('');
    expect(viewSearch('?collect=gaps&author=Oda', 'anime')).toBe('?collect=gaps&author=Oda&view=anime');
    expect(viewSearch('?collect=gaps&view=radar', 'shelf')).toBe('?collect=gaps');
  });

  it('every manifest shortcut points at a view the dashboard handles', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../public/manifest.json'), 'utf8'));
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
    for (const shortcut of manifest.shortcuts) {
      const search = new URL(shortcut.url, 'https://example.test').search;
      const view = new URLSearchParams(search).get('view');
      const parsed = parseInitialView(search);
      const handled = parsed.openStats || (parsed.mainView === view && view !== 'shelf');
      expect(handled, shortcut.url).toBe(true);
    }
  });

  it('quick toggles: the active view goes back to the shelf, any other view opens the target', () => {
    for (const current of ['shelf', 'shopping', 'radar']) {
      for (const target of ['shopping', 'radar']) {
        expect(nextQuickView(current, target)).toBe(current === target ? 'shelf' : target);
      }
    }
  });
});

describe('small formatters', () => {
  it('caps badge counts at 99+', () => {
    expect(formatBadgeCount(0)).toBe('0');
    expect(formatBadgeCount(5)).toBe('5');
    expect(formatBadgeCount(99)).toBe('99');
    expect(formatBadgeCount(100)).toBe('99+');
    expect(formatBadgeCount(1234)).toBe('99+');
    expect(formatBadgeCount(undefined)).toBe('0');
    expect(formatBadgeCount(null)).toBe('0');
  });

  it('shows German role names and Offline in offline mode', () => {
    expect(roleLabel({ role: 'admin' })).toBe('Admin');
    expect(roleLabel({ role: 'editor' })).toBe('Editor');
    expect(roleLabel({ role: 'visitor' })).toBe('Gast');
    expect(roleLabel({ role: 'guest' })).toBe('Gast');
    expect(roleLabel({ role: 'visitor', realRole: 'admin', offline: true })).toBe('Offline');
    expect(roleLabel(null)).toBe('');
  });

  it('has one version string, never a stale hard-coded number', () => {
    expect(APP_VERSION).toBeTruthy();
    for (const file of ['DashboardHeader.jsx', 'DashboardFooter.jsx']) {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, '../components/dashboard', file), 'utf8');
      expect(source, file).not.toMatch(/__APP_VERSION__/);
      expect(source, file).not.toMatch(/'\d+\.\d+\.\d+'/);
    }
  });
});

describe('scanDashboardAction', () => {
  const book = { title: 'Die Prophezeiung', series: 'Naruto' };

  it('opens the matched series', () => {
    const manga = { id: 3, title: 'Naruto' };
    expect(scanDashboardAction({ ok: true, data: { found: true, book, matched_manga: manga }, canEdit: false })).toEqual({ type: 'navigate', manga });
  });

  it('lets the user choose between near-tied candidates instead of searching for the volume title', () => {
    const candidates = [{ id: 1, title: 'Naruto Gaiden' }, { id: 2, title: 'Naruto Shippuden' }];
    const action = scanDashboardAction({ ok: true, data: { found: true, book, matched_manga: null, matched_candidates: candidates }, canEdit: true });
    expect(action.type).toBe('choose');
    expect(action.candidates).toEqual(candidates);
  });

  it('opens a single candidate directly', () => {
    const only = { id: 7, title: 'Kaguya-sama: Love is War' };
    const action = scanDashboardAction({ ok: true, data: { found: true, book: { title: 'Mein kleiner Bruder!' }, matched_candidates: [only] }, canEdit: false });
    expect(action).toEqual({ type: 'navigate', manga: only });
  });

  it('prefills the add dialog for editors and names the series for read-only users', () => {
    const data = { found: true, book };
    expect(scanDashboardAction({ ok: true, data, canEdit: true })).toEqual({ type: 'prefill', book });
    expect(scanDashboardAction({ ok: true, data, canEdit: false })).toEqual({ type: 'notice', message: 'Nicht in der Sammlung: Naruto' });
  });

  it('reports an unknown ISBN with the server message', () => {
    const data = { found: false, message: 'Keine Metadaten für diese ISBN gefunden.' };
    expect(scanDashboardAction({ ok: true, data, canEdit: true })).toEqual({ type: 'notFound', message: data.message, canAdd: true });
    expect(scanDashboardAction({ ok: true, data, canEdit: false }).canAdd).toBe(false);
  });

  it('turns error answers and HTML gateway pages into a readable message', () => {
    expect(scanDashboardAction({ ok: false, data: { error: 'Ungültige ISBN (Prüfziffer)' } })).toEqual({ type: 'error', message: 'Ungültige ISBN (Prüfziffer)' });
    expect(scanDashboardAction({ ok: false, data: null })).toEqual({ type: 'error', message: SCAN_FAILED_MESSAGE });
  });
});

const headerProps = (overrides = {}) => ({
  activeMainView: 'shelf',
  canEdit: false,
  handleBarcodeDetected: vi.fn(),
  handleInstallClick: vi.fn(),
  handleOpenCsvModal: vi.fn(),
  handleOpenModal: vi.fn(),
  handleOpenPasswordModal: vi.fn(),
  handleOpenRestoreModal: vi.fn(),
  handleOpenStats: vi.fn(),
  handleOpenUsersModal: vi.fn(),
  isInstallable: false,
  isInstalledApp: false,
  isOfflineMode: false,
  isVisitor: false,
  mobileMenuOpen: false,
  onLogout: vi.fn(),
  radarData: null,
  search: '',
  searchInputRef: { current: null },
  setMobileMenuOpen: vi.fn(),
  setSearch: vi.fn(),
  setView: vi.fn(),
  shoppingData: null,
  user: { id: 1, username: 'anna', role: 'editor' },
  ...overrides
});

const renderHeader = (overrides) => {
  const props = headerProps(overrides);
  const utils = render(<DashboardHeader {...props} />);
  return { ...utils, props };
};

describe('DashboardHeader', () => {
  it('offers CSV to editors and visitors on desktop and in the menu, backups stay admin-only', () => {
    const { rerender, props } = renderHeader({ canEdit: true, mobileMenuOpen: true });
    expect(document.getElementById('btn-open-csv')).toBeTruthy();
    expect(document.getElementById('btn-mobile-menu-csv')).toBeTruthy();
    expect(document.getElementById('btn-open-backups')).toBeNull();
    fireEvent.click(document.getElementById('btn-mobile-menu-csv'));
    expect(props.handleOpenCsvModal).toHaveBeenCalledTimes(1);

    rerender(<DashboardHeader {...headerProps({ user: { id: 2, username: 'gast', role: 'visitor' }, isVisitor: true, mobileMenuOpen: true })} />);
    expect(document.getElementById('btn-open-csv')).toBeTruthy();

    rerender(<DashboardHeader {...headerProps({ user: { id: 3, username: 'root', role: 'admin' }, canEdit: true, mobileMenuOpen: true })} />);
    expect(document.getElementById('btn-open-csv')).toBeNull();
    expect(document.getElementById('btn-open-backups')).toBeTruthy();
    expect(document.getElementById('btn-mobile-menu-backups')).toBeTruthy();

    rerender(<DashboardHeader {...headerProps({ user: { id: 1, username: 'anna', role: 'visitor', realRole: 'editor', offline: true }, isVisitor: true, isOfflineMode: true })} />);
    expect(document.getElementById('btn-open-csv')).toBeNull();
  });

  it('the cart button opens the shopping list from the radar and goes back to the shelf from the shopping list', () => {
    const { props, rerender } = renderHeader({ activeMainView: 'radar' });
    fireEvent.click(document.getElementById('btn-mobile-shopping'));
    expect(props.setView).toHaveBeenLastCalledWith('shopping');

    rerender(<DashboardHeader {...props} activeMainView="shopping" />);
    fireEvent.click(document.getElementById('btn-mobile-shopping'));
    expect(props.setView).toHaveBeenLastCalledWith('shelf');
  });

  it('the radar entries go through setView', () => {
    const { props } = renderHeader({ mobileMenuOpen: true });
    fireEvent.click(document.getElementById('btn-mobile-radar'));
    expect(props.setView).toHaveBeenLastCalledWith('radar');
    fireEvent.click(document.getElementById('btn-mobile-menu-radar'));
    expect(props.setView).toHaveBeenLastCalledWith('radar');
    expect(props.setMobileMenuOpen).toHaveBeenCalledWith(false);
  });

  it('caps the quick badges and keeps the full number in the accessible name', () => {
    renderHeader({ shoppingData: { total_missing: 120 }, radarData: { total_releases: 7 } });
    const cart = document.getElementById('btn-mobile-shopping');
    expect(cart.textContent).toContain('99+');
    expect(cart.getAttribute('aria-label')).toContain('120');
    const badge = within(cart).getByText('99+');
    expect(badge.className).toContain('min-w-4');
    expect(badge.className).not.toMatch(/(^|\s)w-4(\s|$)/);
  });

  it('names the search field and reports the menu state', () => {
    const { rerender, props } = renderHeader();
    expect(screen.getByRole('textbox', { name: 'Sammlung durchsuchen' })).toBeTruthy();
    const toggle = document.getElementById('btn-mobile-menu-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Menü öffnen');
    rerender(<DashboardHeader {...props} mobileMenuOpen />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Menü schließen');
    expect(document.getElementById(toggle.getAttribute('aria-controls'))).toBeTruthy();
    expect(screen.getByRole('button', { name: /Einkaufsliste/, pressed: false })).toBeTruthy();
  });

  it('the scanner button does not focus the search field, the empty area of the box does', () => {
    const searchInputRef = { current: null };
    renderHeader({ searchInputRef });
    const input = document.getElementById('main-search-input');
    const scanner = input.parentElement.querySelector('button');
    const fileInput = input.parentElement.querySelector('input[type="file"]');
    fileInput.click = vi.fn();
    fireEvent.click(scanner);
    expect(document.activeElement).not.toBe(input);
    fireEvent.click(fileInput);
    expect(document.activeElement).not.toBe(input);
    fireEvent.click(input.parentElement);
    expect(document.activeElement).toBe(input);
  });

  it('typing in the header search on another view shows the shelf', () => {
    const { props } = renderHeader({ activeMainView: 'shopping' });
    fireEvent.change(document.getElementById('main-search-input'), { target: { value: 'Berserk' } });
    expect(props.setView).toHaveBeenCalledWith('shelf');
    expect(props.setSearch).toHaveBeenCalledWith('Berserk');
  });

  it('shows German role labels in both header variants', () => {
    const { rerender } = renderHeader({ user: { id: 2, username: 'gast', role: 'visitor' }, isVisitor: true, mobileMenuOpen: true });
    expect(screen.getAllByText('Gast')).toHaveLength(2);
    expect(screen.queryByText('visitor')).toBeNull();
    expect(screen.queryByText('User:')).toBeNull();
    rerender(<DashboardHeader {...headerProps({ user: { id: 2, username: 'gast', role: 'visitor', realRole: 'editor', offline: true }, isVisitor: true, isOfflineMode: true, mobileMenuOpen: true })} />);
    expect(screen.getAllByText('Offline')).toHaveLength(2);
  });

  it('a menu item that opens a dialog hands focus to the menu toggle first', () => {
    const { props } = renderHeader({ mobileMenuOpen: true });
    let focusedWhenOpened = null;
    props.handleOpenStats.mockImplementation(() => { focusedWhenOpened = document.activeElement; });
    fireEvent.click(document.getElementById('btn-mobile-menu-stats'));
    expect(focusedWhenOpened).toBe(document.getElementById('btn-mobile-menu-toggle'));
  });
});

describe('DashboardFooter', () => {
  const base = { user: { id: 1, role: 'editor' }, isOfflineMode: false, networkOffline: false, refreshingCopy: false, handleRefreshOfflineCopy: vi.fn() };

  it('offers to create the first offline copy and shows refresh errors and pending purchases', () => {
    render(<DashboardFooter {...base} offlineCopyAt={null} refreshError="Aktualisierung fehlgeschlagen" pendingPurchases={2} />);
    expect(screen.getByRole('button', { name: /Offline-Kopie erstellen/ })).toBeTruthy();
    expect(screen.getByText('Aktualisierung fehlgeschlagen')).toBeTruthy();
    expect(screen.getByText(/Ausstehend: 2 Käufe/)).toBeTruthy();
    expect(screen.getByText(`v${APP_VERSION}`)).toBeTruthy();
  });

  it('says that offline start and installation need HTTPS on plain HTTP', () => {
    vi.stubGlobal('isSecureContext', false);
    render(<DashboardFooter {...base} offlineCopyAt={null} />);
    expect(screen.getByText('Offline-Start und App-Installation nur über HTTPS')).toBeTruthy();
  });

  it('hides the refresh button in offline mode', () => {
    render(<DashboardFooter {...base} user={{ id: 1, role: 'visitor', offline: true }} isOfflineMode offlineCopyAt={Date.now()} />);
    expect(screen.queryByRole('button', { name: /Offline-Kopie/ })).toBeNull();
  });
});

const series = (id, extra = {}) => ({
  id, title: `Reihe ${id}`, status: 'Laufend', owned_volumes: 4, regular_owned: 4, total_volumes: 10, read_volume_count: 2, ...extra
});

const gridProps = (overrides = {}) => ({
  canEdit: true,
  error: null,
  filtered: [series(1)],
  getStatusBadge,
  handleDeleteManga: vi.fn(),
  handleOpenModal: vi.fn(),
  isOffline: false,
  loading: false,
  onRetry: vi.fn(),
  publisherFilter: 'ALL',
  search: '',
  setPublisherFilter: vi.fn(),
  setSearch: vi.fn(),
  setStatusFilter: vi.fn(),
  statusFilter: 'ALL',
  viewMode: 'grid',
  ...overrides
});

const renderGrid = (overrides) => {
  const props = gridProps(overrides);
  const utils = render(<MemoryRouter><MangaCollectionGrid {...props} /></MemoryRouter>);
  return { ...utils, props };
};

describe('MangaCollectionGrid', () => {
  it('is memoised', () => {
    expect(MangaCollectionGrid.$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('the grid delete button is named, keyboard visible, away from the count badge and calls the delete handler', () => {
    const { props } = renderGrid();
    const button = screen.getByRole('button', { name: 'Reihe 1 löschen' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('focus-visible:opacity-100');
    expect(button.className).toContain('group-focus-within:opacity-100');
    expect(button.className).toContain('[@media(hover:hover)]:pointer-events-none');
    expect(button.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(button.className).not.toMatch(/(^|\s)right-2\.5(\s|$)/);
    fireEvent.click(button);
    expect(props.handleDeleteManga).toHaveBeenCalledWith(expect.anything(), 1, 'Reihe 1');
  });

  it('has no delete buttons for read-only users', () => {
    renderGrid({ canEdit: false });
    expect(screen.queryByRole('button', { name: /löschen/ })).toBeNull();
  });

  it('read-only users get no add button in the empty state', () => {
    renderGrid({ canEdit: false, filtered: [] });
    expect(screen.queryByText(/Ersten Manga anlegen/)).toBeNull();
    expect(screen.getByText('Noch keine Reihen vorhanden')).toBeTruthy();
  });

  it('editors get the add button in the empty state', () => {
    const { props } = renderGrid({ filtered: [] });
    fireEvent.click(screen.getByRole('button', { name: /Ersten Manga anlegen/ }));
    expect(props.handleOpenModal).toHaveBeenCalledTimes(1);
  });

  it('offline without a copy says so instead of inviting to add', () => {
    renderGrid({ filtered: [], isOffline: true, canEdit: false });
    expect(screen.getByText('Keine Offline-Kopie vorhanden')).toBeTruthy();
    expect(screen.queryByText(/Ersten Manga anlegen/)).toBeNull();
  });

  it('a failed load shows a retry panel, not an empty collection', () => {
    const { props } = renderGrid({ filtered: [], error: 'Server nicht erreichbar – Sammlung konnte nicht geladen werden.' });
    expect(screen.queryByText('Deine Sammlung ist noch leer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('a failed refresh keeps the list and shows a banner', () => {
    renderGrid({ error: 'Server nicht erreichbar – angezeigt wird der zuletzt geladene Stand.' });
    expect(screen.getByRole('alert').textContent).toContain('zuletzt geladene Stand');
    expect(screen.getByText('Reihe 1')).toBeTruthy();
  });

  it('clamps the read percentage and counts only owned volumes', () => {
    renderGrid({ viewMode: 'list', filtered: [series(1, { owned_volumes: 2, regular_owned: 2, read_volume_count: 5 })] });
    expect(screen.getByText(/2 gelesen • 100%/)).toBeTruthy();
  });

  it('a broken cover only swaps its own card to the placeholder', () => {
    renderGrid({ filtered: [series(1, { cover_image: '/uploads/a.jpg' }), series(2, { cover_image: '/uploads/b.jpg' })] });
    const images = document.querySelectorAll('img');
    expect(images).toHaveLength(2);
    fireEvent.error(images[0]);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(screen.getAllByText('Kein Cover')).toHaveLength(1);
  });
});

describe('MangaCollectionGrid: groups', () => {
  const groups = [
    { key: 'a', label: 'Carlsen Manga', items: [series(1), series(2)] },
    { key: '~', label: 'Ohne Verlag', items: [series(3)] }
  ];

  it('visibleSections cuts the groups to the rendered part and keeps the full counts', () => {
    expect(visibleSections(groups, 2)).toEqual([{ key: 'a', label: 'Carlsen Manga', count: 2, items: [series(1), series(2)] }]);
    expect(visibleSections(groups, 3).map(s => [s.label, s.items.length, s.count])).toEqual([['Carlsen Manga', 2, 2], ['Ohne Verlag', 1, 1]]);
    expect(visibleSections([{ key: 'all', label: '', items: [series(1)] }], 1)).toEqual([]);
    expect(visibleSections(null, 5)).toEqual([]);
  });

  it('grid and list show a heading with the count per section', () => {
    const filtered = groups.flatMap(g => g.items);
    const { unmount } = renderGrid({ filtered, groups, groupBy: 'publisher' });
    expect(screen.getByRole('region', { name: /Carlsen Manga/ }).textContent).toContain('2 Reihen');
    expect(screen.getByRole('region', { name: /Ohne Verlag/ }).textContent).toContain('Reihe 3');
    unmount();
    renderGrid({ filtered, groups, groupBy: 'publisher', viewMode: 'list' });
    const headers = screen.getAllByRole('columnheader').filter(th => th.getAttribute('scope') === 'colgroup');
    expect(headers.map(th => th.textContent)).toEqual(['Carlsen Manga2 Reihen', 'Ohne Verlag1 Reihe']);
  });

  it('the empty state resets the collect and author filters too', () => {
    const { props } = renderGrid({ filtered: [], collectFilter: 'gaps', setCollectFilter: vi.fn(), authorFilter: 'Oda', setAuthorFilter: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /Filter & Suche zurücksetzen/ }));
    expect(props.setCollectFilter).toHaveBeenCalledWith('ALL');
    expect(props.setAuthorFilter).toHaveBeenCalledWith('');
  });
});

describe('MangaCollectionGrid: author links', () => {
  const twoAuthors = series(1, { author: 'Tsugumi Ohba, Takeshi Obata' });

  it('grid cards put one button per author below the card link, not inside it', () => {
    const onAuthorClick = vi.fn();
    renderGrid({ filtered: [twoAuthors], onAuthorClick });
    const link = screen.getByRole('link', { name: 'Reihe 1' });
    const ohba = screen.getByRole('button', { name: 'Tsugumi Ohba' });
    const obata = screen.getByRole('button', { name: 'Takeshi Obata' });
    expect(ohba.title).toBe('Alle Reihen von Tsugumi Ohba');
    expect(link.contains(ohba)).toBe(false);
    expect(link.querySelector('button')).toBeNull();
    expect(link.textContent).not.toContain('Ohba');
    fireEvent.click(obata);
    expect(onAuthorClick).toHaveBeenCalledWith('Takeshi Obata');
  });

  it('list rows render each author as a button', () => {
    const onAuthorClick = vi.fn();
    renderGrid({ filtered: [twoAuthors], onAuthorClick, viewMode: 'list' });
    const button = screen.getByRole('button', { name: 'Tsugumi Ohba' });
    expect(button.title).toBe('Alle Reihen von Tsugumi Ohba');
    expect(button.closest('a')).toBeNull();
    fireEvent.click(button);
    expect(onAuthorClick).toHaveBeenCalledWith('Tsugumi Ohba');
  });

  it('without the handler or an author the text stays plain', () => {
    const { unmount } = renderGrid({ filtered: [twoAuthors] });
    expect(screen.queryByRole('button', { name: 'Tsugumi Ohba' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Reihe 1' }).textContent).toContain('Tsugumi Ohba, Takeshi Obata');
    unmount();
    renderGrid({ filtered: [series(2, { author: '' })], onAuthorClick: vi.fn(), viewMode: 'list' });
    expect(screen.getByText('Kein Autor')).toBeTruthy();
  });
});

describe('CollectionToolbar', () => {
  const toolbarProps = {
    availablePublishers: ['Carlsen'], filterCounts: { ALL: 3, Laufend: 2 }, filtered: [], publisherFilter: 'ALL', search: '',
    setPublisherFilter: vi.fn(), setSearch: vi.fn(), setSortBy: vi.fn(), setStatusFilter: vi.fn(), setViewMode: vi.fn(),
    sortBy: 'title_asc', statusFilter: 'ALL', viewMode: 'grid'
  };

  it('renders the given status tabs with their pressed state', () => {
    render(<CollectionToolbar {...toolbarProps} statusTabs={[{ id: 'ALL', label: 'Alle', count: 3 }, { id: 'Abgebrochen', label: 'Abgebrochen', count: 1 }]} />);
    expect(screen.getByRole('button', { name: /Alle/, pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Abgebrochen/, pressed: false })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Status-Filter' })).toBeTruthy();
  });

  it('offers every sort option and names the selects and view toggles', () => {
    render(<CollectionToolbar {...toolbarProps} />);
    const sort = screen.getByRole('combobox', { name: 'Sortierung' });
    expect(Array.from(sort.options).map((o) => o.value)).toEqual(SORT_OPTIONS.map((o) => o.value));
    expect(screen.getByRole('combobox', { name: 'Verlag filtern' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rasteransicht', pressed: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Listenansicht', pressed: false })).toBeTruthy();
  });
});

describe('CollectionToolbar: collect, grouping and author', () => {
  const props = () => ({
    availablePublishers: [], filterCounts: { ALL: 3 }, filtered: [], publisherFilter: 'ALL', search: '',
    setPublisherFilter: vi.fn(), setSearch: vi.fn(), setSortBy: vi.fn(), setStatusFilter: vi.fn(), setViewMode: vi.fn(),
    sortBy: 'title_asc', statusFilter: 'ALL', viewMode: 'grid', collectFilter: 'ALL', setCollectFilter: vi.fn(),
    collectCounts: { ALL: 3, gaps: 2, preorder: 0, complete: 1, pausiert: 0, abgebrochen: 0 }, authorFilter: '',
    setAuthorFilter: vi.fn(), groupBy: 'none', setGroupBy: vi.fn()
  });

  it('the collect select lists its options with counts; grouping offers none, publisher, author, status', () => {
    const p = props();
    render(<CollectionToolbar {...p} />);
    const collect = screen.getByRole('combobox', { name: 'Sammelstand filtern' });
    expect(Array.from(collect.options).map(o => o.textContent)).toEqual([
      'Alle Reihen', 'Mit Lücken (2)', 'Mit Vorbestellungen (0)', 'Komplett (1)', 'Pausiert (0)', 'Nicht mehr gesammelt (0)'
    ]);
    fireEvent.change(collect, { target: { value: 'gaps' } });
    expect(p.setCollectFilter).toHaveBeenCalledWith('gaps');
    const group = screen.getByRole('combobox', { name: 'Gruppieren' });
    expect(Array.from(group.options).map(o => o.value)).toEqual(['none', 'publisher', 'author', 'status']);
    fireEvent.change(group, { target: { value: 'author' } });
    expect(p.setGroupBy).toHaveBeenCalledWith('author');
    expect(screen.queryByRole('button', { name: /Autor-Filter/ })).toBeNull();
  });

  it('an author filter shows a chip that clears it; reset clears collect and author as well', () => {
    const p = { ...props(), authorFilter: 'Eiichiro Oda', collectFilter: 'gaps' };
    render(<CollectionToolbar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Autor-Filter „Eiichiro Oda“ entfernen' }));
    expect(p.setAuthorFilter).toHaveBeenCalledWith('');
    fireEvent.click(screen.getByRole('button', { name: 'Filter und Suche zurücksetzen' }));
    expect(p.setCollectFilter).toHaveBeenCalledWith('ALL');
    expect(p.setAuthorFilter).toHaveBeenCalledTimes(2);
  });
});

describe('MainViewSwitcher', () => {
  it('marks the active view and switches through onSelectView', () => {
    const onSelectView = vi.fn();
    render(<MainViewSwitcher activeMainView="shopping" onSelectView={onSelectView} mangaCount={4} shoppingData={null} radarData={null} />);
    expect(document.getElementById('btn-nav-shopping').getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('btn-nav-shelf').getAttribute('aria-current')).toBeNull();
    fireEvent.click(document.getElementById('btn-nav-radar'));
    expect(onSelectView).toHaveBeenCalledWith('radar');
    fireEvent.click(document.getElementById('btn-nav-shelf'));
    expect(onSelectView).toHaveBeenCalledWith('shelf');
  });
});
