import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import BottomNav, { NARROW_QUERY } from '../components/common/BottomNav';

/** matchMedia stand-in whose phone query answers `narrow`; `set()` fires a change. */
function stubMatchMedia(narrow) {
  const listeners = new Set();
  const list = {
    get matches() { return narrow; },
    media: NARROW_QUERY,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn)
  };
  vi.stubGlobal('matchMedia', vi.fn((query) => (query === NARROW_QUERY ? list : { matches: false, addEventListener() {}, removeEventListener() {} })));
  return {
    set(value) {
      narrow = value;
      for (const fn of listeners) fn();
    }
  };
}

afterEach(() => vi.unstubAllGlobals());

function Header(over = {}) {
  const [view, setView] = useState(over.activeMainView || 'shelf');
  const [menu, setMenu] = useState(false);
  return (
    <MemoryRouter>
      <p data-testid="view">{view}</p>
      <DashboardHeader
        activeMainView={view}
        setView={over.setView || setView}
        canEdit
        user={{ id: 1, username: 'ed', role: 'editor' }}
        handleBarcodeDetected={vi.fn()}
        handleOpenModal={vi.fn()}
        handleOpenStats={vi.fn()}
        handleOpenPasswordModal={vi.fn()}
        handleOpenCsvModal={vi.fn()}
        mobileMenuOpen={menu}
        setMobileMenuOpen={setMenu}
        search=""
        setSearch={vi.fn()}
        searchInputRef={{ current: null }}
        shoppingData={{ total_missing: 12 }}
        radarData={{ total_releases: 3 }}
        isOfflineMode={false}
      />
    </MemoryRouter>
  );
}

const ids = (id) => document.querySelectorAll(`#${id}`).length;

describe('bottom navigation on phones', () => {
  it('replaces the top quick toggles below sm and keeps their ids unique', () => {
    stubMatchMedia(true);
    render(<Header />);
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    expect(nav.parentElement).toBe(document.body);
    for (const id of ['btn-mobile-shopping', 'btn-mobile-radar', 'btn-mobile-menu-toggle']) {
      expect(ids(id)).toBe(1);
      expect(nav.contains(document.getElementById(id))).toBe(true);
    }
    expect(document.getElementById('btn-mobile-anime')).toBeNull();
    expect(within(nav).getByRole('button', { name: 'Einkaufsliste, 12 fehlend' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Release-Radar, 3 Termine' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Scannen' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Sammlung' }).getAttribute('aria-current')).toBe('page');
  });

  it('switches views (tab semantics, no toggle back) and opens the menu as a bottom sheet', () => {
    stubMatchMedia(true);
    render(<Header />);
    fireEvent.click(document.getElementById('btn-mobile-shopping'));
    expect(screen.getByTestId('view').textContent).toBe('shopping');
    fireEvent.click(document.getElementById('btn-mobile-shopping'));
    expect(screen.getByTestId('view').textContent).toBe('shopping');
    expect(document.getElementById('btn-mobile-shopping').getAttribute('aria-current')).toBe('page');

    const more = document.getElementById('btn-mobile-menu-toggle');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const drawer = document.getElementById('mobile-menu-drawer');
    expect(drawer.closest('header')).toBeNull();
    expect(drawer.className).toContain('fixed');
    expect(within(drawer).getByRole('button', { name: /Anime/ })).toBeTruthy();

    fireEvent.click(document.getElementById('btn-mobile-radar'));
    expect(screen.getByTestId('view').textContent).toBe('radar');
    expect(document.getElementById('mobile-menu-drawer')).toBeNull();
  });

  it('a tap outside the sheet closes it', () => {
    stubMatchMedia(true);
    render(<Header />);
    fireEvent.click(document.getElementById('btn-mobile-menu-toggle'));
    const backdrop = document.body.querySelector('div[aria-hidden="true"].fixed.inset-0');
    fireEvent.click(backdrop);
    expect(document.getElementById('mobile-menu-drawer')).toBeNull();
  });

  it('tablets and desktops keep the top controls; rotating a phone switches at once', () => {
    const media = stubMatchMedia(false);
    render(<Header />);
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    expect(document.getElementById('btn-mobile-anime')).toBeTruthy();
    expect(document.getElementById('mobile-menu-drawer')).toBeNull();
    act(() => media.set(true));
    expect(screen.getByRole('navigation', { name: 'Hauptnavigation' })).toBeTruthy();
    expect(ids('btn-mobile-shopping')).toBe(1);
    act(() => media.set(false));
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
  });

  it('without matchMedia nothing changes (old browsers, tests)', () => {
    render(<Header />);
    expect(screen.queryByRole('navigation', { name: 'Hauptnavigation' })).toBeNull();
    expect(ids('btn-mobile-shopping')).toBe(1);
  });

  it('items are at least 44 px tall and the bar keeps clear of the home indicator', () => {
    render(<BottomNav activeMainView="radar" setView={vi.fn()} onScan={vi.fn()} setMobileMenuOpen={vi.fn()} />);
    const nav = screen.getByRole('navigation');
    expect(nav.className).toContain('pb-[env(safe-area-inset-bottom)]');
    for (const button of within(nav).getAllByRole('button').filter((b) => b.id !== 'btn-bottom-scan')) {
      expect(button.className).toContain('min-h-[56px]');
    }
    expect(document.getElementById('btn-bottom-scan').className).toContain('w-14 h-14');
    expect(document.getElementById('btn-mobile-radar').getAttribute('aria-current')).toBe('page');
  });
});
