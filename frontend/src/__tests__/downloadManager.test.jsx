import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import CsvExchangeModal from '../components/dashboard/CsvExchangeModal';
import { setServer } from '../utils/api';
import { cancelAllDownloads, downloadsRunning, startDownload, watchDownload } from '../app/downloadManager';
import { recordToasts } from './toastLog';
import { subscribe } from '../utils/notify';
import Toaster from '../components/common/Toaster';

const MB = 1024 * 1024;

/** fetch answers with a body stream the test feeds; `signal` is the request's signal. */
function streamingFetch({ total = 2 * MB, filename = 'sammlung.csv' } = {}) {
  const state = { signal: null, stream: null, respond: null };
  const fetchMock = vi.fn((url, opts) => {
    state.signal = opts.signal;
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new DOMException('aborted', 'AbortError');
        reject(err);
        try { state.stream?.error(err); } catch (_) { /* already closed */ }
      });
      state.respond = () => resolve(new Response(new ReadableStream({ start(c) { state.stream = c; } }), {
        status: 200,
        headers: { 'Content-Length': String(total), 'Content-Disposition': `attachment; filename="${filename}"` }
      }));
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return state;
}

let toasts;
let clickSpy;
let urls;
beforeEach(() => {
  toasts = recordToasts();
  vi.stubEnv('VITE_APP_MODE', 'app');
  setServer({ base: 'https://shelf.example.org', token: 'tok' });
  urls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(async () => {
  cancelAllDownloads();
  await waitFor(() => expect(downloadsRunning()).toBe(false));
  toasts.stop();
  Object.assign(URL, urls);
  clickSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setServer({ base: '', token: '' });
});

const savedNames = () => clickSpy.mock.contexts.map((a) => a.download);

describe('downloads outlive their dialog (app build)', () => {
  it('Escape and the backdrop wait for the download; after closing it goes on with a toast and the file is saved', async () => {
    const net = streamingFetch();
    const onClose = vi.fn();
    const { unmount } = render(<CsvExchangeModal isOpen onClose={onClose} canEdit={false} />);
    fireEvent.click(document.getElementById('btn-export-csv'));
    expect(await screen.findByText('Lädt… 0 MB')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('data-busy')).toBe('true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Schließen' })[0]);
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    await waitFor(() => expect(toasts.messages('info')).toEqual(['Download läuft weiter (Lädt… 0 MB)']));
    expect(toasts.last().duration).toBe(0);
    expect(toasts.last().action.label).toBe('Abbrechen');
    expect(net.signal.aborted).toBe(false);

    await act(async () => { net.respond(); });
    await waitFor(() => expect(net.stream).not.toBeNull());
    const updates = [];
    const stopUpdates = subscribe((event) => { if (event.type === 'update') updates.push([event.id, event.message]); });
    await act(async () => { net.stream.enqueue(new Uint8Array(MB)); });
    await waitFor(() => expect(updates).toEqual([[toasts.last().id, 'Download läuft weiter (Lädt… 1 von 2 MB)']]));
    stopUpdates();
    expect(toasts.messages('info')).toEqual(['Download läuft weiter (Lädt… 0 MB)']);
    await act(async () => { net.stream.enqueue(new Uint8Array(MB)); net.stream.close(); });
    await waitFor(() => expect(toasts.messages('success')).toEqual(['Download gespeichert: sammlung.csv']));
    expect(savedNames()).toEqual(['sammlung.csv']);
    expect(downloadsRunning()).toBe(false);
    expect(dialog.isConnected).toBe(false);
  });

  it('the progress changes the shown toast in place; a toast the user closed does not come back', async () => {
    const net = streamingFetch({ total: 10 * MB });
    render(<Toaster />);
    startDownload('/api/backup');
    watchDownload('/api/backup')();
    const text = await screen.findByText('Download läuft weiter (Lädt… 0 MB)');
    const toast = text.closest('[data-toast]');
    await act(async () => { net.respond(); });
    await waitFor(() => expect(net.stream).not.toBeNull());
    await act(async () => { net.stream.enqueue(new Uint8Array(2 * MB)); });
    await waitFor(() => expect(text.textContent).toBe('Download läuft weiter (Lädt… 2 von 10 MB)'));
    expect(text.closest('[data-toast]')).toBe(toast);
    expect(text.getAttribute('aria-live')).toBe('off');
    expect(document.querySelectorAll('[data-toast]')).toHaveLength(1);
    expect(toasts.list).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Meldung schließen' }));
    await act(async () => { net.stream.enqueue(new Uint8Array(3 * MB)); });
    await act(async () => { net.stream.enqueue(new Uint8Array(3 * MB)); });
    expect(document.querySelectorAll('[data-toast]')).toHaveLength(0);
    expect(toasts.list).toHaveLength(1);
    await act(async () => { net.stream.enqueue(new Uint8Array(2 * MB)); net.stream.close(); });
    await waitFor(() => expect(screen.getByText('Download gespeichert: sammlung.csv')).toBeTruthy());
  });

  it('the toast action cancels a background download', async () => {
    const net = streamingFetch();
    startDownload('/api/backup');
    const release = watchDownload('/api/backup');
    release();
    await waitFor(() => expect(toasts.last()?.action?.label).toBe('Abbrechen'));
    await act(async () => { toasts.last().action.onClick(); });
    await waitFor(() => expect(toasts.messages('info')).toContain('Download abgebrochen'));
    expect(net.signal.aborted).toBe(true);
    expect(clickSpy).not.toHaveBeenCalled();
    expect(downloadsRunning()).toBe(false);
  });

  it('a link that is shown again takes the progress back; a second start joins the running download', async () => {
    const net = streamingFetch();
    const first = startDownload('/api/export/csv');
    expect(startDownload('/api/export/csv')).toBe(first);
    render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit={false} />);
    expect(await screen.findByText('Lädt… 0 MB')).toBeTruthy();
    await act(async () => { net.respond(); });
    await waitFor(() => expect(net.stream).not.toBeNull());
    await act(async () => { net.stream.close(); });
    expect(await first).toBe(true);
    expect(toasts.messages()).toEqual([]);
    expect(screen.getByRole('link', { name: /CSV herunterladen/ })).toBeTruthy();
  });
});
