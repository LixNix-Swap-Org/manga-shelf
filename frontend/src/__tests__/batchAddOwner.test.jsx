// "Für wen?" in "Bände hinzufügen": whose copies the new owned volumes become.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import BatchAddModal, { ownerOptions, ownerBody } from '../components/detail/BatchAddModal';
import AddVolumeBar from '../components/detail/AddVolumeBar';
import GapFillModal from '../components/detail/GapFillModal';

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
    expect(ownerOptions(people, { id: 1, role: 'admin' }).map(o => o.text)).toEqual(['Für mich', 'Für Felix', 'Noch für niemanden (Haushalt)']);
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

describe('AddVolumeBar and GapFillModal "Für wen?"', () => {
  const barProps = (over = {}) => ({
    canEdit: true,
    handleAddSingleVolume: vi.fn((e) => e.preventDefault()),
    handleUploadNewSingleCover: vi.fn(),
    newVolumeCover: '',
    newVolumeNum: '4',
    newVolumePrice: '',
    newVolumeReleaseDate: '',
    newVolumeStatus: 'Vorhanden',
    newVolumeType: 'volume',
    setNewVolumeCover: vi.fn(),
    setNewVolumeNum: vi.fn(),
    setNewVolumePrice: vi.fn(),
    setNewVolumeReleaseDate: vi.fn(),
    setNewVolumeStatus: vi.fn(),
    setNewVolumeType: vi.fn(),
    uploadingNewCover: false,
    newVolumeOwner: 'me',
    setNewVolumeOwner: vi.fn(),
    people,
    user: { id: 1, role: 'admin' },
    ...over
  });

  it('AddVolumeBar shows "Für wen?" when Vorhanden, hides it when Fehlt, and notifies changes', () => {
    const setNewVolumeOwner = vi.fn();
    const { rerender } = render(<AddVolumeBar {...barProps({ setNewVolumeOwner })} />);
    const select = screen.getByLabelText('Für wen?');
    expect(Array.from(select.options).map(o => o.text)).toEqual(['Für mich', 'Für Felix', 'Noch für niemanden (Haushalt)']);
    fireEvent.change(select, { target: { value: '2' } });
    expect(setNewVolumeOwner).toHaveBeenCalledWith('2');

    rerender(<AddVolumeBar {...barProps({ newVolumeStatus: 'Fehlt', setNewVolumeOwner })} />);
    expect(screen.queryByLabelText('Für wen?')).toBeNull();
  });

  it('GapFillModal sends owner_user_id only when filling as Vorhanden', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 99 }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    render(
      <GapFillModal
        isOpen
        gapNumber={3}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        manga={{ title: 'Test' }}
        mangaId="1"
        mpGapMap={new Map()}
        canEdit
        people={people}
        user={{ id: 1, role: 'admin' }}
      />
    );
    fireEvent.change(screen.getByLabelText('Für wen?'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Direkt als im Besitz eintragen/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ volume_number: '3', status: 'Vorhanden', owner_user_id: 2 });

    fireEvent.click(screen.getByRole('button', { name: /Auf Einkaufsliste setzen/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty('owner_user_id');
  });
});
