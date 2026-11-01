// The episode field of the anime detail cuts a number above the episode count and says so (like the chapter field)
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AnimeDetailModal from '../components/modals/AnimeDetailModal';

const anime = {
  id: 1, title: 'Frieren', title_de: null, format: 'TV', season_year: 2023, episodes: 28, cover_image: null, anilist_id: 154587, mal_id: 52991,
  manual: false, next_airing: null, my_progress: { status: 'Schaue', episodes_watched: 7, score: null, notes: null }, progress_users: []
};

describe('AnimeDetailModal: episode count', () => {
  it('a number above the total becomes the total with a hint; saving sends the total and clears the hint', async () => {
    const updateProgress = vi.fn(async () => ({ status: 'Gesehen', episodes_watched: 28 }));
    render(
      <MemoryRouter>
        <AnimeDetailModal isOpen animeId={1} fallback={anime} onClose={vi.fn()} canEdit
          fetchDetail={vi.fn(async () => anime)} updateProgress={updateProgress} removeFromMyList={vi.fn(async () => true)} update={vi.fn(async () => anime)}
          refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} />
      </MemoryRouter>
    );
    await act(async () => {});
    const field = screen.getByLabelText('Gesehene Folgen (von 28)');
    fireEvent.change(field, { target: { value: '30' } });
    expect(field.value).toBe('28');
    const hint = screen.getByText('Dieser Eintrag hat 28 Folgen – mehr geht nicht.');
    expect(field.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.change(field, { target: { value: '12' } });
    expect(screen.queryByText(/mehr geht nicht/)).toBeNull();
    fireEvent.change(field, { target: { value: '99' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' })); });
    expect(updateProgress).toHaveBeenCalledWith(1, { episodes_watched: 28 });
    expect(screen.queryByText(/mehr geht nicht/)).toBeNull();
  });
});
