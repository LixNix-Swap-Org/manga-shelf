// ServerScreen: adding, testing, saving and removing servers, connect links and per-server logout.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ServerScreen, { formFromLink, linkOffer } from '../app/ServerScreen';
import {
  saveServer, resetServers, setStorageAdapter, getServers, getServer, beginLogout, getPendingLogouts
} from '../app/serverStore';
import { activateServer, resetConnection, setToken, setActiveBase, getToken } from '../app/connection';
import { receiveDeepLink, takePendingDeepLink } from '../app/deepLink';
import { getOutbox, resetOutbox, retiredServerId } from '../utils/outbox';
import ConnectQr, { connectAddress } from '../components/common/ConnectQr';
import DashboardFooter from '../components/dashboard/DashboardFooter';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import { recordToasts } from './toastLog';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const healthy = (id = 'inst-1') => json(200, { name: 'Manga Shelf', status: 'ok', instance_id: id, version: '2.20.0' });

function renderScreen({ user = null, onSelect = vi.fn(async () => ({ status: 'unauthorized' })), path = '/server', state, onUseLocal } = {}) {
  render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="/server" element={<ServerScreen user={user} onSelect={onSelect} onUseLocal={onUseLocal} />} />
        <Route path="/lokal" element={<p>Lokale Einrichtung</p>} />
        <Route path="/login" element={<p>Login-Seite</p>} />
        <Route path="/" element={<p>Sammlung</p>} />
      </Routes>
    </MemoryRouter>
  );
  return { onSelect };
}

let toasts;
beforeEach(() => {
  localStorage.clear();
  setStorageAdapter(null);
  resetServers();
  resetConnection();
  resetOutbox();
  takePendingDeepLink();
  toasts = recordToasts();
});
afterEach(() => {
  toasts.stop();
  vi.unstubAllEnvs();
});

describe('ServerScreen', () => {
  it('starts with the add form, tests every address and shows why one fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => (url.startsWith('https://pub') ? Promise.reject(new TypeError('x')) : healthy())));
    renderScreen();
    fireEvent.change(screen.getByLabelText('Adressen (eine pro Zeile)'), { target: { value: 'https://pub.example\nhttp://192.168.1.10:3000\nkein server' } });
    fireEvent.click(screen.getByRole('button', { name: /Verbindung testen/ }));
    const results = await screen.findByRole('list', { name: 'Ergebnis der Verbindungsprüfung' });
    expect(within(results).getByText(/nicht erreichbar/)).toBeTruthy();
    expect(within(results).getByText(/erreichbar \(Version 2\.20\.0\)/)).toBeTruthy();
    expect(within(results).getAllByRole('listitem')).toHaveLength(2);
  });

  it('the probe result is announced in a live region; the buttons keep the focus while it runs', async () => {
    let answer;
    const fetchMock = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn(async () => ({ status: 'unauthorized' }));
    renderScreen({ onSelect });
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('');
    fireEvent.change(screen.getByLabelText('Adressen (eine pro Zeile)'), { target: { value: 'https://manga.example' } });
    const testButton = screen.getByRole('button', { name: /Verbindung testen/ });
    testButton.focus();
    fireEvent.click(testButton);
    await waitFor(() => expect(testButton.getAttribute('aria-busy')).toBe('true'));
    expect(testButton.disabled).toBe(false);
    expect(testButton.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(testButton);
    const submit = screen.getByRole('button', { name: /Speichern und verbinden/ });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(testButton);
    fireEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    answer(healthy());
    await waitFor(() => expect(within(screen.getByRole('status')).getByText(/erreichbar \(Version 2\.20\.0\)/)).toBeTruthy());
    expect(screen.getByRole('status')).toBe(status);
    expect(document.activeElement).toBe(testButton);
    expect(testButton.hasAttribute('aria-disabled')).toBe(false);
  });

  it('saving needs an address; a saved server is selected and the page moves on to its login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => healthy('inst-7')));
    const { onSelect } = renderScreen();
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/mindestens eine Adresse/);
    fireEvent.change(screen.getByLabelText('Adressen (eine pro Zeile)'), { target: { value: 'https://home.example/' } });
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    expect(await screen.findByText('Login-Seite')).toBeTruthy();
    const [saved] = getServers();
    expect(saved).toMatchObject({ name: 'home.example', urls: ['https://home.example'], instanceId: 'inst-7' });
    expect(onSelect).toHaveBeenCalledWith(saved.id);
  });

  it('a missing address marks the address field invalid, describes it by hint and error and focuses it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => healthy()));
    renderScreen();
    const field = screen.getByLabelText('Adressen (eine pro Zeile)');
    const hintId = field.getAttribute('aria-describedby');
    expect(document.getElementById(hintId).textContent).toMatch(/erste Adresse, die antwortet/);
    expect(field.getAttribute('aria-invalid')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    const alert = await screen.findByRole('alert');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby').split(' ')).toEqual([hintId, alert.id]);
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'http://pub.example.org' } });
    fireEvent.click(screen.getByRole('button', { name: /Verbindung testen/ }));
    expect((await screen.findByRole('alert')).textContent).not.toMatch(/mindestens eine Adresse/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('an invalid connect link marks the link field', () => {
    renderScreen();
    const field = screen.getByLabelText('Verbindungslink einfügen');
    fireEvent.change(field, { target: { value: 'quatsch' } });
    fireEvent.click(screen.getByRole('button', { name: /Übernehmen/ }));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby')).textContent).toMatch(/Kein gültiger Verbindungslink/);
  });

  it('an unreachable server is saved anyway with a hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    renderScreen();
    fireEvent.change(screen.getByLabelText('Adressen (eine pro Zeile)'), { target: { value: 'https://home.example' } });
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    await screen.findByText('Login-Seite');
    expect(toasts.messages('info')[0]).toMatch(/antwortet gerade nicht/);
    expect(getServers()).toHaveLength(1);
  });

  it('lists saved servers; connecting with a session goes to the collection, edit keeps the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => healthy()));
    const a = saveServer({ name: 'Zuhause', urls: ['https://home.example', 'http://10.0.0.2:3000'], token: 'tok' });
    saveServer({ name: 'Laden', urls: ['https://laden.example'] });
    activateServer(a.id);
    const onSelect = vi.fn(async () => ({ status: 'online' }));
    renderScreen({ user: { id: 1 }, onSelect });
    expect(screen.getByRole('link', { name: 'Zurück zur Sammlung' })).toBeTruthy();
    expect(screen.getByText('Angemeldet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zuhause bearbeiten' }));
    expect(screen.getByLabelText('Adressen (eine pro Zeile)').value).toBe('https://home.example\nhttp://10.0.0.2:3000');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Daheim' } });
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    expect(await screen.findByText('Sammlung')).toBeTruthy();
    expect(getServer(a.id)).toMatchObject({ name: 'Daheim', token: 'tok' });
    expect(onSelect).toHaveBeenCalledWith(a.id);
  });

  it('removing a server names its queued changes, asks first and drops them', async () => {
    const a = saveServer({ name: 'Laden', urls: ['https://laden.example'] });
    await getOutbox().add({ kind: 'read', volumeId: 1, userId: 1, serverId: a.id, value: true });
    await getOutbox().add({ kind: 'read', volumeId: 2, userId: 2, serverId: a.id, value: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Laden entfernen' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toBe('Server „Laden“ entfernen? Die Anmeldung auf diesem Gerät wird dabei vergessen. 2 vorgemerkte Änderungen gehen verloren.');
    expect(getServers()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Laden entfernen' }));
    await waitFor(() => expect(getServers()).toEqual([]));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(getOutbox().countServer(a.id)).toBe(0));
    confirmSpy.mockRestore();
  });

  it('the changes of a removed server come back when a server with the same instance id is added again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => healthy('inst-5')));
    const a = saveServer({ name: 'Zuhause', urls: ['https://home.example'], instanceId: 'inst-5' });
    await getOutbox().add({ kind: 'purchase', volumeId: 9, userId: 1, serverId: a.id });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Zuhause entfernen' }));
    await waitFor(() => expect(getServers()).toEqual([]));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/1 vorgemerkte Änderung geht verloren, außer du fügst denselben Server wieder hinzu\.$/);
    expect(getOutbox().countServer(retiredServerId('inst-5'))).toBe(1);
    confirmSpy.mockRestore();

    fireEvent.click(screen.getByRole('button', { name: /Server hinzufügen/ }));
    fireEvent.change(screen.getByLabelText('Adressen (eine pro Zeile)'), { target: { value: 'https://home.example' } });
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    await screen.findByText('Login-Seite');
    const [again] = getServers();
    expect(again.id).not.toBe(a.id);
    await waitFor(() => expect(getOutbox().list({ userId: 1, serverId: again.id })).toMatchObject([{ kind: 'purchase', volumeId: 9 }]));
    expect(getOutbox().countServer(retiredServerId('inst-5'))).toBe(0);
  });

  it('removing a server first sends its outstanding logout with its own token to its own address', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    const a = saveServer({ name: 'Laden', urls: ['https://laden.example'], instanceId: 'inst-l' });
    const b = saveServer({ name: 'Zuhause', urls: ['https://home.example'] });
    activateServer(a.id);
    setToken('tok-a');
    beginLogout(a.id);
    activateServer(b.id);
    setToken('tok-b');
    const fetchMock = vi.fn(async (url) => (url.endsWith('/api/health') ? healthy('inst-l') : json(200, { success: true })));
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'Laden entfernen' }));
    await waitFor(() => expect(getServers().map((s) => s.id)).toEqual([b.id]));
    const logout = fetchMock.mock.calls.find(([url]) => url.endsWith('/api/auth/logout'));
    expect(logout[0]).toBe('https://laden.example/api/auth/logout');
    expect(logout[1].headers.Authorization).toBe('Bearer tok-a');
    expect(getPendingLogouts(a.id)).toEqual([]);
    expect(getToken()).toBe('tok-b');
    confirmSpy.mockRestore();
  });

  it('plain http addresses outside the home network are refused with an explanation', async () => {
    const fetchMock = vi.fn(async () => healthy());
    vi.stubGlobal('fetch', fetchMock);
    renderScreen();
    fireEvent.change(screen.getByLabelText('Adressen (eine pro Zeile)'), { target: { value: 'http://192.168.1.10:3000\nhttp://manga.example.org' } });
    fireEvent.click(screen.getByRole('button', { name: /Verbindung testen/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/nur im Heimnetz erlaubt.*http:\/\/manga\.example\.org$/);
    fireEvent.click(screen.getByRole('button', { name: /Speichern und verbinden/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Heimnetz/));
    expect(getServers()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a saved entry with a plain http address on the internet is marked; "Server bearbeiten" opens its form', () => {
    const old = saveServer({ name: 'Alt', urls: ['http://manga.example.org', 'https://manga.example.org'] });
    saveServer({ name: 'Heim', urls: ['http://nas.fritz.box:3000'] });
    renderScreen({ state: { edit: old.id } });
    const marks = screen.getAllByTestId('insecure-server');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toContain('http://manga.example.org');
    expect(screen.getByRole('heading', { name: 'Server bearbeiten' })).toBeTruthy();
    expect(screen.getByLabelText('Adressen (eine pro Zeile)').value).toBe('http://manga.example.org\nhttps://manga.example.org');
  });

  it('first start: "Ohne Server nutzen" leads to the local setup', async () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    const onUseLocal = vi.fn();
    renderScreen({ onUseLocal });
    fireEvent.click(await screen.findByRole('link', { name: 'Ohne Server nutzen' }));
    expect(screen.getByText('Lokale Einrichtung')).toBeTruthy();
  });

  it('with a local profile the server screen offers to open it and moves on to the collection', async () => {
    localStorage.setItem('mangashelf_local_profile', JSON.stringify({ id: 1, name: 'Felix' }));
    const onUseLocal = vi.fn(async () => ({ status: 'local' }));
    renderScreen({ onUseLocal });
    fireEvent.click(await screen.findByRole('button', { name: 'Lokale Sammlung öffnen (Felix)' }));
    expect(onUseLocal).toHaveBeenCalled();
    expect(await screen.findByText('Sammlung')).toBeTruthy();
  });

  it('a pasted connect link fills the form; an invalid one explains itself', () => {
    renderScreen();
    fireEvent.change(screen.getByLabelText('Verbindungslink einfügen'), { target: { value: 'irgendwas' } });
    fireEvent.click(screen.getByRole('button', { name: /Übernehmen/ }));
    expect(screen.getByText(/Kein gültiger Verbindungslink/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Verbindungslink einfügen'), { target: { value: 'manga-shelf://connect?url=https%3A%2F%2Fa.example&name=Manga%20Shelf&id=x' } });
    fireEvent.click(screen.getByRole('button', { name: /Übernehmen/ }));
    expect(screen.getByLabelText('Adressen (eine pro Zeile)').value).toBe('https://a.example');
    expect(screen.getByLabelText('Name').value).toBe('');
  });

  it('a link with a known instance id never edits that server silently: it asks, and the login stays where it was made', () => {
    const a = saveServer({ name: 'Zuhause', urls: ['http://10.0.0.2:3000'], instanceId: 'inst-1' });
    setActiveBase('http://10.0.0.2:3000');
    setToken('tok-home');
    expect(linkOffer({ url: 'https://home.example', instanceId: 'inst-1' })).toEqual({ server: getServer(a.id), url: 'https://home.example' });
    expect(linkOffer({ url: 'http://10.0.0.2:3000', instanceId: 'inst-1' })).toBeNull();
    expect(formFromLink({ url: 'http://10.0.0.2:3000', name: 'Manga Shelf', instanceId: 'inst-1' })).toEqual({
      id: a.id, name: 'Zuhause', urls: 'http://10.0.0.2:3000', instanceId: 'inst-1'
    });
    receiveDeepLink('manga-shelf://connect?url=https%3A%2F%2Fhome.example&id=inst-1');
    renderScreen();
    expect(screen.getByRole('heading', { name: 'Adresse zu „Zuhause“ hinzufügen?' })).toBeTruthy();
    expect(screen.getByText('https://home.example')).toBeTruthy();
    expect(screen.getByText(/erst an diese Adresse gesendet, nachdem du dich dort neu angemeldet hast/)).toBeTruthy();
    expect(getServer(a.id).urls).toEqual(['http://10.0.0.2:3000']);
    fireEvent.click(screen.getByRole('button', { name: /Adresse hinzufügen/ }));
    expect(getServer(a.id)).toMatchObject({ urls: ['http://10.0.0.2:3000', 'https://home.example'], token: 'tok-home' });
    setActiveBase('https://home.example');
    expect(getToken()).toBe('');
  });

  it('a link offering a plain http address on the internet cannot be added; Abbrechen leaves the server as it was', () => {
    const a = saveServer({ name: 'Zuhause', urls: ['https://home.example'], instanceId: 'inst-1' });
    receiveDeepLink('manga-shelf://connect?url=http%3A%2F%2Fevil.example&id=inst-1');
    renderScreen();
    expect(screen.getByRole('alert').textContent).toMatch(/nur im Heimnetz erlaubt/);
    expect(screen.queryByRole('button', { name: /Adresse hinzufügen/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('heading', { name: /hinzufügen\?/ })).toBeNull();
    expect(getServer(a.id).urls).toEqual(['https://home.example']);
  });
});

describe('Mit App verbinden (web footer)', () => {
  const editor = { id: 2, username: 'ed', role: 'editor' };

  it('editors and admins see it in the browser build; visitors, offline users and the app build do not', () => {
    const footer = (user) => render(<DashboardFooter user={user} />);
    const { unmount } = footer(editor);
    expect(screen.getByRole('button', { name: /Mit App verbinden/ })).toBeTruthy();
    unmount();
    const second = footer({ ...editor, role: 'visitor' });
    expect(screen.queryByRole('button', { name: /Mit App verbinden/ })).toBeNull();
    second.unmount();
    const third = footer({ ...editor, offline: true });
    expect(screen.queryByRole('button', { name: /Mit App verbinden/ })).toBeNull();
    third.unmount();
    vi.stubEnv('VITE_APP_MODE', 'app');
    footer(editor);
    expect(screen.queryByRole('button', { name: /Mit App verbinden/ })).toBeNull();
  });

  it('shows the QR code of the connect link with this browser\'s address and the instance id', async () => {
    const fetchMock = vi.fn(async () => json(200, { url: 'http://intern:3000', name: 'Manga Shelf', instance_id: 'inst-42', link: 'x' }));
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ConnectQr />);
    fireEvent.click(screen.getByRole('button', { name: /Mit App verbinden/ }));
    const dialog = screen.getByRole('dialog', { name: 'Mit App verbinden' });
    expect(await within(dialog).findByRole('img', { name: /QR-Code/ })).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/connect-info');
    expect(within(dialog).getByText(window.location.origin)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /Link kopieren/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const link = new URL(writeText.mock.calls[0][0]);
    expect(link.protocol).toBe('manga-shelf:');
    expect(link.searchParams.get('url')).toBe(window.location.origin);
    expect(link.searchParams.get('id')).toBe('inst-42');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('connectAddress prefers the address the browser used, else what the server saw', () => {
    expect(connectAddress({ url: 'http://intern:3000' }, { origin: 'https://manga.example.org' })).toBe('https://manga.example.org');
    expect(connectAddress({ url: 'http://intern:3000' }, { origin: 'null' })).toBe('http://intern:3000');
  });

  it('the footer counts every queued change, purchases by name', async () => {
    await getOutbox().add({ kind: 'purchase', volumeId: 1, userId: 2, serverId: 'web', value: true });
    const { unmount } = render(<DashboardFooter user={editor} />);
    expect(await screen.findByText(/Ausstehend: 1 Kauf/)).toBeTruthy();
    unmount();
    await getOutbox().add({ kind: 'read', volumeId: 5, userId: 2, serverId: 'web', value: true });
    render(<DashboardFooter user={editor} />);
    expect(await screen.findByText(/Ausstehend: 2 Änderungen/)).toBeTruthy();
  });
});

describe('DashboardHeader in the app build', () => {
  const props = {
    activeMainView: 'shelf', canEdit: true, handleBarcodeDetected: vi.fn(), headingRef: { current: null }, isOfflineMode: false,
    mobileMenuOpen: false, onLogout: vi.fn(), search: '', searchInputRef: { current: null }, setMobileMenuOpen: vi.fn(),
    setSearch: vi.fn(), setView: vi.fn(), user: { id: 1, username: 'admin', role: 'admin' }
  };

  it('shows the server and its connection state as a link to the server screen', () => {
    vi.stubEnv('VITE_APP_MODE', 'app');
    const s = saveServer({ name: 'Zuhause', urls: ['https://home.example'] });
    activateServer(s.id);
    render(<MemoryRouter><DashboardHeader {...props} /></MemoryRouter>);
    const pill = screen.getByRole('link', { name: /Server Zuhause, verbinde/ });
    expect(pill.getAttribute('href')).toBe('/server');
  });

  it('the browser build keeps its subtitle and needs no router', () => {
    render(<DashboardHeader {...props} />);
    expect(screen.getByText('Sammlung & Tracker')).toBeTruthy();
    expect(screen.getAllByPlaceholderText('Titel, Autor, Tag, ISBN oder Notiz suchen...').length).toBeGreaterThan(0);
  });
});
