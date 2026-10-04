import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import TrashModal, { trashEntryLabel } from '../components/modals/TrashModal';
import Toaster from '../components/common/Toaster';
import { fakeResponse } from './fakeResponse';

const items = () => [
  { id: 3, kind: 'manga', ref_id: 7, manga_id: 7, title: 'One Piece', deleted_at: '2026-10-03 10:00:00', deleted_by_name: 'anna', purge_at: '2026-11-02', cover_image: null, volume_count: 12, owned_count: 10, restorable: true },
  { id: 2, kind: 'volume', ref_id: 40, manga_id: 7, title: 'One Piece', deleted_at: '2026-10-02 10:00:00', deleted_by_name: null, purge_at: '2026-11-01', volume_number: '5', type: 'volume', restorable: false, series_in_trash: true }
];

let fetchMock;
let trash;
beforeEach(() => {
  trash = items();
  fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url);
    const method = init.method || 'GET';
    if (path.endsWith('/api/trash') && method === 'GET') return fakeResponse(200, { items: trash, retention_days: 30 });
    if (path.endsWith('/restore')) {
      trash = trash.filter(t => !path.includes(`/trash/${t.id}/`));
      return fakeResponse(200, { success: true });
    }
    if (method === 'DELETE' && /\/api\/trash\/\d+$/.test(path)) return fakeResponse(200, { success: true });
    if (method === 'DELETE') return fakeResponse(200, { success: true, removed: 2 });
    return fakeResponse(404, { error: 'unbekannt' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

const calls = (method) => fetchMock.mock.calls.filter(([, init = {}]) => (init.method || 'GET') === method).map(([url]) => String(url).replace(/^.*\/api/, '/api'));

describe('TrashModal', () => {
  it('labels series and volumes and says when an entry goes for good', async () => {
    expect(trashEntryLabel(items()[0])).toBe('Reihe · 12 Einträge');
    expect(trashEntryLabel(items()[1])).toBe('Band 5');
    render(<TrashModal onClose={vi.fn()} user={{ id: 1, role: 'editor' }} />);
    const list = await screen.findByRole('list', { name: 'Gelöschte Einträge' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/von anna/);
    expect(rows[0].textContent).toMatch(/endgültig weg am 02\.11\.2026/);
    expect(rows[1].textContent).toMatch(/zuerst die Reihe wiederherstellen/);
    expect(within(rows[1]).getByRole('button', { name: /Wiederherstellen|wiederherstellen/ }).disabled).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Papierkorb' })).toBeTruthy();
  });

  it('restores an entry, reports it and lets the caller reload', async () => {
    const onChanged = vi.fn();
    render(<><TrashModal onClose={vi.fn()} user={{ id: 1, role: 'editor' }} onChanged={onChanged} /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: '„One Piece“ Reihe · 12 Einträge wiederherstellen' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls('POST')).toEqual(['/api/trash/3/restore']);
    expect(await screen.findByText('„One Piece“ wiederhergestellt')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
  });

  it('shows the server message when a restore is refused', async () => {
    fetchMock.mockImplementationOnce(async () => fakeResponse(200, { items: [{ ...items()[0] }], retention_days: 30 }));
    fetchMock.mockImplementationOnce(async () => fakeResponse(409, { error: 'Die Reihe existiert bereits', code: 'TRASH_ID_TAKEN' }));
    const onChanged = vi.fn();
    render(<><TrashModal onClose={vi.fn()} user={{ id: 1, role: 'admin' }} onChanged={onChanged} /><Toaster /></>);
    fireEvent.click(await screen.findByRole('button', { name: /wiederherstellen$/ }));
    expect(await screen.findByText(/Die Reihe existiert bereits/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('deletes for good only after a second click; admins can empty the trash', async () => {
    render(<TrashModal onClose={vi.fn()} user={{ id: 1, role: 'admin' }} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '„One Piece“ Band 5 endgültig löschen' }));
    expect(calls('DELETE')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Wirklich löschen?' }));
    await waitFor(() => expect(calls('DELETE')).toEqual(['/api/trash/2']));

    fireEvent.click(await screen.findByRole('button', { name: 'Papierkorb leeren' }));
    fireEvent.click(screen.getByRole('button', { name: 'Wirklich alles endgültig löschen?' }));
    await waitFor(() => expect(calls('DELETE')).toEqual(['/api/trash/2', '/api/trash']));
  });

  it('visitors see the entries without any action', async () => {
    render(<TrashModal onClose={vi.fn()} user={{ id: 3, role: 'visitor' }} />);
    await screen.findByRole('list', { name: 'Gelöschte Einträge' });
    expect(screen.queryByRole('button', { name: /wiederherstellen/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Papierkorb leeren' })).toBeNull();
  });

  it('Escape closes the dialog; an empty trash says so', async () => {
    trash = [];
    const onClose = vi.fn();
    render(<TrashModal onClose={onClose} user={{ id: 1, role: 'editor' }} />);
    expect(await screen.findByText('Der Papierkorb ist leer.')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
