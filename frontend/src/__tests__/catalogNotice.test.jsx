// Catalog notice in the series edit form (migration 46): shared editions keep changes local, reset to the catalog values.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import CatalogNotice from '../components/detail/CatalogNotice';

const manga = (catalog) => ({ id: 7, title: 'Kern', catalog });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CatalogNotice', () => {
  it('shows nothing for an edition the caller edits alone and without own values, or without a catalog entry', () => {
    const { container, rerender } = render(<CatalogNotice manga={manga({ id: 1, editable: true, resettable: true, local_fields: [] })} />);
    expect(container.innerHTML).toBe('');
    rerender(<CatalogNotice manga={manga(null)} />);
    expect(container.innerHTML).toBe('');
    rerender(<CatalogNotice manga={{ id: 7, title: 'Alt' }} />);
    expect(container.innerHTML).toBe('');
  });

  it('a shared edition says that changes stay in this shelf and counts its own values, without a reset it may not do', () => {
    render(<CatalogNotice manga={manga({ id: 1, editable: false, resettable: false, local_fields: ['author', 'description'] })} />);
    expect(screen.getByText('Diese Ausgabe steht auch in einem anderen Regal. Deine Änderungen gelten nur für dieses Regal.')).toBeTruthy();
    expect(screen.getByText('2 Felder haben in diesem Regal einen eigenen Wert.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Auf Katalogstand zurücksetzen' })).toBeNull();
  });

  it('reset asks first, posts and reloads', async () => {
    const toasts = recordToasts();
    const fetchMock = vi.fn(async () => fakeResponse(200, { success: true, local_fields: [] }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onReset = vi.fn(async () => {});
    render(<CatalogNotice manga={manga({ id: 1, editable: true, resettable: true, local_fields: ['author'] })} onReset={onReset} />);
    expect(screen.getByText('1 Feld hat in diesem Regal einen eigenen Wert.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Auf Katalogstand zurücksetzen' }));
    await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/mangas\/7\/catalog-reset$/);
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST' }));
    expect(toasts.messages('success')).toContain('Katalogstand übernommen');
    toasts.stop();
  });

  it('a refused reset shows the server text and does not reload', async () => {
    const toasts = recordToasts();
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(404, { error: 'Manga nicht gefunden', code: 'NOT_FOUND' })));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onReset = vi.fn();
    render(<CatalogNotice manga={manga({ id: 1, editable: true, resettable: true, local_fields: ['author'] })} onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auf Katalogstand zurücksetzen' }));
    await waitFor(() => expect(toasts.messages('error').length).toBe(1));
    expect(onReset).not.toHaveBeenCalled();
    toasts.stop();
  });

  it('a declined question changes nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<CatalogNotice manga={manga({ id: 1, editable: true, resettable: true, local_fields: ['author'] })} onReset={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auf Katalogstand zurücksetzen' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
