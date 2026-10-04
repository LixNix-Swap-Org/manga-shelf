// The settings card of the Crunchyroll history (apps only) and where it is mounted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// AnimeView and AccountModal read the build mode when they load (the web build drops the app-only chunks)
vi.hoisted(() => { vi.stubEnv('VITE_APP_MODE', 'app'); });
import fs from 'fs';
import path from 'path';
import { fakeResponse } from './fakeResponse';
import { COOKIE, fakeBridge } from './watchFakes';
import CrunchyrollCard, { CARD_TEXTS, crunchyrollStateText } from '../app/watch/CrunchyrollCard';
import AccountModal from '../components/modals/AccountModal';
import SourcesPanel from '../app/SourcesPanel';
import { STATE_KEY, SKIPPED_KEY, patchState } from '../app/watch/watchState';
import { SECRET_KEY, writeSecret } from '../app/watch/crunchyrollSecret';
import { runWatchSync, disconnectCrunchyroll } from '../app/watch/crunchyrollSync';

const srcDir = path.resolve(import.meta.dirname, '..');

let fake;
beforeEach(() => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  fake = fakeBridge();
  window.mangashelfNative = fake.bridge;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.mangashelfNative;
});

const card = async () => {
  render(<CrunchyrollCard headingLevel={3} />);
  const heading = await screen.findByRole('heading', { name: CARD_TEXTS.title });
  const section = heading.closest('section');
  await waitFor(() => expect(within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle }).disabled).toBe(false));
  return section;
};

describe('CrunchyrollCard', () => {
  it('is off by default and shows the warning before anything is connected', async () => {
    const section = await card();
    const toggle = within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle });
    expect(toggle.checked).toBe(false);
    const described = toggle.getAttribute('aria-describedby').split(' ').map((id) => document.getElementById(id).textContent).join(' ');
    expect(described).toContain('Inoffizielle Schnittstelle');
    expect(section.textContent).toContain('Nutzungsbedingungen von Crunchyroll');
    expect(section.textContent).toContain('Google oder Apple');
    expect(section.textContent).toContain('kann jederzeit aufhören zu funktionieren');
    expect(within(section).queryByRole('button', { name: /verbinden/ })).toBeNull();
    expect(fake.bridge.plugins.WebLogin.open).not.toHaveBeenCalled();
  });

  it('opt-in, connect through the native login, then sync now and disconnect', async () => {
    const section = await card();
    fireEvent.click(within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle }));
    const connect = await within(section).findByRole('button', { name: CARD_TEXTS.connect });
    expect(JSON.parse(fake.prefs.get(STATE_KEY)).enabled).toBe(true);
    expect(within(section).getByTestId('crunchyroll-state').textContent).toContain('nicht verbunden');

    fireEvent.click(connect);
    await within(section).findByRole('button', { name: CARD_TEXTS.disconnect });
    expect(fake.bridge.plugins.WebLogin.open).toHaveBeenCalledTimes(1);
    expect(fake.secure.has(SECRET_KEY)).toBe(true);
    expect(within(section).getByTestId('crunchyroll-state').textContent).toContain('verbunden');
    expect(section.textContent).not.toContain(COOKIE);

    fireEvent.click(within(section).getByRole('button', { name: CARD_TEXTS.disconnect }));
    await within(section).findByRole('button', { name: CARD_TEXTS.connect });
    expect(fake.secure.has(SECRET_KEY)).toBe(false);
    expect(within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle }).checked).toBe(true);
  });

  it('switching it off deletes the login', async () => {
    await patchState(fake.bridge, { enabled: true });
    const section = await card();
    fireEvent.click(within(section).getByRole('button', { name: CARD_TEXTS.connect }));
    await within(section).findByRole('button', { name: CARD_TEXTS.syncNow });
    fireEvent.click(within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle }));
    await waitFor(() => expect(within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle }).checked).toBe(false));
    expect(fake.secure.has(SECRET_KEY)).toBe(false);
    expect(within(section).queryByRole('button', { name: CARD_TEXTS.syncNow })).toBeNull();
  });

  it('a closed login sheet leaves the card as it was', async () => {
    await patchState(fake.bridge, { enabled: true });
    fake.bridge.plugins.WebLogin.open.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    const section = await card();
    fireEvent.click(within(section).getByRole('button', { name: CARD_TEXTS.connect }));
    await waitFor(() => expect(within(section).getByRole('button', { name: CARD_TEXTS.connect }).disabled).toBe(false));
    expect(within(section).getByTestId('crunchyroll-state').textContent).toContain('nicht verbunden');
    expect(within(section).queryByRole('alert')).toBeNull();
  });

  it('shows the last error, e.g. after the token was refused', async () => {
    await patchState(fake.bridge, { enabled: true, last_error: 'Bitte erneut verbinden', last_error_at: Date.now() });
    const section = await card();
    expect(within(section).getByTestId('crunchyroll-state').textContent).toContain('Bitte erneut verbinden');
    expect(within(section).getByRole('button', { name: CARD_TEXTS.connect })).toBeTruthy();
  });

  const connected = async () => {
    await writeSecret(fake.bridge, { etp_rt: COOKIE, client_id: 'webClient_123', device_id: 'device-0001-abcd' });
    await patchState(fake.bridge, { enabled: true });
  };
  const holdToken = () => {
    const original = fake.bridge.plugins.WebLogin.request.getMockImplementation();
    let release;
    let arrived;
    const reached = new Promise((r) => { arrived = r; });
    fake.bridge.plugins.WebLogin.request.mockImplementation(async (req) => {
      if (!req.url.endsWith('/auth/v1/token')) return original(req);
      arrived();
      return new Promise((r) => { release = r; });
    });
    return { reached, release: () => release(fake.answers.token) };
  };

  it("an automatic sync locks 'Trennen' and the switch (aria-disabled, busy text) until it ends", async () => {
    await connected();
    const section = await card();
    await within(section).findByRole('button', { name: CARD_TEXTS.disconnect });
    const hold = holdToken();
    const run = runWatchSync({ bridge: fake.bridge, user: { id: 3, role: 'editor' }, post: vi.fn(async () => ({ applied: [], unmatched: [] })) });
    await hold.reached;
    const trennen = within(section).getByRole('button', { name: CARD_TEXTS.disconnect });
    const toggle = within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle });
    await waitFor(() => expect(trennen.getAttribute('aria-disabled')).toBe('true'));
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(within(section).getByTestId('crunchyroll-state').textContent).toBe('Gleiche ab…');
    fireEvent.click(trennen);
    fireEvent.click(toggle);
    hold.release();
    await run;
    await waitFor(() => expect(trennen.hasAttribute('aria-disabled')).toBe(false));
    expect(fake.secure.has(SECRET_KEY)).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(within(section).getByTestId('crunchyroll-state').textContent).toMatch(/^verbunden · zuletzt abgeglichen/);
  });

  it("'Trennen' elsewhere during the token request: the card stays 'nicht verbunden'", async () => {
    await connected();
    const section = await card();
    const hold = holdToken();
    const run = runWatchSync({ bridge: fake.bridge, user: { id: 3, role: 'editor' }, post: vi.fn(async () => ({ applied: [], unmatched: [] })) });
    await hold.reached;
    await disconnectCrunchyroll({ bridge: fake.bridge });
    hold.release();
    expect(await run).toEqual({ ran: false, reason: 'disconnected' });
    await within(section).findByRole('button', { name: CARD_TEXTS.connect });
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.secure.has(SECRET_KEY)).toBe(false);
    expect(within(section).getByTestId('crunchyroll-state').textContent).toBe('nicht verbunden');
  });

  it("'Übersprungene wieder anzeigen (N)' while skipped series exist; 'Trennen' clears them too", async () => {
    await connected();
    fake.prefs.set(SKIPPED_KEY, JSON.stringify(['GSERIES001:1', 'GSERIES002:2']));
    const section = await card();
    fireEvent.click(await within(section).findByRole('button', { name: CARD_TEXTS.unskip(2) }));
    await waitFor(() => expect(within(section).queryByRole('button', { name: /Übersprungene/ })).toBeNull());
    expect(fake.prefs.has(SKIPPED_KEY)).toBe(false);
    expect(fake.secure.has(SECRET_KEY)).toBe(true);

    fake.prefs.set(SKIPPED_KEY, JSON.stringify(['GSERIES001:1']));
    fireEvent.click(within(section).getByRole('button', { name: CARD_TEXTS.disconnect }));
    await within(section).findByRole('button', { name: CARD_TEXTS.connect });
    expect(fake.prefs.has(SKIPPED_KEY)).toBe(false);
    expect(within(section).queryByRole('button', { name: /Übersprungene/ })).toBeNull();
  });

  it('touch targets: the switch and its text are one 44 px label, the buttons have hit-44 and wider gaps on phones', async () => {
    await connected();
    const section = await card();
    const toggle = within(section).getByRole('checkbox', { name: CARD_TEXTS.toggle });
    expect(toggle.closest('label').className.split(' ')).toContain('min-h-11');
    for (const name of [CARD_TEXTS.syncNow, CARD_TEXTS.disconnect]) {
      const button = await within(section).findByRole('button', { name });
      expect(button.className.split(' ')).toContain('hit-44');
      expect(button.parentElement.className).toContain('[@media(pointer:coarse)]:gap-5');
    }
  });

  it('state text', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(crunchyrollStateText({ connected: false, state: {} })).toBe('nicht verbunden');
    expect(crunchyrollStateText({ connected: true, state: {} })).toBe('verbunden · noch nicht abgeglichen');
    expect(crunchyrollStateText({ connected: true, state: { last_ok: now - 5 * 60000 } }, now)).toEqual(expect.stringMatching(/^verbunden · zuletzt abgeglichen vor 5 Min/));
    expect(crunchyrollStateText({ connected: true, state: { last_error: 'Crunchyroll bremst gerade, später erneut' } })).toBe('Crunchyroll bremst gerade, später erneut');
  });
});

describe('where the card shows up', () => {
  const serve = () => vi.stubGlobal('fetch', vi.fn(async (url) => {
    if (url.endsWith('/api/sources/guides')) return fakeResponse(200, []);
    if (url.endsWith('/api/auth/api-keys')) return fakeResponse(200, []);
    if (url.endsWith('/api/admin/api-keys')) return fakeResponse(200, { keys: [] });
    if (url.endsWith('/api/anime/sync')) return fakeResponse(200, { anilist: null });
    return fakeResponse(404, { error: 'Nicht gefunden' });
  }));
  const openKeys = async (user) => {
    serve();
    render(<AccountModal isOpen onClose={vi.fn()} user={user} initialTab="keys" />);
    await waitFor(() => expect(screen.queryByText('Wird geladen…')).toBeNull());
  };

  it('in the account dialog of an editor in the apps', async () => {
    await openKeys({ id: 3, role: 'editor' });
    expect(await screen.findByRole('heading', { name: CARD_TEXTS.title })).toBeTruthy();
  });

  it('in the sources panel of the device mode, below the key cards', async () => {
    serve();
    render(<SourcesPanel headingLevel={2} />);
    const heading = await screen.findByRole('heading', { name: CARD_TEXTS.title });
    expect(heading.tagName).toBe('H2');
    expect(heading.closest('#local-sources')).toBeTruthy();
  });

  it('not for visitors', async () => {
    await openKeys({ id: 4, role: 'visitor' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: CARD_TEXTS.title })).toBeNull();
  });

  it('not on the web or desktop (no native bridge)', async () => {
    delete window.mangashelfNative;
    await openKeys({ id: 3, role: 'editor' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: CARD_TEXTS.title })).toBeNull();
  });

  it('not when the build sets VITE_WATCH_CRUNCHYROLL=off', async () => {
    vi.stubEnv('VITE_WATCH_CRUNCHYROLL', 'off');
    await openKeys({ id: 3, role: 'editor' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: CARD_TEXTS.title })).toBeNull();
  });

  it('the web build never sees it (no app mode)', async () => {
    vi.stubEnv('VITE_APP_MODE', '');
    await openKeys({ id: 3, role: 'editor' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('heading', { name: CARD_TEXTS.title })).toBeNull();
  });
});

describe('texts', () => {
  it('German, and nothing about browser add-ons anywhere in the watch code', () => {
    const files = fs.readdirSync(path.join(srcDir, 'app/watch')).map((f) => path.join(srcDir, 'app/watch', f));
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/extension|erweiterung|add-on|addon|plugin für den browser/i);
    }
  });
});
