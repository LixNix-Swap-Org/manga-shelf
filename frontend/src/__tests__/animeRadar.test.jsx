import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnimeRadarView from '../components/dashboard/AnimeRadarView';
import { newEpisodes, mangaLinks } from '../utils/animeHelpers';

const NOW = new Date('2026-10-11T12:00:00Z');
const at = (days) => Math.floor((NOW.getTime() + days * 86400000) / 1000);
const entry = (id, over = {}) => ({ id, title: `Anime ${id}`, kind: 'anime', my_progress: { status: 'Schaue', episodes_watched: 3 }, ...over });

describe('newEpisodes', () => {
  it('lists upcoming airings soonest first and the episodes already out but not watched', () => {
    const list = [
      entry(1, { next_airing: { episode: 6, at: at(3) }, status: 'RELEASING' }),
      entry(2, { next_airing: { episode: 9, at: at(1) }, my_progress: { status: 'Schaue', episodes_watched: 8 } }),
      entry(3, { next_airing: { episode: 4, at: at(2) }, my_progress: { status: 'Gesehen', episodes_watched: 3 } }),
      entry(4, { kind: 'movie', next_airing: { episode: 1, at: at(2) } }),
      entry(5, { next_airing: null, status: 'FINISHED', episodes: 12, my_progress: { status: 'Schaue', episodes_watched: 10 } }),
      entry(6, { my_progress: null, next_airing: { episode: 2, at: at(1) } })
    ];
    const { upcoming, behind } = newEpisodes(list, NOW);
    expect(upcoming.map((a) => a.id)).toEqual([2, 1]);
    expect(behind.map((b) => [b.anime.id, b.missing])).toEqual([[1, 2], [5, 2]]);
  });
});

describe('mangaLinks', () => {
  const mangas = [{ id: 7, title: 'Frieren', alt_title: 'Sousou no Frieren' }, { id: 8, title: 'Mob' }];
  it('splits linked entries, suggestions by title and the rest', () => {
    const list = [
      entry(1, { manga_id: 8 }),
      entry(2, { title: 'Sousou no Frieren' }),
      entry(3, { title: 'Frieren: Beyond Journey’s End' }),
      entry(4, { title: 'Something else' }),
      entry(5, { manga_id: 99 })
    ];
    const r = mangaLinks(list, mangas);
    expect(r.linked.map((l) => [l.anime.id, l.manga?.id ?? null])).toEqual([[1, 8], [5, null]]);
    expect(r.suggestions.map((s) => [s.anime.id, s.manga.id])).toEqual([[3, 7], [2, 7]]);
    expect(r.unlinked.map((a) => a.id)).toEqual([4]);
  });
});

describe('AnimeRadarView', () => {
  const props = { loaded: true, canEdit: true, onOpen: vi.fn(), onRetry: vi.fn(), now: NOW };
  it('shows the new episodes first and opens an entry', () => {
    const onOpen = vi.fn();
    render(<MemoryRouter><AnimeRadarView {...props} onOpen={onOpen} mangas={[]} list={[entry(1, { next_airing: { episode: 6, at: at(1) } })]} /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: 'Neue Folgen', selected: true })).toBeTruthy();
    expect(screen.getByText(/Folge 6/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Anime 1' })[0]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
  it('links a suggestion and unlinks a linked entry', async () => {
    const onLink = vi.fn().mockResolvedValue();
    const list = [entry(2, { title: 'Frieren' }), entry(3, { manga_id: 8 })];
    render(<MemoryRouter><AnimeRadarView {...props} onLink={onLink} mangas={[{ id: 7, title: 'Frieren' }, { id: 8, title: 'Mob', total_volumes: 16, regular_owned: 4 }]} list={list} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Manga-Verknüpfung' }));
    expect(screen.getByText(/4 \/ 16 Bände/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Verknüpfen/ }));
    await waitFor(() => expect(onLink).toHaveBeenCalledWith(2, 7));
    fireEvent.click(screen.getByRole('button', { name: 'Verknüpfung lösen' }));
    await waitFor(() => expect(onLink).toHaveBeenCalledWith(3, null));
  });
});
