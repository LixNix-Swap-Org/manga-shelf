import { describe, expect, it, beforeEach } from 'vitest';
import {
  airingsOf, calendarDays, monthGrid, weekStart, dayKey, togetherRows, tagCounts, spoilerState,
  dueAlerts, historyEvents, watchedEpisode, barPercent, readSpoilerGuard, writeSpoilerGuard
} from '../utils/animeHub';

const NOW = new Date(2026, 9, 21, 12);
const sec = (d) => Math.floor(d.getTime() / 1000);
const tv = (id, over = {}) => ({
  id, title: `Anime ${id}`, format: 'TV', episodes: 12, my_progress: { status: 'Schaue', episodes_watched: 2 },
  next_airing: { episode: 3, at: sec(NOW) + 3600 }, ...over
});

describe('animeHub', () => {
  beforeEach(() => window.localStorage.clear());

  it('projects weekly estimates up to the episode count', () => {
    const out = airingsOf(tv(1, { episodes: 5 }));
    expect(out.map((e) => e.episode)).toEqual([3, 4, 5]);
    expect(out[0].estimated).toBe(false);
    expect(out[1].estimated).toBe(true);
    expect(airingsOf(tv(2, { kind: 'movie' }))).toEqual([]);
    expect(airingsOf({ id: 3 })).toEqual([]);
  });

  it('puts events on their day and respects mineOnly', () => {
    const list = [tv(1), tv(2, { my_progress: null })];
    const start = weekStart(NOW);
    const mine = calendarDays(list, start, 7).flatMap((d) => d.events);
    expect(mine.every((e) => e.anime.id === 1)).toBe(true);
    const all = calendarDays(list, start, 7, { mineOnly: false }).flatMap((d) => d.events);
    expect(all.map((e) => e.anime.id).sort()).toEqual([1, 2]);
    expect(dayKey(start)).toBe('2026-10-19');
  });

  it('lets history events replace the announced episode', () => {
    const list = [tv(1)];
    const extra = [{ anime: list[0], episode: 3, at: NOW.getTime(), past: true }];
    const events = calendarDays(list, weekStart(NOW), 7, { extra }).flatMap((d) => d.events);
    expect(events.filter((e) => e.episode === 3)).toHaveLength(1);
    expect(events.find((e) => e.episode === 3).past).toBe(true);
  });

  it('builds a Monday based month grid', () => {
    const { first, start, weeks } = monthGrid(NOW);
    expect(first.getDate()).toBe(1);
    expect(start.getDay()).toBe(1);
    expect(weeks).toBe(5);
    expect(monthGrid(NOW, 1).first.getMonth()).toBe(10);
  });

  it('lists shared entries with the shared episode and who is ahead', () => {
    const anime = {
      id: 1, title: 'A', episodes: 12,
      progress_users: [
        { username: 'a', status: 'Schaue', episodes_watched: 2 },
        { username: 'b', status: 'Schaue', episodes_watched: 6 }
      ]
    };
    const solo = { id: 2, title: 'B', progress_users: [{ username: 'a', status: 'Schaue', episodes_watched: 1 }] };
    const rows = togetherRows([anime, solo]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reached: 2, furthest: 6, ahead: ['b'], finished: false });
  });

  it('counts tags', () => {
    expect(tagCounts([{ tags: ['x', 'y'] }, { tags: ['y'] }, {}])).toEqual([{ name: 'y', count: 2 }, { name: 'x', count: 1 }]);
  });

  it('hides description and foreign ratings only while the guard is on', () => {
    const fresh = { my_progress: null };
    expect(spoilerState(fresh, false)).toEqual({ hideDescription: false, hideOthers: false });
    expect(spoilerState(fresh, true)).toEqual({ hideDescription: true, hideOthers: true });
    expect(spoilerState({ my_progress: { status: 'Schaue', episodes_watched: 1 } }, true)).toEqual({ hideDescription: false, hideOthers: true });
    expect(spoilerState({ my_progress: { status: 'Gesehen' } }, true)).toEqual({ hideDescription: false, hideOthers: false });
    expect(readSpoilerGuard()).toBe(false);
    writeSpoilerGuard(true);
    expect(readSpoilerGuard()).toBe(true);
  });

  it('reports each aired episode of followed entries once', () => {
    const aired = tv(1, { next_airing: { episode: 4, at: sec(NOW) - 600 } });
    const future = tv(2);
    const unfollowed = tv(3, { my_progress: null, next_airing: { episode: 1, at: sec(NOW) - 60 } });
    const old = tv(4, { next_airing: { episode: 9, at: sec(NOW) - 3 * 86400 } });
    const list = [aired, future, unfollowed, old];
    expect(dueAlerts(list, NOW).map((a) => a.key)).toEqual(['1:4']);
    expect(dueAlerts(list, NOW, ['1:4'])).toEqual([]);
  });

  it('turns the history answer into events and knows watched episodes', () => {
    const list = [tv(1)];
    const events = historyEvents({
      airings: [{ anime_id: 1, episode: 2, at: sec(NOW) }, { anime_id: 99, episode: 1, at: 1 }],
      finished: [{ anime_id: 1, date: '2026-10-20' }]
    }, list);
    expect(events).toHaveLength(2);
    expect(events[1].finished).toBe(true);
    expect(watchedEpisode(events[0])).toBe(true);
    expect(watchedEpisode({ anime: list[0], episode: 5 })).toBe(false);
  });

  it('scales bars', () => {
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(0, 0)).toBe(0);
  });
});
