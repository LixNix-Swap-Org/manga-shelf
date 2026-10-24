// The "Entdecken" tab of the Anime-Radar: hits with their numbers in the format of the UI language.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import AnimeDiscoverTab from '../components/dashboard/animehub/AnimeDiscoverTab';
import { fakeResponse } from './fakeResponse';

const NOW = new Date(2026, 9, 21, 12);

afterEach(() => vi.unstubAllGlobals());

describe('AnimeDiscoverTab', () => {
  it('shows the AniList score with a decimal comma in German', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, {
      results: [{ anilist_id: 1, title: { preferred: 'Frieren' }, format: 'TV', episodes: 28, score: 85, because: ['Mushishi'] }],
      seeds: 1,
      has_next: false
    })));
    render(<AnimeDiscoverTab canEdit now={NOW} onAdd={vi.fn()} onOpenId={vi.fn()} />);
    const title = await screen.findByText('Frieren');
    const line = title.parentElement.querySelector('p.text-xs').textContent;
    expect(line).toMatch(/28 Folgen · ★ 8,5$/);
  });
});
