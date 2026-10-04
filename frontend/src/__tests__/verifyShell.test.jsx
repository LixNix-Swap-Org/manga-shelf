// App shell: sticky dashboard header, server pill and focus reveal after viewport changes.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import { useRevealFocusedField } from '../hooks/useKeyboardOpen';
import appSource from '../App.jsx?raw';

vi.mock('../app/useConnection', () => ({ default: () => ({ state: 'online', server: { name: 'Testserver' } }) }));
vi.mock('../utils/api', async (importOriginal) => ({ ...(await importOriginal()), isAppMode: () => true, isLocalMode: () => false }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--sticky-header-h');
});

function renderHeader(over = {}) {
  const searchInputRef = { current: null };
  const utils = render(
    <MemoryRouter>
      <DashboardHeader
        activeMainView="shelf"
        setView={vi.fn()}
        canEdit
        user={{ id: 1, username: 'ed', role: 'editor' }}
        handleBarcodeDetected={vi.fn()}
        handleOpenModal={vi.fn()}
        handleOpenStats={vi.fn()}
        handleOpenPasswordModal={vi.fn()}
        mobileMenuOpen={false}
        setMobileMenuOpen={vi.fn()}
        search=""
        setSearch={vi.fn()}
        searchInputRef={searchInputRef}
        isOfflineMode={false}
        {...over}
      />
    </MemoryRouter>
  );
  return { ...utils, searchInputRef };
}

/** ResizeObserver stand-in; `fire()` runs every observer callback. */
function stubResizeObserver() {
  const observers = new Set();
  vi.stubGlobal('ResizeObserver', class {
    constructor(fn) { this.fn = fn; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  });
  return { fire: () => observers.forEach((o) => o.fn([])), count: () => observers.size };
}

describe('sticky dashboard header', () => {
  it('publishes its height as --sticky-header-h while sticky, 0 when it scrolls with the page, and clears it on unmount', () => {
    const ro = stubResizeObserver();
    let position = 'sticky';
    let height = 126.4;
    const realStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => (
      el.matches?.('header[data-sticky-header]') ? { position } : realStyle(el)
    ));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top: 0, left: 0, width: 390, height, bottom: height, right: 390 }));
    const root = document.documentElement;
    const { unmount } = renderHeader();
    expect(root.style.getPropertyValue('--sticky-header-h')).toBe('127px');
    height = 98;
    act(() => ro.fire());
    expect(root.style.getPropertyValue('--sticky-header-h')).toBe('98px');
    position = 'static';
    act(() => window.dispatchEvent(new Event('resize')));
    expect(root.style.getPropertyValue('--sticky-header-h')).toBe('0px');
    unmount();
    expect(root.style.getPropertyValue('--sticky-header-h')).toBe('');
    expect(ro.count()).toBe(0);
  });

  it('scrolls with the page on short screens (landscape phones, 200 % zoom)', () => {
    renderHeader();
    expect(document.querySelector('header[data-sticky-header]').className).toMatch(/\bsticky short:static\b/);
  });

  it('the connection state in the server pill has readable contrast (slate-400)', () => {
    renderHeader();
    const pill = document.getElementById('btn-connection-pill');
    const state = Array.from(pill.querySelectorAll('span')).find((s) => s.textContent.includes('verbunden'));
    expect(state.className).toContain('text-slate-400');
    expect(state.className).not.toContain('text-slate-500');
  });

  it('the search field itself fills the box height, so a tap on the box padding lands in the field', () => {
    renderHeader();
    const input = document.getElementById('main-search-input');
    expect(input.className).toContain('py-2.5');
    expect(input.className).not.toMatch(/(^| )p-0( |$)/);
    expect(input.parentElement.className).not.toMatch(/(^| )py-/);
  });

  it('a touch scroll outside the header closes the untouched search field, not one the user typed in', () => {
    const { searchInputRef } = renderHeader();
    const input = searchInputRef.current;
    act(() => input.focus());
    act(() => fireEvent.touchMove(input));
    expect(document.activeElement).toBe(input);
    act(() => fireEvent.touchMove(document.body));
    expect(document.activeElement).not.toBe(input);

    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'One' } });
    act(() => fireEvent.touchMove(document.body));
    expect(document.activeElement).toBe(input);
  });
});

describe('focused field after a viewport change (outside dialogs)', () => {
  function Page() {
    useRevealFocusedField();
    return (
      <>
        <input aria-label="Name" />
        <button type="button">Weiter</button>
        <div role="dialog" aria-modal="true" aria-label="Dialog"><input aria-label="Im Dialog" /></div>
      </>
    );
  }

  function stubViewport() {
    const listeners = new Set();
    const viewport = {
      height: 800, offsetTop: 0, scale: 1,
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn)
    };
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('requestAnimationFrame', (fn) => { fn(); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    return { viewport, resize: () => act(() => listeners.forEach((fn) => fn())), count: () => listeners.size };
  }

  const place = (el, top) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40 });
    el.scrollIntoView = vi.fn();
    return el;
  };

  it('scrolls a focused field the keyboard or a rotation left outside the visual viewport back to the centre', () => {
    const vv = stubViewport();
    render(<Page />);
    const field = place(screen.getByLabelText('Name'), 283);
    act(() => field.focus());
    vv.resize();
    expect(field.scrollIntoView).not.toHaveBeenCalled();
    vv.viewport.height = 138;
    vv.resize();
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
  });

  it('leaves buttons and fields inside dialogs alone (useDialogA11y handles those) and stops listening on unmount', () => {
    const vv = stubViewport();
    const { unmount } = render(<Page />);
    vv.viewport.height = 100;
    const button = place(screen.getByRole('button', { name: 'Weiter' }), 400);
    act(() => button.focus());
    vv.resize();
    expect(button.scrollIntoView).not.toHaveBeenCalled();
    const inDialog = place(screen.getByLabelText('Im Dialog'), 400);
    act(() => inDialog.focus());
    vv.resize();
    expect(inDialog.scrollIntoView).not.toHaveBeenCalled();
    unmount();
    expect(vv.count()).toBe(0);
  });

  it('App mounts the listener once for every page', () => {
    expect(appSource.match(/useRevealFocusedField\(\);/g)).toHaveLength(1);
  });
});
