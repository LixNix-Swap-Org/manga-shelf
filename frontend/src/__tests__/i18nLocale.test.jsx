// Language chain in the app: users.locale from /auth/me, pending choices, the switch UI and the remount on a switch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { useEffect } from 'react';

vi.mock('../utils/offlineStore', () => ({
  saveUser: vi.fn(async () => {}),
  loadUser: vi.fn(async () => null),
  loadMeta: vi.fn(async () => null),
  loadMangaList: vi.fn(async () => []),
  clearOfflineData: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true),
  formatAge: vi.fn(() => 'vor 5 Min.')
}));

const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('../Dashboard', async () => {
  const { t } = await vi.importActual('../i18n/index.js');
  return {
    default: function DashboardStub({ user, onLogout }) {
      useEffect(() => { mounts.count += 1; }, []);
      return <><p>{t('Sprache')}: {user.username}</p><button type="button" onClick={onLogout}>Abmelden</button></>;
    }
  };
});

import App from '../App';
import LanguageSelect from '../components/common/LanguageSelect';
import AccountModal from '../components/modals/AccountModal';
import Toaster from '../components/common/Toaster';
import { notify } from '../utils/notify';
import { getLanguage, LANGUAGES, LOCALE_KEY, resetI18nForTests, setLanguage } from '../i18n/index.js';
import { PENDING_KEY, setLanguageTarget, syncUserLanguage, takeReopenAccount, chooseLanguage, markFocusLanguage, takeFocusLanguage } from '../i18n/preference.js';
import { subscribe } from '../i18n/index.js';
import { SESSION_EXPIRED_EVENT } from '../utils/api';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function routes(table) {
  const calls = [];
  const fn = vi.fn(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const key = `${(init.method || 'GET').toUpperCase()} ${new URL(url, 'http://localhost').pathname}`;
    calls.push({ key, body: init.body });
    const handler = table[key];
    if (handler === undefined) throw new TypeError(`unexpected fetch ${key}`);
    return typeof handler === 'function' ? handler(url, init) : handler.clone();
  });
  fn.calls = calls;
  return fn;
}

const putCalls = (fetchMock) => fetchMock.calls.filter((c) => c.key === 'PUT /api/auth/profile').map((c) => JSON.parse(c.body));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  mounts.count = 0;
  setLanguageTarget(null);
});

afterEach(() => {
  resetI18nForTests();
  document.documentElement.lang = 'de';
});

describe('App and users.locale', () => {
  it('adopts users.locale from /auth/me before the pages mount and mirrors it on the device', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: { id: 1, username: 'anna', role: 'editor', locale: 'en', default_language: 'de' } })
    }));
    render(<App />);
    expect(await screen.findByText(/anna/)).toBeTruthy();
    expect(getLanguage()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
    expect(mounts.count).toBe(1);
  });

  it('a user without the field (older server) leaves the language alone and sends nothing', async () => {
    const fetchMock = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: { id: 1, username: 'anna', role: 'editor' } })
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('Sprache: anna')).toBeTruthy();
    expect(getLanguage()).toBe('de');
    expect(putCalls(fetchMock)).toEqual([]);
  });

  it('locale null follows the device: an old device choice is dropped', async () => {
    localStorage.setItem(LOCALE_KEY, 'en');
    await setLanguage('en', { persist: false });
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: { id: 1, username: 'anna', role: 'editor', locale: null, default_language: 'de' } })
    }));
    vi.stubGlobal('navigator', { ...navigator, languages: ['de-DE'], language: 'de-DE' });
    render(<App />);
    expect(await screen.findByText('Sprache: anna')).toBeTruthy();
    expect(getLanguage()).toBe('de');
    expect(localStorage.getItem(LOCALE_KEY)).toBe(null);
  });

  it('a choice made signed out is sent after the login instead of adopting the stored value', async () => {
    await chooseLanguage('en');
    expect(JSON.parse(localStorage.getItem(PENDING_KEY))).toEqual({ locale: 'en', user: null, base: '' });
    const fetchMock = routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: { id: 1, username: 'anna', role: 'editor', locale: null, default_language: 'de' } }),
      'PUT /api/auth/profile': json(200, { user: { id: 1, username: 'anna', role: 'editor', locale: 'en', default_language: 'de' } })
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText(/anna/)).toBeTruthy();
    await waitFor(() => expect(putCalls(fetchMock)).toEqual([{ locale: 'en' }]));
    expect(getLanguage()).toBe('en');
    await waitFor(() => expect(localStorage.getItem(PENDING_KEY)).toBe(null));
  });

  it('a switch remounts the routed pages once; toasts stay', async () => {
    vi.stubGlobal('fetch', routes({
      'GET /api/setup/status': json(200, { needsSetup: false }),
      'GET /api/auth/me': json(200, { user: { id: 1, username: 'anna', role: 'editor' } })
    }));
    render(<App />);
    expect(await screen.findByText('Sprache: anna')).toBeTruthy();
    act(() => { notify.info('Bleibt stehen'); });
    await act(async () => { await setLanguage('en'); });
    expect(mounts.count).toBe(2);
    expect(screen.getByRole('status').textContent).toContain('Bleibt stehen');
  });
});

describe('preference', () => {
  it('signed in: the choice goes to PUT /api/auth/profile right away; "follow the device" sends null', async () => {
    const fetchMock = routes({ 'PUT /api/auth/profile': json(200, { user: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    setLanguageTarget({ id: 1 });
    await chooseLanguage('en');
    await waitFor(() => expect(putCalls(fetchMock)).toEqual([{ locale: 'en' }]));
    expect(localStorage.getItem(PENDING_KEY)).toBe(null);
    await chooseLanguage('');
    await waitFor(() => expect(putCalls(fetchMock)).toEqual([{ locale: 'en' }, { locale: null }]));
    expect(localStorage.getItem(LOCALE_KEY)).toBe(null);
  });

  it('offline or failing: the choice stays pending; an offline user keeps it pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    setLanguageTarget({ id: 1, username: 'anna' });
    await chooseLanguage('en');
    await waitFor(() => expect(JSON.parse(localStorage.getItem(PENDING_KEY))).toEqual({ locale: 'en', user: 'anna', base: '' }));
    expect(await syncUserLanguage({ id: 1, username: 'anna', offline: true, locale: 'de' })).toBe('en');
    expect(localStorage.getItem(PENDING_KEY)).not.toBe(null);
  });

  it('the account dialog reopen mark is taken once', () => {
    sessionStorage.setItem('mangashelf_reopen_account', 'language');
    expect(takeReopenAccount()).toBe('language');
    expect(takeReopenAccount()).toBe(null);
  });
});

describe('switch UI', () => {
  it('LanguageSelect: labelled select, every language in its own name, the device option first', async () => {
    render(<LanguageSelect />);
    const select = screen.getByLabelText('Sprache');
    const options = [...select.querySelectorAll('option')];
    expect(options.map((o) => [o.value, o.textContent, o.getAttribute('lang')])).toEqual([
      ['', expect.stringMatching(/^Gerätesprache \(.+\)$/), null],
      ...LANGUAGES.map((l) => [l.code, l.name, l.code])
    ]);
    expect(options).toHaveLength(14);
    expect(select.value).toBe('');
    await act(async () => { fireEvent.change(select, { target: { value: 'en' } }); });
    await waitFor(() => expect(getLanguage()).toBe('en'));
    expect(localStorage.getItem(LOCALE_KEY)).toBe('en');
  });

  it('the account dialog has a third tab "Sprache" that marks itself for reopening before the switch', async () => {
    vi.stubGlobal('fetch', routes({ 'PUT /api/auth/profile': json(200, { user: {} }) }));
    render(<><AccountModal isOpen onClose={vi.fn()} user={{ id: 2, role: 'editor' }} initialTab="language" /><Toaster /></>);
    expect(screen.getByRole('dialog', { name: 'Sprache' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Sprache' }).getAttribute('aria-selected')).toBe('true');
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Sprache' }), { target: { value: 'en' } }); });
    await waitFor(() => expect(getLanguage()).toBe('en'));
    expect(sessionStorage.getItem('mangashelf_reopen_account')).toBe('language');
  });
});

describe('a pending choice belongs to an account and a server', () => {
  const me = (user) => routes({
    'GET /api/setup/status': json(200, { needsSetup: false }),
    'GET /api/auth/me': json(200, { user }),
    'PUT /api/auth/profile': json(200, { user }),
    'POST /api/auth/logout': json(200, { ok: true })
  });

  it("another account's queued choice is dropped: nothing is sent, the account's own language applies", async () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ locale: 'en', user: 'anna', base: '' }));
    const fetchMock = me({ id: 2, username: 'ben', role: 'editor', locale: 'de', default_language: 'de' });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('Sprache: ben')).toBeTruthy();
    expect(putCalls(fetchMock)).toEqual([]);
    expect(getLanguage()).toBe('de');
    expect(localStorage.getItem(PENDING_KEY)).toBe(null);
  });

  it('the same account on another server, and an old entry without owner, are dropped too', async () => {
    vi.stubGlobal('fetch', routes({ 'PUT /api/auth/profile': json(200, { user: {} }) }));
    localStorage.setItem(PENDING_KEY, JSON.stringify({ locale: 'en', user: 'anna', base: 'https://other.example' }));
    await syncUserLanguage({ id: 1, username: 'anna', locale: null });
    expect(localStorage.getItem(PENDING_KEY)).toBe(null);
    localStorage.setItem(PENDING_KEY, JSON.stringify({ locale: 'en' }));
    await syncUserLanguage({ id: 1, username: 'anna', locale: null });
    expect(localStorage.getItem(PENDING_KEY)).toBe(null);
  });

  it('the same account on the same server gets its queued choice', async () => {
    const fetchMock = routes({ 'PUT /api/auth/profile': json(200, { user: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem(PENDING_KEY, JSON.stringify({ locale: 'en', user: 'anna', base: '' }));
    await syncUserLanguage({ id: 1, username: 'anna', locale: 'de' });
    expect(putCalls(fetchMock)).toEqual([{ locale: 'en' }]);
    expect(localStorage.getItem(PENDING_KEY)).toBe(null);
  });

  it('a runtime 401 and a logout clear the queued choice', async () => {
    vi.stubGlobal('fetch', me({ id: 1, username: 'anna', role: 'editor', locale: 'de', default_language: 'de' }));
    const { unmount } = render(<App />);
    expect(await screen.findByText('Sprache: anna')).toBeTruthy();
    localStorage.setItem(PENDING_KEY, JSON.stringify({ locale: 'en', user: 'anna', base: '' }));
    await act(async () => { window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT)); });
    await waitFor(() => expect(localStorage.getItem(PENDING_KEY)).toBe(null));
    unmount();

    vi.stubGlobal('fetch', me({ id: 1, username: 'anna', role: 'editor', locale: 'de', default_language: 'de' }));
    render(<App />);
    expect(await screen.findByText('Sprache: anna')).toBeTruthy();
    localStorage.setItem(PENDING_KEY, JSON.stringify({ locale: 'en', user: 'anna', base: '' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Abmelden' })); });
    await waitFor(() => expect(screen.queryByText('Sprache: anna')).toBe(null));
    expect(localStorage.getItem(PENDING_KEY)).toBe(null);
  });
});

describe('LanguageSelect switching', () => {
  const REOPEN = 'mangashelf_reopen_account';

  it('choosing the language already shown sends it but leaves no reopen mark behind', async () => {
    const fetchMock = routes({ 'PUT /api/auth/profile': json(200, { user: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    setLanguageTarget({ id: 2, username: 'ben' });
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 2, role: 'editor' }} initialTab="language" />);
    await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: 'Sprache' }), { target: { value: 'de' } }); });
    await waitFor(() => expect(putCalls(fetchMock)).toEqual([{ locale: 'de' }]));
    expect(getLanguage()).toBe('de');
    expect(sessionStorage.getItem(REOPEN)).toBe(null);
    expect(takeFocusLanguage()).toBe(false);
  });

  it('after a switch the next LanguageSelect takes the focus once; the reopened account dialog focuses it, not Close', async () => {
    vi.stubGlobal('fetch', routes({ 'PUT /api/auth/profile': json(200, { user: {} }) }));
    const first = render(<LanguageSelect />);
    await act(async () => { fireEvent.change(screen.getByLabelText('Sprache'), { target: { value: 'en' } }); });
    await waitFor(() => expect(getLanguage()).toBe('en'));
    first.unmount();
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 2, role: 'editor' }} initialTab="language" />);
    // the tab also holds the default edition language select (wave I18N-D)
    expect(document.activeElement).toBe(screen.getAllByRole('combobox')[0]);
    expect(takeFocusLanguage()).toBe(false);
  });

  it('an old focus mark does not steal the focus', () => {
    markFocusLanguage();
    expect(takeFocusLanguage(Date.now() + 60000)).toBe(false);
    render(<LanguageSelect />);
    expect(document.activeElement).not.toBe(screen.getByLabelText('Sprache'));
  });

  it('keyboard steps commit once after a pause, Enter or leaving the select commits at once', async () => {
    vi.stubGlobal('fetch', routes({ 'PUT /api/auth/profile': json(200, { user: {} }) }));
    let commits = 0;
    const stop = subscribe(() => { commits += 1; });
    try {
      const { unmount } = render(<LanguageSelect />);
      const select = screen.getByLabelText('Sprache');
      act(() => {
        fireEvent.keyDown(select, { key: 'ArrowDown' });
        fireEvent.change(select, { target: { value: 'de' } });
        fireEvent.keyDown(select, { key: 'ArrowDown' });
        fireEvent.change(select, { target: { value: 'en' } });
      });
      expect(select.value).toBe('en');
      expect(getLanguage()).toBe('de');
      await waitFor(() => expect(getLanguage()).toBe('en'));
      expect(commits).toBe(1);
      unmount();

      render(<LanguageSelect />);
      const again = screen.getByRole('combobox');
      act(() => {
        fireEvent.keyDown(again, { key: 'ArrowUp' });
        fireEvent.change(again, { target: { value: 'de' } });
      });
      await act(async () => { fireEvent.keyDown(again, { key: 'Enter' }); });
      await waitFor(() => expect(getLanguage()).toBe('de'));
      expect(commits).toBe(2);
      expect(takeFocusLanguage()).toBe(true);
      act(() => {
        fireEvent.keyDown(again, { key: 'ArrowDown' });
        fireEvent.change(again, { target: { value: 'en' } });
      });
      await act(async () => { fireEvent.blur(again); });
      await waitFor(() => expect(getLanguage()).toBe('en'));
      expect(commits).toBe(3);
      // leaving the select keeps the focus where the user moved it
      expect(takeFocusLanguage()).toBe(false);
    } finally {
      stop();
    }
  });
});
