import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CleanupModal from '../components/modals/CleanupModal';
import { fakeResponse } from './fakeResponse';

const report = () => ({
  generated_at: '2026-10-04T00:00:00Z',
  today: '2026-10-04',
  limit: 50,
  checks: [
    { id: 'duplicate_titles', count: 1, items: [{ key: 'naruto', title: 'Naruto', series: [{ id: 1, title: 'Naruto', publisher: 'Carlsen Manga' }, { id: 2, title: 'Naruto', publisher: 'Carlsen Massiv' }] }] },
    { id: 'series_without_cover', count: 0, items: [] },
    { id: 'overdue_preorders', count: 2, items: [{ id: 11, manga_id: 1, title: 'Naruto', volume_number: '72', type: 'volume', release_date: '2026-09-01' }, { id: 12, manga_id: 1, title: 'Naruto', volume_number: '73', type: 'volume', release_date: '2026-09-15' }] },
    { id: 'legacy_read_status', count: 1, fix: 'legacy_read', items: [{ id: 13, manga_id: 2, title: 'Naruto', volume_number: '1', type: 'volume' }] },
    { id: 'publishers_unknown', count: 60, items: [{ name: 'Kleinverlag', series_count: 1, volume_count: 2 }] }
  ]
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/api/maintenance/quality')) return fakeResponse(200, report());
    if (path.endsWith('/api/maintenance/fix')) return fakeResponse(200, { success: true, changed: 1 });
    if (path.endsWith('/api/volumes/bulk')) return fakeResponse(200, { success: true, updated: 2 });
    return fakeResponse(404, { error: 'unbekannt' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

const posted = () => fetchMock.mock.calls.filter(([, init = {}]) => init.method === 'POST').map(([url, init]) => [String(url).replace(/^.*\/api/, '/api'), JSON.parse(init.body)]);
const ui = (props = {}) => <MemoryRouter><CleanupModal onClose={vi.fn()} user={{ id: 1, role: 'admin' }} {...props} /></MemoryRouter>;

describe('CleanupModal', () => {
  it('lists the open checks with counts and links; checks without findings are summed up', async () => {
    render(ui());
    const dup = await screen.findByText('Gleicher Titel mehrfach');
    const box = dup.closest('details');
    expect(within(box).getByRole('link', { name: 'Naruto (Carlsen Massiv)' }).getAttribute('href')).toBe('/manga/2');
    expect(screen.getByText(/In Ordnung: Reihen ohne Cover/)).toBeTruthy();
    const pubs = screen.getByText('Verlage außerhalb der Verlagsliste').closest('details');
    expect(within(pubs).getByText('… und 59 weitere')).toBeTruthy();
  });

  it('runs a safe fix and the overdue pre-orders only after a second click', async () => {
    const onChanged = vi.fn();
    render(ui({ onChanged }));
    fireEvent.click(await screen.findByRole('button', { name: 'Jetzt umstellen' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Als vorhanden markieren…' }));
    fireEvent.click(screen.getByRole('button', { name: '2 Bände wirklich als vorhanden markieren?' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(posted()).toEqual([
      ['/api/maintenance/fix', { check: 'legacy_read' }],
      ['/api/volumes/bulk', { ids: [11, 12], set: { status: 'Vorhanden' } }]
    ]);
  });

  it('admins jump to the publisher merge; visitors get no actions', async () => {
    const onOpenPublishers = vi.fn();
    const { unmount } = render(ui({ onOpenPublishers }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verlage zusammenführen…' }));
    expect(onOpenPublishers).toHaveBeenCalled();
    unmount();
    render(ui({ user: { id: 3, role: 'visitor' }, onOpenPublishers }));
    await screen.findByText('Gleicher Titel mehrfach');
    expect(screen.queryByRole('button', { name: /umstellen|markieren|zusammenführen/ })).toBeNull();
  });
});
