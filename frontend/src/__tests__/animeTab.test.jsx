// Covers the anime tab: card, view, detail modal and add modal.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, renderHook, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fakeResponse } from './fakeResponse';
import AnimeCard from '../components/dashboard/AnimeCard';
import AnimeView from '../components/dashboard/AnimeView';
import AnimeDetailModal from '../components/modals/AnimeDetailModal';
import AddAnimeModal, { sourcesNote } from '../components/modals/AddAnimeModal';
import MainViewSwitcher from '../components/dashboard/MainViewSwitcher';
import AnimeStatsCard, { watchTime } from '../components/modals/stats/AnimeStatsCard';
import useAnimeList from '../hooks/useAnimeList';
import { mainViewOf, searchForView } from '../Dashboard';
import {
  countdownText, progressText, plusOneDisabled, filterAnime, filterCounts, predictProgress, readAnimeCache, writeAnimeCache,
  ANIME_CACHE_KEY, ANIME_META_KEY, staleText
} from '../utils/animeHelpers';
import { OFFLINE_SYNCED_EVENT } from '../utils/offlineStore';

const entry = (over = {}) => ({
  id: 1, title: 'Frieren', title_de: null, format: 'TV', season_year: 2023, episodes: 12, cover_image: null, anilist_id: 154587, mal_id: 52991,
  manual: false, next_airing: null, my_progress: { status: 'Schaue', episodes_watched: 7, score: null, notes: null }, progress_users: [], ...over
});

const inRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('AnimeCard', () => {
  it('+1 calls back with the entry; "Gesehen" disables it; visitors get no controls', () => {
    const onPlusOne = vi.fn();
    const onStatusChange = vi.fn();
    const { rerender } = inRouter(<AnimeCard anime={entry()} canEdit onOpen={vi.fn()} onPlusOne={onPlusOne} onStatusChange={onStatusChange} userId={1} />);
    expect(screen.getByText('7 / 12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /eine Folge mehr gesehen/ }));
    expect(onPlusOne).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    fireEvent.change(screen.getByLabelText(/Status für Frieren/), { target: { value: 'Pausiert' } });
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'Pausiert');

    rerender(<MemoryRouter><AnimeCard anime={entry({ my_progress: { status: 'Gesehen', episodes_watched: 12 } })} canEdit onOpen={vi.fn()} onPlusOne={onPlusOne} onStatusChange={onStatusChange} userId={1} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /eine Folge mehr gesehen/ }).disabled).toBe(true);

    rerender(<MemoryRouter><AnimeCard anime={entry()} canEdit={false} onOpen={vi.fn()} onPlusOne={onPlusOne} onStatusChange={onStatusChange} userId={1} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /eine Folge mehr gesehen/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows the countdown, the estimate badge, co-watchers and the link to the series', () => {
    const at = Math.floor((Date.now() + 3 * 86400000) / 1000);
    inRouter(<AnimeCard anime={entry({ manga_id: 9, next_airing: { episode: 8, at, estimated: true }, progress_users: [{ user_id: 2, username: 'kim', status: 'Schaue', episodes_watched: 3 }] })}
      canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    expect(screen.getByText(/Folge 8 · in 3 Tagen/)).toBeTruthy();
    expect(screen.getByText('geschätzt')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Schauen auch: kim' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Zur verknüpften Reihe' }).getAttribute('href')).toBe('/manga/9');
  });
});

describe('AnimeCard long titles', () => {
  it('wraps and hyphenates the title in two lines with the title language; the counter stays on one line', () => {
    const { unmount } = inRouter(<AnimeCard anime={entry({ title: 'Donaudampfschifffahrtskapitänsabenteuer', my_progress: null })} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    const heading = screen.getByRole('heading', { name: 'Donaudampfschifffahrtskapitänsabenteuer' });
    expect(heading.getAttribute('lang')).toBe('de');
    const text = within(heading).getByText('Donaudampfschifffahrtskapitänsabenteuer');
    for (const c of ['line-clamp-2', 'break-words', 'hyphens-auto', '[overflow-wrap:anywhere]']) expect(text.className.split(' ')).toContain(c);
    expect(text.closest('button').className.split(' ')).toEqual(expect.arrayContaining(['block', 'max-w-full']));
    expect(screen.getByText('Nicht auf meiner Liste').className).toContain('min-w-0');
    const counter = screen.getByLabelText(/0 von 12 Folgen gesehen/);
    expect(counter.className.split(' ')).toEqual(expect.arrayContaining(['font-mono', 'whitespace-nowrap', 'shrink-0']));
    unmount();
    inRouter(<AnimeCard anime={entry({ title: '葬送のフリーレン' })} canEdit={false} onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    expect(screen.getByRole('heading', { name: '葬送のフリーレン' }).getAttribute('lang')).toBe('ja');
  });
});

describe('animeHelpers', () => {
  it('progress text, +1 rule and countdown by calendar days', () => {
    expect(progressText(7, 12)).toBe('7 / 12');
    expect(progressText(7, null)).toBe('7 / ?');
    expect(plusOneDisabled({ status: 'Schaue', episodes_watched: 12 }, 12)).toBe(true);
    expect(plusOneDisabled({ status: 'Schaue', episodes_watched: 12 }, null)).toBe(false);
    const now = new Date(2026, 9, 4, 22, 0);
    expect(countdownText({ episode: 8, at: Math.floor(new Date(2026, 9, 5, 1, 0).getTime() / 1000) }, now)).toBe('Folge 8 · morgen');
    expect(countdownText({ episode: 8, at: Math.floor(new Date(2026, 9, 4, 23, 30).getTime() / 1000) }, now)).toMatch(/^Folge 8 · heute 23:30/);
    expect(countdownText({ episode: 8, at: Math.floor(new Date(2026, 9, 1).getTime() / 1000) }, now)).toBeNull();
    expect(staleText({ stale: true, meta_fetched_at: Date.now() - 3 * 86400000 })).toMatch(/^Stand: vor 3 Tagen/);
  });

  it('filters by my status, sorts, counts', () => {
    const list = [
      entry({ id: 1, title: 'B', my_progress: { status: 'Gesehen', score: 9 } }),
      entry({ id: 2, title: 'A', my_progress: null, next_airing: { at: 100 } }),
      entry({ id: 3, title: 'C', my_progress: { status: 'Schaue', score: 5 } })
    ];
    expect(filterAnime(list).map((a) => a.id)).toEqual([2, 1, 3]);
    expect(filterAnime(list, { filter: 'Ohne Status' }).map((a) => a.id)).toEqual([2]);
    expect(filterAnime(list, { sort: 'score' }).map((a) => a.id)).toEqual([1, 3, 2]);
    expect(filterAnime(list, { sort: 'next' })[0].id).toBe(2);
    expect(filterAnime(list, { search: 'c' }).map((a) => a.id)).toEqual([3]);
    expect(filterCounts(list)).toMatchObject({ Alle: 3, Gesehen: 1, Schaue: 1, 'Ohne Status': 1 });
  });

  it('predicts the server rules for the optimistic update', () => {
    expect(predictProgress(null, { episodes_watched: 1 }, 12)).toMatchObject({ status: 'Schaue', episodes_watched: 1 });
    expect(predictProgress({ status: 'Schaue', episodes_watched: 11 }, { episodes_watched: 12 }, 12)).toMatchObject({ status: 'Gesehen', episodes_watched: 12 });
    expect(predictProgress({ status: 'Schaue', episodes_watched: 3 }, { status: 'Gesehen' }, 12).episodes_watched).toBe(12);
    expect(predictProgress({ status: 'Schaue', episodes_watched: 3 }, { episodes_watched: 99 }, 12).episodes_watched).toBe(12);
  });

  it('the offline copy belongs to its user and goes with clearOfflineData', () => {
    writeAnimeCache([entry()], 5);
    expect(readAnimeCache(5).list).toHaveLength(1);
    expect(readAnimeCache(6)).toBeNull();
    window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: { synced_at: '2026-10-04' } }));
    expect(localStorage.getItem(ANIME_CACHE_KEY)).not.toBeNull();
    window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: { synced_at: null } }));
    expect(localStorage.getItem(ANIME_CACHE_KEY)).toBeNull();
    expect(localStorage.getItem(ANIME_META_KEY)).toBeNull();
  });

  it('?view=anime is a main view; ?add= never survives a view change', () => {
    expect(mainViewOf('?view=anime')).toBe('anime');
    expect(mainViewOf('?view=radar')).toBe('radar');
    expect(mainViewOf('?view=unbekannt')).toBe('shelf');
    expect(searchForView('?view=anime&add=4', 'anime')).toBe('?view=anime');
    expect(searchForView('?view=anime&add=4', 'shelf')).toBe('');
    expect(searchForView('', 'radar')).toBe('?view=radar');
  });
});

describe('AddAnimeModal', () => {
  it('the manual tab sends title and episodes', async () => {
    const onAdd = vi.fn(async () => ({ id: 3 }));
    const onClose = vi.fn();
    render(<AddAnimeModal isOpen onClose={onClose} search={vi.fn()} onAdd={onAdd} mangas={[{ id: 4, title: 'Frieren' }]} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Manuell' }));
    fireEvent.change(screen.getByLabelText('Titel'), { target: { value: '  Heimvideo  ' } });
    fireEvent.change(screen.getByLabelText('Folgen (optional)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Zu Reihe verknüpfen'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ title: 'Heimvideo', episodes: 3, manga_id: 4 }));
    expect(onClose).toHaveBeenCalled();
  });

  it('searches on the button, marks entries already in the list and adds a hit by its ids', async () => {
    const search = vi.fn(async () => ({
      results: [
        { anilist_id: 154587, mal_id: 52991, title: { preferred: 'Frieren', romaji: 'Sousou no Frieren' }, format: 'TV', season_year: 2023, episodes: 28, in_collection_id: null },
        { anilist_id: 182255, mal_id: null, title: { preferred: 'Frieren 2' }, in_collection_id: 7 }
      ],
      sources_used: ['anilist'], partial: true
    }));
    const onAdd = vi.fn(async () => ({}));
    render(<AddAnimeModal isOpen onClose={vi.fn()} search={search} onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText('Titel suchen'), { target: { value: 'Frieren' } });
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Suchen' }));
    expect(await screen.findByText('Sousou no Frieren')).toBeTruthy();
    expect(screen.getByText('Gerade nur AniList erreichbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: /schon im Regal/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Hinzufügen/ }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ anilist_id: 154587, mal_id: 52991, manga_id: null }));
    expect(sourcesNote({ sources_used: ['anilist', 'jikan'], partial: false })).toBeNull();
  });

  it('the tabs follow the ARIA pattern and switch with the arrow keys', () => {
    render(<AddAnimeModal isOpen onClose={vi.fn()} search={vi.fn()} onAdd={vi.fn()} />);
    const search = screen.getByRole('tab', { name: 'Suche' });
    const manual = screen.getByRole('tab', { name: 'Manuell' });
    const panel = screen.getByRole('tabpanel');
    expect(search.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(search.id);
    expect(panel.contains(screen.getByLabelText('Titel suchen'))).toBe(true);
    expect([search.tabIndex, manual.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(search, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(manual);
    expect(manual.getAttribute('aria-selected')).toBe('true');
    expect([search.tabIndex, manual.tabIndex]).toEqual([-1, 0]);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(manual.id);
    expect(screen.getByLabelText('Titel')).toBeTruthy();
    fireEvent.keyDown(manual, { key: 'Home' });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'End' });
    expect(document.activeElement).toBe(manual);
  });

  it('opened from a series it suggests that series\' adaptations', async () => {
    const loadAdaptations = vi.fn(async () => ({ results: [{ relation: 'ADAPTATION', kind: 'ANIME', anilist_id: 154587, mal_id: 52991, title: 'Sousou no Frieren', format: 'TV', season_year: 2023, in_collection_id: null }], source: 'anilist' }));
    render(<AddAnimeModal isOpen onClose={vi.fn()} search={vi.fn()} loadAdaptations={loadAdaptations} onAdd={vi.fn()} mangas={[{ id: 4, title: 'Frieren', alt_title: 'Sousou no Frieren' }]} initialMangaId={4} />);
    expect(await screen.findByText('Anime-Adaptionen dieser Reihe')).toBeTruthy();
    expect(loadAdaptations).toHaveBeenCalledWith(4, expect.anything());
    expect(screen.getByLabelText('Zu Reihe verknüpfen').value).toBe('4');
    expect(screen.getByLabelText('Titel suchen').value).toBe('Sousou no Frieren');
  });
});

describe('AnimeView', () => {
  const base = { loaded: true, loading: false, error: null, fromCache: false, cacheAt: null, user: { id: 1, role: 'editor' }, onAdd: vi.fn(), onOpen: vi.fn(), onPlusOne: vi.fn(), onStatusChange: vi.fn(), onRetry: vi.fn() };

  beforeEach(() => sessionStorage.clear());

  it('empty state, add button for editors, none offline', () => {
    const { rerender } = inRouter(<AnimeView {...base} list={[]} canEdit sources={null} />);
    expect(screen.getByText('Noch keine Anime in der Liste')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Anime hinzufügen/ })).toBeTruthy();
    rerender(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit user={{ id: 1, role: 'visitor', offline: true }} cacheAt={new Date().toISOString()} sources={null} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /Anime hinzufügen/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Offline: gespeicherte Liste/);
    expect(screen.queryByRole('button', { name: /eine Folge mehr gesehen/ })).toBeNull();
  });

  it('empty state keeps its text off the dashed border; the toolbar button stays on one line', () => {
    inRouter(<AnimeView {...base} list={[]} canEdit sources={null} />);
    const empty = document.getElementById('anime-empty');
    expect(empty.className).toContain('px-6');
    expect(empty.className).toContain('border-dashed');
    const add = document.getElementById('btn-add-anime');
    expect(add.className).toContain('whitespace-nowrap');
    expect(add.className).toContain('shrink-0');
    expect(screen.getByText('Sortierung').className).toContain('sr-only sm:not-sr-only');
    expect(screen.getByLabelText('Sortierung').className).toContain('min-w-0');
  });

  it('source hints: paused source, own key, refused key, slow pool once per session', () => {
    const onOpenAccount = vi.fn();
    const sources = {
      anilist: { enabled: true, circuit: 'closed', paused_until: null, key_disabled: true },
      mal: { enabled: true, circuit: 'open', paused_until: null },
      credential: { anilist: 'shared' },
      slow_recently: true
    };
    const { unmount } = inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={sources} onOpenAccount={onOpenAccount} />);
    expect(screen.getByText('MyAnimeList gerade nicht erreichbar, nur AniList')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Schlüssel prüfen' }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Suche ist gerade langsam/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'einrichten' }));
    expect(onOpenAccount).toHaveBeenCalledTimes(2);
    unmount();
    inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={{ ...sources, anilist: { enabled: true }, credential: { anilist: 'own' } }} onOpenAccount={onOpenAccount} />);
    expect(screen.getByText('Suche läuft über deinen AniList-Zugang')).toBeTruthy();
    expect(screen.queryByText(/Suche ist gerade langsam/)).toBeNull();
  });
});

describe('useAnimeList', () => {
  it('+1 shows at once and goes back when the server refuses', async () => {
    const list = [entry()];
    let refuse = false;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (url === '/api/anime') return fakeResponse(200, list);
      if (url === '/api/anime/1/progress') {
        if (refuse) return fakeResponse(403, { error: 'Nur Lesezugriff' });
        return fakeResponse(200, { status: 'Schaue', episodes_watched: JSON.parse(init.body).episodes_watched, score: null, notes: null });
      }
      return fakeResponse(404, {});
    }));
    const user = { id: 1, username: 'admin', role: 'admin' };
    const { result } = renderHook(() => useAnimeList({ user }));
    await act(() => result.current.fetchAnime());
    expect(result.current.list[0].my_progress.episodes_watched).toBe(7);
    await act(() => result.current.updateProgress(1, { episodes_watched: 8 }));
    expect(result.current.list[0].my_progress.episodes_watched).toBe(8);
    expect(readAnimeCache(1).list[0].my_progress.episodes_watched).toBe(8);
    refuse = true;
    let pending;
    act(() => { pending = result.current.updateProgress(1, { episodes_watched: 9 }); });
    expect(result.current.list[0].my_progress.episodes_watched).toBe(9);
    await act(() => pending);
    expect(result.current.list[0].my_progress.episodes_watched).toBe(8);
  });

  it('offline: the stored list, no request', async () => {
    writeAnimeCache([entry({ title: 'Gespeichert' })], 1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAnimeList({ user: { id: 1, role: 'visitor', offline: true } }));
    await act(() => result.current.fetchAnime());
    expect(result.current.list[0].title).toBe('Gespeichert');
    expect(result.current.fromCache).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tab and statistics', () => {
  it('the fourth tab "Anime" with its count', () => {
    const onSelectView = vi.fn();
    render(<MainViewSwitcher activeMainView="anime" onSelectView={onSelectView} mangaCount={4} animeCount={3} shoppingData={null} radarData={null} />);
    const tab = document.getElementById('btn-nav-anime');
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(tab.textContent).toMatch(/Anime\s*3/);
    fireEvent.click(document.getElementById('btn-nav-radar'));
    expect(onSelectView).toHaveBeenCalledWith('radar');
  });

  it('the anime card of the statistics shows counts and watch time', () => {
    render(<AnimeStatsCard anime={{ total: 4, watching: 1, completed: 2, planned: 1, per_user: [{ user_id: 1, username: 'kim', episodes_watched: 30, watch_minutes: 720 }] }} />);
    expect(screen.getByText('kim')).toBeTruthy();
    expect(screen.getByText(/30 Folgen · 12 Std\./)).toBeTruthy();
    expect(watchTime(3000)).toBe('2 Tage 2 Std.');
    const { container } = render(<AnimeStatsCard anime={{ total: 0 }} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('AnimeDetailModal', () => {
  const open = (anime) => render(
    <MemoryRouter>
      <AnimeDetailModal isOpen animeId={anime.id} fallback={anime} onClose={vi.fn()} canEdit={false}
        fetchDetail={vi.fn(async () => anime)} updateProgress={vi.fn()} removeFromMyList={vi.fn()} update={vi.fn()}
        refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} />
    </MemoryRouter>
  );

  it('has no "Nächste Folge" row without airing data, and shows it (with the estimate) when there is one', async () => {
    const { unmount } = open(entry({ manual: true, next_airing: null }));
    await act(async () => {});
    expect(screen.getByText('Folgen')).toBeTruthy();
    expect(screen.queryByText('Nächste Folge')).toBeNull();
    unmount();

    const at = Math.floor((Date.now() + 3 * 86400000) / 1000);
    open(entry({ next_airing: { episode: 8, at, estimated: true } }));
    await act(async () => {});
    expect(screen.getByText('Nächste Folge').nextElementSibling.textContent).toMatch(/^Folge 8 · in 3 Tagen \(geschätzt\)$/);
  });

  it('the title wraps with hyphens in its language; the close button has a 44 px hit area', async () => {
    open(entry({ title: 'Donaudampfschifffahrtskapitänsabenteuer' }));
    const heading = await screen.findByRole('heading', { name: 'Donaudampfschifffahrtskapitänsabenteuer' });
    expect(heading.getAttribute('lang')).toBe('de');
    expect(heading.className.split(' ')).toEqual(expect.arrayContaining(['break-words', 'hyphens-auto', '[overflow-wrap:anywhere]']));
    expect(screen.getByRole('button', { name: 'Schließen' }).className.split(' ')).toContain('hit-44');
  });
});

