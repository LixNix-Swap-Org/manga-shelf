// Covers the anime tab: card, view, detail modal and add modal.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, renderHook, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fakeResponse } from './fakeResponse';
import AnimeCard from '../components/dashboard/AnimeCard';
import AnimeView, { watchLastText } from '../components/dashboard/AnimeView';
import AnimeDetailModal from '../components/modals/AnimeDetailModal';
import AddAnimeModal, { sourcesNote } from '../components/modals/AddAnimeModal';
import MainViewSwitcher from '../components/dashboard/MainViewSwitcher';
import AnimeStatsCard, { watchTime } from '../components/modals/stats/AnimeStatsCard';
import useAnimeList from '../hooks/useAnimeList';
import { mainViewOf, searchForView } from '../Dashboard';
import {
  countdownText, progressText, plusOneDisabled, filterAnime, filterCounts, predictProgress, readAnimeCache, writeAnimeCache, clearAnimeCache,
  ANIME_CACHE_KEY, ANIME_META_KEY, staleText, continueTarget, predictWatched, listSyncDue, markListSync, LIST_SYNC_INTERVAL_MS,
  shortDescription, progressPercent, airedEpisodes, stillAiring
} from '../utils/animeHelpers';
import { subscribe as subscribeToasts } from '../utils/notify';
import { OFFLINE_SYNCED_EVENT } from '../utils/offlineStore';
import { setOpenExternal } from '../app/openExternal';
import { ANIME_SYNC_EVENT } from '../utils/shareIntake';
import { WATCH_SYNC_EVENT } from '../app/watch/watchState';

const entry = (over = {}) => ({
  id: 1, title: 'Frieren', title_de: null, format: 'TV', season_year: 2023, episodes: 12, cover_image: null, anilist_id: 154587, mal_id: 52991,
  manual: false, next_airing: null, my_progress: { status: 'Schaue', episodes_watched: 7, score: null, notes: null }, progress_users: [], ...over
});

const inRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('AnimeCard', () => {
  it('+1 calls back with the entry; "Gesehen" disables it; visitors get no controls', () => {
    const onPlusOne = vi.fn();
    const onStatusChange = vi.fn();
    const { rerender } = inRouter(<AnimeCard anime={entry()} canEdit onOpen={vi.fn()} onPlusOne={onPlusOne} onStatusChange={onStatusChange} userId={1} />);
    expect(screen.getByText('7 / 12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /eine Folge mehr gesehen/ }));
    expect(onPlusOne).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    fireEvent.change(screen.getByLabelText(/Status für Frieren/), { target: { value: 'Pausiert' } });
    expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'Pausiert');

    rerender(<MemoryRouter><AnimeCard anime={entry({ my_progress: { status: 'Gesehen', episodes_watched: 12 } })} canEdit onOpen={vi.fn()} onPlusOne={onPlusOne} onStatusChange={onStatusChange} userId={1} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: /eine Folge mehr gesehen/ }).disabled).toBe(true);

    rerender(<MemoryRouter><AnimeCard anime={entry()} canEdit={false} onOpen={vi.fn()} onPlusOne={onPlusOne} onStatusChange={onStatusChange} userId={1} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /eine Folge mehr gesehen/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('shows the countdown, the estimate badge, co-watchers and the link to the series', () => {
    const at = Math.floor((Date.now() + 3 * 86400000) / 1000);
    inRouter(<AnimeCard anime={entry({ manga_id: 9, next_airing: { episode: 8, at, estimated: true }, progress_users: [{ user_id: 2, username: 'kim', status: 'Schaue', episodes_watched: 3 }] })}
      canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    expect(screen.getByText(/Folge 8 · in 3 Tagen/)).toBeTruthy();
    expect(screen.getByText('geschätzt')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Schauen auch: kim' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Zur verknüpften Reihe' }).getAttribute('href')).toBe('/manga/9');
  });

  it('a running show without a total counts against the aired episodes; "Gesehen" is locked while it airs, +1 is not', () => {
    const onePiece = entry({ title: 'ONE PIECE', episodes: null, status: 'RELEASING', next_airing: { episode: 1181, at: 1798985760, estimated: false }, my_progress: { status: 'Gesehen', episodes_watched: 12 } });
    const { rerender } = inRouter(<AnimeCard anime={onePiece} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    expect(screen.getByText('12 / 1180+')).toBeTruthy();
    expect(screen.getByLabelText('12 von bisher 1180 ausgestrahlten Folgen gesehen')).toBeTruthy();
    expect(screen.getByRole('button', { name: /eine Folge mehr gesehen/ }).disabled).toBe(false);
    const option = screen.getByRole('option', { name: 'Gesehen' });
    expect(option.disabled).toBe(true);
    expect(option.getAttribute('title')).toBe('Läuft noch');
    expect(screen.getByRole('option', { name: 'Schaue' }).disabled).toBe(false);

    rerender(<MemoryRouter><AnimeCard anime={{ ...onePiece, next_airing: { ...onePiece.next_airing, estimated: true } }} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} /></MemoryRouter>);
    expect(screen.getByText('12 / ?')).toBeTruthy();
    expect(screen.getByLabelText('12 von unbekannt vielen Folgen gesehen')).toBeTruthy();

    rerender(<MemoryRouter><AnimeCard anime={entry({ status: 'FINISHED' })} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} /></MemoryRouter>);
    expect(screen.getByRole('option', { name: 'Gesehen' }).disabled).toBe(false);
    expect(screen.getByRole('option', { name: 'Gesehen' }).getAttribute('title')).toBeNull();
  });
});

describe('AnimeCard "Weiter auf Crunchyroll"', () => {
  const watch = { next_url: 'https://www.crunchyroll.com/watch/NEXT1234/the-next', series_url: null, search_url: 'https://www.crunchyroll.com/search?q=Frieren' };
  afterEach(() => setOpenExternal((url) => window.open(url, '_blank', 'noopener,noreferrer')));

  it('links the next episode outside the h3, opens it through openExternal with preferApp; a modified click stays with the browser', () => {
    const opener = vi.fn();
    setOpenExternal(opener);
    inRouter(<AnimeCard anime={entry({ watch })} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    const link = screen.getByRole('link', { name: 'Weiter auf Crunchyroll: Frieren' });
    expect(link.getAttribute('href')).toBe(watch.next_url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.className.split(' ')).toContain('hit-44');
    const card = document.querySelector('[data-anime-id="1"]');
    expect(card.querySelectorAll('h3 button')).toHaveLength(1);
    expect(card.querySelectorAll('select')).toHaveLength(1);
    expect(fireEvent.click(link)).toBe(false);
    expect(opener).toHaveBeenCalledWith(watch.next_url, { preferApp: true });
    fireEvent.click(link, { metaKey: true });
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('visitors get the link too; none without a Crunchyroll link (search only) and none once watched', () => {
    const { rerender } = inRouter(<AnimeCard anime={entry({ watch })} canEdit={false} onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    expect(screen.getByRole('link', { name: /^Weiter auf Crunchyroll/ })).toBeTruthy();
    rerender(<MemoryRouter><AnimeCard anime={entry({ watch: { ...watch, next_url: null } })} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /Crunchyroll/ })).toBeNull();
    rerender(<MemoryRouter><AnimeCard anime={entry({ watch, my_progress: { status: 'Gesehen', episodes_watched: 12 } })} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /Crunchyroll/ })).toBeNull();
  });
});

describe('AnimeCard long titles', () => {
  it('wraps and hyphenates the title in two lines with the title language; the counter stays on one line', () => {
    const { unmount } = inRouter(<AnimeCard anime={entry({ title: 'Donaudampfschifffahrtskapitänsabenteuer', my_progress: null })} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    const heading = screen.getByRole('heading', { name: 'Donaudampfschifffahrtskapitänsabenteuer' });
    expect(heading.getAttribute('lang')).toBe('de');
    const text = within(heading).getByText('Donaudampfschifffahrtskapitänsabenteuer');
    for (const c of ['line-clamp-2', 'break-words', 'hyphens-auto', '[overflow-wrap:anywhere]']) expect(text.className.split(' ')).toContain(c);
    expect(text.closest('button').className.split(' ')).toEqual(expect.arrayContaining(['block', 'max-w-full']));
    expect(screen.getByText('Nicht auf meiner Liste').className).toContain('min-w-0');
    const counter = screen.getByLabelText(/0 von 12 Folgen gesehen/);
    expect(counter.className.split(' ')).toEqual(expect.arrayContaining(['font-mono', 'whitespace-nowrap', 'shrink-0']));
    unmount();
    inRouter(<AnimeCard anime={entry({ title: '葬送のフリーレン' })} canEdit={false} onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    expect(screen.getByRole('heading', { name: '葬送のフリーレン' }).getAttribute('lang')).toBe('ja');
  });
});

describe('animeHelpers', () => {
  it('progress text, +1 rule and countdown by calendar days', () => {
    expect(progressText(7, 12)).toBe('7 / 12');
    expect(progressText(7, null)).toBe('7 / ?');
    expect(plusOneDisabled({ status: 'Schaue', episodes_watched: 12 }, 12)).toBe(true);
    expect(plusOneDisabled({ status: 'Schaue', episodes_watched: 12 }, null)).toBe(false);
    expect(plusOneDisabled({ status: 'Gesehen', episodes_watched: 12 }, 12)).toBe(true);
    expect(plusOneDisabled({ status: 'Gesehen', episodes_watched: 12 }, null)).toBe(false);
    expect(plusOneDisabled({ status: 'Gesehen', episodes_watched: 5 }, 12)).toBe(false);
    const now = new Date(2026, 9, 4, 22, 0);
    expect(countdownText({ episode: 8, at: Math.floor(new Date(2026, 9, 5, 1, 0).getTime() / 1000) }, now)).toBe('Folge 8 · morgen');
    expect(countdownText({ episode: 8, at: Math.floor(new Date(2026, 9, 4, 23, 30).getTime() / 1000) }, now)).toMatch(/^Folge 8 · heute 23:30/);
    expect(countdownText({ episode: 8, at: Math.floor(new Date(2026, 9, 1).getTime() / 1000) }, now)).toBeNull();
    expect(staleText({ stale: true, meta_fetched_at: Date.now() - 3 * 86400000 })).toMatch(/^Stand: vor 3 Tagen/);
  });

  it('the aired episodes of a running show without a total are for display only and need a confirmed next airing', () => {
    const onePiece = { episodes: null, status: 'RELEASING', next_airing: { episode: 1181, at: 1798985760, estimated: false } };
    expect(airedEpisodes(onePiece)).toBe(1180);
    expect(airedEpisodes({ ...onePiece, next_airing: { ...onePiece.next_airing, estimated: true } })).toBeNull();
    expect(airedEpisodes({ ...onePiece, next_airing: { ...onePiece.next_airing, episode: 1 } })).toBeNull();
    expect(airedEpisodes({ ...onePiece, next_airing: null })).toBeNull();
    expect(airedEpisodes({ ...onePiece, episodes: 1200 })).toBeNull();
    expect(progressText(12, null, 1180)).toBe('12 / 1180+');
    expect(progressText(12, 24, 1180)).toBe('12 / 24');
    expect(progressPercent(590, null, 1180)).toBe(50);
    expect(progressPercent(1300, null, 1180)).toBe(100);
    expect(progressPercent(7, null)).toBeNull();
    expect(progressPercent(6, 12, 1180)).toBe(50);
    expect(predictProgress({ status: 'Schaue', episodes_watched: 1180 }, { episodes_watched: 1181 }, null)).toMatchObject({ status: 'Schaue', episodes_watched: 1181 });
    expect(stillAiring(onePiece)).toBe(true);
    expect(stillAiring({ status: 'NOT_YET_RELEASED' })).toBe(true);
    expect(stillAiring({ status: 'FINISHED' })).toBe(false);
    expect(stillAiring(null)).toBe(false);
  });

  it('the description is plain text: line breaks kept, tags removed even when nested, cut at a word', () => {
    expect(shortDescription('A<br>B<br/>C <i>kursiv</i>')).toEqual({ text: 'A\nB\nC kursiv', cut: false });
    expect(shortDescription('<scr<script>ipt>alert(1)</script>x').text).toBe('ipt>alert(1)x');
    expect(shortDescription('<<b>b>fett</b>').text).not.toMatch(/<[^>]*>/);
    expect(shortDescription('1 < 2').text).toBe('1 < 2');
    expect(shortDescription(null)).toEqual({ text: '', cut: false });
    expect(shortDescription('wort '.repeat(10), 12)).toEqual({ text: 'wort wort …', cut: true });
  });

  it('filters by my status, sorts, counts', () => {
    const list = [
      entry({ id: 1, title: 'B', my_progress: { status: 'Gesehen', score: 9 } }),
      entry({ id: 2, title: 'A', my_progress: null, next_airing: { at: 100 } }),
      entry({ id: 3, title: 'C', my_progress: { status: 'Schaue', score: 5 } })
    ];
    expect(filterAnime(list).map((a) => a.id)).toEqual([2, 1, 3]);
    expect(filterAnime(list, { filter: 'Ohne Status' }).map((a) => a.id)).toEqual([2]);
    expect(filterAnime(list, { sort: 'score' }).map((a) => a.id)).toEqual([1, 3, 2]);
    expect(filterAnime(list, { sort: 'next' })[0].id).toBe(2);
    expect(filterAnime(list, { search: 'c' }).map((a) => a.id)).toEqual([3]);
    expect(filterCounts(list)).toMatchObject({ Alle: 3, Gesehen: 1, Schaue: 1, 'Ohne Status': 1 });
  });

  it('predicts the server rules for the optimistic update', () => {
    expect(predictProgress(null, { episodes_watched: 1 }, 12)).toMatchObject({ status: 'Schaue', episodes_watched: 1 });
    expect(predictProgress({ status: 'Schaue', episodes_watched: 11 }, { episodes_watched: 12 }, 12)).toMatchObject({ status: 'Gesehen', episodes_watched: 12 });
    expect(predictProgress({ status: 'Schaue', episodes_watched: 3 }, { status: 'Gesehen' }, 12).episodes_watched).toBe(12);
    expect(predictProgress({ status: 'Schaue', episodes_watched: 3 }, { episodes_watched: 99 }, 12).episodes_watched).toBe(12);
  });

  it('predicts "Geplant" and "Gesehen" like the server: choosing Geplant resets, a counter means Schaue, below the total Gesehen goes back', () => {
    const watching = { status: 'Schaue', episodes_watched: 5, score: 8, notes: null, started_at: '2026-10-01', finished_at: null };
    expect(predictProgress(watching, { status: 'Geplant' }, 12)).toMatchObject({ status: 'Geplant', episodes_watched: 0, score: 8, started_at: null, finished_at: null });
    expect(predictProgress(watching, { status: 'Geplant', episodes_watched: 3 }, 12)).toMatchObject({ status: 'Schaue', episodes_watched: 3 });
    expect(predictProgress(null, { status: 'Geplant', episodes_watched: 3 }, null)).toMatchObject({ status: 'Schaue', episodes_watched: 3 });
    expect(predictProgress({ ...watching, status: 'Geplant', episodes_watched: 3 }, { score: 9 }, 12)).toMatchObject({ status: 'Schaue', episodes_watched: 3, score: 9 });

    const done = { status: 'Gesehen', episodes_watched: 12, score: null, notes: null, started_at: '2026-10-01', finished_at: '2026-10-10' };
    expect(predictProgress(done, { status: 'Geplant' }, 12)).toMatchObject({ status: 'Geplant', episodes_watched: 0, finished_at: null, started_at: null });
    expect(predictProgress(done, { status: 'Pausiert' }, 12)).toMatchObject({ status: 'Pausiert', episodes_watched: 12, finished_at: null, started_at: '2026-10-01' });
    expect(predictProgress(done, { episodes_watched: 5 }, 12)).toMatchObject({ status: 'Schaue', episodes_watched: 5, finished_at: null });
    expect(predictProgress(done, { episodes_watched: 13 }, null)).toMatchObject({ status: 'Schaue', episodes_watched: 13 });
    expect(predictProgress(done, { episodes_watched: 12 }, 12)).toMatchObject({ status: 'Gesehen', finished_at: '2026-10-10' });
    expect(predictProgress(done, { score: 7 }, null)).toMatchObject({ status: 'Gesehen', episodes_watched: 12, finished_at: '2026-10-10' });
    expect(predictProgress({ ...done, status: 'Schaue', finished_at: null }, { status: 'Gesehen' }, 12)).toMatchObject({ status: 'Gesehen', episodes_watched: 12 });
  });

  it('a counter change by hand drops the remembered "Weiter" page; a shared episode never lowers the counter', () => {
    const mine = { status: 'Schaue', episodes_watched: 7, resume_url: 'https://www.crunchyroll.com/watch/A1B2C3D4', resume_episode: 7 };
    expect(predictProgress(mine, { episodes_watched: 8 }, 12)).toMatchObject({ episodes_watched: 8, resume_url: null, resume_episode: null });
    expect(predictProgress(mine, { score: 8 }, 12)).toMatchObject({ resume_url: mine.resume_url, resume_episode: 7 });
    const url = 'https://www.crunchyroll.com/watch/E5F6G7H8';
    expect(predictWatched(mine, { episode: 9, url }, 12)).toMatchObject({ status: 'Schaue', episodes_watched: 9, resume_url: url, resume_episode: 9 });
    expect(predictWatched(mine, { episode: 3, url }, 12)).toMatchObject({ episodes_watched: 7, resume_episode: 3 });
    expect(predictWatched({ status: 'Pausiert', episodes_watched: 2 }, { episode: 3 }, 12).status).toBe('Schaue');
    expect(predictWatched({ status: 'Pausiert', episodes_watched: 5 }, { episode: 3 }, 12).status).toBe('Pausiert');
    expect(predictWatched(null, { episode: 12, url }, 12)).toMatchObject({ status: 'Gesehen', episodes_watched: 12 });
  });

  it('"Weiter auf Crunchyroll" follows the core chain; the card needs a real link, the detail falls back to the search', () => {
    const watch = { next_url: 'https://www.crunchyroll.com/watch/NEXT1234', series_url: 'https://www.crunchyroll.com/series/SER12345', search_url: 'https://www.crunchyroll.com/search?q=Frieren' };
    expect(continueTarget(entry({ watch }))).toEqual({ url: watch.next_url, kind: 'episode', label: 'Weiter auf Crunchyroll' });
    expect(continueTarget(entry({ watch: { ...watch, next_url: null } }))).toMatchObject({ url: watch.series_url, kind: 'series' });
    expect(continueTarget(entry({ watch: { ...watch, next_url: null, series_url: null } }))).toEqual({ url: watch.search_url, kind: 'search', label: 'Auf Crunchyroll suchen' });
    expect(continueTarget(entry({ watch: { ...watch, next_url: null, series_url: null } }), { search: false })).toBeNull();
    // an older list without `watch`: the search is built here from the English title
    expect(continueTarget(entry({ title_english: 'Frieren: Beyond Journey’s End' })).url).toBe('https://www.crunchyroll.com/search?q=Frieren%3A%20Beyond%20Journey%E2%80%99s%20End');
    expect(continueTarget(entry({ watch, my_progress: { status: 'Gesehen', episodes_watched: 12 } }))).toBeNull();
    expect(continueTarget(entry({ watch, my_progress: { status: 'Schaue', episodes_watched: 12 } }))).toBeNull();
  });

  it('the list sync of the tab is due once per 15 minutes and user', () => {
    sessionStorage.clear();
    expect(listSyncDue(1, 1_000_000)).toBe(true);
    markListSync(1, 1_000_000);
    expect(listSyncDue(1, 1_000_000 + LIST_SYNC_INTERVAL_MS - 1)).toBe(false);
    expect(listSyncDue(2, 1_000_000)).toBe(true);
    expect(listSyncDue(1, 1_000_000 + LIST_SYNC_INTERVAL_MS)).toBe(true);
  });

  it('the offline copy belongs to its user and goes with clearOfflineData', () => {
    writeAnimeCache([entry()], 5);
    expect(readAnimeCache(5).list).toHaveLength(1);
    expect(readAnimeCache(6)).toBeNull();
    window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: { synced_at: '2026-10-04' } }));
    expect(localStorage.getItem(ANIME_CACHE_KEY)).not.toBeNull();
    window.dispatchEvent(new CustomEvent(OFFLINE_SYNCED_EVENT, { detail: { synced_at: null } }));
    expect(localStorage.getItem(ANIME_CACHE_KEY)).toBeNull();
    expect(localStorage.getItem(ANIME_META_KEY)).toBeNull();
  });

  it('the cache keeps the last watch summary until a new one comes, per user, and clearAnimeCache drops it', () => {
    const watch = { auto_add: true, last_at: 1_000_000, last_platform: 'linux', last_applied: 2, last_added: 1 };
    expect(writeAnimeCache(null, 5, undefined, { watch })).toBeNull();
    const stamp = writeAnimeCache([entry()], 5, undefined, { watch });
    expect(readAnimeCache(5)).toEqual({ list: [entry()], timestamp: stamp, watch });
    writeAnimeCache([entry(), entry({ id: 2 })], 5);
    expect(readAnimeCache(5).watch).toEqual(watch);
    const next = { ...watch, last_platform: 'ios' };
    expect(writeAnimeCache(null, 5, undefined, { watch: next })).toBe(readAnimeCache(5).timestamp);
    expect(readAnimeCache(5)).toMatchObject({ watch: next, list: [entry(), entry({ id: 2 })] });
    writeAnimeCache([entry()], 6);
    expect(readAnimeCache(6).watch).toBeNull();
    writeAnimeCache([entry()], 5, undefined, { watch: next });
    clearAnimeCache();
    expect(localStorage.getItem(ANIME_META_KEY)).toBeNull();
    expect(readAnimeCache(5)).toBeNull();
  });

  it('?view=anime is a main view; ?add= never survives a view change', () => {
    expect(mainViewOf('?view=anime')).toBe('anime');
    expect(mainViewOf('?view=radar')).toBe('radar');
    expect(mainViewOf('?view=unbekannt')).toBe('shelf');
    expect(searchForView('?view=anime&add=4', 'anime')).toBe('?view=anime');
    expect(searchForView('?view=anime&add=4', 'shelf')).toBe('');
    expect(searchForView('', 'radar')).toBe('?view=radar');
  });
});

describe('AddAnimeModal', () => {
  it('the manual tab sends title and episodes', async () => {
    const onAdd = vi.fn(async () => ({ id: 3 }));
    const onClose = vi.fn();
    render(<AddAnimeModal isOpen onClose={onClose} search={vi.fn()} onAdd={onAdd} mangas={[{ id: 4, title: 'Frieren' }]} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Manuell' }));
    fireEvent.change(screen.getByLabelText('Titel'), { target: { value: '  Heimvideo  ' } });
    fireEvent.change(screen.getByLabelText('Folgen (optional)'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Zu Reihe verknüpfen'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ title: 'Heimvideo', episodes: 3, manga_id: 4 }));
    expect(onClose).toHaveBeenCalled();
  });

  it('searches on the button, marks entries already in the list and adds a hit by its ids', async () => {
    const search = vi.fn(async () => ({
      results: [
        { anilist_id: 154587, mal_id: 52991, title: { preferred: 'Frieren', romaji: 'Sousou no Frieren' }, format: 'TV', season_year: 2023, episodes: 28, in_collection_id: null },
        { anilist_id: 182255, mal_id: null, title: { preferred: 'Frieren 2' }, in_collection_id: 7 }
      ],
      sources_used: ['anilist'], partial: true
    }));
    const onAdd = vi.fn(async () => ({}));
    render(<AddAnimeModal isOpen onClose={vi.fn()} search={search} onAdd={onAdd} />);
    fireEvent.change(screen.getByLabelText('Titel suchen'), { target: { value: 'Frieren' } });
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Suchen' }));
    expect(await screen.findByText('Sousou no Frieren')).toBeTruthy();
    expect(screen.getByText('Gerade nur AniList erreichbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: /schon im Regal/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Hinzufügen/ }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ anilist_id: 154587, mal_id: 52991, manga_id: null }));
    expect(sourcesNote({ sources_used: ['anilist', 'jikan'], partial: false })).toBeNull();
  });

  it('the tabs follow the ARIA pattern and switch with the arrow keys', () => {
    render(<AddAnimeModal isOpen onClose={vi.fn()} search={vi.fn()} onAdd={vi.fn()} />);
    const search = screen.getByRole('tab', { name: 'Suche' });
    const manual = screen.getByRole('tab', { name: 'Manuell' });
    const panel = screen.getByRole('tabpanel');
    expect(search.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(search.id);
    expect(panel.contains(screen.getByLabelText('Titel suchen'))).toBe(true);
    expect([search.tabIndex, manual.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(search, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(manual);
    expect(manual.getAttribute('aria-selected')).toBe('true');
    expect([search.tabIndex, manual.tabIndex]).toEqual([-1, 0]);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(manual.id);
    expect(screen.getByLabelText('Titel')).toBeTruthy();
    fireEvent.keyDown(manual, { key: 'Home' });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'End' });
    expect(document.activeElement).toBe(manual);
  });

  it('opened from a series it suggests that series\' adaptations', async () => {
    const loadAdaptations = vi.fn(async () => ({ results: [{ relation: 'ADAPTATION', kind: 'ANIME', anilist_id: 154587, mal_id: 52991, title: 'Sousou no Frieren', format: 'TV', season_year: 2023, in_collection_id: null }], source: 'anilist' }));
    render(<AddAnimeModal isOpen onClose={vi.fn()} search={vi.fn()} loadAdaptations={loadAdaptations} onAdd={vi.fn()} mangas={[{ id: 4, title: 'Frieren', alt_title: 'Sousou no Frieren' }]} initialMangaId={4} />);
    expect(await screen.findByText('Anime-Adaptionen dieser Reihe')).toBeTruthy();
    expect(loadAdaptations).toHaveBeenCalledWith(4, expect.anything());
    expect(screen.getByLabelText('Zu Reihe verknüpfen').value).toBe('4');
    expect(screen.getByLabelText('Titel suchen').value).toBe('Sousou no Frieren');
  });

  it('a title from a shared link fills the search and runs it once', async () => {
    const search = vi.fn(async () => ({ results: [], sources_used: ['anilist'], partial: false }));
    render(<AddAnimeModal isOpen onClose={vi.fn()} search={search} onAdd={vi.fn()} initialQuery="Frieren: Beyond Journey’s End" />);
    expect(screen.getByLabelText('Titel suchen').value).toBe('Frieren: Beyond Journey’s End');
    await waitFor(() => expect(search).toHaveBeenCalledWith('Frieren: Beyond Journey’s End', expect.anything()));
    expect(await screen.findByText(/Keine Treffer/)).toBeTruthy();
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('AnimeView', () => {
  const base = { loaded: true, loading: false, error: null, fromCache: false, cacheAt: null, user: { id: 1, role: 'editor' }, onAdd: vi.fn(), onOpen: vi.fn(), onPlusOne: vi.fn(), onStatusChange: vi.fn(), onRetry: vi.fn() };

  beforeEach(() => sessionStorage.clear());

  it('empty state, add button for editors, none offline', () => {
    const { rerender } = inRouter(<AnimeView {...base} list={[]} canEdit sources={null} />);
    expect(screen.getByText('Noch keine Anime in der Liste')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Anime hinzufügen/ })).toBeTruthy();
    rerender(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit user={{ id: 1, role: 'visitor', offline: true }} cacheAt={new Date().toISOString()} sources={null} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /Anime hinzufügen/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Offline: gespeicherte Liste/);
    expect(screen.queryByRole('button', { name: /eine Folge mehr gesehen/ })).toBeNull();
  });

  it('empty state keeps its text off the dashed border; the toolbar button stays on one line', () => {
    inRouter(<AnimeView {...base} list={[]} canEdit sources={null} />);
    const empty = document.getElementById('anime-empty');
    expect(empty.className).toContain('px-6');
    expect(empty.className).toContain('border-dashed');
    const add = document.getElementById('btn-add-anime');
    expect(add.className).toContain('whitespace-nowrap');
    expect(add.className).toContain('shrink-0');
    expect(screen.getByText('Sortierung').className).toContain('sr-only sm:not-sr-only');
    expect(screen.getByLabelText('Sortierung').className).toContain('min-w-0');
  });

  it('"Link einfügen" only for editors online; the clipboard is never read by the view itself', () => {
    const readText = vi.fn(async () => '');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText } });
    try {
      const onPasteLink = vi.fn();
      const { rerender } = inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={null} onPasteLink={onPasteLink} />);
      const button = document.getElementById('btn-anime-paste-link');
      expect(button.textContent).toBe(' Link einfügen');
      expect(screen.getByRole('button', { name: 'Link einfügen' })).toBe(button);
      expect(button.className).toContain('shrink-0');
      fireEvent.click(button);
      expect(onPasteLink).toHaveBeenCalledTimes(1);
      expect(readText).not.toHaveBeenCalled();
      rerender(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit={false} sources={null} onPasteLink={onPasteLink} /></MemoryRouter>);
      expect(document.getElementById('btn-anime-paste-link')).toBeNull();
      rerender(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit user={{ id: 1, role: 'visitor', offline: true }} sources={null} onPasteLink={onPasteLink} /></MemoryRouter>);
      expect(document.getElementById('btn-anime-paste-link')).toBeNull();
    } finally {
      delete navigator.clipboard;
    }
  });

  it('a paused AniList list sync shows its reason and the key button', () => {
    const onOpenAccount = vi.fn();
    inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={null} listSync={{ last_error: 'AniList lehnt den Token ab – bitte im Konto neu eintragen' }} onOpenAccount={onOpenAccount} />);
    expect(screen.getByText(/AniList-Abgleich pausiert: AniList lehnt den Token ab/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Schlüssel prüfen' }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it('a list sync that only could not reach AniList says so without "pausiert" and without the key button', () => {
    inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={null} listSync={{ last_error: 'AniList ist gerade nicht erreichbar' }} onOpenAccount={vi.fn()} />);
    expect(screen.getByText('AniList-Abgleich: AniList ist gerade nicht erreichbar')).toBeTruthy();
    expect(screen.queryByText(/pausiert/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Schlüssel prüfen' })).toBeNull();
  });

  it('"Aktualisieren" in the toolbar: busy while it runs ("Gleiche ab…" for screen readers), none offline', async () => {
    let done;
    const onRefresh = vi.fn(() => new Promise((resolve) => { done = resolve; }));
    const { rerender } = inRouter(<AnimeView {...base} list={[entry()]} canEdit={false} sources={null} onRefresh={onRefresh} />);
    const button = screen.getByRole('button', { name: 'Aktualisieren' });
    expect(button.className.split(' ')).toEqual(expect.arrayContaining(['hit-44', 'shrink-0']));
    fireEvent.click(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('anime-refresh-status').textContent).toBe('Gleiche ab…');
    expect(screen.getByTestId('anime-refresh-status').getAttribute('aria-live')).toBe('polite');
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await act(async () => { done(); });
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(screen.getByTestId('anime-refresh-status').textContent).toBe('');
    rerender(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit user={{ id: 1, role: 'visitor', offline: true }} sources={null} onRefresh={onRefresh} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Aktualisieren' })).toBeNull();
  });

  it('the last Crunchyroll run with its device, for editors only', () => {
    const now = Date.now();
    const watch = { auto_add: true, last_at: now - 5 * 60000, last_platform: 'ios', last_applied: 1, last_added: 0 };
    const { rerender } = inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={null} watchLast={watch} />);
    expect(screen.getByTestId('watch-last').textContent).toMatch(/^ Crunchyroll-Verlauf zuletzt übernommen vor 5 Min.* \(iPhone\/iPad\)$/);
    rerender(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit={false} sources={null} watchLast={watch} /></MemoryRouter>);
    expect(screen.queryByTestId('watch-last')).toBeNull();
    rerender(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit sources={null} watchLast={{ ...watch, last_at: null }} /></MemoryRouter>);
    expect(screen.queryByTestId('watch-last')).toBeNull();
    expect(['macos', 'windows', 'linux', 'ios', 'android', null, 'beos'].map((p) => watchLastText({ last_at: now - 3 * 3600000, last_platform: p }, now)))
      .toEqual([
        'Crunchyroll-Verlauf zuletzt übernommen vor 3 Std. (Mac)', 'Crunchyroll-Verlauf zuletzt übernommen vor 3 Std. (Windows)',
        'Crunchyroll-Verlauf zuletzt übernommen vor 3 Std. (Linux)', 'Crunchyroll-Verlauf zuletzt übernommen vor 3 Std. (iPhone/iPad)',
        'Crunchyroll-Verlauf zuletzt übernommen vor 3 Std. (Android)', 'Crunchyroll-Verlauf zuletzt übernommen vor 3 Std.',
        'Crunchyroll-Verlauf zuletzt übernommen vor 3 Std.'
      ]);
    expect(watchLastText(null)).toBeNull();
  });

  it('source hints: paused source, own key, refused key, slow pool once per session', () => {
    const onOpenAccount = vi.fn();
    const sources = {
      anilist: { enabled: true, circuit: 'closed', paused_until: null, key_disabled: true },
      mal: { enabled: true, circuit: 'open', paused_until: null },
      credential: { anilist: 'shared' },
      slow_recently: true
    };
    const { unmount } = inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={sources} onOpenAccount={onOpenAccount} />);
    expect(screen.getByText('MyAnimeList gerade nicht erreichbar, nur AniList')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Schlüssel prüfen' }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Suche ist gerade langsam/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'einrichten' }));
    expect(onOpenAccount).toHaveBeenCalledTimes(2);
    unmount();
    inRouter(<AnimeView {...base} list={[entry()]} canEdit sources={{ ...sources, anilist: { enabled: true }, credential: { anilist: 'own' } }} onOpenAccount={onOpenAccount} />);
    expect(screen.getByText('Suche läuft über deinen AniList-Zugang')).toBeTruthy();
    expect(screen.queryByText(/Suche ist gerade langsam/)).toBeNull();
  });
});

describe('useAnimeList', () => {
  it('+1 shows at once and goes back when the server refuses', async () => {
    const list = [entry()];
    let refuse = false;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (url === '/api/anime') return fakeResponse(200, list);
      if (url === '/api/anime/1/progress') {
        if (refuse) return fakeResponse(403, { error: 'Nur Lesezugriff' });
        return fakeResponse(200, { status: 'Schaue', episodes_watched: JSON.parse(init.body).episodes_watched, score: null, notes: null });
      }
      return fakeResponse(404, {});
    }));
    const user = { id: 1, username: 'admin', role: 'admin' };
    const { result } = renderHook(() => useAnimeList({ user }));
    await act(() => result.current.fetchAnime());
    expect(result.current.list[0].my_progress.episodes_watched).toBe(7);
    await act(() => result.current.updateProgress(1, { episodes_watched: 8 }));
    expect(result.current.list[0].my_progress.episodes_watched).toBe(8);
    expect(readAnimeCache(1).list[0].my_progress.episodes_watched).toBe(8);
    refuse = true;
    let pending;
    act(() => { pending = result.current.updateProgress(1, { episodes_watched: 9 }); });
    expect(result.current.list[0].my_progress.episodes_watched).toBe(9);
    await act(() => pending);
    expect(result.current.list[0].my_progress.episodes_watched).toBe(8);
  });

  it('"Gesehen" on a running show refused by the server (STILL_AIRING) goes back and shows the server\'s text', async () => {
    const text = 'Läuft noch – „Gesehen“ geht erst nach der letzten Folge; nimm „Schaue“';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/anime') return fakeResponse(200, [entry({ episodes: null, status: 'RELEASING' })]);
      if (url === '/api/anime/1/progress') return fakeResponse(400, { error: text, code: 'STILL_AIRING' });
      return fakeResponse(404, {});
    }));
    const shown = [];
    const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push([e.toast.kind, e.toast.message]); });
    try {
      const { result } = renderHook(() => useAnimeList({ user: { id: 1, username: 'admin', role: 'admin' } }));
      await act(() => result.current.fetchAnime());
      let saved;
      await act(async () => { saved = await result.current.updateProgress(1, { status: 'Gesehen' }); });
      expect(saved).toBeNull();
      expect(result.current.list[0].my_progress.status).toBe('Schaue');
      expect(shown).toEqual([['error', text]]);
    } finally {
      stop();
    }
  });

  it('a shared episode shows at once, keeps the link for "Weiter" and goes back when the server refuses', async () => {
    const list = [entry({ watch: { next_url: null, series_url: null, search_url: 'https://www.crunchyroll.com/search?q=Frieren' } })];
    let refuse = false;
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (url === '/api/anime') return fakeResponse(200, list);
      if (url === '/api/anime/1/watched') {
        calls.push(JSON.parse(init.body));
        if (refuse) return fakeResponse(403, { error: 'Nur Lesezugriff' });
        return fakeResponse(200, { anime_id: 1, progress: { status: 'Schaue', episodes_watched: 9, resume_url: 'https://www.crunchyroll.com/watch/A1B2C3D4', resume_episode: 9 } });
      }
      if (url === '/api/anime/1') return fakeResponse(200, { ...list[0], watch: { ...list[0].watch, next_url: 'https://www.crunchyroll.com/watch/A1B2C3D4' } });
      return fakeResponse(404, {});
    }));
    const user = { id: 1, username: 'admin', role: 'admin' };
    const { result } = renderHook(() => useAnimeList({ user }));
    await act(() => result.current.fetchAnime());
    let saved;
    await act(async () => { saved = await result.current.markWatched(1, { episode: 9, url: 'https://www.crunchyroll.com/watch/A1B2C3D4' }); });
    expect(saved.progress).toMatchObject({ episodes_watched: 9, resume_episode: 9 });
    expect(calls[0]).toEqual({ episode: 9, url: 'https://www.crunchyroll.com/watch/A1B2C3D4' });
    expect(readAnimeCache(1).list[0].my_progress.resume_url).toBe('https://www.crunchyroll.com/watch/A1B2C3D4');
    // the server computes the "Weiter" target: it is read again after the write
    await waitFor(() => expect(result.current.list[0].watch.next_url).toBe('https://www.crunchyroll.com/watch/A1B2C3D4'));
    refuse = true;
    let pending;
    act(() => { pending = result.current.markWatched(1, { episode: 11 }); });
    expect(result.current.list[0].my_progress.episodes_watched).toBe(11);
    await act(() => pending);
    expect(result.current.list[0].my_progress.episodes_watched).toBe(9);
  });

  it('the AniList list sync runs on the tab at most every 15 minutes, reloads the list when it changed it, never for visitors', async () => {
    sessionStorage.clear();
    const calls = [];
    let run = { ran: true, pulled: 1, pushed: 0, not_in_list: 0, changed: true, last_synced_at: Date.now(), last_error: null };
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}${init.body ? ` ${init.body}` : ''}`);
      if (url === '/api/anime') return fakeResponse(200, [entry()]);
      if (url === '/api/anime/sync/run') return fakeResponse(200, { anilist: run });
      return fakeResponse(404, {});
    }));
    const { result } = renderHook(() => useAnimeList({ user: { id: 1, username: 'anna', role: 'editor' } }));
    await act(() => result.current.syncList());
    expect(calls).toEqual(['POST /api/anime/sync/run {"auto":true}', 'GET /api/anime']);
    expect(result.current.listSync).toMatchObject({ ran: true, changed: true });
    await act(() => result.current.syncList());
    expect(calls).toHaveLength(2);

    run = { ...run, changed: false, last_error: 'AniList lehnt den Token ab' };
    await act(async () => { window.dispatchEvent(new CustomEvent(ANIME_SYNC_EVENT, { detail: run })); });
    expect(result.current.listSync.last_error).toBe('AniList lehnt den Token ab');
    // the account dialog switched the sync off: the tab forgets the old error
    await act(async () => { window.dispatchEvent(new CustomEvent(ANIME_SYNC_EVENT, { detail: { ran: false, changed: false, enabled: false, last_synced_at: null, last_error: null } })); });
    expect(result.current.listSync).toBeNull();

    const visitor = renderHook(() => useAnimeList({ user: { id: 2, username: 'v', role: 'visitor' } }));
    await act(() => visitor.result.current.syncList({ force: true }));
    expect(calls).toHaveLength(2);
  });

  it('"Aktualisieren" outside the apps: the AniList sync (forced) and the list for editors, one toast; visitors only reload', async () => {
    const calls = [];
    const watch = { auto_add: true, last_at: 1_700_000_000_000, last_platform: 'android', last_applied: 3, last_added: 0 };
    let pulled = 2;
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}${init.body ? ` ${init.body}` : ''}`);
      if (url === '/api/anime') return fakeResponse(200, [entry()]);
      if (url === '/api/anime/sync/run') return fakeResponse(200, { anilist: { ran: pulled >= 0, pulled: Math.max(pulled, 0), changed: pulled > 0 }, watch });
      return fakeResponse(404, {});
    }));
    const shown = [];
    const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push([e.toast.kind, e.toast.message]); });
    try {
      const { result } = renderHook(() => useAnimeList({ user: { id: 1, username: 'anna', role: 'editor' } }));
      await act(() => result.current.refreshList());
      expect(calls).toEqual(['POST /api/anime/sync/run {}', 'GET /api/anime']);
      expect(shown).toEqual([['success', '2 Serien aktualisiert']]);
      expect(result.current.watchLast).toEqual(watch);
      expect(readAnimeCache(1).watch).toEqual(watch);
      pulled = 0;
      await act(() => result.current.refreshList());
      expect(shown.at(-1)).toEqual(['info', 'Nichts Neues']);
      // a watch-sync event without a summary (undo, match dialog) keeps the last one
      await act(async () => { window.dispatchEvent(new CustomEvent(WATCH_SYNC_EVENT, { detail: { service: 'crunchyroll', applied: 1, added: 0, changed: true, watch: null } })); });
      expect(result.current.watchLast).toEqual(watch);

      calls.length = 0;
      shown.length = 0;
      const visitor = renderHook(() => useAnimeList({ user: { id: 2, username: 'v', role: 'visitor' } }));
      await act(() => visitor.result.current.refreshList());
      expect(calls).toEqual(['GET /api/anime']);
      expect(shown).toEqual([]);
    } finally {
      stop();
    }
  });

  it('"Aktualisieren" that cannot reach the server or load the list says so, never "Nichts Neues"', async () => {
    writeAnimeCache([entry()], 1);
    let answer = () => { throw new TypeError('Failed to fetch'); };
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => answer(url, init)));
    const shown = [];
    const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push([e.toast.kind, e.toast.message]); });
    try {
      const { result } = renderHook(() => useAnimeList({ user: { id: 1, username: 'anna', role: 'editor' } }));
      await act(() => result.current.refreshList());
      expect(shown).toEqual([['error', 'Netzwerkfehler – Server nicht erreichbar.']]);
      expect(result.current.fromCache).toBe(true);
      expect(result.current.error).toBe('Netzwerkfehler – Server nicht erreichbar.');

      answer = (url) => (url === '/api/anime' ? fakeResponse(200, [entry()]) : fakeResponse(500, { error: 'Interner Fehler beim Abgleich' }));
      await act(() => result.current.refreshList());
      expect(shown.at(-1)).toEqual(['error', 'Interner Fehler beim Abgleich']);
      expect(result.current.error).toBeNull();

      answer = (url) => (url === '/api/anime' ? fakeResponse(503, { error: 'Wartung' }) : fakeResponse(200, { anilist: { ran: true, pulled: 0, changed: false } }));
      await act(() => result.current.refreshList());
      expect(shown.at(-1)).toEqual(['error', 'Aktualisierung fehlgeschlagen']);
      expect(result.current.error).toBe('Wartung');
      expect(shown.filter(([, message]) => message === 'Nichts Neues')).toEqual([]);
    } finally {
      stop();
    }
  });

  it('a stored watch summary comes back with the cached list of the same user', () => {
    const watch = { auto_add: false, last_at: 1_700_000_000_000, last_platform: null, last_applied: 0, last_added: 0 };
    writeAnimeCache([entry()], 1, undefined, { watch });
    const { result } = renderHook(() => useAnimeList({ user: { id: 1, role: 'editor' } }));
    expect(result.current.watchLast).toEqual(watch);
    const other = renderHook(() => useAnimeList({ user: { id: 2, role: 'editor' } }));
    expect(other.result.current.watchLast).toBeNull();
  });

  it('"Von meiner Liste entfernen" asks the server to remember the decline; the share undo never does', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url === '/api/anime') return fakeResponse(200, [entry(), entry({ id: 2 })]);
      if (/\/progress/.test(url)) return fakeResponse(200, { success: true });
      return fakeResponse(404, {});
    }));
    const { result } = renderHook(() => useAnimeList({ user: { id: 1, username: 'anna', role: 'editor' } }));
    await act(() => result.current.fetchAnime());
    await act(() => result.current.removeFromMyList(1, { decline: true }));
    await act(() => result.current.undoWatched(2, null));
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual(['DELETE /api/anime/1/progress?decline=1', 'DELETE /api/anime/2/progress']);
  });

  it('offline: the stored list, no request', async () => {
    writeAnimeCache([entry({ title: 'Gespeichert' })], 1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAnimeList({ user: { id: 1, role: 'visitor', offline: true } }));
    await act(() => result.current.fetchAnime());
    expect(result.current.list[0].title).toBe('Gespeichert');
    expect(result.current.fromCache).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tab and statistics', () => {
  it('the fourth tab "Anime" with its count', () => {
    const onSelectView = vi.fn();
    render(<MainViewSwitcher activeMainView="anime" onSelectView={onSelectView} mangaCount={4} animeCount={3} shoppingData={null} radarData={null} />);
    const tab = document.getElementById('btn-nav-anime');
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(tab.textContent).toMatch(/Anime\s*3/);
    fireEvent.click(document.getElementById('btn-nav-radar'));
    expect(onSelectView).toHaveBeenCalledWith('radar');
  });

  it('the anime card of the statistics shows counts and watch time; the status tiles are labelled as my list', () => {
    render(<AnimeStatsCard anime={{ total: 4, watching: 1, completed: 2, planned: 3, per_user: [{ user_id: 1, username: 'kim', episodes_watched: 30, watch_minutes: 720 }] }} />);
    const mine = screen.getByRole('group', { name: 'Meine Liste' });
    const tile = (root, label) => within(root).getByText(label).nextElementSibling.textContent;
    expect([tile(mine, 'Schauen'), tile(mine, 'Gesehen'), tile(mine, 'Geplant')]).toEqual(['1', '2', '3']);
    expect(within(mine).queryByText('Einträge')).toBeNull();
    expect(tile(document.getElementById('stats-anime'), 'Einträge')).toBe('4');
    expect(screen.getByText('kim')).toBeTruthy();
    expect(screen.getByText(/30 Folgen · 12 Std\./)).toBeTruthy();
    expect(watchTime(3000)).toBe('2 Tage 2 Std.');
    const { container } = render(<AnimeStatsCard anime={{ total: 0 }} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('AnimeDetailModal', () => {
  const open = (anime) => render(
    <MemoryRouter>
      <AnimeDetailModal isOpen animeId={anime.id} fallback={anime} onClose={vi.fn()} canEdit={false}
        fetchDetail={vi.fn(async () => anime)} updateProgress={vi.fn()} removeFromMyList={vi.fn()} update={vi.fn()}
        refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} />
    </MemoryRouter>
  );

  it('has no "Nächste Folge" row without airing data, and shows it (with the estimate) when there is one', async () => {
    const { unmount } = open(entry({ manual: true, next_airing: null }));
    await act(async () => {});
    expect(screen.getByText('Folgen')).toBeTruthy();
    expect(screen.queryByText('Nächste Folge')).toBeNull();
    unmount();

    const at = Math.floor((Date.now() + 3 * 86400000) / 1000);
    open(entry({ next_airing: { episode: 8, at, estimated: true } }));
    await act(async () => {});
    expect(screen.getByText('Nächste Folge').nextElementSibling.textContent).toMatch(/^Folge 8 · in 3 Tagen \(geschätzt\)$/);
  });

  it('offers "Weiter auf Crunchyroll", or at least the search; nothing once the series is watched', async () => {
    const opener = vi.fn();
    setOpenExternal(opener);
    try {
      const { unmount } = open(entry({ watch: { next_url: null, series_url: 'https://www.crunchyroll.com/series/SER12345', search_url: 'https://www.crunchyroll.com/search?q=Frieren' } }));
      const link = await screen.findByRole('link', { name: 'Weiter auf Crunchyroll: Frieren' });
      expect(link.getAttribute('href')).toBe('https://www.crunchyroll.com/series/SER12345');
      fireEvent.click(link);
      expect(opener).toHaveBeenCalledWith('https://www.crunchyroll.com/series/SER12345', { preferApp: true });
      unmount();
      const second = open(entry({ manual: true, watch: { next_url: null, series_url: null, search_url: 'https://www.crunchyroll.com/search?q=Frieren' } }));
      expect((await screen.findByRole('link', { name: 'Auf Crunchyroll suchen: Frieren' })).getAttribute('href')).toBe('https://www.crunchyroll.com/search?q=Frieren');
      second.unmount();
      open(entry({ my_progress: { status: 'Gesehen', episodes_watched: 12 } }));
      await act(async () => {});
      expect(screen.queryByRole('link', { name: /Crunchyroll/ })).toBeNull();
    } finally {
      setOpenExternal((url) => window.open(url, '_blank', 'noopener,noreferrer'));
    }
  });

  describe('own progress', () => {
    const onePiece = () => entry({ title: 'ONE PIECE', episodes: null, status: 'RELEASING', next_airing: { episode: 1181, at: 1798985760, estimated: false },
      my_progress: { status: 'Schaue', episodes_watched: 12, score: 9, notes: 'Arc 3' }, progress: [{ user_id: 1, username: 'admin', status: 'Schaue', episodes_watched: 12, score: 9 }] });
    const openEditable = (anime, props = {}) => render(
      <MemoryRouter>
        <AnimeDetailModal isOpen animeId={anime.id} fallback={anime} onClose={vi.fn()} canEdit
          fetchDetail={vi.fn(async () => anime)} updateProgress={vi.fn(async () => ({}))} removeFromMyList={vi.fn(async () => true)} update={vi.fn()}
          refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} {...props} />
      </MemoryRouter>
    );

    it('a running show: "Gesehen" is locked, the aired episodes show without capping the counter', async () => {
      openEditable(onePiece());
      await act(async () => {});
      const select = screen.getByLabelText('Status');
      const option = within(select).getByRole('option', { name: 'Gesehen' });
      expect(option.disabled).toBe(true);
      expect(option.getAttribute('title')).toBe('Läuft noch');
      expect(screen.getByLabelText('Gesehene Folgen (bisher 1180 ausgestrahlt)').getAttribute('max')).toBeNull();
      expect(screen.getByText('12 / 1180+')).toBeTruthy();
    });

    it('a fresh counter is sent without a status, so the server makes it "Schaue"', async () => {
      const updateProgress = vi.fn(async () => ({}));
      openEditable(entry({ my_progress: null, progress: [] }), { updateProgress });
      await act(async () => {});
      expect(within(screen.getByLabelText('Status')).getByRole('option', { name: 'Gesehen' }).disabled).toBe(false);
      for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Eine Folge mehr' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' })); });
      expect(updateProgress).toHaveBeenCalledWith(1, { episodes_watched: 3 });
    });

    it('"Von meiner Liste entfernen" offers to undo with the removed progress', async () => {
      const shown = [];
      const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push(e.toast); });
      const updateProgress = vi.fn(async () => ({ status: 'Schaue' }));
      const removeFromMyList = vi.fn(async () => true);
      const fetchDetail = vi.fn(async () => onePiece());
      try {
        openEditable(onePiece(), { updateProgress, removeFromMyList, fetchDetail });
        await act(async () => {});
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Von meiner Liste entfernen' })); });
        expect(removeFromMyList).toHaveBeenCalledWith(1, { decline: true });
        expect(shown.map((toast) => [toast.kind, toast.message, toast.action?.label])).toEqual([['success', 'Von deiner Liste entfernt', 'Rückgängig']]);
        const loads = fetchDetail.mock.calls.length;
        await act(async () => { await shown[0].action.onClick(); });
        expect(updateProgress).toHaveBeenCalledWith(1, { status: 'Schaue', episodes_watched: 12, score: 9, notes: 'Arc 3', restore: true });
        expect(fetchDetail.mock.calls.length).toBe(loads + 1);
      } finally {
        stop();
      }
    });

    it('the undo puts back a "Gesehen" of a running show as it was (restore, no STILL_AIRING)', async () => {
      const shown = [];
      const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push(e.toast); });
      const updateProgress = vi.fn(async () => ({ status: 'Gesehen' }));
      const seen = () => ({ ...onePiece(), my_progress: { status: 'Gesehen', episodes_watched: 12, score: 9, notes: 'Arc 3' } });
      try {
        openEditable(seen(), { updateProgress, fetchDetail: vi.fn(async () => seen()) });
        await act(async () => {});
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Von meiner Liste entfernen' })); });
        await act(async () => { await shown[0].action.onClick(); });
        expect(updateProgress).toHaveBeenCalledWith(1, { status: 'Gesehen', episodes_watched: 12, score: 9, notes: 'Arc 3', restore: true });
      } finally {
        stop();
      }
    });

    it('no undo when the removal failed', async () => {
      const shown = [];
      const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push(e.toast); });
      try {
        openEditable(onePiece(), { removeFromMyList: vi.fn(async () => false) });
        await act(async () => {});
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Von meiner Liste entfernen' })); });
        expect(shown).toEqual([]);
      } finally {
        stop();
      }
    });
  });

  it('the title wraps with hyphens in its language; the close button has a 44 px hit area', async () => {
    open(entry({ title: 'Donaudampfschifffahrtskapitänsabenteuer' }));
    const heading = await screen.findByRole('heading', { name: 'Donaudampfschifffahrtskapitänsabenteuer' });
    expect(heading.getAttribute('lang')).toBe('de');
    expect(heading.className.split(' ')).toEqual(expect.arrayContaining(['break-words', 'hyphens-auto', '[overflow-wrap:anywhere]']));
    expect(screen.getByRole('button', { name: 'Schließen' }).className.split(' ')).toContain('hit-44');
  });
});

