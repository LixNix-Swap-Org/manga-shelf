// Covers the anime tab: card, view, detail modal and add modal.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen, fireEvent, waitFor, act, renderHook, within } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, useLocation } from 'react-router-dom';
import { HISTORY_STATE_KEY } from '../hooks/useDialogA11y';
import { fakeResponse } from './fakeResponse';
import { clearDataCache } from '../utils/dataCache';
import AnimeCard from '../components/dashboard/AnimeCard';
import AnimeView, { watchLastText } from '../components/dashboard/AnimeView';
import AnimeDetailModal from '../components/modals/AnimeDetailModal';
import AddAnimeModal, { sourcesNote, sourceChipState, hitKey, SOURCES_KEY, SEARCH_KIND_KEY } from '../components/modals/AddAnimeModal';
import MainViewSwitcher from '../components/dashboard/MainViewSwitcher';
import AnimeStatsCard, { watchTime } from '../components/modals/stats/AnimeStatsCard';
import useAnimeList from '../hooks/useAnimeList';
import { mainViewOf, searchForView } from '../Dashboard';
import {
  countdownText, progressText, plusOneDisabled, filterAnime, filterCounts, predictProgress, readAnimeCache, writeAnimeCache, clearAnimeCache,
  ANIME_CACHE_KEY, ANIME_META_KEY, staleText, continueTarget, predictWatched, listSyncDue, markListSync, LIST_SYNC_INTERVAL_MS,
  shortDescription, progressPercent, airedEpisodes, stillAiring, seasonEpisodeText, sourceBadges, kindOf, KIND_FILTER_KEY, LANGUAGE_FILTER_KEY,
  episodeSections, episodeGridCount, watchedEpisodesOf, episodeScoresOf
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

  it('single episodes: predicted like the server, sections per season or per 100, grid size without a total', () => {
    const base = { status: 'Schaue', episodes_watched: 3, watched_episodes: [1, 2, 5] };
    expect(watchedEpisodesOf(base)).toEqual([1, 2, 5]);
    expect(watchedEpisodesOf({ episodes_watched: 2 })).toEqual([1, 2]);
    let next = predictProgress(base, { watched_episodes: [1, 2, 5, 6] }, 12);
    expect([next.episodes_watched, next.watched_episodes, next.status]).toEqual([4, [1, 2, 5, 6], 'Schaue']);
    next = predictProgress(base, { episodes_watched: 4 }, 12);
    expect([next.episodes_watched, next.watched_episodes]).toEqual([4, [1, 2, 3, 5]]);
    next = predictProgress(base, { watched_episodes: [1, 2, 3] }, 12);
    expect(next.watched_episodes).toBeNull();
    next = predictProgress(base, { status: 'Gesehen' }, 12);
    expect([next.episodes_watched, next.watched_episodes]).toEqual([12, null]);
    expect(episodeSections({ kind: 'anime' }, 250).map((s) => [s.from, s.to])).toEqual([[1, 100], [101, 200], [201, 250]]);
    expect(episodeSections({ kind: 'tv', seasons: [{ season_number: 1, episode_count: 8 }, { season_number: 2, episode_count: 10 }] }, 18))
      .toEqual([{ from: 1, to: 8, season: 1, name: null, relative: true, start: 1 }, { from: 9, to: 18, season: 2, name: null, relative: true, start: 9 }]);
    const onePiece = { kind: 'anime', custom_seasons: [{ start: 1, name: 'East Blue' }, { start: 62, name: null }, { start: 1200, name: 'Zu spät' }] };
    expect(episodeSections(onePiece, 135)).toEqual([
      { from: 1, to: 61, season: 1, name: 'East Blue', relative: false, start: 1 },
      { from: 62, to: 135, season: 2, name: null, relative: false, start: 62 }
    ]);
    expect(episodeSections({ kind: 'tv', seasons: [{ season_number: 1, episode_count: 8 }], custom_seasons: [{ start: 1, name: 'A' }] }, 8))
      .toEqual([{ from: 1, to: 8, season: 1, name: 'A', relative: true, start: 1 }], 'seasons set by hand win over TMDb');
    // a TV show numbers the cells of its seasons by hand within the season, like the S×E badge of the card
    const show = { kind: 'tv', seasons: [{ season_number: 1, episode_count: 20 }], custom_seasons: [{ start: 1, name: 'Pilot' }, { start: 6, name: null }] };
    expect(episodeSections(show, 20)).toEqual([
      { from: 1, to: 5, season: 1, name: 'Pilot', relative: true, start: 1 },
      { from: 6, to: 20, season: 2, name: null, relative: true, start: 6 }
    ]);
    expect(seasonEpisodeText(show, 8)).toBe('S2E3');
    // a season longer than 100 episodes comes in blocks that keep its name or number and count within the season
    expect(episodeSections({ kind: 'anime', custom_seasons: [{ start: 1, name: 'East Blue' }, { start: 62, name: 'Alabasta' }] }, 300)
      .map((s) => [s.name, s.from, s.to, s.start])).toEqual([['East Blue', 1, 61, 1], ['Alabasta', 62, 161, 62], ['Alabasta', 162, 261, 62], ['Alabasta', 262, 300, 62]]);
    expect(episodeSections({ kind: 'tv', seasons: [{ season_number: 1, episode_count: 5 }, { season_number: 2, episode_count: 150 }] }, 155)
      .map((s) => [s.season, s.from, s.to, s.start, s.relative])).toEqual([[1, 1, 5, 1, true], [2, 6, 105, 6, true], [2, 106, 155, 6, true]]);
    expect(episodeGridCount({ episodes: 12 }, [])).toBe(12);
    expect(episodeGridCount({ episodes: null }, [1, 4])).toBe(5);
    expect(episodeGridCount({ episodes: null, next_airing: { episode: 30, estimated: false } }, [1])).toBe(29);
  });

  it('a rated episode is a watched one: ratings mark their episodes, an episode that stops being watched loses its rating', () => {
    let next = predictProgress(null, { episode_scores: { 3: 8, 1: 10 } }, 12);
    expect([next.episodes_watched, next.watched_episodes, next.status, next.episode_scores]).toEqual([2, [1, 3], 'Schaue', { 1: 10, 3: 8 }]);
    const rated = { status: 'Schaue', episodes_watched: 5, score: null, notes: null, watched_episodes: null, episode_scores: { 2: 7, 5: 9 } };
    next = predictProgress(rated, { episodes_watched: 3 }, 12);
    expect([next.episodes_watched, next.watched_episodes, next.episode_scores]).toEqual([3, null, { 2: 7 }]);
    expect(predictProgress(rated, { status: 'Geplant' }, 12)).toMatchObject({ episodes_watched: 0, episode_scores: {} });
    expect(predictProgress(rated, { notes: 'gut' }, 12).episode_scores).toEqual({ 2: 7, 5: 9 });
    next = predictProgress(rated, { watched_episodes: [1, 2, 3], episode_scores: { 2: 7, 5: 9 } }, 12);
    expect([next.episodes_watched, next.watched_episodes, next.episode_scores]).toEqual([4, [1, 2, 3, 5], { 2: 7, 5: 9 }]);
    next = predictProgress(rated, { watched_episodes: [1, 2, 3] }, 12);
    expect([next.episodes_watched, next.watched_episodes, next.episode_scores]).toEqual([3, null, { 2: 7 }]);
  });

  it('added episodes join the watched ones without filling the gaps; past MAX_MARKS the row keeps a plain counter', () => {
    const gaps = { status: 'Pausiert', episodes_watched: 3, score: null, notes: null, watched_episodes: [1, 2, 10] };
    let next = predictProgress(gaps, { add_episodes: [3, 10] }, 12);
    expect([next.episodes_watched, next.watched_episodes, next.status]).toEqual([4, [1, 2, 3, 10], 'Schaue']);
    next = predictProgress({ status: 'Schaue', episodes_watched: 5 }, { add_episodes: [8] }, 12);
    expect([next.episodes_watched, next.watched_episodes]).toEqual([6, [1, 2, 3, 4, 5, 8]]);
    expect(predictProgress(gaps, { add_episodes: [2] }, 12)).toMatchObject({ episodes_watched: 3, watched_episodes: [1, 2, 10], status: 'Pausiert' });
    next = predictProgress({ status: 'Schaue', episodes_watched: 5000 }, { add_episodes: [5003] }, null);
    expect([next.episodes_watched, next.watched_episodes]).toEqual([5003, null]);
    // like withEpisodes on the server: the plain counter runs to the highest episode of the union, existing marks included
    const even = { status: 'Schaue', episodes_watched: 5000, score: null, notes: null, watched_episodes: Array.from({ length: 5000 }, (_, i) => 2 * (i + 1)) };
    next = predictProgress(even, { add_episodes: [1] }, null);
    expect([next.episodes_watched, next.watched_episodes]).toEqual([10000, null]);
    expect(predictWatched(even, { episode: 1 }, null)).toMatchObject({ episodes_watched: 10000, watched_episodes: null });
  });

  it('marks and ratings above a known total stay out of the grid; only ratings of watched episodes count', () => {
    const stale = { status: 'Schaue', episodes_watched: 3, watched_episodes: [1, 2, 14], episode_scores: { 2: 6, 4: 9, 14: 8 } };
    expect(watchedEpisodesOf(stale, 12)).toEqual([1, 2]);
    expect(watchedEpisodesOf(stale, null)).toEqual([1, 2, 14]);
    expect(episodeScoresOf(stale, 12)).toEqual({ 2: 6 });
    expect(episodeScoresOf(stale)).toEqual({ 2: 6, 14: 8 });
    expect(episodeScoresOf({ episodes_watched: 4, episode_scores: { 4: 9, 5: 3 } }, 12)).toEqual({ 4: 9 });
    expect(episodeScoresOf(null)).toEqual({});
  });

  it('a shared episode on a row with single marks adds that episode only; past the total it completes the entry', () => {
    const gaps = { status: 'Schaue', episodes_watched: 3, score: null, notes: null, watched_episodes: [1, 2, 10], episode_scores: { 10: 8 } };
    const url = 'https://www.crunchyroll.com/watch/E5F6G7H8';
    expect(predictWatched(gaps, { episode: 3, url }, 12))
      .toMatchObject({ status: 'Schaue', episodes_watched: 4, watched_episodes: [1, 2, 3, 10], resume_url: url, resume_episode: 3, episode_scores: { 10: 8 } });
    expect(predictWatched(gaps, { episode: 2 }, 12)).toMatchObject({ episodes_watched: 3, watched_episodes: [1, 2, 10] });
    expect(predictWatched({ ...gaps, watched_episodes: [1, 2, 4] }, { episode: 3 }, 12)).toMatchObject({ episodes_watched: 4, watched_episodes: null });
    expect(predictWatched(gaps, { episode: 29 }, 12)).toMatchObject({ status: 'Gesehen', episodes_watched: 12, watched_episodes: null });
    expect(predictWatched({ status: 'Schaue', episodes_watched: 3 }, { episode: 6 }, 12)).toMatchObject({ episodes_watched: 6 });
    expect(predictWatched({ status: 'Schaue', episodes_watched: 3 }, { episode: 6 }, 12).watched_episodes).toBeUndefined();
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
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ title: 'Heimvideo', episodes: 3, kind: 'anime', manga_id: 4 }));
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
    expect(screen.getByText('Gerade ohne MyAnimeList')).toBeTruthy();
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

  it('the share undo sends the single marks and their ratings back, with the entry in the list and without it', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (url === '/api/anime') return fakeResponse(200, [entry()]);
      if (/\/progress$/.test(url) && init.method === 'PUT') {
        bodies.push([url, JSON.parse(init.body)]);
        return fakeResponse(200, { status: 'Schaue', episodes_watched: 3, score: null, notes: null, watched_episodes: [1, 2, 5], episode_scores: { 5: 9 } });
      }
      return fakeResponse(404, {});
    }));
    const { result } = renderHook(() => useAnimeList({ user: { id: 1, username: 'anna', role: 'editor' } }));
    await act(() => result.current.fetchAnime());
    const previous = { status: 'Schaue', episodes_watched: 3, watched_episodes: [1, 2, 5], episode_scores: { 5: 9 } };
    await act(() => result.current.undoWatched(1, previous));
    expect(result.current.list[0].my_progress).toMatchObject({ watched_episodes: [1, 2, 5], episode_scores: { 5: 9 } });
    await act(() => result.current.undoWatched(4, previous));
    const body = { status: 'Schaue', episodes_watched: 3, restore: true, watched_episodes: [1, 2, 5], episode_scores: { 5: 9 } };
    expect(bodies).toEqual([['/api/anime/1/progress', body], ['/api/anime/4/progress', body]]);
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
      my_progress: { status: 'Schaue', episodes_watched: 12, score: 9, notes: 'Arc 3', audio_language: 'ja', subtitle_language: 'de' }, progress: [{ user_id: 1, username: 'admin', status: 'Schaue', episodes_watched: 12, score: 9 }] });
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

    it('closing with unsaved notes asks in a dialog, keeps the dialog on cancel and closes on discard', async () => {
      const onClose = vi.fn();
      openEditable(onePiece(), { onClose });
      await act(async () => {});
      const notesInput = screen.getByLabelText('Meine Notiz');
      fireEvent.change(notesInput, { target: { value: 'Neue ungespeicherte Notiz' } });

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(await screen.findByText('Ungespeicherte Änderungen verwerfen?')).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
      expect(screen.queryByText('Ungespeicherte Änderungen verwerfen?')).toBeNull();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      fireEvent.click(await screen.findByRole('button', { name: 'Verwerfen' }));
      expect(onClose).toHaveBeenCalled();
    });

    it('"Von meiner Liste entfernen" offers to undo with the removed progress, single marks, ratings, visibility and comment included', async () => {
      const shown = [];
      const stop = subscribeToasts((e) => { if (e.type === 'show') shown.push(e.toast); });
      const updateProgress = vi.fn(async () => ({ status: 'Schaue' }));
      const removeFromMyList = vi.fn(async () => true);
      const marked = () => ({
        ...onePiece(),
        my_progress: {
          ...onePiece().my_progress, episodes_watched: 3, watched_episodes: [1, 2, 5], episode_scores: { 2: 7, 5: 9 },
          rating_visibility: 'anonymous', public_comment: 'Bester Arc'
        }
      });
      const fetchDetail = vi.fn(async () => marked());
      try {
        openEditable(marked(), { updateProgress, removeFromMyList, fetchDetail });
        await act(async () => {});
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Von meiner Liste entfernen' })); });
        expect(removeFromMyList).toHaveBeenCalledWith(1, { decline: true });
        expect(shown.map((toast) => [toast.kind, toast.message, toast.action?.label])).toEqual([['success', 'Von deiner Liste entfernt', 'Rückgängig']]);
        const loads = fetchDetail.mock.calls.length;
        await act(async () => { await shown[0].action.onClick(); });
        expect(updateProgress).toHaveBeenCalledWith(1, {
          status: 'Schaue', episodes_watched: 3, score: 9, notes: 'Arc 3', audio_language: 'ja', subtitle_language: 'de',
          watched_episodes: [1, 2, 5], episode_scores: { 2: 7, 5: 9 }, rating_visibility: 'anonymous', public_comment: 'Bester Arc', restore: true
        });
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
        expect(updateProgress).toHaveBeenCalledWith(1, { status: 'Gesehen', episodes_watched: 12, score: 9, notes: 'Arc 3', audio_language: null, subtitle_language: null, restore: true });
      } finally {
        stop();
      }
    });

    it('single episodes: the grid shows the watched ones and saves a tapped episode as the set of watched episodes', async () => {
      const updateProgress = vi.fn(async () => ({ status: 'Schaue', episodes_watched: 8 }));
      const fetchDetail = vi.fn(async () => entry());
      openEditable(entry(), { updateProgress, fetchDetail });
      await act(async () => {});
      const grid = screen.getByRole('list', { name: 'Folgen 1–12' });
      const cells = within(grid).getAllByRole('button');
      expect(cells.map((b) => b.getAttribute('aria-pressed'))).toEqual([...Array(7).fill('true'), ...Array(5).fill('false')]);
      fireEvent.click(within(grid).getByRole('button', { name: 'Folge 9' }));
      fireEvent.click(within(grid).getByRole('button', { name: 'Folge 2' }));
      expect(within(grid).getByRole('button', { name: 'Folge 9' }).getAttribute('aria-pressed')).toBe('true');
      await waitFor(() => expect(updateProgress).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(updateProgress).toHaveBeenCalledWith(1, { watched_episodes: [1, 3, 4, 5, 6, 7, 9], episode_scores: {} });
      await waitFor(() => expect(fetchDetail.mock.calls.length).toBeGreaterThan(1), { timeout: 3000 });
    });

    it('single episodes: "Alle im Abschnitt gesehen" marks the shown section; a film has no grid', async () => {
      const updateProgress = vi.fn(async () => ({}));
      const show = entry({ kind: 'tv', episodes: 20, seasons: [{ season_number: 1, episode_count: 10 }, { season_number: 2, episode_count: 10 }],
        my_progress: { status: 'Schaue', episodes_watched: 12, score: null, notes: null } });
      const { unmount } = openEditable(show, { updateProgress, fetchDetail: vi.fn(async () => show) });
      await act(async () => {});
      const grid = screen.getByRole('list', { name: 'Staffel 2 · Folgen 11–20' });
      expect(within(grid).getByRole('button', { name: 'Staffel 2, Folge 3' }).textContent).toBe('3');
      fireEvent.click(screen.getByRole('button', { name: 'Alle im Abschnitt gesehen' }));
      await waitFor(() => expect(updateProgress).toHaveBeenCalledWith(1, { watched_episodes: Array.from({ length: 20 }, (_, i) => i + 1), episode_scores: {} }), { timeout: 3000 });
      unmount();
      openEditable(entry({ kind: 'movie', episodes: 1 }));
      await act(async () => {});
      expect(screen.queryByRole('heading', { name: 'Einzelne Folgen' })).toBeNull();
    });

    it('episode ratings: "Folgen bewerten" rates a tapped episode, marks it watched and shows the average; unmarking drops the rating', async () => {
      let rated = entry({ my_progress: { status: 'Schaue', episodes_watched: 3, score: null, notes: null, episode_scores: { 2: 7 } } });
      const updateProgress = vi.fn(async (id, change) => {
        rated = { ...rated, my_progress: { ...rated.my_progress, episodes_watched: change.watched_episodes.length, ...change } };
        return rated.my_progress;
      });
      openEditable(rated, { updateProgress, fetchDetail: vi.fn(async () => rated) });
      await act(async () => {});
      const grid = screen.getByRole('list', { name: 'Folgen 1–12' });
      expect(within(grid).getByRole('button', { name: 'Folge 2, Bewertung 7 von 10' })).toBeTruthy();
      expect(screen.getByText('Ø 7 aus 1 bewerteten Folge')).toBeTruthy();
      const mode = screen.getByRole('button', { name: 'Folgen bewerten' });
      fireEvent.click(mode);
      expect(mode.getAttribute('aria-pressed')).toBe('true');
      // the watched state stays on the cells in rating mode
      expect(within(grid).getByRole('button', { name: 'Folge 1' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(within(grid).getByRole('button', { name: 'Folge 6' }));
      const panel = screen.getByRole('group', { name: 'Folge 6 bewerten' });
      const six = within(grid).getByRole('button', { name: 'Folge 6' });
      expect([six.getAttribute('aria-pressed'), six.getAttribute('aria-expanded'), six.getAttribute('aria-controls')]).toEqual(['false', 'true', panel.id]);
      expect(within(grid).getByRole('button', { name: 'Folge 1' }).getAttribute('aria-expanded')).toBe('false');
      // the picker sits above the cells and takes the focus; a score gives it back to the episode
      expect(panel.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.activeElement).toBe(within(panel).getByRole('button', { name: '1' }));
      fireEvent.click(within(panel).getByRole('button', { name: '9' }));
      expect(screen.queryByRole('group', { name: 'Folge 6 bewerten' })).toBeNull();
      expect(document.activeElement).toBe(within(grid).getByRole('button', { name: 'Folge 6, Bewertung 9 von 10' }));
      expect(screen.getByText('Ø 8 aus 2 bewerteten Folgen')).toBeTruthy();
      await waitFor(() => expect(updateProgress).toHaveBeenCalledWith(1, { watched_episodes: [1, 2, 3, 6], episode_scores: { 2: 7, 6: 9 } }), { timeout: 3000 });
      fireEvent.click(within(grid).getByRole('button', { name: 'Folge 2, Bewertung 7 von 10' }));
      const again = screen.getByRole('group', { name: 'Folge 2 bewerten' });
      expect(document.activeElement).toBe(within(again).getByRole('button', { name: '7' }));
      fireEvent.click(within(again).getByRole('button', { name: 'Fertig' }));
      expect(document.activeElement).toBe(within(grid).getByRole('button', { name: 'Folge 2, Bewertung 7 von 10' }));
      fireEvent.click(mode);
      fireEvent.click(within(grid).getByRole('button', { name: 'Folge 2, Bewertung 7 von 10' }));
      await waitFor(() => expect(updateProgress).toHaveBeenLastCalledWith(1, { watched_episodes: [1, 3, 6], episode_scores: { 6: 9 } }), { timeout: 3000 });
    });

    const deferredSaves = () => {
      const saves = [];
      const updateProgress = vi.fn((id, change) => new Promise((resolve) => { saves.push({ change, resolve }); }));
      return { saves, updateProgress };
    };
    const gridCell = (name, n) => within(screen.getByRole('list', { name })).getByRole('button', { name: `Folge ${n}` });

    it('single episodes: a tap while a save runs stays on screen and goes into the next save; the burst ends with one reload', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let stored = { status: 'Schaue', episodes_watched: 7, score: null, notes: null, watched_episodes: null, episode_scores: {} };
      const { saves, updateProgress } = deferredSaves();
      const answer = (i) => {
        const { change } = saves[i];
        stored = { ...stored, episodes_watched: change.watched_episodes.length, watched_episodes: change.watched_episodes, episode_scores: change.episode_scores };
        saves[i].resolve(stored);
      };
      const fetchDetail = vi.fn(async () => entry({ my_progress: stored }));
      openEditable(entry({ my_progress: stored }), { updateProgress, fetchDetail });
      await act(async () => {});
      const pressed = (n) => gridCell('Folgen 1–12', n).getAttribute('aria-pressed');
      fireEvent.click(gridCell('Folgen 1–12', 9));
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(updateProgress).toHaveBeenCalledTimes(1);
      fireEvent.click(gridCell('Folgen 1–12', 10));
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(updateProgress).toHaveBeenCalledTimes(1);
      expect([pressed(9), pressed(10)]).toEqual(['true', 'true']);
      await act(async () => { answer(0); });
      await waitFor(() => expect(updateProgress).toHaveBeenCalledTimes(2));
      expect(updateProgress).toHaveBeenLastCalledWith(1, { watched_episodes: [1, 2, 3, 4, 5, 6, 7, 9, 10], episode_scores: {} });
      expect([pressed(9), pressed(10)]).toEqual(['true', 'true']);
      expect(fetchDetail).toHaveBeenCalledTimes(1);
      await act(async () => { answer(1); });
      await waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(2));
      expect([pressed(8), pressed(9), pressed(10)]).toEqual(['false', 'true', 'true']);
    });

    it('single episodes: a failed save drops the taps and reloads the detail', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const updateProgress = vi.fn(async () => null);
      const fetchDetail = vi.fn(async () => entry());
      openEditable(entry(), { updateProgress, fetchDetail });
      await act(async () => {});
      fireEvent.click(gridCell('Folgen 1–12', 9));
      expect(gridCell('Folgen 1–12', 9).getAttribute('aria-pressed')).toBe('true');
      await act(async () => { vi.advanceTimersByTime(600); });
      await waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(2));
      expect(gridCell('Folgen 1–12', 9).getAttribute('aria-pressed')).toBe('false');
    });

    it('a grid tap keeps an unsaved note and score; the counter and the status follow the grid', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let stored = { status: 'Geplant', episodes_watched: 0, score: null, notes: null };
      const updateProgress = vi.fn(async (id, change) => {
        stored = { ...stored, status: 'Schaue', episodes_watched: change.watched_episodes.length, watched_episodes: null, episode_scores: change.episode_scores };
        return stored;
      });
      const fetchDetail = vi.fn(async () => entry({ my_progress: stored }));
      openEditable(entry({ my_progress: stored }), { updateProgress, fetchDetail });
      await act(async () => {});
      fireEvent.change(screen.getByLabelText('Meine Notiz'), { target: { value: 'Spannend' } });
      fireEvent.change(screen.getByLabelText('Bewertung'), { target: { value: '8' } });
      fireEvent.click(gridCell('Folgen 1–12', 1));
      await act(async () => { vi.advanceTimersByTime(600); });
      await waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(2));
      expect(screen.getByLabelText('Meine Notiz').value).toBe('Spannend');
      expect(screen.getByLabelText('Bewertung').value).toBe('8');
      expect(screen.getByLabelText('Gesehene Folgen (von 12)').value).toBe('1');
      expect(screen.getByLabelText('Status').value).toBe('Schaue');
    });

    it('while a grid save waits or runs, "Von meiner Liste entfernen" and "Fortschritt speichern" wait too', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { saves, updateProgress } = deferredSaves();
      openEditable(entry(), { updateProgress, fetchDetail: vi.fn(async () => entry()) });
      await act(async () => {});
      const waiting = () => ['Von meiner Liste entfernen', 'Fortschritt speichern'].map((name) => screen.getByRole('button', { name }).disabled);
      expect(waiting()).toEqual([false, false]);
      fireEvent.click(gridCell('Folgen 1–12', 9));
      expect(waiting()).toEqual([true, true]);
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(updateProgress).toHaveBeenCalledTimes(1);
      expect(waiting()).toEqual([true, true]);
      await act(async () => { saves[0].resolve({ status: 'Schaue', episodes_watched: 8, watched_episodes: [1, 2, 3, 4, 5, 6, 7, 9], episode_scores: {} }); });
      await waitFor(() => expect(waiting()).toEqual([false, false]));
    });

    it('single episodes: stored marks and ratings above a lowered total are never sent back', async () => {
      const stale = entry({ my_progress: { status: 'Schaue', episodes_watched: 3, score: null, notes: null, watched_episodes: [1, 2, 14], episode_scores: { 2: 5, 14: 6 } } });
      const updateProgress = vi.fn(async () => ({}));
      openEditable(stale, { updateProgress, fetchDetail: vi.fn(async () => stale) });
      await act(async () => {});
      expect(within(screen.getByRole('list', { name: 'Folgen 1–12' })).getByRole('button', { name: 'Folge 2, Bewertung 5 von 10' }).getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(gridCell('Folgen 1–12', 3));
      await waitFor(() => expect(updateProgress).toHaveBeenCalledWith(1, { watched_episodes: [1, 2, 3], episode_scores: { 2: 5 } }), { timeout: 3000 });
    });

    it('a waiting tap is saved for its own entry when the dialog switches to another anime; the season editor starts over', async () => {
      const updateProgress = vi.fn(async () => ({}));
      const second = entry({ id: 2, title: 'Frieren 2', my_progress: null });
      const fetchDetail = vi.fn(async (id) => (id === 2 ? second : entry()));
      const props = {
        isOpen: true, onClose: vi.fn(), canEdit: true, fetchDetail, updateProgress, removeFromMyList: vi.fn(), update: vi.fn(), seasonSuggestion: vi.fn(),
        refresh: vi.fn(), remove: vi.fn(), onAdd: vi.fn(), onOpenAnime: vi.fn()
      };
      const { rerender } = render(<MemoryRouter><AnimeDetailModal {...props} animeId={1} fallback={entry()} /></MemoryRouter>);
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      expect(screen.getAllByLabelText('Ab Folge')).toHaveLength(1);
      fireEvent.click(gridCell('Folgen 1–12', 9));
      rerender(<MemoryRouter><AnimeDetailModal {...props} animeId={2} fallback={second} /></MemoryRouter>);
      await act(async () => {});
      expect(updateProgress).toHaveBeenCalledTimes(1);
      expect(updateProgress).toHaveBeenCalledWith(1, { watched_episodes: [1, 2, 3, 4, 5, 6, 7, 9], episode_scores: {} });
      expect(gridCell('Folgen 1–12', 9).getAttribute('aria-pressed')).toBe('false');
      expect(screen.queryAllByLabelText('Ab Folge')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Staffeln bearbeiten' })).toBeTruthy();
    });

    it('seasons: a long season comes in blocks of 100; saving seasons keeps a waiting tap on screen and in the save', async () => {
      vi.useFakeTimers();
      let current = entry({ episodes: 300, my_progress: { status: 'Schaue', episodes_watched: 70, score: null, notes: null } });
      const update = vi.fn(async (id, body) => { current = { ...current, custom_seasons: body.custom_seasons || [] }; return current; });
      const updateProgress = vi.fn(async () => ({}));
      openEditable(current, { update, updateProgress, seasonSuggestion: vi.fn(), fetchDetail: vi.fn(async () => current) });
      await act(async () => {});
      fireEvent.click(gridCell('Folgen 1–100', 75));
      fireEvent.click(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      fireEvent.change(screen.getAllByLabelText('Name (optional)')[0], { target: { value: 'East Blue' } });
      fireEvent.click(screen.getByRole('button', { name: 'Staffel hinzufügen' }));
      fireEvent.change(screen.getAllByLabelText('Ab Folge')[1], { target: { value: '62' } });
      fireEvent.change(screen.getAllByLabelText('Name (optional)')[1], { target: { value: 'Alabasta' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Staffeln speichern' })); });
      expect(update).toHaveBeenCalledWith(1, { custom_seasons: [{ start: 1, name: 'East Blue' }, { start: 62, name: 'Alabasta' }] });
      expect([...screen.getByLabelText('Abschnitt').options].map((o) => o.textContent))
        .toEqual(['East Blue · Folgen 1–61', 'Alabasta · Folgen 62–161', 'Alabasta · Folgen 162–261', 'Alabasta · Folgen 262–300']);
      expect(gridCell('Alabasta · Folgen 62–161', 75).getAttribute('aria-pressed')).toBe('true');
      expect(updateProgress).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(updateProgress).toHaveBeenCalledTimes(1);
      expect(updateProgress.mock.calls[0][1].watched_episodes).toEqual([...Array.from({ length: 70 }, (_, i) => i + 1), 75]);
    });

    it('seasons: a TV show starts from its stored TMDb seasons without a request; a suggestion after "Abbrechen" is dropped; names stop at 80 characters', async () => {
      let answer;
      const seasonSuggestion = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
      const tv = entry({ kind: 'tv', episodes: 19, seasons: [{ season_number: 1, episode_count: 9 }, { season_number: 2, episode_count: 10 }] });
      openEditable(tv, { seasonSuggestion, fetchDetail: vi.fn(async () => tv) });
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      expect(screen.getAllByLabelText('Ab Folge').map((input) => input.value)).toEqual(['1', '10']);
      expect(screen.getAllByLabelText('Name (optional)').map((input) => input.value)).toEqual(['', '']);
      expect(seasonSuggestion).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getAllByLabelText('Name (optional)')[0]);
      fireEvent.click(screen.getByRole('button', { name: 'Vorschlag von TMDB laden' }));
      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      const seasons = [{ start: 1, name: 'Staffel 1' }, { start: 10, name: 'x'.repeat(100) }];
      await act(async () => { answer({ seasons, reason: null }); });
      expect(screen.queryAllByLabelText('Ab Folge')).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      fireEvent.click(screen.getByRole('button', { name: 'Vorschlag von TMDB laden' }));
      await act(async () => { answer({ seasons, reason: null }); });
      const names = screen.getAllByLabelText('Name (optional)');
      expect(names.map((input) => input.value.length)).toEqual([9, 80]);
      expect(names[1].getAttribute('maxLength')).toBe('80');
    });

    it('seasons: "Vorschlag von TMDB laden" fills the editor, saving stores them for everybody and the grid follows the names', async () => {
      let current = entry({ episodes: 135, my_progress: { status: 'Schaue', episodes_watched: 70, score: null, notes: null } });
      const update = vi.fn(async (id, body) => { current = { ...current, custom_seasons: body.custom_seasons || [] }; return current; });
      const seasonSuggestion = vi.fn(async () => ({ seasons: [{ start: 1, name: 'East Blue', episodes: 61 }, { start: 62, name: 'Arabasta', episodes: 74 }], reason: null, tmdb_id: 37854 }));
      openEditable(current, { update, seasonSuggestion, fetchDetail: vi.fn(async () => current) });
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vorschlag von TMDB laden' })); });
      expect(seasonSuggestion).toHaveBeenCalledWith(1);
      expect(screen.getByRole('status').textContent).toBe('2 Staffeln von TMDB übernommen. Prüfen und speichern.');
      const names = screen.getAllByLabelText('Name (optional)');
      expect(names.map((input) => input.value)).toEqual(['East Blue', 'Arabasta']);
      fireEvent.change(names[1], { target: { value: 'Alabasta' } });
      fireEvent.click(screen.getByRole('button', { name: 'Staffel hinzufügen' }));
      fireEvent.change(screen.getAllByLabelText('Ab Folge')[2], { target: { value: '200' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Staffeln speichern' })); });
      expect(screen.getByRole('alert').textContent).toBe('Jede Staffel muss nach der vorigen beginnen, die erste bei Folge 1 und keine nach Folge 135.');
      fireEvent.click(screen.getByRole('button', { name: 'Staffel 3 entfernen' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Staffeln speichern' })); });
      expect(update).toHaveBeenCalledWith(1, { custom_seasons: [{ start: 1, name: 'East Blue' }, { start: 62, name: 'Alabasta' }] });
      const grid = await screen.findByRole('list', { name: 'Alabasta · Folgen 62–135' });
      expect(within(grid).getByRole('button', { name: 'Folge 71' }).textContent).toBe('71');
      expect(screen.getByText('2 eigene Staffeln')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Eigene Staffeln entfernen' })); });
      expect(update).toHaveBeenLastCalledWith(1, { custom_seasons: null });
      expect(await screen.findByRole('list', { name: 'Folgen 1–100' })).toBeTruthy();
    });

    it('seasons: without a TMDB key the suggestion says so; without the prop there is no editor', async () => {
      const seasonSuggestion = vi.fn(async () => ({ seasons: [], reason: 'no_key', tmdb_id: null }));
      const { unmount } = openEditable(entry(), { seasonSuggestion });
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Staffeln bearbeiten' }));
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vorschlag von TMDB laden' })); });
      expect(screen.getByRole('status').textContent).toBe('Für den Vorschlag braucht es einen TMDB-Schlüssel (Konto & Sprache → API-Schlüssel).');
      unmount();
      openEditable(entry());
      await act(async () => {});
      expect(screen.queryByRole('button', { name: 'Staffeln bearbeiten' })).toBeNull();
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

describe('AnimeDetailModal: ratings with other accounts', () => {
  const ME = 1;
  const mine = (over = {}) => ({
    user_id: ME, status: 'Schaue', episodes_watched: 7, score: null, notes: null, episode_scores: {}, rating_visibility: 'public', public_comment: null, ...over
  });
  const shared = ({ my_progress: own, ...over } = {}) => entry({
    my_progress: mine(own),
    progress: [
      { user_id: ME, username: 'felix', status: 'Schaue', episodes_watched: 7, score: own?.score ?? null },
      { user_id: 2, username: 'anna', status: 'Gesehen', episodes_watched: 12, score: 8, episode_scores: {} }
    ],
    community: { average: 8, count: 1, watchers: 2, episodes: {} },
    ...over
  });
  const RATINGS = { ratings: [{ user_id: 2, username: 'anna', score: 8, comment: 'Schön', visibility: 'public', own: false }] };

  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async (url) => {
      if (url === '/api/anime/1/ratings') return fakeResponse(200, RATINGS);
      if (url === '/api/auth/me') return fakeResponse(200, { user: { id: ME, username: 'felix', default_anime_visibility: 'anonymous' } });
      return fakeResponse(404, { error: 'Nicht gefunden' });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { clearDataCache(); });

  function Where() {
    const location = useLocation();
    return <p data-testid="where">{location.pathname}</p>;
  }
  const openShared = (anime, props = {}) => render(
    <MemoryRouter initialEntries={['/']}>
      <Where />
      <AnimeDetailModal isOpen animeId={anime.id} fallback={anime} onClose={vi.fn()} canEdit
        fetchDetail={vi.fn(async () => anime)} updateProgress={vi.fn(async () => ({}))} removeFromMyList={vi.fn(async () => true)} update={vi.fn()}
        refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} {...props} />
    </MemoryRouter>
  );
  const save = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' })); }); };

  it('before the first rating the visibility shows the account default; untouched it is no unsaved change', async () => {
    const onClose = vi.fn();
    openShared(shared(), { defaultVisibility: 'private', onClose });
    await act(async () => {});
    expect(screen.getByLabelText('Meine Bewertung sehen').value).toBe('private');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByText('Ungespeicherte Änderungen verwerfen?')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a picked and reverted visibility is no unsaved change either', async () => {
    const onClose = vi.fn();
    openShared(shared(), { defaultVisibility: 'private', onClose });
    await act(async () => {});
    const select = screen.getByLabelText('Meine Bewertung sehen');
    fireEvent.change(select, { target: { value: 'public' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(await screen.findByText('Ungespeicherte Änderungen verwerfen?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    fireEvent.change(select, { target: { value: 'private' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the first rating goes out with the shown visibility, also when it equals the stored one', async () => {
    const updateProgress = vi.fn(async () => ({}));
    const { unmount } = openShared(shared(), { defaultVisibility: 'private', updateProgress });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Bewertung'), { target: { value: '9' } });
    await save();
    expect(updateProgress).toHaveBeenLastCalledWith(1, { score: 9, rating_visibility: 'private' });
    unmount();

    openShared(shared(), { defaultVisibility: 'public', updateProgress });
    await act(async () => {});
    expect(screen.getByLabelText('Meine Bewertung sehen').value).toBe('public');
    fireEvent.change(screen.getByLabelText('Bewertung'), { target: { value: '6' } });
    await save();
    expect(updateProgress).toHaveBeenLastCalledWith(1, { score: 6, rating_visibility: 'public' });
  });

  it('without the prop the default comes from GET /api/auth/me (user.default_anime_visibility), asked once', async () => {
    const updateProgress = vi.fn(async () => ({}));
    const { unmount } = openShared(shared(), { updateProgress });
    await waitFor(() => expect(screen.getByLabelText('Meine Bewertung sehen').value).toBe('anonymous'));
    fireEvent.change(screen.getByLabelText('Bewertung'), { target: { value: '7' } });
    await save();
    expect(updateProgress).toHaveBeenLastCalledWith(1, { score: 7, rating_visibility: 'anonymous' });
    unmount();
    openShared(shared());
    await act(async () => {});
    expect(screen.getByLabelText('Meine Bewertung sehen').value).toBe('anonymous');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(1);
  });

  it('a first episode rating in the grid goes out with the shown visibility', async () => {
    const updateProgress = vi.fn(async (id, change) => mine({ episode_scores: change.episode_scores }));
    openShared(shared(), { defaultVisibility: 'anonymous', updateProgress });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Folgen bewerten' }));
    const grid = screen.getByRole('list', { name: 'Folgen 1–12' });
    fireEvent.click(within(grid).getByRole('button', { name: 'Folge 3' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Folge 3 bewerten' })).getByRole('button', { name: '8' }));
    await waitFor(() => expect(updateProgress).toHaveBeenCalledWith(1, expect.objectContaining({ episode_scores: { 3: 8 }, rating_visibility: 'anonymous' })), { timeout: 3000 });
  });

  it('a rated entry shows its stored visibility; the comment (at most 500 characters) is saved with the progress', async () => {
    const updateProgress = vi.fn(async () => ({}));
    openShared(shared({ my_progress: { score: 7, rating_visibility: 'anonymous', public_comment: 'Gut' } }), { defaultVisibility: 'private', updateProgress });
    await act(async () => {});
    expect(screen.getByLabelText('Meine Bewertung sehen').value).toBe('anonymous');
    const comment = screen.getByLabelText('Kommentar zur Bewertung');
    expect(comment.value).toBe('Gut');
    expect(comment.getAttribute('maxLength')).toBe('500');
    fireEvent.change(comment, { target: { value: '  Sehr gut ' } });
    await save();
    expect(updateProgress).toHaveBeenLastCalledWith(1, { public_comment: 'Sehr gut' });
    fireEvent.change(comment, { target: { value: '' } });
    await save();
    expect(updateProgress).toHaveBeenLastCalledWith(1, { public_comment: null });
  });

  it('"Fortschritt aller" lists status and progress only; the scores are in the community line and the ratings', async () => {
    openShared(shared());
    await act(async () => {});
    const section = screen.getByRole('heading', { name: 'Fortschritt aller' }).closest('section');
    expect(within(section).getByText('Community: Ø 8 / 10 aus 1 Bewertung')).toBeTruthy();
    const ratings = await within(section).findByRole('list', { name: 'Bewertungen' });
    expect(ratings.textContent).toContain('anna 8/10');
    const rows = within(section).getAllByRole('listitem').filter((li) => !ratings.contains(li));
    expect(rows.map((li) => li.textContent)).toEqual(['felixSchaue7 / 12', 'annaGesehen12 / 12']);
  });

  it('a single account: no visibility, no comment, no community block, and a first rating sends no visibility', async () => {
    const updateProgress = vi.fn(async () => ({}));
    const alone = entry({
      my_progress: mine({ score: null }),
      progress: [{ user_id: ME, username: 'felix', status: 'Schaue', episodes_watched: 7, score: null }],
      community: { average: 9, count: 1, watchers: 1, episodes: {} }
    });
    const rated = openShared({ ...alone, my_progress: { ...alone.my_progress, score: 9 } }, { defaultVisibility: 'private' });
    await act(async () => {});
    expect(screen.queryByLabelText('Meine Bewertung sehen')).toBeNull();
    expect(screen.queryByLabelText('Kommentar zur Bewertung')).toBeNull();
    expect(screen.queryByText(/^Community:/)).toBeNull();
    expect(screen.queryByRole('list', { name: 'Bewertungen' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/ratings') || url === '/api/auth/me')).toBe(false);
    rated.unmount();

    openShared({ ...alone, community: { average: null, count: 0, watchers: 1, episodes: {} } }, { updateProgress });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Bewertung'), { target: { value: '9' } });
    await save();
    expect(updateProgress).toHaveBeenLastCalledWith(1, { score: 9 });
  });

  it('films and specials get their own block apart from the related anime', async () => {
    openShared(shared({
      relations: [
        { kind: 'ANIME', relation: 'SEQUEL', title: 'Frieren 2', format: 'TV', anilist_id: 2 },
        { kind: 'ANIME', relation: 'SIDE_STORY', title: 'Frieren Film', format: 'MOVIE', anilist_id: 3 }
      ]
    }), { defaultVisibility: 'public' });
    await act(async () => {});
    const extras = screen.getByRole('heading', { name: 'Filme & Specials' }).closest('section');
    expect(extras.textContent).toContain('Frieren Film');
    expect(extras.textContent).not.toContain('Frieren 2');
    expect(screen.getByRole('heading', { name: 'Verwandte Anime' }).closest('section').textContent).toContain('Frieren 2');
  });

  it('shows my status per related film and hides the episode grid of a one-episode film', async () => {
    const view = openShared(shared({
      relations: [{ kind: 'ANIME', relation: 'SIDE_STORY', title: 'Frieren Film', format: 'MOVIE', anilist_id: 3, in_collection_id: 9, my_status: 'Gesehen' }]
    }), { defaultVisibility: 'public' });
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'Filme & Specials' }).closest('section').textContent).toContain('Gesehen');
    expect(screen.getByRole('heading', { name: 'Einzelne Folgen' })).toBeTruthy();
    view.unmount();

    openShared(shared({ format: 'MOVIE', episodes: 1 }), { defaultVisibility: 'public' });
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: 'Einzelne Folgen' })).toBeNull();
  });

  it('"Öffnen" on a related anime and the series link ask before unsaved input is dropped', async () => {
    const onOpenAnime = vi.fn();
    const linked = () => shared({
      manga: { id: 3, title: 'Frieren Manga' },
      relations: [{ kind: 'ANIME', relation: 'SEQUEL', title: 'Frieren 2', anilist_id: 2, in_collection_id: 9 }]
    });
    const dirty = openShared(linked(), { defaultVisibility: 'public', onOpenAnime });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Meine Notiz'), { target: { value: 'Ungespeichert' } });
    fireEvent.click(screen.getByRole('button', { name: 'Öffnen' }));
    expect(await screen.findByText('Ungespeicherte Änderungen verwerfen?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(onOpenAnime).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Öffnen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verwerfen' }));
    expect(onOpenAnime).toHaveBeenCalledWith(9);

    fireEvent.click(screen.getByRole('link', { name: 'Frieren Manga' }));
    expect(await screen.findByText('Ungespeicherte Änderungen verwerfen?')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/');
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/manga/3'));
    dirty.unmount();

    openShared(linked(), { defaultVisibility: 'public' });
    await act(async () => {});
    fireEvent.click(screen.getByRole('link', { name: 'Frieren Manga' }));
    expect(screen.queryByText('Ungespeicherte Änderungen verwerfen?')).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/manga/3');
  });

  it('closing while the save of that input runs does not ask', async () => {
    let finish;
    const updateProgress = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    openShared(shared(), { defaultVisibility: 'public', updateProgress, onClose });
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Meine Notiz'), { target: { value: 'Wird gespeichert' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByText('Ungespeicherte Änderungen verwerfen?')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { finish({}); });
  });

  it('the series link after the discard question: one Back from the series page leaves no entry of the closed dialog', async () => {
    window.history.replaceState(null, '', '/');
    const anime = shared({ manga: { id: 3, title: 'Frieren Manga' } });
    // like the dashboard: leaving the page closes the dialog for good
    function Page() {
      const { pathname } = useLocation();
      const [left, setLeft] = useState(false);
      useEffect(() => { if (pathname !== '/') setLeft(true); }, [pathname]);
      return (
        <>
          <p data-testid="where">{pathname}</p>
          <AnimeDetailModal isOpen={!left && pathname === '/'} animeId={1} fallback={anime} onClose={vi.fn()} canEdit defaultVisibility="public"
            fetchDetail={vi.fn(async () => anime)} updateProgress={vi.fn(async () => ({}))} removeFromMyList={vi.fn()} update={vi.fn()}
            refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} />
        </>
      );
    }
    render(<BrowserRouter><Page /></BrowserRouter>);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Meine Notiz'), { target: { value: 'Meine Notiz geändert' } });
    fireEvent.click(screen.getByRole('link', { name: 'Frieren Manga' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/manga/3'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    const landed = new Promise((resolve) => window.addEventListener('popstate', (e) => resolve(e.state), { once: true }));
    act(() => { window.history.back(); });
    const state = await landed;
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/'));
    expect(state?.[HISTORY_STATE_KEY]).toBeUndefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a save that ends after "Öffnen" switched the entry leaves the opened entry on screen', async () => {
    let finish;
    const updateProgress = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = shared({ title: 'Erste Staffel', relations: [{ kind: 'ANIME', relation: 'SEQUEL', title: 'Zweite Staffel', anilist_id: 2, in_collection_id: 9 }] });
    const second = shared({ id: 9, title: 'Zweite Staffel' });
    const fetchDetail = vi.fn(async (id) => (id === 9 ? second : first));
    function Host() {
      const [id, setId] = useState(1);
      return (
        <AnimeDetailModal isOpen animeId={id} fallback={id === 9 ? second : first} onClose={vi.fn()} canEdit defaultVisibility="public"
          fetchDetail={fetchDetail} updateProgress={updateProgress} removeFromMyList={vi.fn()} update={vi.fn()}
          refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={setId} />
      );
    }
    render(<MemoryRouter><Host /></MemoryRouter>);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('Meine Notiz'), { target: { value: 'Neu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Öffnen' }));
    expect(screen.queryByText('Ungespeicherte Änderungen verwerfen?')).toBeNull();
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Zweite Staffel');

    await act(async () => { finish({}); });
    expect(updateProgress).toHaveBeenCalledWith(1, { notes: 'Neu' });
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Zweite Staffel');
    expect(fetchDetail.mock.calls.map(([id]) => id)).toEqual([1, 9]);
  });
});

describe('films and TV shows', () => {
  const SOURCES = {
    anilist: { enabled: true, available: true }, mal: { enabled: true, available: true },
    tmdb: { enabled: true, name: 'TMDB', own: null, key_disabled: false, available: true, error: null }
  };
  const NO_TMDB_KEY = { ...SOURCES, tmdb: { ...SOURCES.tmdb, available: false } };
  const show = (over = {}) => entry({
    id: 5, kind: 'tv', title: 'Severance', format: 'TV', anilist_id: null, mal_id: null, tmdb_id: 95396, tmdb_kind: 'tv', episodes: 19, status: 'RELEASING',
    seasons: [{ season_number: 1, episode_count: 9, air_date: '2022-02-18' }, { season_number: 2, episode_count: 10, air_date: '2025-01-17' }],
    urls: { tmdb: 'https://www.themoviedb.org/tv/95396', imdb: 'https://www.imdb.com/title/tt11280740/' },
    my_progress: { status: 'Schaue', episodes_watched: 12, score: null, notes: null, audio_language: 'en', subtitle_language: 'de' }, ...over
  });
  const film = (over = {}) => entry({
    id: 6, kind: 'movie', title: 'Dune', format: 'MOVIE', anilist_id: null, mal_id: null, tmdb_id: 438631, tmdb_kind: 'movie', episodes: 1, duration: 155,
    status: 'FINISHED', seasons: [], urls: { tmdb: 'https://www.themoviedb.org/movie/438631', imdb: 'https://www.imdb.com/title/tt1160419/' },
    my_progress: { status: 'Geplant', episodes_watched: 0, score: null, notes: null }, ...over
  });

  it('helpers: missing kind is anime, S×E by the running sum, the airing lock per kind, TMDB badge, no "Weiter" for non-anime', () => {
    expect(kindOf({})).toBe('anime');
    expect(kindOf({ kind: 'movie' })).toBe('movie');
    expect(seasonEpisodeText(show(), 12)).toBe('S2E3');
    expect(seasonEpisodeText(show(), 9)).toBe('S1E9');
    expect(seasonEpisodeText(show(), 0)).toBeNull();
    expect(seasonEpisodeText(show({ seasons: [] }), 4)).toBeNull();
    expect(seasonEpisodeText(entry(), 4)).toBeNull();
    // seasons set by hand win, so the card, the form and the grid name the same season
    const custom = [{ start: 1, name: 'Teil 1' }, { start: 6, name: null }, { start: 15, name: 'Finale' }];
    expect([5, 6, 12, 19].map((n) => seasonEpisodeText(show({ custom_seasons: custom }), n))).toEqual(['S1E5', 'S2E1', 'S2E7', 'S3E5']);
    expect(seasonEpisodeText(show({ seasons: [], custom_seasons: custom }), 7)).toBe('S2E2');
    expect(seasonEpisodeText(entry({ custom_seasons: custom }), 7)).toBeNull();
    expect(stillAiring(show({ next_airing: { episode: 19, at: 1798985760, estimated: true } }))).toBe(true);
    expect(stillAiring(show({ next_airing: { episode: 20, at: 1798985760, estimated: true } }))).toBe(false);
    expect(stillAiring(show({ next_airing: null }))).toBe(false);
    expect(stillAiring(film({ status: 'NOT_YET_RELEASED' }))).toBe(false);
    expect(stillAiring({ status: 'RELEASING' })).toBe(true);
    expect(sourceBadges(show())).toEqual(['TMDB']);
    expect(continueTarget(show({ watch: { next_url: null, series_url: null, search_url: null } }))).toBeNull();
    expect(predictProgress({ status: 'Schaue', episodes_watched: 3, audio_language: 'ja' }, { subtitle_language: 'de' }, 12))
      .toMatchObject({ audio_language: 'ja', subtitle_language: 'de' });
    expect(predictProgress({ status: 'Schaue', episodes_watched: 3, audio_language: 'ja' }, { audio_language: null }, 12).audio_language).toBeNull();
  });

  it('a TV show airs by date: no clock time, today until the day is over; anime keep the time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 11, 20, 0));
    const at = Math.floor(new Date(2026, 9, 11, 9, 0).getTime() / 1000);
    expect(countdownText({ episode: 20, at }, new Date(), 'tv')).toBe('Folge 20 · heute');
    expect(countdownText({ episode: 8, at }, new Date())).toBeNull();
    expect(countdownText({ episode: 20, at: at - 86400 }, new Date(), 'tv')).toBeNull();
  });

  it('filters by kind and watched language', () => {
    const list = [entry(), show(), film()];
    expect(filterAnime(list, { kind: 'tv' }).map((a) => a.id)).toEqual([5]);
    expect(filterAnime(list, { kind: 'anime' }).map((a) => a.id)).toEqual([1]);
    expect(filterAnime(list, { language: 'en' }).map((a) => a.id)).toEqual([5]);
  });

  it('card: S×E for a TV show, the language pill with full names, TMDB badge, no IMDb link; a film has no counter and no +1', () => {
    const { rerender } = inRouter(<AnimeCard anime={show()} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} />);
    expect(screen.getByText('S2E3')).toBeTruthy();
    const pill = screen.getByRole('img', { name: 'Englisch · Untertitel: Deutsch' });
    expect(pill.textContent).toBe('EN');
    expect(pill.getAttribute('title')).toBe('Englisch · Untertitel: Deutsch');
    expect(screen.getByText('TMDB')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /IMDb/ })).toBeNull();
    expect(screen.getByRole('button', { name: /eine Folge mehr gesehen/ })).toBeTruthy();

    rerender(<MemoryRouter><AnimeCard anime={show({ my_progress: { status: 'Geplant', episodes_watched: 0 } })} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} /></MemoryRouter>);
    expect(screen.getByText('0 / 19')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Englisch/ })).toBeNull();

    rerender(<MemoryRouter><AnimeCard anime={film()} canEdit onOpen={vi.fn()} onPlusOne={vi.fn()} onStatusChange={vi.fn()} userId={1} /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /eine Folge mehr gesehen/ })).toBeNull();
    expect(screen.queryByText('0 / 1')).toBeNull();
    expect(screen.getByLabelText(/Status für Dune/)).toBeTruthy();
  });

  it('view: heading "Anime & Serien", kind chips remembered per device, the language filter falls back to "Alle"', () => {
    localStorage.setItem(LANGUAGE_FILTER_KEY, 'fr');
    const base = { loaded: true, loading: false, error: null, fromCache: false, cacheAt: null, user: { id: 1, role: 'editor' }, onAdd: vi.fn(), onOpen: vi.fn(), onPlusOne: vi.fn(), onStatusChange: vi.fn(), onRetry: vi.fn() };
    const { unmount } = render(<MemoryRouter><AnimeView {...base} list={[entry()]} canEdit /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Anime' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Nach Art filtern' })).toBeNull();
    expect(screen.queryByLabelText('Sprache')).toBeNull();
    unmount();

    render(<MemoryRouter><AnimeView {...base} list={[entry(), show(), film()]} canEdit /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Anime & Serien' })).toBeTruthy();
    const kinds = screen.getByRole('group', { name: 'Nach Art filtern' });
    expect(within(kinds).getAllByRole('button').map((b) => b.textContent)).toEqual(['Alle 3', 'Anime 1', 'Serien 1', 'Filme 1']);
    fireEvent.click(within(kinds).getByRole('button', { name: /Filme/ }));
    expect(localStorage.getItem(KIND_FILTER_KEY)).toBe('movie');
    expect(document.querySelectorAll('[data-anime-id]')).toHaveLength(1);
    expect(document.querySelector('[data-anime-id="6"]')).toBeTruthy();
    fireEvent.click(within(kinds).getByRole('button', { name: /Alle/ }));
    const language = screen.getByLabelText('Sprache');
    expect(language.value).toBe('all');
    expect([...language.options].map((o) => o.textContent)).toEqual(['Alle', 'Englisch']);
    fireEvent.change(language, { target: { value: 'en' } });
    expect(localStorage.getItem(LANGUAGE_FILTER_KEY)).toBe('en');
    expect([...document.querySelectorAll('[data-anime-id]')].map((n) => n.getAttribute('data-anime-id'))).toEqual(['5']);
  });

  describe('add dialog', () => {
    const tmdbHit = { kind: 'tv', tmdb_id: 95396, tmdb_kind: 'tv', title: { preferred: 'Severance', english: 'Severance', native: 'Severance', romaji: null }, format: 'TV', season_year: 2022, in_collection_id: null };
    const movieHit = { kind: 'movie', tmdb_id: 95396, tmdb_kind: 'movie', title: { preferred: 'Dune: Teil 1', english: 'Dune: Teil 1', native: 'Dune', romaji: null }, format: 'MOVIE', episodes: 1, season_year: 2021, in_collection_id: null };
    const answer = (over = {}) => ({ results: [tmdbHit, movieHit], sources_used: ['anilist', 'tmdb'], partial: true, cached: false, sources_available: ['anilist', 'mal', 'tmdb'], ...over });

    it('chip states follow GET /api/anime/sources', () => {
      expect(sourceChipState(SOURCES, 'tmdb')).toBe('on');
      expect(sourceChipState(NO_TMDB_KEY, 'tmdb')).toBe('disabled');
      expect(sourceChipState({ ...SOURCES, tmdb: { enabled: false, available: false } }, 'tmdb')).toBe('hidden');
      expect(sourceChipState(SOURCES, 'tmdb', { animeOnly: true })).toBe('hidden');
      expect(sourceChipState(null, 'tmdb')).toBe('hidden');
      expect(sourceChipState(null, 'anilist')).toBe('on');
      expect(hitKey(tmdbHit)).toBe('tmdb:tv:95396');
      expect(hitKey(movieHit)).toBe('tmdb:movie:95396');
      expect(sourcesNote(answer(), { sources: [], kind: 'all' })).toBe('Gerade ohne MyAnimeList');
      expect(sourcesNote(answer({ sources_used: ['tmdb'] }), { sources: ['tmdb'], kind: 'all' })).toBeNull();
      expect(sourcesNote(answer({ sources_used: ['anilist'] }), { sources: [], kind: 'anime' })).toBe('Gerade ohne MyAnimeList');
      expect(sourcesNote(answer({ sources_used: ['jikan'], sources_available: ['anilist', 'mal'] }), {})).toBe('Gerade ohne AniList');
    });

    it('loads the sources on open, searches with the chosen chips and kind, keys TMDb hits by kind and id and adds one with its title', async () => {
      const search = vi.fn(async () => answer());
      const loadSources = vi.fn();
      const onAdd = vi.fn(async () => ({}));
      render(<AddAnimeModal isOpen onClose={vi.fn()} search={search} onAdd={onAdd} sources={SOURCES} loadSources={loadSources} />);
      expect(loadSources).toHaveBeenCalledTimes(1);
      const chips = screen.getByRole('group', { name: 'Quellen' });
      expect(within(chips).getAllByRole('button').map((b) => b.textContent)).toEqual(['AniList', 'MyAnimeList', 'TMDB (Filme & Serien)']);
      fireEvent.click(within(chips).getByRole('button', { name: 'MyAnimeList' }));
      expect(JSON.parse(localStorage.getItem(SOURCES_KEY))).toEqual(['anilist', 'tmdb']);
      fireEvent.click(within(screen.getByRole('group', { name: 'Art' })).getByRole('button', { name: 'Serien' }));
      expect(localStorage.getItem(SEARCH_KIND_KEY)).toBe('tv');
      fireEvent.change(screen.getByLabelText('Titel suchen'), { target: { value: 'Severance' } });
      fireEvent.click(screen.getByRole('button', { name: 'Suchen' }));
      await screen.findByText('Dune: Teil 1');
      expect(search).toHaveBeenCalledWith('Severance', expect.objectContaining({ sources: ['anilist', 'tmdb'], kind: 'tv' }));
      expect(screen.getAllByText('Daten: TMDB')).toHaveLength(2);
      expect(screen.getAllByText('TMDB')).toHaveLength(2);
      expect(screen.getByText('Dune')).toBeTruthy();
      expect(screen.queryByText(/1 Folgen/)).toBeNull();
      fireEvent.click(screen.getAllByRole('button', { name: /Hinzufügen/ })[1]);
      await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ tmdb_id: 95396, tmdb_kind: 'movie', title: 'Dune: Teil 1', manga_id: null }));
    });

    it('without a TMDB key: the TMDB chip, "Serien" and "Filme" are disabled, a remembered "Serien" counts as "Alle", the hint opens the keys', async () => {
      localStorage.setItem(SEARCH_KIND_KEY, 'tv');
      localStorage.setItem(SOURCES_KEY, JSON.stringify(['anilist', 'mal', 'tmdb']));
      const search = vi.fn(async () => answer({ results: [], sources_used: ['anilist', 'jikan'], partial: false, sources_available: ['anilist', 'mal'] }));
      const onClose = vi.fn();
      const opened = vi.fn();
      window.addEventListener('mangashelf:open-account', opened);
      try {
        render(<AddAnimeModal isOpen onClose={onClose} search={search} onAdd={vi.fn()} sources={NO_TMDB_KEY} />);
        expect(screen.getByRole('button', { name: 'TMDB (Filme & Serien)' }).disabled).toBe(true);
        const kinds = screen.getByRole('group', { name: 'Art' });
        expect(within(kinds).getByRole('button', { name: 'Serien' }).disabled).toBe(true);
        expect(within(kinds).getByRole('button', { name: 'Filme' }).disabled).toBe(true);
        expect(within(kinds).getByRole('button', { name: 'Alle' }).getAttribute('aria-pressed')).toBe('true');
        fireEvent.change(screen.getByLabelText('Titel suchen'), { target: { value: 'Frieren' } });
        fireEvent.click(screen.getByRole('button', { name: 'Suchen' }));
        await waitFor(() => expect(search).toHaveBeenCalledWith('Frieren', expect.objectContaining({ sources: ['anilist', 'mal'], kind: 'all' })));
        fireEvent.click(screen.getByRole('button', { name: 'Schlüssel hinterlegen' }));
        expect(onClose).toHaveBeenCalled();
        expect(opened.mock.calls[0][0].detail).toBe('keys');
      } finally {
        window.removeEventListener('mangashelf:open-account', opened);
      }
    });

    it('a disabled source hidden by ANIME_SOURCES has no chip; anime only (share, match) ignores the remembered chips and hides kind and TMDB', async () => {
      localStorage.setItem(SEARCH_KIND_KEY, 'movie');
      localStorage.setItem(SOURCES_KEY, JSON.stringify(['tmdb']));
      const search = vi.fn(async () => answer({ results: [], sources_used: ['anilist', 'jikan'], partial: false }));
      const { unmount } = render(<AddAnimeModal isOpen onClose={vi.fn()} search={search} onAdd={vi.fn()} sources={{ ...SOURCES, mal: { enabled: false, available: false } }} />);
      expect(within(screen.getByRole('group', { name: 'Quellen' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['AniList', 'TMDB (Filme & Serien)']);
      unmount();

      render(<AddAnimeModal isOpen onClose={vi.fn()} search={search} onAdd={vi.fn()} sources={SOURCES} animeOnly initialQuery="Frieren" />);
      await waitFor(() => expect(search).toHaveBeenCalledWith('Frieren', expect.objectContaining({ sources: ['anilist', 'mal'], kind: 'anime' })));
      expect(screen.queryByRole('group', { name: 'Art' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'TMDB (Filme & Serien)' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'AniList' }));
      expect(localStorage.getItem(SOURCES_KEY)).toBe(JSON.stringify(['tmdb']));
    });

    it('the manual tab has a kind select', async () => {
      const onAdd = vi.fn(async () => ({ id: 3 }));
      render(<AddAnimeModal isOpen onClose={vi.fn()} search={vi.fn()} onAdd={onAdd} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Manuell' }));
      const kind = screen.getByLabelText('Art');
      expect([...kind.options].map((o) => o.textContent)).toEqual(['Anime', 'Serie', 'Film']);
      fireEvent.change(kind, { target: { value: 'movie' } });
      fireEvent.change(screen.getByLabelText('Titel'), { target: { value: 'Heimvideo' } });
      fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
      await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ title: 'Heimvideo', episodes: null, kind: 'movie', manga_id: null }));
    });

    it('anime only (share, match) has no kind select in the manual tab and adds an anime', async () => {
      const onAdd = vi.fn(async () => ({ id: 3 }));
      const search = vi.fn(async () => answer({ results: [], sources_used: ['anilist', 'jikan'], partial: false }));
      render(<AddAnimeModal isOpen onClose={vi.fn()} search={search} onAdd={onAdd} sources={SOURCES} animeOnly initialQuery="Frieren" />);
      await waitFor(() => expect(search).toHaveBeenCalled());
      fireEvent.click(screen.getByRole('tab', { name: 'Manuell' }));
      expect(screen.queryByLabelText('Art')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
      await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ title: 'Frieren', episodes: null, kind: 'anime', manga_id: null }));
    });
  });

  it('useAnimeList sends sources, kind and the UI language', async () => {
    const fetchMock = vi.fn(async (url) => fakeResponse(200, url.startsWith('/api/anime/search') ? { results: [], sources_used: [], partial: false, cached: false, sources_available: [] } : {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAnimeList({ user: { id: 1, username: 'anna', role: 'editor' } }));
    await act(() => result.current.search('Dune Teil', { sources: ['anilist', 'tmdb'], kind: 'movie' }));
    await act(() => result.current.search('Dune', { sources: [], kind: 'all' }));
    const urls = fetchMock.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/anime/search'));
    expect(urls).toEqual(['/api/anime/search?q=Dune%20Teil&sources=anilist%2Ctmdb&kind=movie&language=de', '/api/anime/search?q=Dune&language=de']);
  });

  describe('detail', () => {
    const openDetail = (anime, props = {}) => render(
      <MemoryRouter>
        <AnimeDetailModal isOpen animeId={anime.id} fallback={anime} onClose={vi.fn()} canEdit
          fetchDetail={vi.fn(async () => anime)} updateProgress={vi.fn(async () => ({}))} removeFromMyList={vi.fn(async () => true)} update={vi.fn(async () => anime)}
          refresh={vi.fn()} remove={vi.fn()} onAdd={vi.fn()} onOpenAnime={vi.fn()} {...props} />
      </MemoryRouter>
    );

    it('a TV show: kind, seasons line, S×E, IMDb and TMDB links; the languages are saved with the progress', async () => {
      const updateProgress = vi.fn(async () => ({}));
      openDetail(show(), { updateProgress });
      await act(async () => {});
      expect(screen.getByText('Art').nextElementSibling.textContent).toBe('Serie');
      expect(screen.getByText('Staffeln: 2 · Folgen: 19')).toBeTruthy();
      expect(screen.queryByText('Folgen')).toBeNull();
      expect(screen.getAllByText('S2E3').length).toBeGreaterThan(0);
      expect(screen.getByRole('link', { name: /IMDb/ }).getAttribute('href')).toBe('https://www.imdb.com/title/tt11280740/');
      expect(screen.getByRole('link', { name: /TMDB/ }).getAttribute('href')).toBe('https://www.themoviedb.org/tv/95396');
      const audio = screen.getByLabelText('Gesehen auf');
      expect(audio.value).toBe('en');
      expect(audio.options[0].textContent).toBe('Keine Angabe');
      fireEvent.change(audio, { target: { value: 'ja' } });
      fireEvent.change(screen.getByLabelText('Untertitel'), { target: { value: '' } });
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Fortschritt speichern' })); });
      expect(updateProgress).toHaveBeenCalledWith(5, { audio_language: 'ja', subtitle_language: null });
    });

    it('a film shows its running time and no counter; a manual entry gets a kind select that saves with PUT', async () => {
      const { unmount } = openDetail(film());
      await act(async () => {});
      expect(screen.getByText('Laufzeit: 155 Min.')).toBeTruthy();
      expect(screen.queryByText('Folgen')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Eine Folge mehr' })).toBeNull();
      expect(screen.queryByLabelText('Art')).toBeNull();
      unmount();

      const update = vi.fn(async (id, body) => ({ ...entry({ manual: true, anilist_id: null, mal_id: null }), ...body }));
      openDetail(entry({ manual: true, anilist_id: null, mal_id: null }), { update });
      await act(async () => {});
      const kind = screen.getByLabelText('Art');
      expect(kind.value).toBe('anime');
      await act(async () => { fireEvent.change(kind, { target: { value: 'tv' } }); });
      expect(update).toHaveBeenCalledWith(1, { kind: 'tv' });
    });
  });

  it('statistics: the kinds show only once the list holds a TV show or a film', () => {
    const { unmount } = render(<AnimeStatsCard anime={{ total: 2, by_kind: { anime: 2, tv: 0, movie: 0 }, watching: 0, completed: 0, planned: 0, per_user: [] }} />);
    expect(screen.queryByTestId('stats-anime-kinds')).toBeNull();
    unmount();
    render(<AnimeStatsCard anime={{ total: 4, by_kind: { anime: 2, tv: 1, movie: 1 }, watching: 0, completed: 0, planned: 0, per_user: [] }} />);
    const kinds = screen.getByTestId('stats-anime-kinds');
    const tile = (label) => within(kinds).getByText(label).nextElementSibling.textContent;
    expect([tile('Anime'), tile('Serien'), tile('Filme')]).toEqual(['2', '1', '1']);
  });
});
