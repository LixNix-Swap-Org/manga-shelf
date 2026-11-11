// Quick access: the header search opens a list of series and actions; Ctrl+K focuses it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import { quickAccessEntries } from '../components/dashboard/QuickAccess';
import { getRecentSeries, rememberRecentSeries, RECENT_LIMIT } from '../utils/recentSeries';

const mangas = [
  { id: 1, title: 'One Piece', author: 'Eiichiro Oda', publisher: 'Carlsen' },
  { id: 2, title: 'Frieren', author: 'Kanehito Yamada', publisher: 'Egmont' },
  { id: 3, title: 'Spy x Family', author: 'Tatsuya Endo', publisher: 'Kazé' }
];

const props = (overrides = {}) => ({
  activeMainView: 'shelf',
  canEdit: true,
  handleBarcodeDetected: vi.fn(),
  handleInstallClick: vi.fn(),
  handleOpenCsvModal: vi.fn(),
  handleOpenModal: vi.fn(),
  handleOpenPasswordModal: vi.fn(),
  handleOpenRestoreModal: vi.fn(),
  handleOpenStats: vi.fn(),
  handleOpenUsersModal: vi.fn(),
  handleOpenTool: vi.fn(),
  isInstallable: false,
  isInstalledApp: false,
  isOfflineMode: false,
  isVisitor: false,
  mangas,
  mobileMenuOpen: false,
  onLogout: vi.fn(),
  onOpenSeries: vi.fn(),
  radarData: null,
  search: '',
  searchInputRef: { current: null },
  setMobileMenuOpen: vi.fn(),
  setSearch: vi.fn(),
  setView: vi.fn(),
  shoppingData: null,
  user: { id: 7, username: 'anna', role: 'editor' },
  ...overrides
});

beforeEach(() => { localStorage.clear(); });

describe('quickAccessEntries', () => {
  const actions = [{ id: 'stats', label: 'Statistiken', hint: 'Seite', run: vi.fn() }, { id: 'add', label: 'Neuer Manga', hint: 'Aktion', run: vi.fn() }];

  it('without a query: the recently opened series that still exist, then every action', () => {
    const { sections, items } = quickAccessEntries({ mangas, recentIds: [3, 99, 1], actions });
    expect(sections.map((s) => s.title)).toEqual(['Zuletzt geöffnet', 'Aktionen']);
    expect(items.map((i) => i.label)).toEqual(['Spy x Family', 'One Piece', 'Statistiken', 'Neuer Manga']);
  });

  it('with a query: series by title or author and the actions whose label or hint matches', () => {
    expect(quickAccessEntries({ query: 'oda', mangas, actions }).items.map((i) => i.label)).toEqual(['One Piece']);
    expect(quickAccessEntries({ query: 'FRIE', mangas, actions }).sections.map((s) => s.title)).toEqual(['Reihen']);
    expect(quickAccessEntries({ query: 'seite', mangas, actions }).items.map((i) => i.label)).toEqual(['Statistiken']);
    expect(quickAccessEntries({ query: 'zzz', mangas, actions }).sections).toEqual([]);
  });
});

describe('recent series', () => {
  it('keeps the newest first, once each, per account and at most RECENT_LIMIT', () => {
    for (let id = 1; id <= RECENT_LIMIT + 2; id++) rememberRecentSeries(7, id);
    rememberRecentSeries(7, 3);
    expect(getRecentSeries(7)).toEqual([3, 7, 6, 5, 4]);
    expect(getRecentSeries(8)).toEqual([]);
    rememberRecentSeries(7, 'x');
    expect(getRecentSeries(7)).toHaveLength(RECENT_LIMIT);
  });
});

describe('quick access in the header', () => {
  it('focusing the search opens the list; a series opens its page and an action runs', () => {
    rememberRecentSeries(7, 2);
    const p = props();
    render(<DashboardHeader {...p} />);
    const input = screen.getByRole('combobox', { name: 'Sammlung durchsuchen' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('listbox', { name: 'Schnellzugriff' });
    expect(within(list).getByRole('group', { name: 'Zuletzt geöffnet' }).textContent).toMatch('Frieren');
    fireEvent.click(within(list).getByRole('option', { name: /Frieren/ }));
    expect(p.onOpenSeries).toHaveBeenCalledWith(2);
    fireEvent.focus(input);
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /Statistiken/ }));
    expect(p.handleOpenStats).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move through the matches and Enter opens the active one; the typed query is cleared', () => {
    const p = props({ search: 'piece' });
    render(<DashboardHeader {...p} />);
    const input = document.getElementById('main-search-input');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('quick-access-option-0');
    expect(document.getElementById('quick-access-option-0').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onOpenSeries).toHaveBeenCalledWith(1);
    expect(p.setSearch).toHaveBeenCalledWith('');
  });

  it('Enter without a chosen entry keeps the search as before', () => {
    const p = props({ search: 'piece' });
    render(<DashboardHeader {...p} />);
    const input = document.getElementById('main-search-input');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(p.onOpenSeries).not.toHaveBeenCalled();
    expect(p.setSearch).not.toHaveBeenCalled();
  });

  it('readers get no "Neuer Manga"; the views and Verwaltung entries are listed', () => {
    render(<DashboardHeader {...props({ canEdit: false, user: { id: 7, username: 'anna', role: 'viewer' } })} />);
    fireEvent.focus(document.getElementById('main-search-input'));
    const labels = screen.getAllByRole('option').map((o) => o.textContent);
    expect(labels.some((l) => l.startsWith('Neuer Manga'))).toBe(false);
    expect(labels.some((l) => l.startsWith('Radar'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Einkaufsliste'))).toBe(true);
  });

  it('Ctrl+K and Cmd+K focus the search and open the list, not while a dialog is open', () => {
    const searchInputRef = { current: null };
    render(<DashboardHeader {...props({ searchInputRef })} />);
    const input = document.getElementById('main-search-input');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    input.blur();
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(document.activeElement).toBe(input);
    input.blur();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).not.toBe(input);
    dialog.remove();
  });
});
