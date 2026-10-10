// Unmatched series of the Crunchyroll history: the hint in the anime tab and the match dialog.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// AnimeView and AccountModal read the build mode when they load (the web build drops the app-only chunks)
vi.hoisted(() => { vi.stubEnv('VITE_APP_MODE', 'app'); });
import fs from 'fs';
import path from 'path';
import api, { ApiError } from '../utils/api';
import AnimeView from '../components/dashboard/AnimeView';
import {
  confirmMatch, createMatch, seriesLabel, preselectedCandidate, seasonOfCandidate, syncAfterMatch, splitCandidates
} from '../app/watch/WatchMatchDialog';
import { UNMATCHED_KEY, SKIPPED_KEY, WATCH_SYNC_EVENT, loadUnmatched, resetUnmatchedView, patchState } from '../app/watch/watchState';
import { writeSecret } from '../app/watch/crunchyrollSecret';
import { startWatchSync } from '../app/watch/crunchyrollSync';
import { CARD_TEXTS } from '../app/watch/CrunchyrollCard';
import useAnimeList from '../hooks/useAnimeList';
import { COOKIE, EDITOR, fakeBridge, fakeDesktopBridge } from './watchFakes';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

const SCOPE = 'srv-1:3';
const entry = (over = {}) => ({
  id: 1, title: 'Frieren', title_de: null, format: 'TV', season_year: 2023, episodes: 28, cover_image: null, anilist_id: 154587, mal_id: 52991,
  manual: false, next_airing: null, my_progress: { status: 'Schaue', episodes_watched: 3, score: null, notes: null }, progress_users: [], ...over
});
const LIST = [entry(), entry({ id: 2, title: 'Frieren 2nd Season', episodes: 12 }), entry({ id: 3, title: 'Dandadan', episodes: 12 })];
const FRIEREN = {
  external_id: 'GSERIES001', series_title: 'Sousou no Frieren', season: 1, episode: 7, episodes_watched: 7, reason: 'ambiguous',
  candidates: [{ id: 1, title: 'Frieren', score: 0.8, episodes: 28 }, { id: 2, title: 'Frieren 2nd Season', score: 0.7, episodes: 12 }]
};
const DANDADAN = {
  external_id: 'GSERIES002', series_title: 'Dandadan', season: 2, episode: 4, episodes_watched: 3, reason: 'no_match', candidates: []
};
const base = {
  loaded: true, loading: false, error: null, fromCache: false, cacheAt: null, user: { id: 3, role: 'editor' }, sources: null, listSync: null,
  onAdd: vi.fn(), onOpen: vi.fn(), onPlusOne: vi.fn(), onStatusChange: vi.fn(), onRetry: vi.fn()
};

let fake;
const seed = async (items) => {
  fake.prefs.set(UNMATCHED_KEY, JSON.stringify({ scope: SCOPE, items }));
  await act(() => loadUnmatched(fake.bridge, SCOPE));
};
const view = (props = {}) => render(<MemoryRouter><AnimeView {...base} list={LIST} canEdit {...props} /></MemoryRouter>);
const openDialog = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Zuordnen' }));
  return screen.findByRole('dialog');
};

beforeEach(() => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  fake = fakeBridge();
  window.mangashelfNative = fake.bridge.native;
});

afterEach(() => {
  resetUnmatchedView();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete window.mangashelfNative;
  localStorage.clear();
});

describe('hint in the anime tab', () => {
  it('counts the series still to confirm', async () => {
    await seed([FRIEREN, DANDADAN]);
    view();
    expect(screen.getByTestId('watch-unmatched').textContent).toContain('2 Serien aus deinem Crunchyroll-Verlauf noch nicht zugeordnet');
    await seed([FRIEREN]);
    expect(screen.getByTestId('watch-unmatched').textContent).toContain('1 Serie aus deinem Crunchyroll-Verlauf noch nicht zugeordnet');
  });

  it('none without unmatched series, for visitors, offline or from the cache', async () => {
    const first = view();
    expect(screen.queryByTestId('watch-unmatched')).toBeNull();
    first.unmount();
    await seed([FRIEREN]);
    const { rerender } = view({ canEdit: false });
    expect(screen.queryByTestId('watch-unmatched')).toBeNull();
    rerender(<MemoryRouter><AnimeView {...base} list={LIST} canEdit user={{ id: 3, role: 'visitor', realRole: 'editor', offline: true }} /></MemoryRouter>);
    expect(screen.queryByTestId('watch-unmatched')).toBeNull();
    rerender(<MemoryRouter><AnimeView {...base} list={LIST} canEdit fromCache /></MemoryRouter>);
    expect(screen.queryByTestId('watch-unmatched')).toBeNull();
  });
});

describe('WatchMatchDialog', () => {
  it('asks per series, confirms with remember and the watched count, then goes to the next one', async () => {
    await seed([FRIEREN, DANDADAN]);
    const post = vi.spyOn(api, 'post').mockResolvedValue({ anime_id: 1, progress: { episodes_watched: 7 } });
    const synced = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, synced);
    const toasts = recordToasts();
    view();
    const dialog = await openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // two weak candidates, one of another season: nothing preselected, the season named
    expect(within(dialog).getByText('Welcher Eintrag ist „Sousou no Frieren (Staffel 1)“?')).toBeTruthy();
    expect(within(dialog).getByText('Serie 1 von 2')).toBeTruthy();
    expect(within(dialog).getAllByRole('radio')).toHaveLength(2);
    expect(within(dialog).getAllByRole('radio').some((r) => r.checked)).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Ja, zuordnen' }).disabled).toBe(true);

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Frieren 2nd Season' }));
    expect(within(dialog).getByText('Ist „Sousou no Frieren (Staffel 1)“ dein Eintrag „Frieren 2nd Season“?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Frieren' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ja, zuordnen' }));

    await within(dialog).findByText('Welcher Eintrag ist „Dandadan (Staffel 2)“?');
    expect(post).toHaveBeenCalledWith('/api/anime/1/watched', {
      episode: 7, remember: { service: 'crunchyroll', external_id: 'GSERIES001', season: 1 }
    }, expect.anything());
    expect(post.mock.calls[0][1]).not.toHaveProperty('url');
    expect(synced.mock.calls[0][0].detail).toEqual({ service: 'crunchyroll', applied: 1, added: 0, changed: true, watch: null });
    window.removeEventListener(WATCH_SYNC_EVENT, synced);
    expect(toasts.messages('success')).toContain('Frieren: zugeordnet');
    toasts.stop();
    expect(JSON.parse(fake.prefs.get(UNMATCHED_KEY)).items.map((u) => u.external_id)).toEqual(['GSERIES002']);
    expect(screen.getByTestId('watch-unmatched').textContent).toContain('1 Serie');

    // no candidates: the whole list as a picker
    const select = within(dialog).getByLabelText('Eintrag aus der Liste');
    fireEvent.change(select, { target: { value: '3' } });
    expect(within(dialog).getByText('Ist „Dandadan (Staffel 2)“ dein Eintrag „Dandadan“?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ja, zuordnen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).toHaveBeenLastCalledWith('/api/anime/3/watched', {
      episode: 3, remember: { service: 'crunchyroll', external_id: 'GSERIES002', season: 2 }
    }, expect.anything());
    expect(screen.queryByTestId('watch-unmatched')).toBeNull();
  });

  it("'Überspringen' is remembered on the device and the hint stops counting the series", async () => {
    await seed([FRIEREN, DANDADAN]);
    const post = vi.spyOn(api, 'post');
    view();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Überspringen' }));
    await within(dialog).findByText(/Dandadan/, { selector: 'p' });
    expect(JSON.parse(fake.prefs.get(SKIPPED_KEY))).toEqual(['GSERIES001:1']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Überspringen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByTestId('watch-unmatched')).toBeNull();

    // a new load keeps the skipped series hidden
    resetUnmatchedView();
    await act(() => loadUnmatched(fake.bridge, SCOPE));
    expect(screen.queryByTestId('watch-unmatched')).toBeNull();
  });

  it("'Anderer Eintrag…' offers the rest of the list; the close button and Escape close without a write", async () => {
    await seed([{ ...FRIEREN, candidates: [FRIEREN.candidates[0]] }]);
    const post = vi.spyOn(api, 'post');
    view();
    let dialog = await openDialog();
    // one weak candidate: offered as a choice, not preselected
    expect(within(dialog).getAllByRole('radio')).toHaveLength(1);
    expect(within(dialog).getByRole('radio', { name: 'Frieren' }).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Anderer Eintrag…' }));
    const select = within(dialog).getByLabelText('Anderer Eintrag');
    expect([...select.options].map((o) => o.textContent)).toEqual(['–', 'Dandadan', 'Frieren 2nd Season']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await openDialog();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByTestId('watch-unmatched')).toBeTruthy();
  });

  it('episode above the total: "Als komplett gesehen markieren" sends complete', async () => {
    await seed([{ ...FRIEREN, episodes_watched: 30, episode: 30, candidates: [{ ...FRIEREN.candidates[0], score: 0.95 }] }]);
    const post = vi.spyOn(api, 'post')
      .mockRejectedValueOnce(new ApiError('Zu viele Folgen', { status: 400, code: 'EPISODE_ABOVE_TOTAL', data: { episodes: 28 } }))
      .mockResolvedValueOnce({ anime_id: 1, progress: { episodes_watched: 28 } });
    view();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ja, zuordnen' }));
    await within(dialog).findByText('Folge 30 liegt über den 28 Folgen dieses Eintrags.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Als komplett gesehen markieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post.mock.calls[1][1]).toMatchObject({ episode: 30, complete: true });
  });

  it("reason 'episode_above_total' offers the complete button at once; other errors stay in the dialog", async () => {
    await seed([{ ...FRIEREN, reason: 'episode_above_total', episodes_watched: 30, candidates: [FRIEREN.candidates[0]] }]);
    vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError('Server nicht erreichbar', { status: 0 }));
    view();
    const dialog = await openDialog();
    const button = within(dialog).getByRole('button', { name: 'Als komplett gesehen markieren' });
    fireEvent.click(button);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Server nicht erreichbar');
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  it('never preselects an entry of another season: focus on the choice, Enter writes nothing, the season is named', async () => {
    const s2 = { id: 2, title: 'Sousou no Frieren 2nd Season', score: 0.9, episodes: 12, season: 2 };
    await seed([{ ...FRIEREN, reason: 'no_match', candidates: [s2] }]);
    const post = vi.spyOn(api, 'post');
    view();
    const dialog = await openDialog();
    expect(within(dialog).getByText('Welcher Eintrag ist „Sousou no Frieren (Staffel 1)“?')).toBeTruthy();
    const radio = within(dialog).getByRole('radio', { name: 'Sousou no Frieren 2nd Season' });
    await waitFor(() => expect(document.activeElement).toBe(radio));
    expect(radio.checked).toBe(false);
    fireEvent.submit(dialog.querySelector('form'));
    expect(within(dialog).getByRole('alert').textContent).toBe('Bitte einen Eintrag wählen.');
    expect(post).not.toHaveBeenCalled();
  });

  it('a sure hit of the same season is preselected and its button focused', async () => {
    await seed([{ ...FRIEREN, candidates: [{ id: 1, title: 'Frieren', score: 0.95, episodes: 28, season: 1 }] }]);
    view();
    const dialog = await openDialog();
    expect(within(dialog).getByText('Ist „Sousou no Frieren“ dein Eintrag „Frieren“?')).toBeTruthy();
    expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Ja, zuordnen' })));
  });

  it('preselectedCandidate: score >= 0.9 and the same season only; the server-matched entry above the total counts', () => {
    const item = { season: 1, reason: 'ambiguous' };
    expect(preselectedCandidate(item, [{ id: 1, title: 'Frieren', score: 0.95, season: 1 }])?.id).toBe(1);
    expect(preselectedCandidate(item, [{ id: 1, title: 'Frieren', score: 0.89, season: 1 }])).toBeNull();
    expect(preselectedCandidate(item, [{ id: 2, title: 'Frieren', score: 1, season: 2 }])).toBeNull();
    // an older server without candidates[].season: the title names the season
    expect(preselectedCandidate(item, [{ id: 2, title: 'Sousou no Frieren 2nd Season', score: 0.9 }])).toBeNull();
    expect(preselectedCandidate({ season: 2 }, [{ id: 2, title: 'Sousou no Frieren 2nd Season', score: 0.9 }])?.id).toBe(2);
    expect(preselectedCandidate({ season: 1, reason: 'episode_above_total' }, [{ id: 1, title: 'Frieren', score: 0.5, season: 1 }])?.id).toBe(1);
    expect(preselectedCandidate(item, [])).toBeNull();
    // a series the user took off the list: one Enter must not bring it back
    expect(preselectedCandidate({ season: 1, reason: 'declined' }, [{ id: 1, title: 'Frieren', score: 1, season: 1 }])).toBeNull();
    expect(seasonOfCandidate({ title: 'Frieren', season: 3 })).toBe(3);
    expect(seasonOfCandidate({ title: 'Frieren' })).toBe(1);
  });

  it('after the last confirmation one forced sync runs, so the resume link of the history lands at once', async () => {
    await writeSecret(fake.bridge, { etp_rt: COOKIE, client_id: 'webClient_123', device_id: 'device-0001-abcd' });
    // a sync ran a minute ago: the floor would hold an ordinary run back
    await patchState(fake.bridge, { enabled: true, last_attempt: Date.now() - 60000 });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ anime_id: 1, progress: { episodes_watched: 7 } });
    const stop = startWatchSync({ user: EDITOR, bridge: fake.bridge });
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toHaveLength(0);
    await seed([{ ...FRIEREN, candidates: [{ id: 1, title: 'Frieren', score: 0.95, episodes: 28, season: 1 }] }]);
    view();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ja, zuordnen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/anime/watch-sync', expect.anything(), expect.anything()));
    expect(fake.calls[0].url).toMatch(/\/auth\/v1\/token$/);
    stop();
  });

  it('no sync after closing without a confirmation; a throttled sync is tried once more after the limit', async () => {
    await seed([FRIEREN]);
    const post = vi.spyOn(api, 'post');
    view();
    fireEvent.click(within(await openDialog()).getByRole('button', { name: 'Schließen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(post).not.toHaveBeenCalled();

    const sync = vi.fn().mockResolvedValueOnce({ ran: false, reason: 'throttled' }).mockResolvedValue({ ran: true });
    expect(await syncAfterMatch(fake.bridge, { sync, wait: 5 })).toEqual({ ran: false, reason: 'throttled' });
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    expect(sync).toHaveBeenCalledWith({ bridge: fake.bridge });
  });

  it('a throttled or too early sync after the dialog is tried again after the retryIn seconds', async () => {
    vi.useFakeTimers();
    try {
      for (const reason of ['throttled', 'too_soon']) {
        const sync = vi.fn().mockResolvedValueOnce({ ran: false, reason, retryIn: 2 }).mockResolvedValue({ ran: true });
        await syncAfterMatch(fake.bridge, { sync });
        vi.advanceTimersByTime(1999);
        expect(sync).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(sync).toHaveBeenCalledTimes(2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  const KUSURIYA = { kind: 'external', anilist_id: 161645, mal_id: 54492, title: 'Kusuriya no Hitorigoto', format: 'TV', season_year: 2023, episodes: 24, score: 1 };
  const PHARMACIST = { ...DANDADAN, external_id: 'GSERIES003', series_title: 'The Apothecary Diaries', season: 1, episodes_watched: 3, reason: 'no_match' };

  it('candidates not in the list yet: their own group, never preselected; "Anlegen: {title}" creates the entry with the episode', async () => {
    await seed([{ ...PHARMACIST, candidates: [KUSURIYA] }]);
    const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 9, title: 'Kusuriya no Hitorigoto' });
    const synced = vi.fn();
    window.addEventListener(WATCH_SYNC_EVENT, synced);
    view();
    const dialog = await openDialog();
    const group = within(dialog).getByRole('group', { name: 'Noch nicht in der Liste' });
    const radio = within(group).getByRole('radio', { name: /Kusuriya no Hitorigoto/ });
    expect(radio.checked).toBe(false);
    expect(radio.value).toBe('ext:161645');
    expect(within(dialog).getByRole('button', { name: 'Ja, zuordnen' }).disabled).toBe(true);
    fireEvent.click(radio);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Anlegen: Kusuriya no Hitorigoto' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).toHaveBeenCalledWith('/api/anime', {
      anilist_id: 161645, watched: { episode: 3, remember: { service: 'crunchyroll', external_id: 'GSERIES003', season: 1 } }
    }, expect.anything());
    expect(synced.mock.calls[0][0].detail).toEqual({ service: 'crunchyroll', applied: 1, added: 0, changed: true, watch: null });
    window.removeEventListener(WATCH_SYNC_EVENT, synced);
  });

  it('list and AniList candidates are cut separately (5 and 3); a sure list hit stays preselected next to them', () => {
    const listed = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `Eintrag ${i + 1}`, score: i ? 0.5 : 0.95, season: 1 }));
    const external = Array.from({ length: 4 }, (_, i) => ({ ...KUSURIYA, anilist_id: 100 + i, title: `Neu ${i}` }));
    const split = splitCandidates({ candidates: [...external.slice(0, 2), ...listed, ...external.slice(2), { kind: 'external', anilist_id: null }] });
    expect(split.list.map((c) => c.id)).toEqual([1, 2, 3, 4, 5]);
    expect(split.external.map((c) => c.anilist_id)).toEqual([100, 101, 102]);
    expect(preselectedCandidate({ season: 1, reason: 'ambiguous' }, split.list)?.id).toBe(1);
  });

  it('a sure list hit with AniList candidates beside it: all offered, the hit chosen, the others not', async () => {
    await seed([{ ...FRIEREN, candidates: [{ id: 1, title: 'Frieren', score: 0.95, episodes: 28, season: 1 }, KUSURIYA] }]);
    view();
    const dialog = await openDialog();
    expect(within(dialog).getByRole('radio', { name: 'Frieren' }).checked).toBe(true);
    expect(within(dialog).getByRole('radio', { name: /Kusuriya/ }).checked).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Ja, zuordnen' })).toBeTruthy();
  });

  it('"Anlegen" of an entry that exists by now assigns the episode to it; above its total the complete button follows', async () => {
    const item = { ...PHARMACIST, episodes_watched: 30 };
    const post = vi.fn()
      .mockRejectedValueOnce(new ApiError('Dieser Anime ist schon in der Liste', { status: 409, code: 'DUPLICATE', data: { id: 4 } }))
      .mockResolvedValueOnce({ anime_id: 4 });
    expect(await createMatch(item, KUSURIYA, { post })).toEqual({ ok: true, animeId: 4 });
    expect(post.mock.calls[1]).toEqual(['/api/anime/4/watched', { episode: 30, remember: { service: 'crunchyroll', external_id: 'GSERIES003', season: 1 } }, expect.anything()]);

    post.mockReset().mockRejectedValueOnce(new ApiError('Zu viele Folgen', { status: 400, code: 'EPISODE_ABOVE_TOTAL', data: { episodes: 24 } }));
    expect(await createMatch(item, KUSURIYA, { post })).toEqual({ aboveTotal: 24 });
    post.mockReset().mockResolvedValueOnce({ id: 9 });
    expect(await createMatch(item, KUSURIYA, { post, complete: true })).toEqual({ ok: true, animeId: 9 });
    expect(post.mock.calls[0][1].watched).toMatchObject({ episode: 30, complete: true });
  });

  it('"Anderen Anime suchen…" opens the search above the dialog and confirms the entry it brings back', async () => {
    await seed([{ ...PHARMACIST, candidates: [KUSURIYA] }]);
    const post = vi.spyOn(api, 'post').mockResolvedValue({ anime_id: 3 });
    let answer;
    const onSearchAnime = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    view({ onSearchAnime });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Anderen Anime suchen…' }));
    expect(onSearchAnime).toHaveBeenCalledWith('The Apothecary Diaries');
    await act(async () => { answer(null); });
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBe(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Anderen Anime suchen…' }));
    await act(async () => { answer({ id: 3 }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).toHaveBeenCalledWith('/api/anime/3/watched', { episode: 3, remember: { service: 'crunchyroll', external_id: 'GSERIES003', season: 1 } }, expect.anything());
  });

  it('touch targets: radio rows and footer buttons reach 44 px on phones', async () => {
    await seed([FRIEREN]);
    view();
    const dialog = await openDialog();
    for (const name of ['Überspringen', 'Ja, zuordnen']) expect(within(dialog).getByRole('button', { name }).className.split(' ')).toContain('hit-44');
    expect(within(dialog).getByRole('button', { name: 'Ja, zuordnen' }).parentElement.className).toContain('[@media(pointer:coarse)]:gap-5');
    expect(within(dialog).getAllByRole('radio')[0].closest('label').className.split(' ')).toContain('min-h-11');
  });

  it('confirmMatch and labels', async () => {
    const post = vi.fn(async () => ({}));
    expect(await confirmMatch({ external_id: 'GX1', season: null, episode: 5 }, 9, { post })).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith('/api/anime/9/watched', { episode: 5, remember: { service: 'crunchyroll', external_id: 'GX1' } }, expect.anything());
    expect(seriesLabel({ series_title: 'Frieren', season: 1 })).toBe('Frieren');
    expect(seriesLabel({ series_title: 'Frieren', season: 2 })).toBe('Frieren (Staffel 2)');
    expect(seriesLabel({ series_title: 'Frieren', season: 1 }, true)).toBe('Frieren (Staffel 1)');
  });

  it('uses the shared overlay and box of every dialog', () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, '../app/watch/WatchMatchDialog.jsx'), 'utf8');
    expect(text).toMatch(/className="outline-none dialog-overlay /);
    expect(text).toMatch(/className="dialog-box /);
    expect(text).toMatch(/useDialogA11y\(true/);
  });
});

describe('"Aktualisieren" with the Crunchyroll history (desktop)', () => {
  const WATCH = { auto_add: true, last_at: Date.now(), last_platform: 'macos', last_applied: 1, last_added: 0 };
  let desktop;
  let toasts;
  let calls;
  const serve = ({ watchSync = { applied: [], unmatched: [], unchanged: [], added: [], watch: WATCH }, pulled = 0 } = {}) => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      calls.push(`${method} ${path}`);
      if (path === '/api/anime/watch-sync') return typeof watchSync === 'function' ? watchSync() : fakeResponse(200, watchSync);
      if (path === '/api/anime/sync/run') return fakeResponse(200, { anilist: { ran: true, pulled, pushed: 0, changed: pulled > 0 }, watch: WATCH });
      if (path === '/api/anime') return fakeResponse(200, []);
      return fakeResponse(404, { error: 'Nicht gefunden' });
    }));
  };
  const setup = async (options) => {
    desktop = fakeDesktopBridge(options);
    window.mangashelfDesktop = { watch: desktop.watch };
    await patchState(desktop.bridge, { enabled: true });
    const hook = renderHook(() => useAnimeList({ user: EDITOR }));
    return hook;
  };
  const refresh = async (hook) => { await act(() => hook.result.current.refreshList()); };

  beforeEach(() => { toasts = recordToasts(); });
  afterEach(() => {
    toasts.stop();
    vi.unstubAllGlobals();
    delete window.mangashelfDesktop;
  });

  it('runs the history first, then the AniList sync and the list; the count adds both', async () => {
    serve({ watchSync: { applied: [{ anime_id: 1 }, { anime_id: 2 }], unmatched: [], unchanged: [], added: [], watch: WATCH }, pulled: 1 });
    const hook = await setup();
    await refresh(hook);
    expect(desktop.calls.filter((c) => c.method === 'sync').map((c) => c.args)).toEqual([[{ force: true }]]);
    expect(calls.filter((c) => !c.startsWith('GET /api/anime/sync'))).toEqual(['POST /api/anime/watch-sync', 'POST /api/anime/sync/run', 'GET /api/anime']);
    expect(toasts.messages()).toEqual(['3 Serien aktualisiert']);
    expect(hook.result.current.watchLast).toEqual(WATCH);
  });

  it('nothing new, and only new entries (their own toast with undo, no second one)', async () => {
    serve();
    let hook = await setup();
    await refresh(hook);
    expect(toasts.messages()).toEqual(['Nichts Neues']);
    hook.unmount();

    serve({ watchSync: { applied: [], unmatched: [], unchanged: [], added: [{ anime_id: 7, title: 'Dandadan', external_id: 'GSERIES002', season: 1, episodes_watched: 1, status: 'Schaue' }], watch: WATCH } });
    hook = await setup();
    await refresh(hook);
    expect(toasts.messages().slice(1)).toEqual(['Neu in der Liste: Dandadan']);
  });

  it('too early, a locked key store and a failed run each say so', async () => {
    serve();
    let hook = await setup({ sync: { ok: false, code: 'too_soon', retryIn: 12 } });
    await refresh(hook);
    expect(toasts.last()).toMatchObject({ kind: 'info', message: 'Gerade erst abgeglichen – wieder in 12 s' });
    hook.unmount();

    hook = await setup({ sync: { ok: false, code: 'locked' } });
    await refresh(hook);
    expect(toasts.last()).toMatchObject({ kind: 'error', message: CARD_TEXTS.locked });
    hook.unmount();

    serve({ watchSync: () => fakeResponse(500, { error: 'Interner Fehler beim Abgleich' }) });
    hook = await setup();
    await refresh(hook);
    expect(toasts.last()).toMatchObject({ kind: 'error', message: 'Interner Fehler beim Abgleich' });
  });

  it('a history the device could not fetch (offline) is no "Nichts Neues"', async () => {
    serve();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const hook = await setup();
      await refresh(hook);
      expect(desktop.calls.filter((c) => c.method === 'sync')).toEqual([]);
      expect(toasts.messages()).toEqual(['Aktualisierung fehlgeschlagen']);
    } finally {
      onLine.mockRestore();
    }
  });

  it('without a Crunchyroll login only the AniList sync and the list run', async () => {
    serve({ pulled: 2 });
    const hook = await setup({ status: { ok: true, available: true, connected: false } });
    await refresh(hook);
    expect(desktop.watch.sync).not.toHaveBeenCalled();
    expect(calls.filter((c) => !c.startsWith('GET /api/anime/sync'))).toEqual(['POST /api/anime/sync/run', 'GET /api/anime']);
    expect(toasts.messages()).toEqual(['2 Serien aktualisiert']);
  });

  it('the last watch summary stays when an event brings none', async () => {
    serve();
    const hook = await setup();
    await refresh(hook);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: { service: 'crunchyroll', applied: 0, added: 0, changed: true, watch: null } }));
    });
    expect(hook.result.current.watchLast).toEqual(WATCH);
    const next = { ...WATCH, last_platform: 'windows' };
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: { service: 'crunchyroll', applied: 0, added: 0, changed: false, watch: next } }));
    });
    expect(hook.result.current.watchLast).toEqual(next);
  });
});
