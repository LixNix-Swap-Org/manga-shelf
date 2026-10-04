import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook, waitFor } from '@testing-library/react';
import Toaster, { trimToasts } from '../components/common/Toaster';
import BarcodeScannerButton from '../components/common/BarcodeScannerButton';
import GapFillModal from '../components/detail/GapFillModal';
import BatchReadModal, { batchReadUndo } from '../components/detail/BatchReadModal';
import useVolumeActions from '../hooks/useVolumeActions';
import useMpGaps from '../hooks/useMpGaps';
import { notify, notifyResponseError, NOTIFY_EVENT, UNEXPECTED_ERROR, toastText } from '../utils/notify';
import { ApiError } from '../utils/api';
import { buildMpGapMap } from '../utils/volumeHelpers';
import { fakeResponse, htmlResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const json = (status, body) => fakeResponse(status, body);
const bodyOf = (call) => JSON.parse(call[1].body);
const methodOf = (call) => (call[1]?.method || 'GET').toUpperCase();

let toasts;
beforeEach(() => { toasts = recordToasts(); });
afterEach(() => {
  toasts.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const toastOf = (text) => screen.getByText(text).closest('[data-toast]');

describe('notify', () => {
  it('takes strings, ApiErrors with the error ID, and maps other errors to the fallback', () => {
    expect(toastText('Kaputt')).toEqual({ message: 'Kaputt', ref: null });
    expect(toastText(new ApiError('Nicht gefunden.', { status: 404, ref: 'ab12' }))).toEqual({ message: 'Nicht gefunden.', ref: 'ab12' });
    expect(toastText(new TypeError('x is undefined'), 'Upload-Fehler')).toEqual({ message: 'Upload-Fehler', ref: null });
    expect(toastText(new Error('intern'))).toEqual({ message: UNEXPECTED_ERROR, ref: null });
    expect(toastText(Object.assign(new Error('abort'), { name: 'AbortError' }))).toBeNull();
    expect(toastText('')).toBeNull();
  });

  it('an aborted request shows nothing', () => {
    expect(notify.error(Object.assign(new Error('abort'), { name: 'AbortError' }))).toBeNull();
    expect(toasts.list).toEqual([]);
  });

  it('a failed response uses the server text, or the fallback with the status for a proxy page', async () => {
    await notifyResponseError(json(409, { error: 'Band 5 gibt es schon' }), 'Fehler beim Speichern');
    await notifyResponseError(htmlResponse(502), 'Fehler beim Speichern');
    expect(toasts.messages('error')).toEqual(['Band 5 gibt es schon', 'Fehler beim Speichern (HTTP 502)']);
  });

  it('fires a window event for the browser suites', () => {
    const seen = vi.fn();
    window.addEventListener(NOTIFY_EVENT, seen);
    notify.error('Kaputt');
    window.removeEventListener(NOTIFY_EVENT, seen);
    expect(seen.mock.calls[0][0].detail).toEqual({ kind: 'error', message: 'Kaputt' });
  });
});

describe('Toaster', () => {
  it('announces info and success politely and errors as alerts, with the error ID', () => {
    render(<Toaster />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      notify.success('Gespeichert');
      notify.info('Hinweis');
      notify.error(new ApiError('Serverfehler', { status: 500, ref: 'f00d' }));
    });
    expect(status.textContent).toContain('Gespeichert');
    expect(status.textContent).toContain('Hinweis');
    expect(status.textContent).not.toContain('Serverfehler');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Serverfehler');
    expect(alert.textContent).toContain('Fehler-ID: f00d');
  });

  it('info leaves after 5 s, errors after 8 s', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => { notify.info('Kurz'); notify.error('Länger'); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByText('Kurz')).toBeNull();
    expect(screen.getByText('Länger')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText('Länger')).toBeNull();
  });

  it('pauses while hovered or focused and resumes afterwards', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => { notify.info('Bleib'); });
    act(() => { vi.advanceTimersByTime(4000); });
    fireEvent.mouseEnter(toastOf('Bleib'));
    act(() => { vi.advanceTimersByTime(20000); });
    expect(screen.getByText('Bleib')).toBeTruthy();
    fireEvent.mouseLeave(toastOf('Bleib'));
    fireEvent.focus(screen.getByRole('button', { name: 'Meldung schließen' }));
    act(() => { vi.advanceTimersByTime(20000); });
    expect(screen.getByText('Bleib')).toBeTruthy();
    fireEvent.blur(screen.getByRole('button', { name: 'Meldung schließen' }));
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByText('Bleib')).toBeNull();
  });

  it('closes with the close button and with Escape, without the key reaching the page', () => {
    const pageKeys = vi.fn();
    window.addEventListener('keydown', pageKeys);
    render(<Toaster />);
    act(() => { notify.error('Eins'); notify.info('Zwei'); });
    fireEvent.click(screen.getAllByRole('button', { name: 'Meldung schließen' })[0]);
    expect(screen.queryByText('Eins')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Meldung schließen' }), { key: 'Escape' });
    window.removeEventListener('keydown', pageKeys);
    expect(screen.queryByText('Zwei')).toBeNull();
    expect(pageKeys).not.toHaveBeenCalled();
  });

  it('runs the action once and closes the toast', () => {
    const undo = vi.fn();
    render(<Toaster />);
    act(() => { notify.success('Erledigt', { action: { label: 'Rückgängig', onClick: undo } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Erledigt')).toBeNull();
  });

  it('shows a repeated message once, keeps at most four, and notify.dismiss removes one', () => {
    render(<Toaster />);
    let id;
    act(() => {
      notify.error('Netzwerkfehler');
      notify.error('Netzwerkfehler');
    });
    expect(screen.getAllByText('Netzwerkfehler')).toHaveLength(1);
    act(() => { for (let i = 1; i <= 5; i++) id = notify.info(`Meldung ${i}`); });
    expect(document.querySelectorAll('[data-toast]')).toHaveLength(4);
    expect(screen.queryByText('Netzwerkfehler')).toBeNull();
    act(() => { notify.dismiss(id); });
    expect(screen.queryByText('Meldung 5')).toBeNull();
    expect(screen.getByText('Meldung 4')).toBeTruthy();
  });

  it('never evicts a toast with a pending undo; only toasts without an action are capped', () => {
    const undos = [1, 2, 3, 4, 5].map((n) => vi.fn());
    render(<Toaster />);
    act(() => {
      undos.forEach((onClick, i) => notify.success(`Kauf ${i + 1}`, { action: { label: 'Rückgängig', onClick } }));
      notify.error('Kein Barcode erkannt');
      for (let i = 1; i <= 5; i++) notify.info(`Meldung ${i}`);
    });
    expect(screen.getAllByRole('button', { name: 'Rückgängig' })).toHaveLength(5);
    expect(screen.queryByText('Kein Barcode erkannt')).toBeNull();
    expect(screen.queryByText('Meldung 1')).toBeNull();
    expect(screen.getByText('Meldung 5')).toBeTruthy();
    fireEvent.click(toastOf('Kauf 1').querySelector('button'));
    expect(undos[0]).toHaveBeenCalledTimes(1);
  });

  it('trimToasts drops the oldest toasts without an action first', () => {
    const t = (id, action = null) => ({ id, action });
    const list = [t(1), t(2, {}), t(3), t(4), t(5, {}), t(6)];
    expect(trimToasts(list, 2).map((x) => x.id)).toEqual([2, 4, 5, 6]);
    expect(trimToasts(list, 4)).toBe(list);
  });
});

describe('error toasts instead of blocking alerts', () => {
  it('a photo the scanner cannot read reports it without blocking the next scan', async () => {
    const onDetected = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<><BarcodeScannerButton onDetected={onDetected} /><Toaster /></>);
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(['x'], 'scan.jpg', { type: 'image/jpeg' })] } });
    expect((await screen.findByRole('alert')).textContent).toMatch(/Konnte Bild nicht analysieren/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Barcode scannen' }).disabled).toBe(false));
    expect(onDetected).not.toHaveBeenCalled();
  });
});

describe('undo for quick actions', () => {
  it('read toggle: the success toast offers to set the old state again', async () => {
    const fetchMock = vi.fn(async () => json(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const fetchManga = vi.fn(async () => {});
    const { result } = renderHook(() => useVolumeActions({ id: '7', user: { id: 2, role: 'editor' }, canEdit: true, selectedReaderId: 2, fetchManga }));
    await act(() => result.current.handleToggleVolumeRead({ id: 4, volume_number: '4', type: 'volume', read_users: [] }));
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ user_id: 2, read: true });
    const toast = toasts.last();
    expect(toast).toMatchObject({ kind: 'success', message: '„Band 4“ als gelesen markiert' });
    await act(async () => { await toast.action.onClick(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1])).toMatchObject({ user_id: 2, read: false });
    expect(fetchManga).toHaveBeenCalledTimes(2);
  });

  it('read toggle: undo of "ungelesen" restores the original read date the server reports', async () => {
    const fetchMock = vi.fn(async () => json(200, { success: true, is_read: false, previous_read_at: '2024-05-01 10:00:00' }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useVolumeActions({ id: '7', user: { id: 2, role: 'editor' }, canEdit: true, selectedReaderId: 2, fetchManga: vi.fn(async () => {}) }));
    await act(() => result.current.handleToggleVolumeRead({ id: 4, volume_number: '4', type: 'volume', read_users: [{ user_id: 2 }] }));
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ read: false });
    expect(bodyOf(fetchMock.mock.calls[0]).read_at).toBeUndefined();
    const toast = toasts.last();
    expect(toast.message).toBe('„Band 4“ als ungelesen markiert');
    await act(async () => { await toast.action.onClick(); });
    expect(bodyOf(fetchMock.mock.calls[1])).toMatchObject({ user_id: 2, read: true, read_at: '2024-05-01 10:00:00' });
  });

  it('read toggle: no undo for "ungelesen" when the server cannot restore the read date', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { success: true, is_read: false })));
    const { result } = renderHook(() => useVolumeActions({ id: '7', user: { id: 2, role: 'editor' }, canEdit: true, selectedReaderId: 2, fetchManga: vi.fn(async () => {}) }));
    await act(() => result.current.handleToggleVolumeRead({ id: 4, volume_number: '4', type: 'volume', read_users: [{ user_id: 2 }] }));
    expect(toasts.last()).toMatchObject({ message: '„Band 4“ als ungelesen markiert', action: null });
  });

  it('read toggle: no success toast when the request failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { error: 'Datenbank gesperrt' })));
    const { result } = renderHook(() => useVolumeActions({ id: '7', user: { id: 2, role: 'editor' }, canEdit: true, selectedReaderId: 2, fetchManga: vi.fn() }));
    await act(() => result.current.handleToggleVolumeRead({ id: 4, volume_number: '4', read_users: [] }));
    expect(toasts.messages('success')).toEqual([]);
    expect(toasts.messages('error')).toEqual(['Datenbank gesperrt']);
  });

  it('gap fill: Rückgängig deletes the volume that was just created', async () => {
    const fetchMock = vi.fn(async (url, init) => (init?.method === 'DELETE' ? json(200, { success: true }) : json(200, { success: true, id: 55 })));
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn(async () => {});
    render(
      <>
        <GapFillModal isOpen gapNumber={5} onClose={vi.fn()} manga={{ title: 'T' }} mangaId="1" mpGapMap={buildMpGapMap([])} canEdit onSuccess={onSuccess} />
        <Toaster />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: /Auf Einkaufsliste setzen/ }));
    expect(await screen.findByText('Band 5 als „Fehlt“ erfasst')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => methodOf(c) === 'DELETE')).toBe(true));
    const del = fetchMock.mock.calls.find((c) => methodOf(c) === 'DELETE');
    expect(del[0]).toBe('/api/volumes/55');
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(2));
  });

  it('gap fill: a failure is an error toast naming the server text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: 'Band 5 existiert bereits' })));
    render(<><GapFillModal isOpen gapNumber={5} onClose={vi.fn()} manga={{ title: 'T' }} mangaId="1" mpGapMap={buildMpGapMap([])} canEdit /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: /Auf Einkaufsliste setzen/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Band 5 existiert bereits');
  });

  it('batchReadUndo: the changed ids; for "ungelesen" only with every original read date', () => {
    expect(batchReadUndo({ count: 2, changed_ids: [2] }, true)).toEqual({ ids: [2], readAt: null });
    expect(batchReadUndo({ count: 2, changed_ids: [] }, true)).toBeNull();
    expect(batchReadUndo({ count: 2 }, true)).toBeNull();
    expect(batchReadUndo({ changed_ids: [1, 3] }, false)).toBeNull();
    expect(batchReadUndo({ changed_ids: [1, 3], previous_read_at: { 1: '2024-01-01 08:00:00' } }, false)).toBeNull();
    const dates = { 1: '2024-01-01 08:00:00', 3: '2024-02-01 09:00:00' };
    expect(batchReadUndo({ changed_ids: [1, 3], previous_read_at: dates }, false)).toEqual({ ids: [1, 3], readAt: dates });
  });

  it('batch read: Rückgängig resets only the volumes the batch changed, without a pre-batch load', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/volumes/batch-read') return json(200, { success: true, count: 2, changed_ids: [2] });
      return json(200, { success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn(async () => {});
    render(<><BatchReadModal isOpen onClose={vi.fn()} mangaId="9" user={{ id: 2, role: 'editor' }} onSuccess={onSuccess} /><Toaster /></>);
    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    expect(await screen.findByText('2 Bände als gelesen markiert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(2));
    const reverts = fetchMock.mock.calls.filter(([url]) => /^\/api\/volumes\/\d+\/read$/.test(url));
    expect(reverts.map(([url]) => url)).toEqual(['/api/volumes/2/read']);
    expect(bodyOf(reverts[0])).toMatchObject({ user_id: 2, read: false });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/mangas/9')).toBe(false);
  });

  it('batch read "ungelesen": Rückgängig puts every read back with its original date', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url === '/api/volumes/batch-read') {
        return json(200, { success: true, count: 2, changed_ids: [1, 2], previous_read_at: { 1: '2024-01-01 08:00:00', 2: '2024-02-01 09:00:00' } });
      }
      return json(200, { success: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn(async () => {});
    render(<><BatchReadModal isOpen onClose={vi.fn()} mangaId="9" user={{ id: 2, role: 'editor' }} onSuccess={onSuccess} /><Toaster /></>);
    fireEvent.click(screen.getByRole('button', { name: /ungelesen/i }));
    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    expect(await screen.findByText('2 Bände als ungelesen markiert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rückgängig' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(2));
    const reverts = fetchMock.mock.calls.filter(([url]) => /^\/api\/volumes\/\d+\/read$/.test(url));
    expect(reverts.map(bodyOf)).toEqual([
      { user_id: 2, read: true, is_read: true, read_at: '2024-01-01 08:00:00' },
      { user_id: 2, read: true, is_read: true, read_at: '2024-02-01 09:00:00' }
    ]);
  });

  it('gap import: undo is offered when the server lists the new volumes and changed no others', async () => {
    const confirmed = { matched: true, link_confirmed: true, edition: { id: 9, title: 'E' }, gaps: [{ volume_number: '2', type: 'volume' }, { volume_number: '3', type: 'volume' }], discrepancy: null };
    let imported = { success: true, imported_count: 2, updated_count: 0, imported_ids: [31, 32] };
    const fetchMock = vi.fn(async (url, init) => {
      if (url.includes('/gaps')) return json(200, confirmed);
      if (url.endsWith('/batch-import-gaps')) return json(200, imported);
      if (init?.method === 'DELETE') return json(200, { success: true });
      return json(404, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchManga = vi.fn(async () => {});
    const { result } = renderHook(() => useMpGaps({
      id: '1', canEdit: true, volumes: [{ volume_number: '1' }], manga: { total_volumes: 3 }, fetchManga, setShowMpEditionModal: vi.fn()
    }));
    await act(async () => { await result.current.fetchMpGaps(); });
    expect(result.current.detectedGaps).toEqual([2, 3]);
    await act(async () => { await result.current.handleBatchFillGaps('Fehlt'); });
    const toast = toasts.last();
    expect(toast.message).toBe('2 Lücken erfasst');
    await act(async () => { await toast.action.onClick(); });
    expect(fetchMock.mock.calls.filter((c) => methodOf(c) === 'DELETE').map(([url]) => url)).toEqual(['/api/volumes/31', '/api/volumes/32']);

    imported = { success: true, imported_count: 1, updated_count: 1, imported_ids: [33] };
    await act(async () => { await result.current.handleBatchFillGaps('Fehlt'); });
    expect(toasts.last()).toMatchObject({ message: '2 Lücken erfasst', action: null });
  });
});
