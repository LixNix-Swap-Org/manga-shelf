import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnimeRadarView from '../components/dashboard/AnimeRadarView';
import { newEpisodes, mangaLinks } from '../utils/animeHelpers';

const NOW = new Date('2026-10-11T12:00:00Z');
const at = (days) => Math.floor((NOW.getTime() + days * 86400000) / 1000);
const entry = (id, over = {}) => ({ id, title: `Anime ${id}`, kind: 'anime', my_progress: { status: 'Schaue', episodes_watched: 3 }, ...over });

describe('newEpisodes', () => {
  it('lists upcoming airings soonest first and the aired episodes not watched of shows still airing', () => {
    const list = [
      entry(1, { next_airing: { episode: 6, at: at(3) }, status: 'RELEASING' }),
      entry(2, { next_airing: { episode: 9, at: at(1) }, my_progress: { status: 'Schaue', episodes_watched: 8 } }),
      entry(3, { next_airing: { episode: 4, at: at(2) }, my_progress: { status: 'Gesehen', episodes_watched: 3 } }),
      entry(4, { kind: 'movie', next_airing: { episode: 1, at: at(2) } }),
      entry(5, { next_airing: null, status: 'FINISHED', episodes: 12, my_progress: { status: 'Schaue', episodes_watched: 10 } }),
      entry(6, { my_progress: null, next_airing: { episode: 2, at: at(1) } }),
      entry(7, { next_airing: { episode: 10, at: at(4) }, my_progress: { status: 'Geplant', episodes_watched: 0 } })
    ];
    const { upcoming, behind } = newEpisodes(list, NOW);
    expect(upcoming.map((a) => a.id)).toEqual([2, 1, 7]);
    expect(behind.map((b) => [b.anime.id, b.missing])).toEqual([[1, 2]]);
  });

  it('leaves finished shows and estimated airings out of "Zum Nachschauen"', () => {
    const list = [
      entry(1, { status: 'FINISHED', episodes: 24, next_airing: null }),
      entry(2, { status: 'RELEASING', next_airing: { episode: 8, at: at(2), estimated: true } }),
      entry(3, { status: 'RELEASING', next_airing: { episode: 8, at: at(2) } })
    ];
    const { upcoming, behind } = newEpisodes(list, NOW);
    expect(behind.map((b) => [b.anime.id, b.missing])).toEqual([[3, 4]]);
    expect(upcoming.map((a) => a.id)).toEqual([2, 3]);
  });

  it('counts the episode of a next airing that already lies in the past', () => {
    const { upcoming, behind } = newEpisodes([entry(1, { next_airing: { episode: 6, at: at(-2) } })], NOW);
    expect(upcoming).toEqual([]);
    expect(behind.map((b) => [b.anime.id, b.missing])).toEqual([[1, 3]]);
  });

  it('counts the missing episodes by the single marks', () => {
    const list = [
      entry(1, { next_airing: { episode: 11, at: at(1) }, my_progress: { status: 'Schaue', episodes_watched: 3, watched_episodes: [1, 2, 10] } }),
      entry(2, { next_airing: { episode: 4, at: at(1) }, my_progress: { status: 'Schaue', episodes_watched: 3, watched_episodes: [1, 2, 9] } })
    ];
    const { behind } = newEpisodes(list, NOW);
    expect(behind.map((b) => [b.anime.id, b.missing])).toEqual([[1, 7], [2, 1]]);
  });

  it('sorts "Zum Nachschauen" by the next airing, then by the most missing episodes', () => {
    const list = [
      entry(1, { next_airing: { episode: 5, at: at(3) } }),
      entry(2, { next_airing: { episode: 5, at: at(1) } }),
      entry(3, { next_airing: { episode: 9, at: at(1) } }),
      entry(4, { next_airing: { episode: 6, at: at(-1) } })
    ];
    expect(newEpisodes(list, NOW).behind.map((b) => [b.anime.id, b.missing])).toEqual([[4, 3], [3, 5], [2, 1], [1, 1]]);
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
      entry(5, { manga_id: 99 }),
      entry(6, { title: 'Another one' })
    ];
    const r = mangaLinks(list, mangas);
    expect(r.linked.map((l) => [l.anime.id, l.manga?.id ?? null])).toEqual([[1, 8], [5, null]]);
    expect(r.suggestions.map((s) => [s.anime.id, s.manga.id])).toEqual([[3, 7], [2, 7]]);
    expect(r.unlinked.map((a) => a.id)).toEqual([6, 4]);
  });

  it('prefers a series with the same title over an earlier one that only starts with it', () => {
    const shelf = [{ id: 1, title: 'Frieren Extra Stories' }, { id: 2, title: 'Frieren' }];
    expect(mangaLinks([entry(1, { title: 'Frieren' })], shelf).suggestions.map((s) => s.manga.id)).toEqual([2]);
    expect(mangaLinks([entry(1, { title: 'Frieren Extra Stories' })], [shelf[1]]).suggestions.map((s) => s.manga.id)).toEqual([2]);
  });

  it('matches titles in other scripts', () => {
    const shelf = [{ id: 1, title: 'Kusuriya no Hitorigoto', alt_title: '薬屋のひとりごと' }, { id: 2, title: 'Поднятие уровня в одиночку' }];
    const list = [
      entry(1, { title: 'The Apothecary Diaries', title_native: '薬屋のひとりごと' }),
      entry(2, { title: 'Поднятие уровня в одиночку' }),
      entry(3, { title: 'ダンジョン飯' })
    ];
    const r = mangaLinks(list, shelf);
    expect(r.suggestions.map((s) => [s.anime.id, s.manga.id])).toEqual([[1, 1], [2, 2]]);
    expect(r.unlinked.map((a) => a.id)).toEqual([3]);
  });
});

describe('AnimeRadarView', () => {
  const props = { loaded: true, canEdit: true, onOpen: vi.fn(), onRetry: vi.fn(), now: NOW };
  it('shows the new episodes first and opens an entry', () => {
    const onOpen = vi.fn();
    render(<MemoryRouter><AnimeRadarView {...props} onOpen={onOpen} mangas={[]} list={[entry(1, { next_airing: { episode: 6, at: at(1) } })]} /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: 'Neue Folgen', selected: true })).toBeTruthy();
    expect(screen.getByText(/Folge 6/)).toBeTruthy();
    expect(screen.getByText('3 Folgen gesehen')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Zum Nachschauen 1' })).toBeTruthy();
    expect(screen.getByText('2 Folgen offen')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Anime 1' })[0]);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
  it('links a suggestion and unlinks a linked entry', async () => {
    const onLink = vi.fn().mockResolvedValue();
    const list = [entry(2, { title: 'Frieren' }), entry(3, { manga_id: 8 })];
    render(<MemoryRouter><AnimeRadarView {...props} onLink={onLink} mangas={[{ id: 7, title: 'Frieren' }, { id: 8, title: 'Mob', total_volumes: 16, regular_owned: 4 }]} list={list} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Manga-Verknüpfung' }));
    expect(screen.getByText(/4 von 16 Bänden/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Verknüpfen/ }));
    await waitFor(() => expect(onLink).toHaveBeenCalledWith(2, 7));
    fireEvent.click(screen.getByRole('button', { name: 'Verknüpfung lösen' }));
    await waitFor(() => expect(onLink).toHaveBeenCalledWith(3, null));
  });
  it('lists the entries without a link and links one through the series select', async () => {
    let finish;
    const onLink = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const mangas = [{ id: 8, title: 'Mob' }, { id: 7, title: 'Frieren' }, { id: 9, title: 'Akira' }];
    const list = [entry(2, { title: 'Frieren' }), entry(3, { manga_id: 8 }), entry(4, { title: 'Something else' })];
    render(<MemoryRouter><AnimeRadarView {...props} onLink={onLink} mangas={mangas} list={list} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Manga-Verknüpfung' }));
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual(['Anime-Radar', 'Vorschläge 1', 'Verknüpft 1', 'Ohne Verknüpfung 1']);
    const select = screen.getByRole('combobox', { name: 'Reihe für „Something else“ wählen' });
    expect([...select.options].map((o) => o.textContent)).toEqual(['Reihe wählen…']);
    fireEvent.focus(select);
    expect([...select.options].map((o) => o.textContent)).toEqual(['Reihe wählen…', 'Akira', 'Frieren', 'Mob']);
    fireEvent.change(select, { target: { value: '9' } });
    expect(onLink).toHaveBeenCalledWith(4, 9);
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('9');
    finish();
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe('');
  });
  it('asks the source once for the cover of an entry that has a source ID and no cover', async () => {
    const onRefreshCover = vi.fn().mockResolvedValue({});
    const list = [entry(901, { anilist_id: 5, cover_image: null }), entry(902, { anilist_id: 6, cover_image: '/uploads/a.jpg' }), entry(903, { cover_image: null })];
    const { rerender } = render(<MemoryRouter><AnimeRadarView {...props} onRefreshCover={onRefreshCover} mangas={[]} list={list} /></MemoryRouter>);
    await waitFor(() => expect(onRefreshCover).toHaveBeenCalledWith(901));
    rerender(<MemoryRouter><AnimeRadarView {...props} onRefreshCover={onRefreshCover} mangas={[]} list={[...list]} /></MemoryRouter>);
    expect(onRefreshCover).toHaveBeenCalledTimes(1);
  });

  it('shows the entries without a link to readers without a select', () => {
    render(<MemoryRouter><AnimeRadarView {...props} canEdit={false} onLink={vi.fn()} mangas={[{ id: 7, title: 'Frieren' }]} list={[entry(2, { title: 'Frieren' }), entry(4, { title: 'Something else' })]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Manga-Verknüpfung' }));
    expect(screen.getByRole('heading', { name: 'Ohne Verknüpfung 1' })).toBeTruthy();
    expect(screen.getByText('Something else')).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Verknüpfen/ })).toBeNull();
  });
  it('shows the empty state only without any entry', () => {
    const empty = /Noch keine Verknüpfung/;
    const { unmount } = render(<MemoryRouter><AnimeRadarView {...props} onLink={vi.fn()} mangas={[{ id: 7, title: 'Frieren' }]} list={[entry(4, { title: 'Something else' })]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Manga-Verknüpfung' }));
    expect(screen.queryByText(empty)).toBeNull();
    unmount();
    render(<MemoryRouter><AnimeRadarView {...props} onLink={vi.fn()} mangas={[{ id: 7, title: 'Frieren' }]} list={[]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Manga-Verknüpfung' }));
    expect(screen.getByText(empty)).toBeTruthy();
  });
});
