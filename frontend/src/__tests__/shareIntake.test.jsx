// Covers a shared streaming link: detection, the deep-link routing, the confirmation dialog and its writes.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useEffect } from 'react';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import { writeAnimeCache } from '../utils/animeHelpers';
import useAnimeList from '../hooks/useAnimeList';
import useShareIntake from '../hooks/useShareIntake';
import ShareLinkDialog from '../components/modals/ShareLinkDialog';
import { findStreamingLink, readClipboardText, SHARE_TEXTS, displaySeriesTitle } from '../utils/shareIntake';
import {
  buildShareLink, parseShareLink, receiveDeepLink, takePendingDeepLink, takePendingShare, hasPendingShare, DEEP_LINK_EVENT,
  SHARE_LINK_EVENT, SHARE_TEXT_LIMIT
} from '../app/deepLink';
import { openExternal, openLinkOutside, setOpenExternal } from '../app/openExternal';

const EPISODE_URL = 'https://www.crunchyroll.com/de/watch/GG1U2Q5MW/the-hero-party';
const CANONICAL = 'https://www.crunchyroll.com/watch/GG1U2Q5MW/the-hero-party';

const entry = (over = {}) => ({
  id: 1, title: 'Frieren', title_de: null, episodes: 28, my_progress: { status: 'Schaue', episodes_watched: 7, score: null, notes: null },
  progress_users: [], ...over
});

const answerOf = (over = {}) => ({
  service: 'crunchyroll', kind: 'episode', external_id: 'GG1U2Q5MW', series_id: 'GG5H5XQX4', series_title: 'Frieren: Beyond Journey’s End',
  episode: 8, episode_source: 'text', anime_id: 1, match: 'link', candidates: [], url: CANONICAL, page_checked: false, ...over
});

/**
 * fetch stub: GET /api/anime, resolve-link, watched, progress; `answer` may be a function returning a response. `server` is
 * the server's list when it differs from the cached one, `listGate` holds GET /api/anime back until it resolves.
 */
function stubApi({ list = [entry()], answer = answerOf(), watched, server = null, listGate = null, create, undo } = {}) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/anime' && method === 'GET') {
      if (listGate) await listGate;
      return fakeResponse(200, server || list);
    }
    if (url === '/api/anime/resolve-link') return typeof answer === 'function' ? answer(body) : fakeResponse(200, answer);
    if (url === '/api/anime' && method === 'POST') return create ? create(body) : fakeResponse(404, { error: 'unbekannt' });
    if (url === '/api/anime/watch-sync/undo') return undo ? undo(body) : fakeResponse(200, { removed: 'entry' });
    const w = /^\/api\/anime\/(\d+)\/watched$/.exec(url);
    if (w) {
      if (watched) return watched(body);
      const before = (server || list).find((a) => a.id === Number(w[1]))?.my_progress || null;
      const episodes = Math.max(before?.episodes_watched || 0, body.episode);
      return fakeResponse(200, {
        anime_id: Number(w[1]),
        progress: { status: 'Schaue', episodes_watched: episodes, score: null, notes: null, resume_url: body.url, resume_episode: body.episode },
        previous: before && { ...before }
      });
    }
    if (/\/progress$/.test(url) && method === 'PUT') {
      const airing = ['RELEASING', 'NOT_YET_RELEASED'].includes((server || list).find((a) => url === `/api/anime/${a.id}/progress`)?.status);
      if (body.status === 'Gesehen' && body.restore !== true && airing) return fakeResponse(400, { error: 'Läuft noch', code: 'STILL_AIRING' });
      return fakeResponse(200, { status: body.status, episodes_watched: body.episodes_watched, score: null, notes: null });
    }
    if (/\/progress$/.test(url) && method === 'DELETE') return fakeResponse(200, { success: true });
    return fakeResponse(404, { error: 'unbekannt' });
  });
  fn.calls = calls;
  vi.stubGlobal('fetch', fn);
  return fn;
}

const harness = {};
function Harness({ user = { id: 1, username: 'anna', role: 'editor' }, canEdit = true, showAnime = () => {}, openAddAnime = () => {} }) {
  const anime = useAnimeList({ user });
  useEffect(() => { anime.fetchAnime(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once
  const share = useShareIntake({ anime, user, canEdit, showAnime, openAddAnime });
  harness.share = share;
  harness.anime = anime;
  return (
    <>
      <button type="button" onClick={() => share.paste()}>Link einfügen</button>
      {share.state && (
        <ShareLinkDialog
          state={share.state}
          list={anime.list}
          listLoaded={anime.loaded}
          canAdd={canEdit}
          onClose={share.close}
          onSubmitPaste={share.submitPaste}
          onRetry={share.retry}
          onChoose={share.choose}
          onAddToList={share.addToList}
          onConfirm={share.confirm}
          onCreate={share.create}
        />
      )}
    </>
  );
}

const loadHarness = async (props) => {
  const utils = render(<Harness {...props} />);
  await waitFor(() => expect(harness.anime.loaded).toBe(true));
  return utils;
};

let toasts;
beforeEach(() => {
  toasts = recordToasts();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  toasts.stop();
  vi.unstubAllGlobals();
  while (takePendingShare());
  takePendingDeepLink();
});

describe('detection', () => {
  it('finds a Crunchyroll link inside a German share text or the url parameter; lookalikes and http are no links', () => {
    expect(findStreamingLink(`Schau dir Frieren Folge 8 auf Crunchyroll an! ${EPISODE_URL}`)).toMatchObject({ kind: 'episode', url: CANONICAL });
    expect(findStreamingLink('', 'https://crunchyroll.com/series/GG5H5XQX4/frieren')).toMatchObject({ kind: 'series' });
    expect(findStreamingLink('https://www.crunchyroll.com.evil.example/watch/GG1U2Q5MW/x')).toBeNull();
    expect(findStreamingLink('https://evilcrunchyroll.com/watch/GG1U2Q5MW/x')).toBeNull();
    expect(findStreamingLink('http://www.crunchyroll.com/watch/GG1U2Q5MW/x')).toBeNull();
    expect(findStreamingLink('ISBN 978-3-551-00000-2', '')).toBeNull();
  });

  it('reads the clipboard only when asked, and a refused read is an empty text', async () => {
    expect(await readClipboardText({ clipboard: { readText: async () => EPISODE_URL } })).toBe(EPISODE_URL);
    expect(await readClipboardText({ clipboard: { readText: async () => { throw new DOMException('denied', 'NotAllowedError'); } } })).toBe('');
    expect(await readClipboardText({})).toBe('');
  });
});

describe('deep links', () => {
  it('a streaming link is a share, never a server address; a plain server address still is', () => {
    const shares = [];
    const connects = [];
    const onShare = (e) => shares.push(e.detail);
    const onConnect = (e) => connects.push(e.detail);
    window.addEventListener(SHARE_LINK_EVENT, onShare);
    window.addEventListener(DEEP_LINK_EVENT, onConnect);
    try {
      expect(receiveDeepLink(EPISODE_URL)).toEqual({ share: true });
      expect(takePendingDeepLink()).toBeNull();
      expect(hasPendingShare()).toBe(true);
      expect(takePendingShare()).toEqual({ text: EPISODE_URL, url: '', subject: '' });
      expect(hasPendingShare()).toBe(false);

      expect(receiveDeepLink(buildShareLink({ text: 'ISBN 978-3-551-00000-2', subject: 'Buch' }))).toEqual({ share: true });
      expect(takePendingShare()).toEqual({ text: 'ISBN 978-3-551-00000-2', url: '', subject: 'Buch' });

      expect(receiveDeepLink('https://shelf.example')).toMatchObject({ url: 'https://shelf.example' });
      expect(shares).toHaveLength(2);
      expect(connects).toHaveLength(1);
    } finally {
      window.removeEventListener(SHARE_LINK_EVENT, onShare);
      window.removeEventListener(DEEP_LINK_EVENT, onConnect);
    }
  });

  it('several shares wait in order (first in, first out), at most 20', () => {
    for (const n of [1, 2, 3]) receiveDeepLink(buildShareLink({ url: `https://www.crunchyroll.com/watch/GABCDEF00${n}/folge-${n}` }));
    expect([1, 2, 3].map(() => takePendingShare()?.url.slice(-7))).toEqual(['folge-1', 'folge-2', 'folge-3']);
    expect(hasPendingShare()).toBe(false);
    expect(takePendingShare()).toBeNull();
    for (let n = 1; n <= 22; n += 1) receiveDeepLink(buildShareLink({ text: `Folge ${n} ${EPISODE_URL}` }));
    expect(takePendingShare().text).toBe(`Folge 3 ${EPISODE_URL}`);
  });

  it('buildShareLink and parseShareLink round-trip, leave out empty parts and cap the text', () => {
    const link = buildShareLink({ text: `Frieren ${EPISODE_URL}`, url: '', subject: 'Folge 8' });
    expect(link.startsWith('manga-shelf://share?')).toBe(true);
    expect(link).not.toContain('url=');
    expect(parseShareLink(link)).toEqual({ text: `Frieren ${EPISODE_URL}`, url: '', subject: 'Folge 8' });
    expect(parseShareLink(buildShareLink({ text: 'x'.repeat(5000) })).text).toHaveLength(SHARE_TEXT_LIMIT);
    expect(parseShareLink('manga-shelf://connect?url=https%3A%2F%2Fa.example')).toBeNull();
  });

  it('openExternal hands its options to the opener; a plain click on a link goes through it, a modified one stays with the browser', () => {
    const opener = vi.fn();
    setOpenExternal(opener);
    try {
      expect(openExternal(CANONICAL, { preferApp: true })).toBe(true);
      expect(opener).toHaveBeenLastCalledWith(CANONICAL, { preferApp: true });
      render(<a href={CANONICAL} onClick={(e) => openLinkOutside(e, { preferApp: true })}>Weiter</a>);
      const link = screen.getByRole('link', { name: 'Weiter' });
      expect(fireEvent.click(link)).toBe(false);
      expect(opener).toHaveBeenCalledTimes(2);
      fireEvent.click(link, { ctrlKey: true });
      expect(opener).toHaveBeenCalledTimes(2);
    } finally {
      setOpenExternal((url) => window.open(url, '_blank', 'noopener,noreferrer'));
    }
  });
});

describe('ShareLinkDialog', () => {
  it('"Ja, gesehen" saves the episode with the link and the series, and "Rückgängig" restores the old counter', async () => {
    const api = stubApi();
    await loadHarness();
    act(() => { harness.share.start({ text: `Frieren Folge 8 ${EPISODE_URL}` }); });
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('data-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toBe('Link wird gelesen…');
    const heading = await screen.findByRole('heading', { name: 'Frieren, Folge 8 gesehen?' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(dialog.getAttribute('data-busy')).toBeNull();
    expect(screen.getByRole('button', { name: 'Schließen' }).className.split(' ')).toContain('hit-44');
    expect(api.calls.find((c) => c.url === '/api/anime/resolve-link').body).toEqual({ url: CANONICAL, text: `Frieren Folge 8 ${EPISODE_URL}` });

    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => c.url === '/api/anime/1/watched').body).toEqual({
      episode: 8, url: CANONICAL, remember: { service: 'crunchyroll', external_id: 'GG5H5XQX4' }
    });
    expect(harness.anime.list[0].my_progress).toMatchObject({ episodes_watched: 8, resume_url: CANONICAL, resume_episode: 8 });
    const toast = toasts.last();
    expect(toast).toMatchObject({ kind: 'success', message: 'Frieren: Folge 8 gesehen', action: { label: 'Rückgängig' } });
    await act(() => toast.action.onClick());
    expect(api.calls.at(-1)).toEqual({ method: 'PUT', url: '/api/anime/1/progress', body: { status: 'Schaue', episodes_watched: 7, restore: true } });
  });

  it('without a match it asks "Welcher Eintrag?"; the chosen entry is written, and undo takes it off my list again', async () => {
    const list = [entry(), entry({ id: 2, title: 'Sousou no Frieren 2', my_progress: null })];
    const api = stubApi({
      list,
      answer: answerOf({ anime_id: null, match: null, series_id: null, candidates: [
        { id: 2, title: 'Sousou no Frieren 2', score: 0.9, episodes: 28, my_status: null, my_episodes: null },
        { id: 1, title: 'Frieren', score: 0.7, episodes: 28, my_status: 'Schaue', my_episodes: 7 }
      ] })
    });
    await loadHarness();
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    const group = await screen.findByRole('group', { name: 'Welcher Eintrag?' });
    expect(group.tagName).toBe('FIELDSET');
    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    expect(screen.getByRole('alert').textContent).toBe('Bitte einen Eintrag wählen.');
    expect(api.calls.some((c) => /watched/.test(c.url))).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Sousou no Frieren 2' }));
    expect(screen.getByRole('heading', { name: 'Sousou no Frieren 2, Folge 8 gesehen?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // no series id in the answer: nothing to remember
    expect(api.calls.find((c) => c.url === '/api/anime/2/watched').body).toEqual({ episode: 8, url: CANONICAL });
    await act(() => toasts.last().action.onClick());
    expect(api.calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/anime/2/progress' });
  });

  it('an unknown episode needs the number field; the current one only remembers the link, an older one changes nothing', async () => {
    const api = stubApi({ answer: answerOf({ episode: null, episode_source: null }) });
    await loadHarness();
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    expect(await screen.findByRole('heading', { name: 'Frieren: welche Folge?' })).toBeTruthy();
    const field = screen.getByLabelText('Folge');
    expect(field.className).toContain('text-base');
    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    expect(screen.getByRole('alert').textContent).toBe('Bitte die Folge eingeben.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: '5' } });
    expect(screen.getByText('Du bist schon bei Folge 7, Folge 5 ändert nichts.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ja, gesehen|Link merken/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeTruthy();
    fireEvent.change(field, { target: { value: '7' } });
    expect(screen.getByText('Du bist schon bei Folge 7 – nur den Link für „Weiter“ merken?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Link merken' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => /watched/.test(c.url)).body.episode).toBe(7);
    expect(toasts.last()).toMatchObject({ message: 'Frieren: Link für „Weiter“ gemerkt', action: null });
  });

  it('visitors and offline users get a short note and no request; a non-streaming text is left to the caller', async () => {
    const api = stubApi();
    const { unmount } = await loadHarness({ canEdit: false, user: { id: 1, username: 'v', role: 'visitor' } });
    let handled;
    act(() => { handled = harness.share.start({ text: EPISODE_URL }); });
    expect(handled).toBe(true);
    expect(toasts.messages('info')).toEqual([SHARE_TEXTS.visitor]);
    unmount();
    render(<Harness canEdit={false} user={{ id: 1, username: 'v', role: 'visitor', realRole: 'editor', offline: true }} />);
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    expect(toasts.messages('info')).toEqual([SHARE_TEXTS.visitor, SHARE_TEXTS.offline]);
    act(() => { handled = harness.share.start({ text: 'ISBN 978-3-551-00000-2' }); });
    expect(handled).toBe(false);
    expect(api.calls.some((c) => c.url === '/api/anime/resolve-link')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"Link einfügen" reads the clipboard only on the tap; without a link it offers the paste field', async () => {
    const readText = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    try {
      const api = stubApi();
      await loadHarness();
      expect(readText).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Link einfügen' }));
      const field = await screen.findByLabelText('Link aus der Crunchyroll-App oder -Website');
      expect(readText).toHaveBeenCalledTimes(1);
      expect(field.getAttribute('type')).toBe('url');
      expect(field.className).toContain('text-base');
      expect(field.getAttribute('aria-describedby')).toContain('-paste-hint');
      fireEvent.change(field, { target: { value: 'https://example.com/watch/1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Link prüfen' }));
      expect(screen.getByRole('alert').textContent).toBe('Das ist kein Crunchyroll-Link.');
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(field);
      fireEvent.change(field, { target: { value: EPISODE_URL } });
      fireEvent.click(screen.getByRole('button', { name: 'Link prüfen' }));
      expect(await screen.findByRole('heading', { name: 'Frieren, Folge 8 gesehen?' })).toBeTruthy();
      expect(api.calls.filter((c) => c.url === '/api/anime/resolve-link')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
      expect(screen.queryByRole('dialog')).toBeNull();

      readText.mockImplementation(async () => `Frieren ${EPISODE_URL}`);
      fireEvent.click(screen.getByRole('button', { name: 'Link einfügen' }));
      expect(await screen.findByRole('heading', { name: 'Frieren, Folge 8 gesehen?' })).toBeTruthy();
      expect(screen.queryByLabelText('Link aus der Crunchyroll-App oder -Website')).toBeNull();
    } finally {
      delete navigator.clipboard;
    }
  });

  it('an unsupported link says so without a retry; a failed read offers "Erneut versuchen"', async () => {
    let status = 400;
    stubApi({
      answer: () => (status === 400
        ? fakeResponse(400, { error: 'Das ist kein Crunchyroll-Link.', code: 'UNSUPPORTED_LINK' })
        : status === 503 ? fakeResponse(503, { error: 'AniList und MyAnimeList gerade nicht erreichbar' }) : fakeResponse(200, answerOf()))
    });
    await loadHarness();
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    expect((await screen.findByRole('alert')).textContent).toBe('Das ist kein Crunchyroll-Link.');
    expect(screen.queryByRole('button', { name: /Erneut versuchen/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    status = 503;
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    expect((await screen.findByRole('alert')).textContent).toBe('AniList und MyAnimeList gerade nicht erreichbar');
    status = 200;
    fireEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    expect(await screen.findByRole('heading', { name: 'Frieren, Folge 8 gesehen?' })).toBeTruthy();
  });

  it('a second share waits until the open dialog closes; "Zur Liste hinzufügen" passes the series title', async () => {
    const openAddAnime = vi.fn();
    const api = stubApi({ answer: (body) => fakeResponse(200, answerOf(/Folge 3/.test(body.text) ? { episode: 3 } : { anime_id: null, candidates: [] })) });
    await loadHarness({ openAddAnime });
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    fireEvent.click(await screen.findByRole('button', { name: /Zur Liste hinzufügen/ }));
    expect(openAddAnime).toHaveBeenCalledWith('Frieren: Beyond Journey’s End');
    act(() => { harness.share.start({ text: `Folge 3 ${EPISODE_URL}` }); });
    expect(api.calls.filter((c) => c.url === '/api/anime/resolve-link')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(await screen.findByRole('heading', { name: 'Frieren, Folge 3 gesehen?' })).toBeTruthy();
  });

  it('three shares back to back (before a render) neither abort nor overwrite each other: three dialogs in order', async () => {
    const api = stubApi({ answer: (body) => fakeResponse(200, answerOf({ episode: Number(/Folge (\d+)/.exec(body.text)[1]) })) });
    await loadHarness();
    act(() => {
      for (const n of [3, 4, 5]) harness.share.start({ text: `Folge ${n} ${EPISODE_URL}` });
    });
    for (const n of [3, 4, 5]) {
      expect(await screen.findByRole('heading', { name: `Frieren, Folge ${n} gesehen?` })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    }
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.filter((c) => c.url === '/api/anime/resolve-link').map((c) => c.body.text)).toEqual([3, 4, 5].map((n) => `Folge ${n} ${EPISODE_URL}`));
  });

  const deferred = () => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
  };
  const serverEntry = () => entry({ my_progress: { status: 'Schaue', episodes_watched: 7, score: 9, notes: 'n' } });
  const matched = { id: 1, title: 'Frieren', episodes: 28, my_status: 'Schaue', my_episodes: 7 };

  it('undo while the list was still loading restores the server\'s earlier progress instead of deleting it', async () => {
    const gate = deferred();
    const api = stubApi({ list: [], server: [serverEntry()], listGate: gate.promise, answer: answerOf({ match: 'title', series_id: null, entry: matched }) });
    render(<Harness />);
    act(() => { harness.share.start({ text: `Frieren Folge 8 ${EPISODE_URL}` }); });
    expect(await screen.findByRole('heading', { name: 'Frieren, Folge 8 gesehen?' })).toBeTruthy();
    expect(harness.anime.loaded).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    await waitFor(() => expect(toasts.last()).toMatchObject({ message: 'Frieren: Folge 8 gesehen', action: { label: 'Rückgängig' } }));
    await act(async () => { gate.release(); });
    await waitFor(() => expect(harness.anime.loaded).toBe(true));
    await act(() => toasts.last().action.onClick());
    expect(api.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(api.calls.at(-1)).toEqual({ method: 'PUT', url: '/api/anime/1/progress', body: { status: 'Schaue', episodes_watched: 7, restore: true } });
  });

  it('undo with an old cached list uses the server\'s value from before the share, not the cached one', async () => {
    writeAnimeCache([entry({ my_progress: { status: 'Schaue', episodes_watched: 4, score: null, notes: null } })], 1);
    const gate = deferred();
    const api = stubApi({ server: [serverEntry()], listGate: gate.promise, answer: answerOf({ entry: matched }) });
    render(<Harness />);
    act(() => { harness.share.start({ text: `Frieren Folge 8 ${EPISODE_URL}` }); });
    expect(await screen.findByRole('heading', { name: 'Frieren, Folge 8 gesehen?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    await waitFor(() => expect(toasts.last()?.action?.label).toBe('Rückgängig'));
    await act(() => toasts.last().action.onClick());
    expect(api.calls.filter((c) => /\/progress$/.test(c.url))).toEqual([{ method: 'PUT', url: '/api/anime/1/progress', body: { status: 'Schaue', episodes_watched: 7, restore: true } }]);
    gate.release();
  });

  it('undo of a share on a running series puts its "Gesehen" back, with the list loaded and before it loaded', async () => {
    const running = () => entry({ status: 'RELEASING', episodes: null, my_progress: { status: 'Gesehen', episodes_watched: 7, score: null, notes: null } });
    const share = async () => {
      act(() => { harness.share.start({ text: `Frieren Folge 8 ${EPISODE_URL}` }); });
      fireEvent.click(await screen.findByRole('button', { name: 'Ja, gesehen' }));
      await waitFor(() => expect(toasts.last()?.action?.label).toBe('Rückgängig'));
      await act(() => toasts.last().action.onClick());
    };
    const restored = { method: 'PUT', url: '/api/anime/1/progress', body: { status: 'Gesehen', episodes_watched: 7, restore: true } };

    let api = stubApi({ list: [running()] });
    const { unmount } = await loadHarness();
    await share();
    expect(api.calls.filter((c) => /\/progress$/.test(c.url))).toEqual([restored]);
    expect(harness.anime.list[0].my_progress).toMatchObject({ status: 'Gesehen', episodes_watched: 7 });
    unmount();

    localStorage.clear();
    const gate = deferred();
    api = stubApi({ list: [], server: [running()], listGate: gate.promise, answer: answerOf({ entry: { id: 1, title: 'Frieren', episodes: null, my_status: 'Gesehen', my_episodes: 7 } }) });
    render(<Harness />);
    await share();
    expect(api.calls.filter((c) => /\/progress$/.test(c.url))).toEqual([restored]);
    expect(toasts.messages('error')).toEqual([]);
    gate.release();
  });

  it('while the list loads without a match the picker says it is loading, not that the anime is missing', async () => {
    const gate = deferred();
    stubApi({ list: [], listGate: gate.promise, answer: answerOf({ anime_id: null, match: null, candidates: [] }) });
    render(<Harness />);
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    expect(await screen.findByText('Die Liste wird noch geladen…')).toBeTruthy();
    expect(screen.queryByText('Dieser Anime steht noch nicht in der Liste.')).toBeNull();
    gate.release();
  });

  it('an episode above the entry\'s total warns and offers another entry, the number field and "Trotzdem als komplett markieren"', async () => {
    const api = stubApi({ list: [entry({ episodes: 12 })], answer: answerOf({ episode: 29, entry: { ...matched, episodes: 12 } }) });
    await loadHarness();
    act(() => { harness.share.start({ text: `Frieren Folge 29 ${EPISODE_URL}` }); });
    expect(await screen.findByText('Folge 29 liegt über den 12 Folgen dieses Eintrags.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ja, gesehen' })).toBeNull();
    const field = screen.getByLabelText('Folge');
    expect(field.value).toBe('29');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Anderen Eintrag wählen' }));
    expect(screen.getByRole('group', { name: 'Welcher Eintrag?' })).toBeTruthy();
    fireEvent.change(field, { target: { value: '12' } });
    expect(screen.queryByText(/liegt über/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Ja, gesehen' })).toBeTruthy();
    fireEvent.change(field, { target: { value: '29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trotzdem als komplett markieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => /watched/.test(c.url)).body).toEqual({
      episode: 29, url: CANONICAL, remember: { service: 'crunchyroll', external_id: 'GG5H5XQX4' }, complete: true
    });
    expect(toasts.last()).toMatchObject({ message: 'Frieren: Folge 29 gesehen', action: { label: 'Rückgängig' } });
  });

  it('a 400 EPISODE_ABOVE_TOTAL from the server shows the same warning without an error toast', async () => {
    const bodies = [];
    stubApi({
      list: [entry({ episodes: null })],
      answer: answerOf({ episode: 29 }),
      watched: (body) => {
        bodies.push(body);
        return body.complete
          ? fakeResponse(200, { anime_id: 1, progress: { status: 'Gesehen', episodes_watched: 12 }, previous: { status: 'Schaue', episodes_watched: 7 } })
          : fakeResponse(400, { error: 'Folge 29 gibt es bei diesem Eintrag nicht (er hat nur 12 Folgen).', code: 'EPISODE_ABOVE_TOTAL', episodes: 12 });
      }
    });
    await loadHarness();
    act(() => { harness.share.start({ text: `Frieren Folge 29 ${EPISODE_URL}` }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Ja, gesehen' }));
    expect(await screen.findByText('Folge 29 liegt über den 12 Folgen dieses Eintrags.')).toBeTruthy();
    expect(toasts.messages('error')).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Folge')));
    expect(harness.anime.list[0].my_progress.episodes_watched).toBe(7);
    fireEvent.click(screen.getByRole('button', { name: 'Trotzdem als komplett markieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bodies.map((b) => b.complete)).toEqual([undefined, true]);
    expect(toasts.last()).toMatchObject({ message: 'Frieren: komplett gesehen' });
  });

  it('texts: a slug title gets capitals and no repeated subtitle, an unknown title asks neutrally, a series page sends no url', async () => {
    const SERIES = 'https://www.crunchyroll.com/de/series/GG5H5XQX4/frieren';
    expect(displaySeriesTitle({ series_title: 'sousou no frieren' }, findStreamingLink('https://www.crunchyroll.com/series/GG5H5XQX4/sousou-no-frieren'))).toBe('Sousou No Frieren');
    expect(displaySeriesTitle({ series_title: 'frieren' }, findStreamingLink(EPISODE_URL))).toBe('frieren');
    let answer = answerOf({ kind: 'series', series_title: 'frieren', episode: null, anime_id: null, match: null, candidates: [], url: 'https://www.crunchyroll.com/series/GG5H5XQX4/frieren' });
    stubApi({ list: [], answer: () => fakeResponse(200, answer) });
    await loadHarness();
    act(() => { harness.share.start({ text: SERIES }); });
    expect(await screen.findByRole('heading', { name: 'Frieren: welche Folge?' })).toBeTruthy();
    expect(screen.queryByText(/^Crunchyroll:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    answer = { ...answer, anime_id: 1, match: 'link', entry: matched };
    const { calls } = stubApi({ answer: () => fakeResponse(200, answer) });
    act(() => { harness.share.start({ text: SERIES }); });
    expect(await screen.findByRole('heading', { name: 'Frieren: welche Folge?' })).toBeTruthy();
    expect(screen.queryByText(/^Crunchyroll:/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Folge'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ja, gesehen' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.find((c) => /watched/.test(c.url)).body).toEqual({ episode: 9, remember: { service: 'crunchyroll', external_id: 'GG5H5XQX4' } });

    answer = answerOf({ series_title: null, series_id: null, episode: null, anime_id: null, match: null, candidates: [] });
    act(() => { harness.share.start({ text: EPISODE_URL }); });
    expect(await screen.findByRole('heading', { name: 'Welche Folge hast du gesehen?' })).toBeTruthy();
  });

  const SUGGESTION = { anilist_id: 154587, title: 'Sousou no Frieren', episodes: 28, format: 'TV' };
  const created = (body) => fakeResponse(201, {
    id: 7, title: 'Sousou no Frieren', title_de: null, episodes: 28, anilist_id: body.anilist_id, my_progress: { status: 'Schaue', episodes_watched: body.watched.episode },
    progress: [], watched: { progress: { status: 'Schaue', episodes_watched: body.watched.episode }, previous: null, entry_episodes: 28 }
  });

  it('a suggestion of the server: "Anlegen und als gesehen markieren" creates the entry with the episode in one request; undo removes it', async () => {
    const api = stubApi({ list: [], answer: answerOf({ anime_id: null, match: null, candidates: [], suggestion: SUGGESTION }), create: created });
    await loadHarness();
    act(() => { harness.share.start({ text: `Frieren Folge 8 ${EPISODE_URL}` }); });
    const button = await screen.findByRole('button', { name: 'Anlegen und als gesehen markieren' });
    expect(screen.getByText('Sousou no Frieren')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.filter((c) => c.method === 'POST' && c.url === '/api/anime')).toEqual([{
      method: 'POST', url: '/api/anime', body: { anilist_id: 154587, watched: { episode: 8, url: CANONICAL, remember: { service: 'crunchyroll', external_id: 'GG5H5XQX4' } } }
    }]);
    expect(api.calls.some((c) => /watched$/.test(c.url))).toBe(false);
    expect(harness.anime.list.map((a) => a.id)).toEqual([7]);
    expect(harness.anime.list[0]).not.toHaveProperty('watched');
    const toast = toasts.last();
    expect(toast).toMatchObject({ kind: 'success', message: 'Sousou no Frieren: Folge 8 gesehen', action: { label: 'Rückgängig' } });
    await act(() => toast.action.onClick());
    expect(api.calls.at(-1)).toEqual({ method: 'POST', url: '/api/anime/watch-sync/undo', body: { anime_id: 7 } });
    expect(harness.anime.list).toEqual([]);
  });

  it('an undo too late shows the server\'s text and keeps the entry', async () => {
    stubApi({
      list: [], answer: answerOf({ anime_id: null, match: null, candidates: [], suggestion: SUGGESTION }), create: created,
      undo: () => fakeResponse(409, { error: 'Rückgängig geht nicht mehr', code: 'UNDO_EXPIRED' })
    });
    await loadHarness();
    act(() => { harness.share.start({ text: `Frieren Folge 8 ${EPISODE_URL}` }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Anlegen und als gesehen markieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(() => toasts.last().action.onClick());
    expect(toasts.messages('error')).toEqual(['Rückgängig geht nicht mehr']);
    expect(harness.anime.list.map((a) => a.id)).toEqual([7]);
  });

  it('the suggested anime is in the collection by now: the episode goes to that entry instead', async () => {
    const list = [entry({ id: 3, title: 'Frieren', my_progress: null })];
    const api = stubApi({
      list, answer: answerOf({ anime_id: null, match: null, candidates: [], suggestion: SUGGESTION }),
      create: () => fakeResponse(409, { error: 'Dieser Anime ist schon in der Liste', code: 'DUPLICATE', id: 3 })
    });
    await loadHarness();
    act(() => { harness.share.start({ text: `Frieren Folge 8 ${EPISODE_URL}` }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Anlegen und als gesehen markieren' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.calls.find((c) => c.url === '/api/anime/3/watched').body).toEqual({
      episode: 8, url: CANONICAL, remember: { service: 'crunchyroll', external_id: 'GG5H5XQX4' }
    });
    expect(toasts.last()).toMatchObject({ message: 'Frieren: Folge 8 gesehen', action: { label: 'Rückgängig' } });
  });

  it('above the suggestion\'s total the dialog says so; choosing a list entry takes the offer away', async () => {
    stubApi({
      list: [entry()], answer: answerOf({ anime_id: null, match: null, episode: 30, candidates: [], suggestion: SUGGESTION }),
      create: () => fakeResponse(400, { error: 'Zu viele Folgen', code: 'EPISODE_ABOVE_TOTAL', episodes: 28 })
    });
    await loadHarness();
    act(() => { harness.share.start({ text: `Frieren Folge 30 ${EPISODE_URL}` }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Anlegen und als gesehen markieren' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Folge 30 liegt über den 28 Folgen dieses Eintrags.');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(toasts.messages('error')).toEqual([]);
    fireEvent.change(screen.getByLabelText('Eintrag aus der Liste'), { target: { value: '1' } });
    expect(screen.queryByRole('button', { name: 'Anlegen und als gesehen markieren' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Trotzdem als komplett markieren' })).toBeTruthy();
  });

  it('Escape closes the dialog and focus goes back to the button that opened it', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    try {
      stubApi();
      await loadHarness();
      const button = screen.getByRole('button', { name: 'Link einfügen' });
      button.focus();
      fireEvent.click(button);
      const field = await screen.findByLabelText('Link aus der Crunchyroll-App oder -Website');
      await waitFor(() => expect(document.activeElement).toBe(field));
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(button);
    } finally {
      delete navigator.clipboard;
    }
  });
});
