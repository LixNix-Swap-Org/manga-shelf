// "Geplant" alone resets the watched episodes to 0 on the server: the change shows a toast with "Rückgängig"
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnimeDetailModal from '../components/modals/AnimeDetailModal';
import { fakeResponse } from './fakeResponse';
import useAnimeList from '../hooks/useAnimeList';
import { resetByPlanned, resetUndoChange } from '../utils/animeHelpers';
import { subscribe as subscribeToasts } from '../utils/notify';

const watching = { status: 'Schaue', episodes_watched: 7, score: 8, notes: null, watched_episodes: [1, 2, 3, 4, 5, 6, 9], episode_scores: { 9: 10 } };
const planned = { status: 'Geplant', episodes_watched: 0, score: 8, notes: null, watched_episodes: null, episode_scores: {} };
const entry = (over = {}) => ({
  id: 1, title: 'Frieren', title_de: null, format: 'TV', season_year: 2023, episodes: 12, cover_image: null, anilist_id: 154587, mal_id: 52991,
  manual: false, next_airing: null, my_progress: watching, progress_users: [], ...over
});
const user = { id: 1, username: 'admin', role: 'admin' };

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('resetByPlanned', () => {
  it('is true only for "Geplant" alone that took watched episodes back to 0', () => {
    expect(resetByPlanned(watching, { status: 'Geplant' }, planned)).toBe(true);
    // an explicit counter, an undo, another status, nothing watched before or a counter the server kept do not count
    expect(resetByPlanned(watching, { status: 'Geplant', episodes_watched: 0 }, planned)).toBe(false);
    expect(resetByPlanned(watching, { status: 'Geplant', restore: true }, planned)).toBe(false);
    expect(resetByPlanned(watching, { status: 'Pausiert' }, { ...watching, status: 'Pausiert' })).toBe(false);
    expect(resetByPlanned({ status: 'Schaue', episodes_watched: 0 }, { status: 'Geplant' }, planned)).toBe(false);
    expect(resetByPlanned(null, { status: 'Geplant' }, planned)).toBe(false);
    expect(resetByPlanned(watching, { status: 'Geplant' }, { ...watching, status: 'Schaue' })).toBe(false);
  });

  it('the undo puts status, counter, single episodes and their ratings back', () => {
    expect(resetUndoChange(watching)).toEqual({
      status: 'Schaue', episodes_watched: 7, restore: true, watched_episodes: [1, 2, 3, 4, 5, 6, 9], episode_scores: { 9: 10 }
    });
    expect(resetUndoChange({ status: 'Gesehen', episodes_watched: 12 })).toEqual({ status: 'Gesehen', episodes_watched: 12, restore: true });
  });
});

describe('useAnimeList: "Geplant" with watched episodes', () => {
  it('shows a toast with "Rückgängig" that restores the progress; an undo runs onUndone and shows no second toast', async () => {
    const puts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (url === '/api/anime') return fakeResponse(200, [entry()]);
      if (url === '/api/anime/1/progress') {
        const body = JSON.parse(init.body);
        puts.push(body);
        return fakeResponse(200, body.restore ? watching : planned);
      }
      return fakeResponse(404, {});
    }));
    const shown = [];
    const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push(e.toast); });
    try {
      const { result } = renderHook(() => useAnimeList({ user }));
      await act(() => result.current.fetchAnime());
      const onUndone = vi.fn();
      await act(() => result.current.updateProgress(1, { status: 'Geplant' }, { onUndone }));
      expect(result.current.list[0].my_progress.episodes_watched).toBe(0);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ kind: 'success', message: 'Frieren: 7 gesehene Folgen zurückgesetzt' });
      expect(shown[0].action.label).toBe('Rückgängig');

      await act(() => shown[0].action.onClick());
      expect(puts[1]).toEqual(resetUndoChange(watching));
      expect(result.current.list[0].my_progress).toMatchObject({ status: 'Schaue', episodes_watched: 7 });
      expect(onUndone).toHaveBeenCalledTimes(1);
      expect(shown).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('shows nothing when no episode was watched or the status is not "Geplant"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (url === '/api/anime') return fakeResponse(200, [entry({ my_progress: { status: 'Schaue', episodes_watched: 0, score: null, notes: null } })]);
      if (url === '/api/anime/1/progress') return fakeResponse(200, { ...planned, ...JSON.parse(init.body) });
      return fakeResponse(404, {});
    }));
    const shown = [];
    const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push(e.toast); });
    try {
      const { result } = renderHook(() => useAnimeList({ user }));
      await act(() => result.current.fetchAnime());
      await act(() => result.current.updateProgress(1, { status: 'Geplant' }));
      await act(() => result.current.updateProgress(1, { status: 'Pausiert' }));
      expect(shown).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe('AnimeDetailModal: "Geplant" with watched episodes', () => {
  const openDetail = (anime, updateProgress) => render(
    <MemoryRouter>
      <AnimeDetailModal isOpen animeId={anime.id} fallback={anime} onClose={vi.fn()} canEdit
        fetchDetail={vi.fn(async () => anime)} updateProgress={updateProgress} removeFromMyList={vi.fn(async () => true)} update={vi.fn(async () => anime)}
        refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} />
    </MemoryRouter>
  );

  it('passes onUndone to updateProgress and leaves the toast to it; any other save keeps "Fortschritt gespeichert"', async () => {
    const shown = [];
    const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push(e.toast.message); });
    try {
      const updateProgress = vi.fn(async (id, change) => (change.status === 'Geplant' ? planned : watching));
      openDetail(entry(), updateProgress);
      await act(async () => {});
      fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Geplant' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' })); });
      expect(updateProgress).toHaveBeenCalledWith(1, { status: 'Geplant' }, { onUndone: expect.any(Function) });
      expect(shown).not.toContain('Fortschritt gespeichert');

      fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'Pausiert' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' })); });
      expect(shown).toContain('Fortschritt gespeichert');
    } finally {
      stop();
    }
  });
});
