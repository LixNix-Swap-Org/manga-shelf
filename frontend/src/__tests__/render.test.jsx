// Render behaviour: cover images, memoised cards, progressive shelf and dialog history.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';

vi.mock('../utils/volumeHelpers', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getSeriesProgress: vi.fn(actual.getSeriesProgress) };
});

import { getSeriesProgress } from '../utils/volumeHelpers';
import { getStatusBadge } from '../utils/collectionHelpers';
import CoverImage from '../components/common/CoverImage';
import MangaCard from '../components/dashboard/MangaCard';
import MangaRow from '../components/dashboard/MangaRow';
import MangaCollectionGrid, {
  CARD_WRAPPER_CLASS, PAGE_SIZE, SHELF_COUNT_KEY, SHELF_SCROLL_KEY
} from '../components/dashboard/MangaCollectionGrid';
import PersonalTimeline, { GROUP_PREVIEW } from '../components/dashboard/radar/PersonalTimeline';
import useDialogA11y, { HISTORY_STATE_KEY } from '../hooks/useDialogA11y';
import { setServer } from '../utils/api';

const series = (id, over = {}) => ({ id, title: `Reihe ${id}`, status: 'Laufend', owned_volumes: 1, regular_owned: 1, ...over });
const many = (n) => Array.from({ length: n }, (_, i) => series(i + 1));

const gridProps = (over = {}) => ({
  canEdit: true, error: null, filtered: [series(1)], getStatusBadge, handleDeleteManga: vi.fn(), handleOpenModal: vi.fn(),
  isOffline: false, loading: false, onRetry: vi.fn(), publisherFilter: 'ALL', search: '', setPublisherFilter: vi.fn(),
  setSearch: vi.fn(), setStatusFilter: vi.fn(), sortBy: 'title_asc', statusFilter: 'ALL', viewMode: 'grid', ...over
});
const renderGrid = (over) => {
  const utils = render(<MemoryRouter><MangaCollectionGrid {...gridProps(over)} /></MemoryRouter>);
  return { ...utils, rerenderGrid: (next) => utils.rerender(<MemoryRouter><MangaCollectionGrid {...gridProps(next)} /></MemoryRouter>) };
};
const cardCount = () => document.querySelectorAll('a[href^="/manga/"][aria-labelledby]').length;

/** IntersectionObserver stand-in: trigger() reports every observed element as intersecting. */
function installObserver() {
  const observers = new Set();
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.add(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { observers.delete(this); }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return {
    trigger: () => act(() => {
      for (const o of [...observers]) o.callback(o.targets.map((target) => ({ target, isIntersecting: true })));
    })
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  setServer({ base: '' });
});

describe('CoverImage', () => {
  it('tries the candidates in order and ends at the fallback; only the failing image re-renders', () => {
    const onFail = vi.fn();
    render(<CoverImage src={['/uploads/vol.jpg', null, '/uploads/series.jpg']} alt="Berserk" onFail={onFail} fallback={<span>Kein Cover</span>} />);
    const first = screen.getByAltText('Berserk');
    expect(first.getAttribute('src')).toBe('/uploads/vol.jpg');
    expect(first.getAttribute('loading')).toBe('lazy');
    fireEvent.error(first);
    expect(onFail).toHaveBeenCalledWith('/uploads/vol.jpg');
    expect(screen.getByAltText('Berserk').getAttribute('src')).toBe('/uploads/series.jpg');
    fireEvent.error(screen.getByAltText('Berserk'));
    expect(screen.queryByAltText('Berserk')).toBeNull();
    expect(screen.getByText('Kein Cover')).toBeTruthy();
  });

  it('a new src is tried again even after an earlier one failed', () => {
    const { rerender } = render(<CoverImage src="/uploads/a.jpg" alt="x" fallback={<span>leer</span>} />);
    fireEvent.error(screen.getByAltText('x'));
    rerender(<CoverImage src="/uploads/b.jpg" alt="x" fallback={<span>leer</span>} />);
    expect(screen.getByAltText('x').getAttribute('src')).toBe('/uploads/b.jpg');
  });

  it('loads server covers in CORS mode in the app build', () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    setServer({ base: 'https://shelf.example.org' });
    render(<CoverImage src={['/uploads/a.jpg']} alt="x" />);
    const img = screen.getByAltText('x');
    expect(img.getAttribute('src')).toBe('https://shelf.example.org/uploads/a.jpg');
    expect(img.getAttribute('crossorigin')).toBe('anonymous');
  });
});

describe('memoised cards', () => {
  it('card and row are memo components', () => {
    expect(MangaCard.$$typeof).toBe(Symbol.for('react.memo'));
    expect(MangaRow.$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('a grid re-render with the same list does not re-render the cards', () => {
    const filtered = many(3);
    const onDelete = vi.fn();
    const { rerenderGrid } = renderGrid({ filtered, handleDeleteManga: onDelete });
    const calls = getSeriesProgress.mock.calls.length;
    rerenderGrid({ filtered, handleDeleteManga: onDelete, refreshing: true });
    expect(screen.getByText('aktualisiere…')).toBeTruthy();
    expect(getSeriesProgress.mock.calls.length).toBe(calls);
  });

  it('a broken cover swaps only its own card to the placeholder', () => {
    renderGrid({ filtered: [series(1, { cover_image: '/uploads/a.jpg' }), series(2, { cover_image: '/uploads/b.jpg' })] });
    const calls = getSeriesProgress.mock.calls.length;
    fireEvent.error(document.querySelectorAll('img')[0]);
    expect(screen.getAllByText('Kein Cover')).toHaveLength(1);
    expect(getSeriesProgress.mock.calls.length).toBe(calls);
  });

  it('card wrappers skip off-screen rendering with content-visibility', () => {
    renderGrid();
    const wrapper = screen.getByRole('link', { name: /^Reihe 1\b/ }).parentElement;
    expect(wrapper.className).toBe(CARD_WRAPPER_CLASS);
    expect(wrapper.className).toContain('[content-visibility:auto]');
  });
});

describe('progressive shelf', () => {
  it('renders one page and says how many are shown; the button adds the next page', () => {
    renderGrid({ filtered: many(130) });
    expect(cardCount()).toBe(PAGE_SIZE.grid);
    expect(screen.getByText('Zeige 60 von 130')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere anzeigen' }));
    expect(cardCount()).toBe(120);
    fireEvent.click(screen.getByRole('button', { name: 'Weitere anzeigen' }));
    expect(cardCount()).toBe(130);
    expect(screen.queryByText(/Zeige/)).toBeNull();
  });

  it('the next page loads when the end of the list comes near', () => {
    const io = installObserver();
    renderGrid({ filtered: many(130) });
    io.trigger();
    expect(cardCount()).toBe(120);
  });

  it('the list view pages too, with its own page size', () => {
    renderGrid({ filtered: many(250), viewMode: 'list' });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(PAGE_SIZE.list);
    expect(screen.getByText('Zeige 100 von 250')).toBeTruthy();
  });

  it('a new search, filter or sort starts at the first page again', () => {
    const filtered = many(200);
    const { rerenderGrid } = renderGrid({ filtered });
    fireEvent.click(screen.getByRole('button', { name: 'Weitere anzeigen' }));
    expect(cardCount()).toBe(120);
    rerenderGrid({ filtered, sortBy: 'title_desc' });
    expect(cardCount()).toBe(60);
  });

  it('coming back with the same filters renders as many cards as before (stored per filter key)', () => {
    const filtered = many(200);
    const first = renderGrid({ filtered });
    fireEvent.click(screen.getByRole('button', { name: 'Weitere anzeigen' }));
    first.unmount();
    expect(JSON.parse(sessionStorage.getItem(SHELF_COUNT_KEY)).count).toBe(120);

    const again = renderGrid({ filtered });
    expect(cardCount()).toBe(120);
    again.unmount();
    renderGrid({ filtered, search: 'Reihe' });
    expect(cardCount()).toBe(60);
  });

  it('restores the shelf scroll position once the list is there and records it when the shelf goes', () => {
    sessionStorage.setItem(SHELF_SCROLL_KEY, '900');
    const { rerenderGrid, unmount } = renderGrid({ loading: true, filtered: [] });
    expect(window.scrollTo).not.toHaveBeenCalled();
    rerenderGrid({ filtered: many(80) });
    expect(window.scrollTo).toHaveBeenCalledWith(0, 900);
    rerenderGrid({ filtered: many(81) });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);

    act(() => {
      window.scrollY = 450;
      window.dispatchEvent(new Event('scroll'));
    });
    unmount();
    expect(sessionStorage.getItem(SHELF_SCROLL_KEY)).toBe('450');
    window.scrollY = 0;
  });

  it('shows the age of an old copy, never of a fresh one', () => {
    const { rerenderGrid } = renderGrid({ dataAt: Date.now() - 2 * 60 * 60 * 1000 });
    expect(screen.getByText(/^Stand: vor 2/)).toBeTruthy();
    rerenderGrid({ dataAt: Date.now() - 5 * 60 * 1000 });
    expect(screen.queryByText(/Stand:/)).toBeNull();
  });
});

describe('PersonalTimeline: long months', () => {
  const item = (id) => ({
    id, manga_id: id, manga_title: `Reihe ${id}`, volume_number: String(id), effective_publisher: 'Carlsen', status: 'Vorbestellt',
    price: 7, release_date: '2026-11', countdown_label: null
  });
  const props = (count) => ({
    setRadarSubView: vi.fn(), loadingRadar: false, radarError: null, onRetry: vi.fn(), radarPublisherFilter: 'ALL',
    radarStatusFilter: 'ALL', radarSearch: '', onResetFilters: vi.fn(), canEdit: false, onMarkDelivered: vi.fn(),
    radarData: { total_releases: count, groups: [{ key: '2026-11', label: 'November 2026', items: Array.from({ length: count }, (_, i) => item(i + 1)) }] }
  });

  it('shows the first items of a month and the rest on request', () => {
    render(<MemoryRouter><PersonalTimeline {...props(GROUP_PREVIEW + 6)} /></MemoryRouter>);
    expect(screen.getAllByText('Details', { exact: false })).toHaveLength(GROUP_PREVIEW);
    fireEvent.click(screen.getByRole('button', { name: `Alle ${GROUP_PREVIEW + 6} anzeigen` }));
    expect(screen.getAllByText('Details', { exact: false })).toHaveLength(GROUP_PREVIEW + 6);
    expect(screen.queryByRole('button', { name: /^Alle/ })).toBeNull();
  });

  it('a short month has no button', () => {
    render(<MemoryRouter><PersonalTimeline {...props(3)} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /^Alle/ })).toBeNull();
  });

  it('a broken volume cover falls back to the series cover without a shared failure map', () => {
    const data = props(1).radarData;
    data.groups[0].items[0] = { ...data.groups[0].items[0], vol_cover: '/uploads/dead.jpg', manga_cover: '/uploads/series.jpg' };
    render(<MemoryRouter><PersonalTimeline {...props(1)} radarData={data} /></MemoryRouter>);
    fireEvent.error(screen.getByAltText('Reihe 1'));
    expect(screen.getByAltText('Reihe 1').getAttribute('src')).toBe('/uploads/series.jpg');
  });
});

function Dialog({ label = 'Dialog', onEscape, onClose, history }) {
  const ref = useDialogA11y(true, { onClose, history });
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') onEscape?.(); }}
    >
      <button type="button">In {label}</button>
    </div>
  );
}

/** Two dialogs that close on Escape; a `stubborn` outer one ignores it (like a busy dialog). */
function Page({ stubborn = false, withOnClose = false }) {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOuter(true)}>Außen öffnen</button>
      <button type="button" onClick={() => setInner(true)}>Innen öffnen</button>
      <button type="button" onClick={() => setOuter(false)}>Außen zu</button>
      {outer && (
        <Dialog
          label="Außen"
          onEscape={stubborn ? undefined : () => setOuter(false)}
          onClose={withOnClose ? () => setOuter(false) : undefined}
        />
      )}
      {inner && <Dialog label="Innen" onEscape={() => setInner(false)} />}
    </>
  );
}

const tokens = () => window.history.state?.[HISTORY_STATE_KEY] || [];
const settle = () => act(() => new Promise((r) => setTimeout(r, 200)));

describe('useDialogA11y: history entries', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('opening adds a history entry with the dialog token; Back closes the dialog through its Escape handling', async () => {
    const length = window.history.length;
    render(<Page />);
    fireEvent.click(screen.getByText('Außen öffnen'));
    expect(window.history.length).toBe(length + 1);
    expect(tokens()).toHaveLength(1);
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await settle();
    expect(tokens()).toHaveLength(0);
  });

  it('Back calls onClose when the dialog passes one', async () => {
    render(<Page stubborn withOnClose />);
    fireEvent.click(screen.getByText('Außen öffnen'));
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a dialog that stays open (busy, unsaved input kept) gets its entry back', async () => {
    render(<Page stubborn />);
    fireEvent.click(screen.getByText('Außen öffnen'));
    act(() => { window.history.back(); });
    await waitFor(() => expect(tokens()).toHaveLength(0));
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(tokens()).toHaveLength(1);
  });

  it('Back closes only the top dialog', async () => {
    render(<Page />);
    fireEvent.click(screen.getByText('Außen öffnen'));
    fireEvent.click(screen.getByText('Innen öffnen'));
    expect(tokens()).toHaveLength(2);
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Innen' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Außen' })).toBeTruthy();
  });

  it('a dialog the app closes removes its own entry, and that Back closes nothing else', async () => {
    const back = vi.spyOn(window.history, 'back');
    render(<Page />);
    fireEvent.click(screen.getByText('Innen öffnen'));
    fireEvent.click(screen.getByText('Außen öffnen'));
    fireEvent.click(screen.getByText('Außen zu'));
    await settle();
    expect(back).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Innen' })).toBeTruthy();
    expect(tokens()).toHaveLength(1);
  });

  it('a navigation right after closing keeps its entry (no Back)', async () => {
    const back = vi.spyOn(window.history, 'back');
    render(<Page />);
    fireEvent.click(screen.getByText('Außen öffnen'));
    act(() => {
      fireEvent.click(screen.getByText('Außen zu'));
      window.history.pushState({ idx: 9 }, '', '/manga/2');
    });
    await settle();
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/manga/2');
  });

  it('history: false keeps the dialog out of the history', () => {
    const length = window.history.length;
    render(<Dialog history={false} />);
    expect(window.history.length).toBe(length);
  });
});
