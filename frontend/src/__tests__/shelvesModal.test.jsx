// ShelvesModal: create, rename, roles, removal and leaving with the confirmation that names the deleted marks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ShelvesModal, { memberRemovalText } from '../components/modals/ShelvesModal';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const ME = { id: 1, username: 'admin', role: 'admin' };
const HOME = { id: 1, name: 'Familie', color: '#6366f1', is_default: true, role: 'owner', series_count: 4, member_count: 2 };
const SHARED = { id: 2, name: 'Bens Regal', color: '#22c55e', is_default: false, role: 'editor', series_count: 1, member_count: 2 };

const member = (user_id, username, role, marks = { owned: 0, read: 0 }) => ({ user_id, username, role, marks });

let toasts;
let routes;
let fetchMock;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  toasts = recordToasts();
  routes = {
    'GET /api/shelves': () => fakeResponse(200, { shelves: [HOME, SHARED] }),
    'GET /api/users/directory': () => fakeResponse(200, { users: [{ id: 1, username: 'admin' }, { id: 2, username: 'erika' }, { id: 3, username: 'ben' }] }),
    'GET /api/shelves/1': () => fakeResponse(200, { ...HOME, members: [member(1, 'admin', 'owner'), member(2, 'erika', 'editor', { owned: 3, read: 5 })] }),
    'GET /api/shelves/2': () => fakeResponse(200, { ...SHARED, members: [member(3, 'ben', 'owner'), member(1, 'admin', 'editor', { owned: 1, read: 0 })] })
  };
  fetchMock = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  toasts.stop();
  vi.unstubAllGlobals();
});

const calls = (method) => fetchMock.mock.calls
  .filter(([, init = {}]) => (init.method || 'GET') === method)
  .map(([url, init]) => [url, init.body ? JSON.parse(init.body) : undefined]);
const shelvesDialog = () => screen.getByRole('dialog', { name: 'Regale' });
const renderModal = (props = {}) => render(<ShelvesModal onClose={vi.fn()} user={ME} onChanged={vi.fn()} {...props} />);
const openShelf = async (name) => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name) }));
  return screen.findByRole('heading', { name: 'Mitglieder' });
};

describe('memberRemovalText', () => {
  it('names the counts, says they are deleted, and stays general without counts', () => {
    expect(memberRemovalText(member(2, 'erika', 'editor', { owned: 3, read: 1 })))
      .toBe('„erika“ aus diesem Regal entfernen? Die Markierungen von erika in diesem Regal werden gelöscht: 3 Bände im Besitz, 1 Band gelesen. Bände, die danach niemand mehr besitzt, gelten als „Fehlt“. Das lässt sich nicht rückgängig machen.');
    expect(memberRemovalText({ user_id: 2, username: 'erika', role: 'editor' }))
      .toMatch(/^„erika“ aus diesem Regal entfernen\? Die Besitz- und Lesemarkierungen von erika in diesem Regal werden gelöscht\./);
    expect(memberRemovalText(member(2, 'erika', 'viewer'))).toBe('„erika“ aus diesem Regal entfernen? erika hat hier keine Besitz- oder Lesemarkierungen.');
    expect(memberRemovalText(member(1, 'admin', 'editor', { owned: 2, read: 7 }), { self: true }))
      .toMatch(/^Du verlierst den Zugriff auf dieses Regal, und deine Markierungen darin werden gelöscht: 2 Bände im Besitz, 7 Bände gelesen\./);
    expect(memberRemovalText(member(1, 'admin', 'editor'), { self: true })).toBe('Du verlierst den Zugriff auf dieses Regal. Wirklich verlassen?');
  });
});

describe('ShelvesModal', () => {
  it('a failed create keeps the typed name; a successful one clears it and reloads the list', async () => {
    const onChanged = vi.fn();
    const answers = [
      fakeResponse(409, { error: 'Ein Regal mit diesem Namen gibt es schon' }),
      fakeResponse(201, { id: 5, name: 'Kinderregal', role: 'owner' })
    ];
    routes['POST /api/shelves'] = () => answers.shift();
    renderModal({ onChanged });
    await screen.findByRole('button', { name: /Familie/ });
    const input = screen.getByPlaceholderText('Neues Regal');
    fireEvent.change(input, { target: { value: '  Kinderregal ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await waitFor(() => expect(toasts.messages('error')).toContain('Ein Regal mit diesem Namen gibt es schon'));
    expect(input.value).toBe('  Kinderregal ');
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await waitFor(() => expect(input.value).toBe(''));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(calls('POST')).toEqual([['/api/shelves', { name: 'Kinderregal' }], ['/api/shelves', { name: 'Kinderregal' }]]);
    expect(calls('GET').filter(([url]) => url === '/api/shelves').length).toBeGreaterThanOrEqual(2);
  });

  it('an owner renames the shelf', async () => {
    routes['PUT /api/shelves/1'] = () => fakeResponse(200, { ...HOME, name: 'Wohnzimmer' });
    renderModal();
    await openShelf('Familie');
    fireEvent.click(screen.getByRole('button', { name: 'Umbenennen' }));
    const field = screen.getByLabelText('Name des Regals');
    expect(field.value).toBe('Familie');
    fireEvent.change(field, { target: { value: 'Wohnzimmer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(screen.queryByLabelText('Name des Regals')).toBeNull());
    expect(calls('PUT')).toEqual([['/api/shelves/1', { name: 'Wohnzimmer', color: '#6366f1' }]]);
    expect(toasts.messages('success')).toContain('Regal gespeichert');
  });

  it('removing a member asks first, names the marks that go, and keeps focus in the shelves dialog', async () => {
    routes['DELETE /api/shelves/1/members/2'] = () => fakeResponse(200, { success: true, members: [member(1, 'admin', 'owner')] });
    renderModal();
    await openShelf('Familie');
    const remove = screen.getByRole('button', { name: 'erika: Entfernen' });
    remove.focus();
    fireEvent.click(remove);
    let question = await screen.findByRole('dialog', { name: 'Mitglied entfernen' });
    expect(question.textContent).toContain('Die Markierungen von erika in diesem Regal werden gelöscht: 3 Bände im Besitz, 5 Bände gelesen.');
    expect(question.textContent).toContain('gelten als „Fehlt“');
    fireEvent.click(within(question).getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mitglied entfernen' })).toBeNull());
    expect(calls('DELETE')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'erika: Entfernen' }));
    question = await screen.findByRole('dialog', { name: 'Mitglied entfernen' });
    fireEvent.click(within(question).getByRole('button', { name: 'Entfernen' }));
    await waitFor(() => expect(screen.queryByText('erika')).toBeNull());
    expect(calls('DELETE')).toEqual([['/api/shelves/1/members/2', undefined]]);
    await waitFor(() => expect(shelvesDialog().contains(document.activeElement)).toBe(true));
  });

  it('leaving names the own marks; the confirmed leave closes the shelf', async () => {
    routes['DELETE /api/shelves/2/members/1'] = () => fakeResponse(200, { success: true });
    renderModal();
    await openShelf('Bens Regal');
    expect(screen.queryByRole('button', { name: 'ben: Entfernen' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'admin: Rolle' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'admin: Entfernen' }));
    const question = await screen.findByRole('dialog', { name: 'Regal verlassen' });
    expect(question.textContent).toContain('deine Markierungen darin werden gelöscht: 1 Band im Besitz, 0 Bände gelesen.');
    fireEvent.click(within(question).getByRole('button', { name: 'Verlassen' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Mitglieder' })).toBeNull());
    expect(calls('DELETE')).toEqual([['/api/shelves/2/members/1', undefined]]);
  });

  it('the only owner can neither demote nor remove themselves; with a second owner both are offered', async () => {
    renderModal();
    await openShelf('Familie');
    expect(screen.queryByRole('combobox', { name: 'admin: Rolle' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'admin: Entfernen' })).toBeNull();
    expect(screen.getByText(/Du bist der einzige Besitzer dieses Regals/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'erika: Rolle' }).value).toBe('editor');

    routes['GET /api/shelves/1'] = () => fakeResponse(200, { ...HOME, members: [member(1, 'admin', 'owner'), member(2, 'erika', 'owner')] });
    fireEvent.click(screen.getByRole('button', { name: /Familie/ }));
    await openShelf('Familie');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'admin: Rolle' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'admin: Entfernen' })).toBeTruthy();
    expect(screen.queryByText(/Du bist der einzige Besitzer dieses Regals/)).toBeNull();
  });

  it('a read-only account is offered no role above viewer', async () => {
    routes['GET /api/shelves/1'] = () => fakeResponse(200, {
      ...HOME,
      members: [member(1, 'admin', 'owner'), { ...member(4, 'gast', 'viewer'), app_role: 'visitor' }, member(5, 'kind', 'viewer')]
    });
    routes['PUT /api/shelves/1/members/5'] = () => fakeResponse(400, { error: 'Besucher- und Gastkonten können in einem Regal nur Leser sein', code: 'SHELF_ROLE_CAPPED' });
    renderModal();
    await openShelf('Familie');
    expect(screen.queryByRole('combobox', { name: 'gast: Rolle' })).toBeNull();
    const kind = screen.getByRole('combobox', { name: 'kind: Rolle' });
    fireEvent.change(kind, { target: { value: 'editor' } });
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'kind: Rolle' })).toBeNull());
    expect(toasts.messages('error')).toContain('Besucher- und Gastkonten können in einem Regal nur Leser sein');
  });

  it('a late answer for a shelf that is no longer open is dropped', async () => {
    const slow = deferred();
    routes['GET /api/shelves/1'] = () => slow.promise;
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: /Familie/ }));
    fireEvent.click(screen.getByRole('button', { name: /Bens Regal/ }));
    expect(await screen.findByText('ben')).toBeTruthy();
    slow.resolve(fakeResponse(200, { ...HOME, members: [member(1, 'admin', 'owner'), member(2, 'erika', 'editor')] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('erika')).toBeNull();
    expect(screen.getByText('ben')).toBeTruthy();
  });

  it('deleting a shelf asks first and says its trash goes too', async () => {
    const own = { id: 7, name: 'Leer', color: '#6366f1', is_default: false, role: 'owner', series_count: 0, member_count: 1 };
    routes['GET /api/shelves'] = () => fakeResponse(200, { shelves: [HOME, own] });
    routes['GET /api/shelves/7'] = () => fakeResponse(200, { ...own, members: [member(1, 'admin', 'owner')] });
    routes['DELETE /api/shelves/7'] = () => fakeResponse(200, { success: true });
    renderModal();
    await openShelf('Leer');
    fireEvent.click(screen.getByRole('button', { name: 'Regal löschen' }));
    const question = await screen.findByRole('dialog', { name: 'Regal löschen' });
    expect(question.textContent).toContain('Was von diesem Regal noch im Papierkorb liegt, wird dabei endgültig gelöscht.');
    fireEvent.click(within(question).getByRole('button', { name: 'Löschen' }));
    await waitFor(() => expect(calls('DELETE')).toEqual([['/api/shelves/7', undefined]]));
    await waitFor(() => expect(shelvesDialog().contains(document.activeElement)).toBe(true));
  });
});
