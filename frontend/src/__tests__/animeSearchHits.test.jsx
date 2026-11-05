// The header search on the shelf also names matching entries of the anime list.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AnimeSearchHits, { animeSearchHits, ANIME_HIT_LIMIT } from '../components/dashboard/AnimeSearchHits';

const entry = (id, title, over = {}) => ({ id, title, title_de: null, kind: 'anime', my_progress: null, progress_users: [], ...over });
const list = [
  entry(1, 'Sousou no Frieren', { my_progress: { status: 'Schaue', episodes_watched: 3 } }),
  entry(2, 'Cyberpunk: Edgerunners', { kind: 'tv' }),
  entry(3, 'Dandadan'),
  entry(4, 'Frieren: Specials', { kind: 'movie' })
];

describe('animeSearchHits', () => {
  it('matches like the anime tab, from two characters on, nothing for an empty list', () => {
    expect(animeSearchHits(list, 'frieren').map((a) => a.id).sort()).toEqual([1, 4]);
    expect(animeSearchHits(list, 'edgerunner').map((a) => a.id)).toEqual([2]);
    expect(animeSearchHits(list, 'f')).toEqual([]);
    expect(animeSearchHits(list, '  ')).toEqual([]);
    expect(animeSearchHits([], 'frieren')).toEqual([]);
    expect(animeSearchHits(null, 'frieren')).toEqual([]);
  });
});

describe('AnimeSearchHits', () => {
  it('renders nothing without hits', () => {
    const { container } = render(<AnimeSearchHits hits={[]} onOpen={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists the hits with kind and own status; a hit opens it; "Alle im Anime-Tab" only above the limit', () => {
    const onOpen = vi.fn();
    const onShowAll = vi.fn();
    const { rerender } = render(<AnimeSearchHits hits={animeSearchHits(list, 'frieren')} onOpen={onOpen} onShowAll={onShowAll} />);
    expect(screen.getByRole('heading', { name: /In deiner Anime-Liste/ }).textContent).toContain('2 Treffer');
    const frieren = screen.getByRole('button', { name: /Sousou no Frieren/ });
    expect(frieren.textContent).toContain('Schaue');
    expect(screen.getByRole('button', { name: /Frieren: Specials/ }).textContent).toContain('Film');
    fireEvent.click(frieren);
    expect(onOpen).toHaveBeenCalledWith(list[0]);
    expect(screen.queryByRole('button', { name: 'Alle im Anime-Tab' })).toBeNull();

    const many = Array.from({ length: ANIME_HIT_LIMIT + 2 }, (_, i) => entry(10 + i, `Frieren ${i}`));
    rerender(<AnimeSearchHits hits={many} onOpen={onOpen} onShowAll={onShowAll} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(ANIME_HIT_LIMIT);
    fireEvent.click(screen.getByRole('button', { name: 'Alle im Anime-Tab' }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });
});
