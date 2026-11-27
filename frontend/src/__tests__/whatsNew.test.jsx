// "Was ist neu": the CHANGELOG read per version (utils/whatsNew.js), the hint after an update, the dialog and the seen
// version per account (hooks/useWhatsNew.js, users.whats_new_seen through PUT /api/auth/profile).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, waitFor, renderHook, act } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import {
  APP_LINK_TARGETS, CHANGELOG_SINCE_MAJOR, changelogSince, compareVersions, fallbackItem, forAllItems, inlineParts, migrationNumbers, parseChangelog, parseForAllItem,
  updateSummary, versionsSince, versionsUpTo, withoutCodeNotes
} from '../utils/whatsNew.js';
import useWhatsNew from '../hooks/useWhatsNew';
import WhatsNewHint from '../components/whatsNew/WhatsNewHint';
import WhatsNewDialog from '../components/whatsNew/WhatsNewDialog';
import { clearDataCache } from '../utils/dataCache';
import { APP_VERSION } from '../components/dashboard/dashboardShell';

const REAL = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8');

const SAMPLE = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '### Für alle',
  '- **Nicht dieses:** gehört zu keiner Version.',
  '',
  '## 4.3.0 – 2026-12-01',
  '',
  '### Für alle',
  '- **Regal einladen:** Lade jemanden in dein Regal ein.',
  '- **Mein Jahr:** Dein Jahr in der Statistik. [Ansehen](app:statistik/verlauf)',
  '- Ohne Titel, über zwei',
  '  Zeilen.',
  '',
  '### Before updating',
  '- **Database migration 62** runs at the first start.',
  '',
  '### Shelves',
  '- **Invitations:** a shelf manager invites people (`POST /api/shelves/:id/invites`). Accepting adds them.',
  '- **Internal:** the invite table has an index.',
  '',
  '### Maintenance',
  '- Updated dependencies.',
  '',
  '## 4.2.0 – 2026-11-23',
  '',
  '### Statistics',
  '- **"Mein Manga-Jahr":** your year (`GET /api/stats/year`), with (Cloudflare 100 MB) kept.',
  '',
  '## 4.1.0',
  '',
  '### Before updating',
  '- **Database migrations 40 to 58** run.',
  ''
].join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
  clearDataCache();
  try { sessionStorage.clear(); localStorage.clear(); } catch (_) { /* none */ }
});

describe('utils/whatsNew: the CHANGELOG per version', () => {
  const versions = parseChangelog(SAMPLE);

  it('reads every version section with its date, the German block, the notes before updating and the English sections', () => {
    expect(versions.map((v) => [v.version, v.date])).toEqual([['4.3.0', '2026-12-01'], ['4.2.0', '2026-11-23'], ['4.1.0', null]]);
    const [first] = versions;
    expect(first.forAll).toEqual([
      { title: 'Regal einladen', text: 'Lade jemanden in dein Regal ein.', link: null },
      { title: 'Mein Jahr', text: 'Dein Jahr in der Statistik.', link: { label: 'Ansehen', target: 'statistik/verlauf' } },
      { title: '', text: 'Ohne Titel, über zwei Zeilen.', link: null }
    ]);
    expect(first.before).toEqual(['**Database migration 62** runs at the first start.']);
    expect(first.sections.map((s) => [s.heading, s.technical, s.items.length])).toEqual([['Shelves', false, 2], ['Maintenance', true, 1]]);
  });

  it('shows the German block in German, else the English non-technical items without code notes and "Internal:"', () => {
    expect(forAllItems(versions[0], 'de')).toEqual({ items: versions[0].forAll, english: false });
    const english = forAllItems(versions[0], 'en');
    expect(english.english).toBe(true);
    expect(english.items).toEqual([{ title: 'Invitations', text: 'a shelf manager invites people. Accepting adds them.', link: null }]);
    expect(forAllItems(versions[1], 'de').items).toEqual([{ title: '"Mein Manga-Jahr"', text: 'your year, with (Cloudflare 100 MB) kept.', link: null }]);
    expect(forAllItems(null)).toEqual({ items: [], english: false });
  });

  it('compares versions and picks the ones since a seen version, never a newer section than the app', () => {
    expect(compareVersions('4.10.0', '4.9.9')).toBe(1);
    expect(compareVersions('4.2.0', '4.2.0')).toBe(0);
    expect(compareVersions('dev', '4.2.0')).toBe(-1);
    expect(versionsSince(versions, '4.1.0', '4.2.0').map((v) => v.version)).toEqual(['4.2.0']);
    expect(versionsSince(versions, '4.1.0', '4.3.0').map((v) => v.version)).toEqual(['4.3.0', '4.2.0']);
    expect(versionsUpTo(versions, '4.2.0').map((v) => v.version)).toEqual(['4.2.0', '4.1.0']);
  });

  it('sums up an update for the hint: items for everybody, migrations only for admins, nothing after going back', () => {
    expect(updateSummary(versions, { seen: '4.2.0', current: '4.3.0' })).toEqual({ versions: ['4.3.0'], count: 3, titles: ['Regal einladen', 'Mein Jahr'], migrations: [], adminNotes: 0 });
    expect(updateSummary(versions, { seen: '4.0.0', current: '4.3.0', admin: true })).toMatchObject({ versions: ['4.3.0', '4.2.0', '4.1.0'], count: 4, migrations: [40, 58, 62], adminNotes: 2 });
    expect(updateSummary(versions, { seen: '4.3.0', current: '4.2.0' })).toBeNull();
    expect(updateSummary(versions, { seen: '4.3.0', current: '4.3.0' })).toBeNull();
    expect(updateSummary(versions, { seen: null, current: '4.3.0' })).toBeNull();
    // 4.1.0 only has a note before updating: nothing for a reader
    expect(updateSummary(versions, { seen: '4.0.0', current: '4.1.0' })).toBeNull();
    expect(updateSummary(versions, { seen: '4.0.0', current: '4.1.0', admin: true })).toMatchObject({ count: 0, migrations: [40, 58] });
    expect(migrationNumbers(['**Database migration 7** x', 'no number'])).toEqual([7]);
  });

  it('keeps bold, code and https links of a text and drops other links to their label', () => {
    expect(inlineParts('a **b** `c` [d](https://x.test) [e](http://x.test)')).toEqual([
      { type: 'text', text: 'a ' }, { type: 'bold', text: 'b' }, { type: 'text', text: ' ' }, { type: 'code', text: 'c' },
      { type: 'text', text: ' ' }, { type: 'link', text: 'd', href: 'https://x.test' }, { type: 'text', text: ' ' },
      { type: 'text', text: 'e' }
    ]);
    expect(withoutCodeNotes('Price (`a`, `b`) and (two words) stay.')).toBe('Price and (two words) stay.');
    expect(parseForAllItem('**A:** b [X](app:unbekannt)').link).toEqual({ label: 'X', target: 'unbekannt' });
    expect(fallbackItem('**A:** b [X](app:radar)').link).toBeNull();
  });
});

describe('CHANGELOG.md as the app reads it', () => {
  const versions = parseChangelog(changelogSince(REAL));

  it('the app gets the versions from 4.0.0 on, newest first, and none below', () => {
    expect(CHANGELOG_SINCE_MAJOR).toBe(4);
    const numbers = versions.map((v) => v.version);
    expect(numbers).toContain('4.0.0');
    expect(numbers.every((v) => compareVersions(v, '4.0.0') >= 0)).toBe(true);
    expect([...numbers].sort((a, b) => compareVersions(b, a))).toEqual(numbers);
    expect(changelogSince('## 4.0.0\n- a\n## 3.9.9 – 2026-01-01\n- b\n')).toBe('## 4.0.0\n- a\n');
  });

  it('every version from 4.0.0 on has a German "Für alle" block of 3 to 8 titled sentences', () => {
    for (const entry of versions) {
      expect(entry.forAll.length, entry.version).toBeGreaterThanOrEqual(3);
      expect(entry.forAll.length, entry.version).toBeLessThanOrEqual(8);
      for (const item of entry.forAll) {
        expect(item.title, entry.version).toBeTruthy();
        expect(item.text, `${entry.version} ${item.title}`).not.toMatch(/`|\/api\//);
      }
    }
  });

  it('every app: link of the CHANGELOG leads to a place the app knows', () => {
    const targets = [...REAL.matchAll(/\]\(app:([^)]*)\)/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !APP_LINK_TARGETS.includes(target))).toEqual([]);
  });

  it('the app version has its own section, so the dialog has something to show', () => {
    expect(versions.some((v) => v.version === APP_VERSION)).toBe(true);
  });
});

function serve(user, onPut = (body) => ({ ...user, ...body })) {
  const puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    if (url === '/api/auth/me') return fakeResponse(200, { user });
    if (url === '/api/auth/profile' && init.method === 'PUT') {
      const body = JSON.parse(init.body);
      puts.push(body);
      return fakeResponse(200, { user: onPut(body) });
    }
    return fakeResponse(404, { error: 'Nicht gefunden' });
  }));
  return puts;
}

describe('useWhatsNew: the seen version of the account', () => {
  const user = { id: 1, username: 'max', role: 'admin' };

  it('is unseen while the app is newer than the version the account saw, and saves the running version', async () => {
    const puts = serve({ ...user, whats_new_seen: '4.1.0' });
    const { result } = renderHook(() => useWhatsNew({ user }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current).toMatchObject({ seen: '4.1.0', current: APP_VERSION, unseen: true });
    await act(() => result.current.markSeen());
    expect(puts).toEqual([{ whats_new_seen: APP_VERSION }]);
    await waitFor(() => expect(result.current.unseen).toBe(false));
  });

  it('a new account starts at the running version without news; an older app than the one seen shows nothing', async () => {
    let puts = serve({ ...user, whats_new_seen: null });
    const fresh = renderHook(() => useWhatsNew({ user }));
    await waitFor(() => expect(puts).toEqual([{ whats_new_seen: APP_VERSION }]));
    expect(fresh.result.current.unseen).toBe(false);
    fresh.unmount();
    clearDataCache();
    puts = serve({ ...user, whats_new_seen: '9.0.0' });
    const back = renderHook(() => useWhatsNew({ user }));
    await waitFor(() => expect(back.result.current.ready).toBe(true));
    expect(back.result.current.unseen).toBe(false);
    expect(puts).toEqual([]);
  });

  it('a server without the field: this device remembers the version, nothing is sent', async () => {
    const puts = serve({ ...user });
    const { result } = renderHook(() => useWhatsNew({ user }));
    await waitFor(() => expect(result.current.seen).toBe(APP_VERSION));
    expect(result.current.unseen).toBe(false);
    expect(puts).toEqual([]);
  });

  it('asks nothing for an offline copy and keeps "Später" for this session', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useWhatsNew({ user: { ...user, offline: true } }));
    expect(result.current.ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => result.current.putOff());
    expect(result.current.later).toBe(true);
    expect(renderHook(() => useWhatsNew({ user, enabled: false })).result.current.later).toBe(true);
  });
});

vi.mock('../components/whatsNew/changelog.js', () => ({
  loadChangelog: vi.fn(async () => parseChangelog(SAMPLE))
}));

const hintState = (over = {}) => ({ unseen: true, later: false, seen: '4.2.0', current: '4.3.0', markSeen: vi.fn(), putOff: vi.fn(), ...over });

describe('WhatsNewHint: the card after an update', () => {
  it('names the version and the news; admins also read about the migration; "Ansehen" opens and marks seen', async () => {
    const state = hintState({ seen: '4.1.0' });
    const onOpen = vi.fn();
    render(<WhatsNewHint whatsNew={state} isAdmin onOpen={onOpen} />);
    expect(await screen.findByText('Manga Shelf 4.3.0 ist da')).toBeTruthy();
    expect(screen.getByTestId('whats-new-hint').textContent).toContain('4 Neuerungen seit 4.1.0, zum Beispiel „Regal einladen“ und „Mein Jahr“.');
    expect(screen.getByText(/Datenbank-Migration 62 ist beim Start gelaufen/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ansehen' }));
    expect(state.markSeen).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalled();
  });

  it('a reader sees no admin line; X marks seen, "Später" only puts it off', async () => {
    const state = hintState();
    render(<WhatsNewHint whatsNew={state} />);
    expect((await screen.findByTestId('whats-new-hint')).textContent).toContain('3 Neuerungen für dich');
    expect(screen.queryByText(/Datenbank-Migration/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Später' }));
    expect(state.putOff).toHaveBeenCalled();
    expect(state.markSeen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hinweis schließen' }));
    expect(state.markSeen).toHaveBeenCalled();
  });

  it('shows nothing when seen or put off, and marks seen without a card when nothing concerns the account', async () => {
    const { container, rerender } = render(<WhatsNewHint whatsNew={hintState({ unseen: false })} />);
    expect(container.innerHTML).toBe('');
    rerender(<WhatsNewHint whatsNew={hintState({ later: true })} />);
    expect(container.innerHTML).toBe('');
    const quiet = hintState({ seen: '4.0.0', current: '4.1.0' });
    rerender(<WhatsNewHint whatsNew={quiet} />);
    await waitFor(() => expect(quiet.markSeen).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});

describe('WhatsNewDialog', () => {
  it('shows the German block of the newest version with its link; readers get no admin tab', async () => {
    const onLink = vi.fn();
    render(<WhatsNewDialog current="4.3.0" since="4.2.0" onClose={vi.fn()} onLink={onLink} />);
    expect(await screen.findByText('Neu in 4.3.0')).toBeTruthy();
    expect(screen.getByText('Seit deinem letzten Besuch (4.2.0)')).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ansehen/ }));
    expect(onLink).toHaveBeenCalledWith('statistik/verlauf');
    // a version without a German block: its English list
    fireEvent.click(screen.getByRole('button', { name: /^4\.2\.0/ }));
    expect(await screen.findByText('Für diese Version gibt es die Liste nur auf Englisch.')).toBeTruthy();
  });

  it('admins switch to the whole section with the notes before updating and the technical label', async () => {
    render(<WhatsNewDialog current="4.3.0" isAdmin onClose={vi.fn()} onLink={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Für Admins' }));
    expect(screen.getByText('Vor dem Update')).toBeTruthy();
    expect(screen.getAllByText('TECHNIK').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Release mit Downloads auf GitHub/ }).getAttribute('href')).toMatch(/\/releases\/tag\/v4\.3\.0$/);
  });

  it('never lists a section newer than the app', async () => {
    render(<WhatsNewDialog current="4.2.0" onClose={vi.fn()} />);
    expect(await screen.findByText('Neu in 4.2.0')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^4\.3\.0/ })).toBeNull();
  });
});
