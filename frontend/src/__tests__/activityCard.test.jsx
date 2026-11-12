// Tab "Aktivität" of the statistics page: GET /api/activity by day, each entry linking to its series.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ActivityCard, { activityText } from '../components/modals/stats/ActivityCard';
import { fakeResponse } from './fakeResponse';

afterEach(() => { vi.unstubAllGlobals(); });

describe('activityText', () => {
  it('names person, volumes and series for each kind', () => {
    const base = { manga_id: 1, title: 'Frieren', username: 'Lena' };
    expect(activityText({ ...base, kind: 'read', count: 3, volumes: ['1', '2', '3'] })).toBe('Lena hat Bände 1–3 von „Frieren“ gelesen');
    expect(activityText({ ...base, kind: 'owned', count: 1, volumes: ['4'] })).toBe('Lena besitzt jetzt Band 4 von „Frieren“');
    expect(activityText({ ...base, kind: 'added', username: null, count: 1, volumes: ['5'] })).toBe('Band 5 zu „Frieren“ hinzugefügt');
    expect(activityText({ ...base, kind: 'changed', count: 2, volumes: ['6', '7'] })).toBe('Lena hat Bände 6, 7 von „Frieren“ geändert');
    expect(activityText({ ...base, kind: 'series_added', count: 0, volumes: [] })).toBe('Lena hat „Frieren“ angelegt');
    expect(activityText({ ...base, kind: 'series_changed', count: 0, volumes: [] })).toBe('Lena hat „Frieren“ bearbeitet');
  });
});

describe('ActivityCard', () => {
  it('loads the shelf\'s activity, groups by day and links each entry', async () => {
    const now = new Date();
    const fetchMock = vi.fn(async () => fakeResponse(200, {
      days: 30,
      total: 2,
      items: [
        { kind: 'read', at: now.toISOString(), user_id: 2, username: 'Lena', manga_id: 7, title: 'Frieren', count: 1, volumes: ['2'] },
        { kind: 'owned', at: '2026-01-05T10:00:00Z', user_id: 1, username: 'Max', manga_id: 8, title: 'Dandadan', count: 1, volumes: ['1'] }
      ]
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MemoryRouter><ActivityCard shelfId="5" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Lena hat Band 2 von „Frieren“ gelesen')).toBeTruthy());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/activity?shelf_id=5');
    expect(screen.getByRole('region', { name: 'Heute' })).toBeTruthy();
    expect(screen.getByText('Max besitzt jetzt Band 1 von „Dandadan“').closest('a').getAttribute('href')).toBe('/manga/8');
  });

  it('says so when nothing happened', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, { days: 30, total: 0, items: [] })));
    render(<MemoryRouter><ActivityCard /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('In den letzten 30 Tagen ist nichts passiert.')).toBeTruthy());
  });
});
