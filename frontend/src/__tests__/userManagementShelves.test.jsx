// UserManagementModal: where a new account starts (shelf_mode household / personal / share_same / share_mutual).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import UserManagementModal from '../components/modals/UserManagementModal';
import { fakeResponse } from './fakeResponse';

const ADMIN = { id: 1, username: 'admin', role: 'admin' };
const USERS = [
  { id: 1, username: 'admin', role: 'admin', created_at: '2026-01-01T00:00:00Z' },
  { id: 2, username: 'erika', role: 'editor', created_at: '2026-02-01T00:00:00Z' }
];
const HOUSEHOLD_OWNER = [{ id: 1, name: 'Familie', is_default: true, role: 'owner' }];

function mockServer(shelves) {
  const posts = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    if (key === 'GET /api/users') return fakeResponse(200, USERS);
    if (key === 'GET /api/shelves') return shelves ? fakeResponse(200, { shelves }) : fakeResponse(404, { error: 'unbekannt' });
    if (key === 'POST /api/users') {
      posts.push(JSON.parse(init.body));
      return fakeResponse(201, { success: true, user: { id: 9 } });
    }
    throw new Error(`unexpected request ${key}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return posts;
}

const renderUsers = () => render(<UserManagementModal isOpen onClose={vi.fn()} currentUser={ADMIN} />);
const assignment = () => screen.getByRole('group', { name: /Sammlung \/ Regal-Zuordnung/ });
const fill = (name) => {
  fireEvent.change(screen.getByLabelText('Benutzername'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: 'langes-passwort' } });
};
const create = () => fireEvent.click(screen.getByRole('button', { name: /Benutzer erstellen/ }));

afterEach(() => vi.unstubAllGlobals());

describe('UserManagementModal: shelf of a new account', () => {
  it('starts in the household shelf by default and names it; every option says what it does', async () => {
    const posts = mockServer(HOUSEHOLD_OWNER);
    renderUsers();
    await screen.findByText('erika');
    const radios = await waitFor(() => {
      const list = within(assignment()).getAllByRole('radio');
      expect(screen.getByText(/gemeinsamen Sammlung „Familie“/)).toBeTruthy();
      return list;
    });
    expect(radios.map((r) => r.value)).toEqual(['household', 'personal', 'share_same', 'share_mutual']);
    expect(within(assignment()).getByRole('radio', { name: /Haushaltsregal/ }).checked).toBe(true);
    expect(within(assignment()).getByRole('radio', { name: /Eigenes Regal.*leeren Sammlung.*auch Admins nicht/ })).toBeTruthy();
    expect(within(assignment()).getByRole('radio', { name: /Regal eines Benutzers mitnutzen.*die dir gehören/ })).toBeTruthy();
    expect(within(assignment()).getByRole('radio', { name: /Gegenseitig mit dir teilen.*Zugriff auf deins/ })).toBeTruthy();

    fill('anna');
    create();
    await screen.findByText(/Benutzer "anna" erfolgreich angelegt/);
    expect(posts).toEqual([{ username: 'anna', password: 'langes-passwort', role: 'editor', shelf_mode: 'household' }]);
  });

  it('without the owner role in the household shelf that option is gone and a new account gets its own shelf', async () => {
    const posts = mockServer([{ id: 1, name: 'Familie', is_default: true, role: 'editor' }, { id: 4, name: 'Meins', is_default: false, role: 'owner' }]);
    renderUsers();
    await screen.findByText('erika');
    await waitFor(() => expect(within(assignment()).queryByRole('radio', { name: /Haushaltsregal/ })).toBeNull());
    expect(within(assignment()).getByRole('radio', { name: /Eigenes Regal/ }).checked).toBe(true);
    fill('ben');
    create();
    await screen.findByText(/Benutzer "ben" erfolgreich angelegt/);
    expect(posts[0].shelf_mode).toBe('personal');
  });

  it('"Regal eines Benutzers mitnutzen" needs a user; a guest gets read access only', async () => {
    const posts = mockServer(HOUSEHOLD_OWNER);
    renderUsers();
    await screen.findByText('erika');
    fireEvent.click(within(assignment()).getByRole('radio', { name: /Regal eines Benutzers mitnutzen/ }));
    fill('carla');
    // the browser stops the empty required select; the handler checks it as well
    fireEvent.submit(screen.getByRole('button', { name: /Benutzer erstellen/ }).closest('form'));
    expect(screen.getByRole('alert').textContent).toBe('Bitte wähle einen Benutzer zum Teilen aus.');
    expect(posts).toHaveLength(0);

    const pick = screen.getByLabelText('Benutzer zum Teilen');
    expect([...pick.options].map((o) => o.textContent)).toEqual(['Benutzer auswählen...', 'admin (du)', 'erika (Editor)']);
    fireEvent.change(pick, { target: { value: '2' } });
    create();
    await screen.findByText(/Benutzer "carla" erfolgreich angelegt/);
    expect(posts[0]).toEqual({
      username: 'carla', password: 'langes-passwort', role: 'editor', shelf_mode: 'share_same', share_with_user_id: '2', share_role: 'editor'
    });

    fireEvent.click(within(assignment()).getByRole('radio', { name: /Regal eines Benutzers mitnutzen/ }));
    fill('gast');
    fireEvent.change(screen.getByRole('combobox', { name: 'Rolle' }), { target: { value: 'visitor' } });
    fireEvent.change(screen.getByLabelText('Benutzer zum Teilen'), { target: { value: '1' } });
    expect(screen.getByLabelText('Rechte im geteilten Regal').disabled).toBe(true);
    create();
    await screen.findByText(/Benutzer "gast" erfolgreich angelegt/);
    expect(posts[1]).toMatchObject({ role: 'visitor', shelf_mode: 'share_same', share_with_user_id: '1', share_role: 'viewer' });
  });

  it('a guest account is offered no shelf of its own: personal and mutual sharing are gone', async () => {
    const posts = mockServer(HOUSEHOLD_OWNER);
    renderUsers();
    await screen.findByText('erika');
    fireEvent.click(within(assignment()).getByRole('radio', { name: /Eigenes Regal/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Rolle' }), { target: { value: 'visitor' } });
    expect(within(assignment()).getAllByRole('radio').map((r) => r.value)).toEqual(['household', 'share_same']);
    expect(within(assignment()).getByRole('radio', { name: /Haushaltsregal/ }).checked).toBe(true);
    fill('gerda');
    create();
    await screen.findByText(/Benutzer "gerda" erfolgreich angelegt/);
    expect(posts[0]).toEqual({ username: 'gerda', password: 'langes-passwort', role: 'visitor', shelf_mode: 'household' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Rolle' }), { target: { value: 'editor' } });
    expect(within(assignment()).getAllByRole('radio').map((r) => r.value)).toEqual(['household', 'personal', 'share_same', 'share_mutual']);
  });

  it('a guest account without the household option starts in a shared shelf', async () => {
    mockServer([{ id: 1, name: 'Familie', is_default: true, role: 'editor' }, { id: 4, name: 'Meins', is_default: false, role: 'owner' }]);
    renderUsers();
    await screen.findByText('erika');
    await waitFor(() => expect(within(assignment()).queryByRole('radio', { name: /Haushaltsregal/ })).toBeNull());
    fireEvent.change(screen.getByRole('combobox', { name: 'Rolle' }), { target: { value: 'visitor' } });
    expect(within(assignment()).getAllByRole('radio').map((r) => r.value)).toEqual(['share_same']);
    expect(within(assignment()).getByRole('radio', { name: /Regal eines Benutzers mitnutzen/ }).checked).toBe(true);
    expect(screen.getByLabelText('Benutzer zum Teilen')).toBeTruthy();
  });

  it('"Gegenseitig mit dir teilen" always shares with the signed-in account', async () => {
    const posts = mockServer(HOUSEHOLD_OWNER);
    renderUsers();
    await screen.findByText('erika');
    fireEvent.click(within(assignment()).getByRole('radio', { name: /Gegenseitig mit dir teilen/ }));
    expect(screen.queryByLabelText('Benutzer zum Teilen')).toBeNull();
    expect(screen.getByText('Geteilt wird mit dir (admin).')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Rechte im geteilten Regal'), { target: { value: 'viewer' } });
    fill('dora');
    create();
    await screen.findByText(/Benutzer "dora" erfolgreich angelegt/);
    expect(posts[0]).toEqual({
      username: 'dora', password: 'langes-passwort', role: 'editor', shelf_mode: 'share_mutual', share_with_user_id: 1, share_role: 'viewer'
    });
  });

  it('a server that does not answer the shelf list keeps the household default (the server decides)', async () => {
    const posts = mockServer(null);
    renderUsers();
    await screen.findByText('erika');
    expect(within(assignment()).getByRole('radio', { name: /Haushaltsregal/ }).checked).toBe(true);
    expect(screen.getByText(/gemeinsamen Sammlung „Sammlung“/)).toBeTruthy();
    fill('emil');
    create();
    await screen.findByText(/Benutzer "emil" erfolgreich angelegt/);
    expect(posts[0].shelf_mode).toBe('household');
  });
});
