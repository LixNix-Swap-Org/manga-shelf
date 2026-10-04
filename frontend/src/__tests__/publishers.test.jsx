// PublishersModal and its suggested merge target.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PublishersModal, { suggestedTarget } from '../components/modals/PublishersModal';
import Toaster from '../components/common/Toaster';
import { fakeResponse } from './fakeResponse';

const listing = () => ({
  publishers: [
    { name: 'Carlsen Manga', canonical: 'Carlsen Manga', series_count: 10, volume_count: 80, known: true, outdated: false },
    { name: 'Carlsen', canonical: 'Carlsen', series_count: 2, volume_count: 3, known: false, outdated: false },
    { name: 'Egmont Manga & Anime', canonical: 'Egmont Manga', series_count: 1, volume_count: 0, known: true, outdated: true }
  ],
  aliases: [{ alias: 'ema', canonical: 'Egmont Manga' }]
});

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/api/publishers')) return fakeResponse(200, listing());
    if (path.endsWith('/api/publishers/merge')) {
      const body = JSON.parse(init.body);
      return fakeResponse(200, { success: true, to: body.to, updated_series: 2, updated_volumes: 3 });
    }
    if (init.method === 'DELETE') return fakeResponse(200, { success: true });
    return fakeResponse(404, { error: 'unbekannt' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

const posted = () => fetchMock.mock.calls.filter(([, init = {}]) => init.method === 'POST').map(([url, init]) => [String(url).replace(/^.*\/api/, '/api'), JSON.parse(init.body)]);

describe('PublishersModal', () => {
  it('suggests the selected spelling with the most entries as the target', () => {
    const { publishers } = listing();
    expect(suggestedTarget(publishers, ['Carlsen', 'Carlsen Manga'])).toBe('Carlsen Manga');
    expect(suggestedTarget(publishers, ['Egmont Manga & Anime'])).toBe('Egmont Manga');
    expect(suggestedTarget(publishers, [])).toBe('');
  });

  it('lists spellings with counts and marks outdated and unknown ones', async () => {
    render(<PublishersModal onClose={vi.fn()} user={{ id: 1, role: 'admin' }} />);
    expect(await screen.findByText('→ Egmont Manga')).toBeTruthy();
    expect(screen.getByText('nicht in der Verlagsliste')).toBeTruthy();
    expect(screen.getByText('10 Reihen · 80 Bände')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Verlage filtern'), { target: { value: 'egmont' } });
    expect(screen.queryByText('Carlsen Manga')).toBeNull();
  });

  it('merges the selected spellings into the target and reports what changed', async () => {
    const onChanged = vi.fn();
    render(<><PublishersModal onClose={vi.fn()} user={{ id: 1, role: 'admin' }} onChanged={onChanged} /><Toaster /></>);
    fireEvent.click(await screen.findByLabelText('Carlsen auswählen'));
    fireEvent.click(screen.getByLabelText('Carlsen Manga auswählen'));
    const target = screen.getByLabelText(/zusammenführen als/);
    expect(target.value).toBe('Carlsen');
    fireEvent.change(target, { target: { value: 'Carlsen Manga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zusammenführen' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(posted()).toEqual([['/api/publishers/merge', { from: ['Carlsen'], to: 'Carlsen Manga' }]]);
    expect(await screen.findByText('2 Reihen und 3 Bände auf „Carlsen Manga“ umgestellt')).toBeTruthy();
  });

  it('one spelling and a new name is a rename', async () => {
    render(<PublishersModal onClose={vi.fn()} user={{ id: 1, role: 'admin' }} />);
    fireEvent.click(await screen.findByLabelText('Carlsen auswählen'));
    expect(screen.getByRole('button', { name: 'Zusammenführen' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/zusammenführen als/), { target: { value: 'Carlsen Comics' } });
    fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    await waitFor(() => expect(posted()).toEqual([['/api/publishers/merge', { from: ['Carlsen'], to: 'Carlsen Comics' }]]));
  });

  it('admins remove a stored spelling; others only read', async () => {
    const { unmount } = render(<PublishersModal onClose={vi.fn()} user={{ id: 1, role: 'admin' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Schreibweise „ema“ entfernen' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init = {}]) => init.method === 'DELETE' && String(url).endsWith('/api/publishers/aliases/ema'))).toBe(true));
    unmount();
    render(<PublishersModal onClose={vi.fn()} user={{ id: 2, role: 'editor' }} />);
    await screen.findByText('→ Egmont Manga');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Zusammenführen|Umbenennen/ })).toBeNull();
  });
});
