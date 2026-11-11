// "Für wen?" in "Bände hinzufügen": whose copies the new owned volumes become.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import BatchAddModal, { ownerOptions, ownerBody } from '../components/detail/BatchAddModal';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const people = [
  { user_id: 1, username: 'Max', role: 'admin' },
  { user_id: 2, username: 'Felix', role: 'user' },
  { user_id: 3, username: 'Gast', role: 'visitor' }
];

describe('ownerOptions', () => {
  it('is empty when nobody else may own volumes', () => {
    expect(ownerOptions([], { id: 1, role: 'admin' })).toEqual([]);
    expect(ownerOptions([people[0], people[2]], { id: 1, role: 'admin' })).toEqual([]);
  });

  it('lists every other owner for an admin, read-only accounts left out', () => {
    expect(ownerOptions(people, { id: 1, role: 'admin' }).map(o => o.label)).toEqual(['Für mich', 'Für Felix', 'Noch für niemanden (Haushalt)']);
  });

  it('offers an editor only "me" and "nobody yet"', () => {
    expect(ownerOptions(people, { id: 2, role: 'user' }).map(o => o.value)).toEqual(['me', 'nobody']);
  });
});

describe('ownerBody', () => {
  it('maps the choice to owner_user_id', () => {
    expect(ownerBody('me')).toEqual({});
    expect(ownerBody(undefined)).toEqual({});
    expect(ownerBody('nobody')).toEqual({ owner_user_id: null });
    expect(ownerBody('2')).toEqual({ owner_user_id: 2 });
  });
});

describe('BatchAddModal "Für wen?"', () => {
  const okFetch = () => vi.fn(async () => new Response(JSON.stringify({ created: 3, skipped: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  it('is hidden without other people', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<BatchAddModal isOpen onClose={vi.fn()} mangaId="1" manga={{}} people={[people[0]]} user={{ id: 1, role: 'admin' }} />);
    expect(screen.queryByLabelText('Für wen?')).toBeNull();
  });

  it('sends the chosen person with the request', async () => {
    const fetch = okFetch();
    vi.stubGlobal('fetch', fetch);
    render(<BatchAddModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} mangaId="1" manga={{}} people={people} user={{ id: 1, role: 'admin' }} />);
    fireEvent.change(screen.getByLabelText('Für wen?'), { target: { value: '2' } });
    fireEvent.submit(screen.getByLabelText('Für wen?').closest('form'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [, init] = fetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ status: 'Vorhanden', owner_user_id: 2 });
  });

  it('leaves owner_user_id out for "Für mich"', async () => {
    const fetch = okFetch();
    vi.stubGlobal('fetch', fetch);
    render(<BatchAddModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} mangaId="1" manga={{}} people={people} user={{ id: 2, role: 'user' }} />);
    fireEvent.submit(screen.getByLabelText('Für wen?').closest('form'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('owner_user_id');
  });
});
