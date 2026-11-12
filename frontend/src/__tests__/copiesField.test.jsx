// Copies in the volume editor (CopiesField), the "Verliehen" badge and the lent card of the statistics.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CopiesField, { canChangeCopy, copyBody } from '../components/detail/volumeEdit/CopiesField';
import { LentBadge } from '../components/detail/OwnerBadges';
import LentCard from '../components/modals/stats/LentCard';
import { fakeResponse } from './fakeResponse';

const anna = { id: 1, username: 'anna', role: 'editor' };
const copy = (over = {}) => ({
  id: 10, owner_user_id: 1, owner: 'anna', price: 7.5, purchase_date: '2025-03-01', condition: 'Gut',
  lent_to_user_id: null, lent_to: null, lent_at: null, ...over
});

afterEach(() => vi.unstubAllGlobals());

describe('CopiesField', () => {
  it('"Weiteres Exemplar" adds a copy for an owner; a copy of several is numbered and can be removed alone', async () => {
    const two = [copy(), copy({ id: 13, price: null, purchase_date: null, condition: null })];
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (init.method === 'POST') {
        expect(String(url)).toContain('/api/volumes/5/copies');
        return fakeResponse(200, { success: true, copy: two[1], copies: two });
      }
      expect(String(url)).toContain('/api/volumes/5/copies/10');
      expect(init.method).toBe('DELETE');
      return fakeResponse(200, { success: true, copies: [two[1]] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    render(<CopiesField volumeId={5} mangaId={2} currentUser={anna} canEdit copies={[copy()]} onChanged={onChanged} />);
    expect(screen.queryByRole('button', { name: /^Entfernen/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weiteres Exemplar' }));
    await waitFor(() => expect(document.querySelectorAll('[data-copy]')).toHaveLength(2));
    expect(document.querySelectorAll('[data-copy]')[1].textContent).toContain('anna · Exemplar 2');
    fireEvent.click(screen.getByRole('button', { name: 'Entfernen – Exemplar von anna · Exemplar 1' }));
    await waitFor(() => expect(document.querySelectorAll('[data-copy]')).toHaveLength(1));
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('offers no further copy to someone without an own copy', () => {
    render(<CopiesField volumeId={5} mangaId={2} currentUser={anna} canEdit copies={[copy({ owner_user_id: 2, owner: 'ben' })]} />);
    expect(screen.queryByRole('button', { name: 'Weiteres Exemplar' })).toBeNull();
  });

  it('lists every copy with its purchase, the household and who borrowed it; only changeable copies get "Bearbeiten"', () => {
    render(
      <CopiesField
        volumeId={5}
        mangaId={2}
        currentUser={anna}
        canEdit
        copies={[
          copy(),
          copy({ id: 11, owner_user_id: 2, owner: 'ben', price: null, purchase_date: null, condition: null, lent_to_user_id: 1, lent_to: 'anna', lent_at: '2026-01-02' }),
          copy({ id: 12, owner_user_id: null, owner: null, price: null, purchase_date: null, condition: null })
        ]}
      />
    );
    const rows = document.querySelectorAll('[data-copy]');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('anna');
    expect(rows[0].textContent).toContain('Gut');
    expect(rows[1].textContent).toContain('Keine Angaben zum Kauf');
    expect(rows[1].textContent).toContain('Ausgeliehen an anna seit 02.01.2026');
    expect(rows[2].textContent).toContain('Haushalt');
    expect(screen.getAllByRole('button', { name: /^Bearbeiten/ }).map(b => b.getAttribute('aria-label')))
      .toEqual(['Bearbeiten – Exemplar von anna', 'Bearbeiten – Exemplar von Haushalt']);
  });

  it('saves price, condition and the lending to an account with one PUT and shows the answer', async () => {
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (String(url).includes('/api/users/directory')) return fakeResponse(200, { users: [anna, { id: 2, username: 'ben' }] });
      expect(String(url)).toContain('/api/volumes/5/copies/10');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ price: '6,90', purchase_date: '2025-03-01', condition: 'Sehr gut', lent: { user_id: 2 } });
      return fakeResponse(200, { success: true, copies: [copy({ price: 6.9, condition: 'Sehr gut', lent_to_user_id: 2, lent_to: 'ben', lent_at: '2026-11-08' })] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const onChanged = vi.fn();
    render(<CopiesField volumeId={5} mangaId={2} currentUser={anna} canEdit copies={[copy()]} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten – Exemplar von anna' }));
    fireEvent.change(screen.getByLabelText(/Kaufpreis/), { target: { value: '6,90' } });
    fireEvent.change(screen.getByLabelText('Zustand'), { target: { value: 'Sehr gut' } });
    await screen.findByRole('option', { name: 'ben' });
    expect(screen.queryByRole('option', { name: 'anna' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Ausgeliehen an'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Exemplar speichern' }));
    expect(await screen.findByText(/Ausgeliehen an ben seit/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid price before sending and a missing name for another person', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, { users: [] })));
    render(<CopiesField volumeId={5} mangaId={2} currentUser={anna} canEdit copies={[copy()]} />);
    fireEvent.click(screen.getByRole('button', { name: /^Bearbeiten/ }));
    fireEvent.change(screen.getByLabelText(/Kaufpreis/), { target: { value: 'viel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Exemplar speichern' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Ungültiger Preis');
    fireEvent.change(screen.getByLabelText(/Kaufpreis/), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Ausgeliehen an'), { target: { value: 'name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Exemplar speichern' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Bitte einen Namen eingeben'));
  });

  it('copyBody sends the lending only when it changed; canChangeCopy follows owner, household and admin', () => {
    const lent = copy({ lent_to: 'Oma', lent_at: '2026-01-02' });
    const form = { price: '7,5', purchase_date: '2025-03-01', condition: 'Gut', lend: 'name', lend_name: 'Oma', lend_at: '2026-01-02' };
    expect(copyBody(form, lent)).toEqual({ price: '7,5', purchase_date: '2025-03-01', condition: 'Gut' });
    expect(copyBody({ ...form, lend: 'none' }, lent).lent).toBeNull();
    expect(copyBody({ ...form, lend_name: 'Opa' }, lent).lent).toEqual({ name: 'Opa', at: '2026-01-02' });
    expect(canChangeCopy(copy({ owner_user_id: 2 }), anna, true)).toBe(false);
    expect(canChangeCopy(copy({ owner_user_id: null }), anna, true)).toBe(true);
    expect(canChangeCopy(copy({ owner_user_id: 2 }), { ...anna, role: 'admin' }, true)).toBe(true);
    expect(canChangeCopy(copy(), anna, false)).toBe(false);
  });
});

describe('LentBadge and LentCard', () => {
  it('the badge shows only for a lent copy and names the borrower', () => {
    const { container, rerender } = render(<LentBadge vol={{ copies: [copy()] }} />);
    expect(container.textContent).toBe('');
    rerender(<LentBadge vol={{ copies: [copy({ lent_to: 'ben', lent_at: '2026-01-02' })] }} />);
    expect(screen.getByText('Verliehen')).toBeTruthy();
    expect(container.querySelector('[data-lent]').getAttribute('title')).toBe('Ausgeliehen an: ben');
  });

  it('the card lists lent and borrowed copies, passes ?shelf_id when filtered and shows the shelf name for all shelves', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, {
      lent_out: [{ copy_id: 1, volume_id: 5, manga_id: 2, title: 'Berserk', volume_number: '1', type: 'volume', shelf_name: 'Wohnzimmer', owner: 'anna', lent_to: 'ben', lent_at: '2026-01-02' }],
      borrowed: [{ copy_id: 2, volume_id: null, manga_id: null, title: 'Monster', volume_number: '3', type: 'volume', shelf_name: null, owner: 'lena', lent_to: 'anna', lent_at: null }]
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<MemoryRouter><LentCard /></MemoryRouter>);
    expect(await screen.findByText('Verliehen & ausgeliehen')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Berserk – Band 1' })).toBeTruthy();
    expect(screen.getByText('Wohnzimmer')).toBeTruthy();
    expect(screen.getByText('an ben seit 02.01.2026')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Monster/ })).toBeNull();
    expect(screen.getByText('von lena')).toBeTruthy();

    rerender(<MemoryRouter><LentCard shelfId={3} /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith('/api/copies/lent?shelf_id=3', expect.anything()));
  });

  it('the card stays hidden while nothing is lent', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, { lent_out: [], borrowed: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<MemoryRouter><LentCard /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
