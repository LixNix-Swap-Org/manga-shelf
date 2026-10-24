// Release-day reminders of the apps: the pure plan, the scheduler over a fake LocalNotifications bridge, the switch and
// the build gate (the web build has none of it).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// REMINDER_BUILD is read when reminderState loads (the build folds it)
vi.hoisted(() => { vi.stubEnv('VITE_APP_MODE', 'app'); });
import fs from 'fs';
import path from 'path';
import { render, screen, renderHook, waitFor, fireEvent } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import { planReminders, volumeReleases, episodeReleases, reminderIdFor, REMINDER_DAYS } from '../app/reminders/reminderPlan';
import {
  REMINDER_BUILD, REMINDER_ID_BASE, REMINDER_KEY, reminderBridge, remindersAvailable, canRemind, readEnabled, clearReleaseReminders,
  releaseRemindersChanged
} from '../app/reminders/reminderState';
import { PURCHASE_RECORDED_EVENT } from '../appShell';
import { startReleaseReminders, refreshReleaseReminders, setReleaseReminders, REFRESH_FLOOR_MS } from '../app/reminders/reminderScheduler';
import ReminderSwitch, { REMINDER_TEXTS } from '../app/reminders/ReminderSwitch';

// the hook's lazy import gets the same module: a wrapped start shows whether the hook ever reached it
vi.mock('../app/reminders/reminderScheduler.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, startReleaseReminders: vi.fn(real.startReleaseReminders) };
});

import useReleaseReminders from '../app/reminders/useReleaseReminders';

const EDITOR = { id: 3, role: 'editor' };
// Friday 2026-10-23, 08:00 local time
const NOW = new Date(2026, 9, 23, 8, 0, 0);
const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0, 0);
const seconds = (date) => Math.floor(date.getTime() / 1000);

const radarOf = (items) => ({ groups: [{ key: '2026-10', items }] });
const volume = (release_date, extra = {}) => ({ id: Math.random(), manga_title: 'Frieren', volume_number: '12', type: 'volume', status: 'Vorbestellt', release_date, ...extra });
const anime = (status, next, extra = {}) => ({ id: Math.random(), title: 'Sousou no Frieren', kind: 'anime', my_progress: status ? { status, episodes_watched: 3 } : null, next_airing: next, ...extra });

// Like the plugin: a fired notification leaves the pending list and shows in the shade (`delivered`); on Android cancel()
// and schedule() of an id also take a shown notification with that id off the shade, on iOS only
// removeDeliveredNotifications() does.
function fakeNotificationsBridge({ permission = 'granted', request = 'granted', platform = 'android', pending = [] } = {}) {
  const prefs = new Map();
  const listeners = {};
  let scheduled = pending.map((n) => ({ ...n }));
  let delivered = [];
  const without = (list, notifications) => list.filter((n) => !notifications.some((x) => x.id === n.id));
  const LocalNotifications = {
    checkPermissions: vi.fn(async () => ({ display: permission })),
    requestPermissions: vi.fn(async () => {
      permission = request;
      return { display: request };
    }),
    getPending: vi.fn(async () => ({ notifications: scheduled.map(({ id, title, body }) => ({ id, title, body })) })),
    schedule: vi.fn(async ({ notifications }) => {
      scheduled = [...without(scheduled, notifications), ...notifications];
      if (platform === 'android') delivered = without(delivered, notifications);
      return { notifications: notifications.map(({ id }) => ({ id })) };
    }),
    cancel: vi.fn(async ({ notifications }) => {
      scheduled = without(scheduled, notifications);
      if (platform === 'android') delivered = without(delivered, notifications);
    }),
    removeDeliveredNotifications: vi.fn(async ({ notifications }) => { delivered = without(delivered, notifications); }),
    createChannel: vi.fn(async () => {})
  };
  const native = {
    version: 4,
    platform,
    plugins: {
      LocalNotifications,
      Preferences: {
        get: vi.fn(async ({ key }) => ({ value: prefs.has(key) ? prefs.get(key) : null })),
        set: vi.fn(async ({ key, value }) => { prefs.set(key, value); }),
        remove: vi.fn(async ({ key }) => { prefs.delete(key); })
      },
      App: {
        addListener: vi.fn(async (event, fn) => {
          (listeners[event] ||= []).push(fn);
          return { remove: vi.fn(() => { listeners[event] = listeners[event].filter((f) => f !== fn); }) };
        })
      }
    }
  };
  return {
    native,
    prefs,
    LocalNotifications,
    scheduled: () => scheduled,
    own: () => scheduled.filter((n) => n.id >= REMINDER_ID_BASE),
    delivered: () => delivered,
    // the system shows a pending notification (its time came)
    fire: (id) => {
      delivered = [...delivered, ...scheduled.filter((n) => n.id === id)];
      scheduled = scheduled.filter((n) => n.id !== id);
    },
    foreground: () => (listeners.appStateChange || []).forEach((fn) => fn({ isActive: true })),
    background: () => (listeners.appStateChange || []).forEach((fn) => fn({ isActive: false })),
    listenerCount: () => (listeners.appStateChange || []).length
  };
}

function stubLists({ radar = radarOf([volume('2026-10-25')]), list = [], fail = false } = {}) {
  const fetchMock = vi.fn(async (url) => {
    if (fail) throw new TypeError('Failed to fetch');
    if (String(url).endsWith('/api/release-radar')) return fakeResponse(200, radar);
    if (String(url).endsWith('/api/anime')) return fakeResponse(200, list);
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const listCalls = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/release-radar')).length;

beforeEach(() => {
  vi.stubEnv('VITE_APP_MODE', 'app');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.mangashelfNative;
  localStorage.clear();
});

describe('planReminders (pure)', () => {
  it('one notification per release day at 9:00 local time, several volumes and episodes of a day share one', () => {
    const radar = radarOf([
      volume('2026-10-25'),
      volume('2026-10-25', { manga_title: 'Dandadan', volume_number: '15' }),
      volume('2026-10-28', { manga_title: 'Kaiju No. 8', volume_number: '10' })
    ]);
    const list = [anime('Schaue', { episode: 7, at: seconds(new Date(2026, 9, 25, 17, 30)), estimated: false })];
    const plan = planReminders({ radar, anime: list, now: NOW });
    expect(plan).toHaveLength(2);
    // days since 1970 (20751 and 20754) modulo the 100 ids of the own range
    expect(plan.map((n) => n.id)).toEqual([REMINDER_ID_BASE + 51, REMINDER_ID_BASE + 54]);
    expect(plan[0].schedule).toEqual({ at: at(2026, 10, 25), allowWhileIdle: true });
    expect(plan[0].title).toBe('3 Neuerscheinungen heute');
    expect(plan[0].body).toBe('Frieren – Band 12\nDandadan – Band 15\nSousou no Frieren – Folge 7');
    expect(plan[0].largeBody).toBe(plan[0].body);
    expect(plan[0].channelId).toBe('release-day');
    expect(plan[0].extra).toEqual({ kind: 'release-day', day: '2026-10-25' });
    expect(plan[1]).toMatchObject({ title: '1 Band erscheint heute', body: 'Kaiju No. 8 – Band 10', schedule: { at: at(2026, 10, 28) } });
  });

  it('only the next 14 days: today before 9:00 counts, a reminder time already passed or beyond the window does not', () => {
    const radar = radarOf([volume('2026-10-23'), volume('2026-10-22'), volume('2026-11-05'), volume('2026-11-06')]);
    expect(REMINDER_DAYS).toBe(14);
    const days = (now) => planReminders({ radar, now }).map((n) => n.extra.day);
    expect(days(NOW)).toEqual(['2026-10-23', '2026-11-05']);
    // 9:30: today's reminder time has passed, 2026-11-06 09:00 is exactly 14 days ahead
    expect(days(new Date(2026, 9, 23, 9, 30))).toEqual(['2026-11-05', '2026-11-06']);
  });

  it('the id of a release day stays the same in every plan and differs from every other day of the window', () => {
    const radar = radarOf([volume('2026-10-23'), volume('2026-10-24'), volume('2026-11-05')]);
    const idsOf = (now) => Object.fromEntries(planReminders({ radar, now }).map((n) => [n.extra.day, n.id]));
    const early = idsOf(NOW);
    const later = idsOf(new Date(2026, 9, 23, 9, 30));
    expect(later['2026-10-24']).toBe(early['2026-10-24']);
    expect(later['2026-11-05']).toBe(early['2026-11-05']);
    expect(later).not.toHaveProperty('2026-10-23');
    expect(Object.values(later)).not.toContain(early['2026-10-23']);
    expect(reminderIdFor(at(2026, 10, 24))).toBe(early['2026-10-24']);
    const daysAhead = Array.from({ length: REMINDER_DAYS + 1 }, (_, i) => reminderIdFor(new Date(2026, 9, 23 + i, 9)));
    expect(new Set(daysAhead).size).toBe(REMINDER_DAYS + 1);
    expect(daysAhead.every((id) => id >= REMINDER_ID_BASE && id < REMINDER_ID_BASE + 100)).toBe(true);
  });

  it('leaves out month-only and year-only dates, impossible days and estimated or unfollowed airings', () => {
    const radar = radarOf([
      volume('2026-11', { date_precision: 'month' }),
      volume('2026-10-30', { date_precision: 'month' }),
      volume('2026'),
      volume('2026-02-30'),
      volume(null),
      volume(' 2026-10-26 ')
    ]);
    expect(volumeReleases(radar).map((r) => r.at)).toEqual([at(2026, 10, 26)]);
    const soon = seconds(new Date(2026, 9, 24, 12));
    const list = [
      anime('Schaue', { episode: 4, at: soon, estimated: true }),
      anime('Gesehen', { episode: 4, at: soon, estimated: false }),
      anime(null, { episode: 4, at: soon, estimated: false }),
      anime('Geplant', null),
      anime('Geplant', { episode: 0, at: soon, estimated: false }),
      anime('Geplant', { episode: 1, at: soon, estimated: false }, { title_de: 'Frieren DE' })
    ];
    expect(episodeReleases(list).map((r) => r.line)).toEqual(['Frieren DE – Folge 1']);
    expect(planReminders({ radar: { groups: [] }, anime: list, now: NOW })[0].title).toBe('1 neue Folge heute');
  });

  it('caps the lines of a busy day and names the rest', () => {
    const radar = radarOf(Array.from({ length: 9 }, (_, i) => volume('2026-10-24', { volume_number: String(i + 1) })));
    const [day] = planReminders({ radar, now: NOW });
    expect(day.title).toBe('9 Bände erscheinen heute');
    expect(day.body.split('\n')).toEqual(['Frieren – Band 1', 'Frieren – Band 2', 'Frieren – Band 3', 'Frieren – Band 4', 'Frieren – Band 5', '+ 4 weitere Titel']);
  });
});

describe('feature detection and the build gate', () => {
  it('needs the app build and a bridge with LocalNotifications and Preferences', () => {
    const { native } = fakeNotificationsBridge();
    expect(REMINDER_BUILD).toBe(true);
    expect(reminderBridge({ mangashelfNative: native })).toBe(native);
    expect(remindersAvailable({})).toBe(false);
    expect(remindersAvailable({ mangashelfNative: { ...native, plugins: { ...native.plugins, LocalNotifications: undefined } } })).toBe(false);
    vi.stubEnv('VITE_APP_MODE', '');
    expect(reminderBridge({ mangashelfNative: native })).toBeNull();
  });

  it('editors and admins only (offline: the role before the drop)', () => {
    expect(canRemind(EDITOR)).toBe(true);
    expect(canRemind({ id: 1, role: 'admin' })).toBe(true);
    expect(canRemind({ id: 4, role: 'visitor' })).toBe(false);
    expect(canRemind({ id: 3, role: 'visitor', realRole: 'editor', offline: true })).toBe(true);
    expect(canRemind({ id: 4, role: 'visitor', realRole: 'guest', offline: true })).toBe(false);
    expect(canRemind(null)).toBe(false);
  });

  it('every lazy import of reminder code is behind the one build constant, the hook checks it first', () => {
    const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, '..', file), 'utf8');
    expect(read('app/reminders/reminderState.js').match(/^export const REMINDER_BUILD = .*$/gm)).toEqual([
      "export const REMINDER_BUILD = import.meta.env.VITE_APP_MODE === 'app';"
    ]);
    for (const file of ['components/modals/AccountModal.jsx', 'app/LocalScreen.jsx']) {
      const text = read(file);
      const imports = text.match(/import\('[^']*reminders\/[^']+'\)/g) || [];
      expect(imports.length, file).toBeGreaterThan(0);
      expect(text.match(/REMINDER_BUILD \? lazy\(\(\) => import\('[^']*reminders\/[^']+'\)\)/g) || [], file).toHaveLength(imports.length);
      expect(text, file).not.toMatch(/^import .*reminders\/(reminderScheduler|reminderPlan|ReminderSwitch)/m);
    }
    const hook = read('app/reminders/useReleaseReminders.js');
    expect(hook.indexOf('if (!REMINDER_BUILD) return undefined;')).toBeGreaterThan(-1);
    expect(hook.indexOf('if (!REMINDER_BUILD) return undefined;')).toBeLessThan(hook.indexOf("import('./reminderScheduler.js')"));
    const app = read('App.jsx');
    expect(app).toMatch(/useReleaseReminders\(user, localMode \? 'local' : activeServer\?\.id/);
    expect(app).not.toMatch(/import .*reminderScheduler|import .*reminderPlan/);
    // every session cleanup (logout, expiry, server or profile switch) clears them; only a restore keeps the switch
    expect(app).toMatch(/clearReleaseReminders\(undefined, \{ keepSetting: sameCollection \}\)\]\)/);
    expect(app.match(/clearSessionData\(\{ sameCollection: true \}\)/g)).toHaveLength(1);
  });
});

describe('the scheduler', () => {
  it('off by default: a session reads nothing and schedules nothing', async () => {
    const fake = fakeNotificationsBridge();
    const fetchMock = stubLists();
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now: () => NOW });
    await waitFor(() => expect(fake.listenerCount()).toBe(1));
    expect(await refreshReleaseReminders({ now: () => NOW })).toEqual({ ran: false, reason: 'off' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.LocalNotifications.schedule).not.toHaveBeenCalled();
    expect(await readEnabled(fake.native)).toBe(false);
    stop();
  });

  it('switching on asks for the permission, stores the setting and replaces only its own reminders', async () => {
    const foreign = { id: 5, title: 'fremd', body: '' };
    const fake = fakeNotificationsBridge({ permission: 'prompt', pending: [foreign, { id: REMINDER_ID_BASE + 3, title: 'alt', body: '' }] });
    stubLists({ list: [anime('Schaue', { episode: 2, at: seconds(new Date(2026, 9, 27, 1)), estimated: false })] });
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now: () => NOW });
    expect(await setReleaseReminders(true, { native: fake.native, now: () => NOW })).toEqual({ enabled: true });
    expect(fake.LocalNotifications.requestPermissions).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fake.prefs.get(REMINDER_KEY))).toEqual({ enabled: true });
    await waitFor(() => expect(fake.own().map((n) => n.extra?.day)).toEqual(['2026-10-25', '2026-10-27']));
    expect(fake.scheduled()).toContainEqual(foreign);
    // Android: its own channel, default importance, private on a lock screen that hides sensitive content
    expect(fake.LocalNotifications.createChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 'release-day', name: 'Erinnerungen am Erscheinungstag', importance: 3, visibility: 0 }));
    stop();
  });

  it('a refused permission keeps it off; switching off cancels every own reminder', async () => {
    const refused = fakeNotificationsBridge({ permission: 'prompt', request: 'denied' });
    expect(await setReleaseReminders(true, { native: refused.native })).toEqual({ enabled: false, denied: true });
    expect(refused.prefs.has(REMINDER_KEY)).toBe(false);

    const fake = fakeNotificationsBridge({ pending: [{ id: 5, title: 'fremd', body: '' }, { id: REMINDER_ID_BASE, title: 'a', body: '' }, { id: REMINDER_ID_BASE + 1, title: 'b', body: '' }] });
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    expect(await setReleaseReminders(false, { native: fake.native })).toEqual({ enabled: false });
    expect(fake.scheduled().map((n) => n.id)).toEqual([5]);
    expect(await readEnabled(fake.native)).toBe(false);
  });

  it('plans again on a return to the foreground, at most every 15 minutes, and keeps the reminders when the lists fail', async () => {
    const fake = fakeNotificationsBridge();
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    let fetchMock = stubLists();
    let clock = NOW.getTime();
    const now = () => new Date(clock);
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now });
    await waitFor(() => expect(fake.own()).toHaveLength(1));
    await waitFor(() => expect(fake.listenerCount()).toBe(1));
    fake.foreground();
    expect(await refreshReleaseReminders({ force: false, now })).toEqual({ ran: false, reason: 'floor' });
    expect(listCalls(fetchMock)).toBe(1);

    clock += REFRESH_FLOOR_MS + 1000;
    fetchMock = stubLists({ radar: radarOf([volume('2026-10-26'), volume('2026-10-29')]) });
    fake.foreground();
    await waitFor(() => expect(fake.own().map((n) => n.extra.day)).toEqual(['2026-10-26', '2026-10-29']));
    expect(listCalls(fetchMock)).toBe(1);

    stubLists({ fail: true });
    expect(await refreshReleaseReminders({ now })).toEqual({ ran: false, reason: 'unreachable' });
    expect(fake.own()).toHaveLength(2);
    stop();
  });

  it('a revoked permission schedules nothing new; a guest session never starts', async () => {
    const fake = fakeNotificationsBridge({ permission: 'denied' });
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    stubLists();
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now: () => NOW });
    expect(await refreshReleaseReminders({ now: () => NOW })).toEqual({ ran: false, reason: 'denied' });
    expect(fake.LocalNotifications.schedule).not.toHaveBeenCalled();
    stop();
    const guest = fakeNotificationsBridge();
    startReleaseReminders({ user: { id: 4, role: 'visitor' }, native: guest.native })();
    expect(guest.native.plugins.App.addListener).not.toHaveBeenCalled();
  });

  it('iOS has no channels: it schedules without createChannel', async () => {
    const fake = fakeNotificationsBridge({ platform: 'ios' });
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    stubLists();
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now: () => NOW });
    await waitFor(() => expect(fake.own()).toHaveLength(1));
    expect(fake.LocalNotifications.createChannel).not.toHaveBeenCalled();
    stop();
  });

  it('stop (logout) cancels the reminders, and a run that answers after it schedules nothing', async () => {
    const fake = fakeNotificationsBridge();
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    stubLists();
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now: () => NOW });
    await waitFor(() => expect(fake.own()).toHaveLength(1));
    await waitFor(() => expect(fake.listenerCount()).toBe(1));

    const answers = [];
    vi.stubGlobal('fetch', vi.fn((url) => new Promise((resolve) => {
      answers.push(() => resolve(String(url).endsWith('/api/anime') ? fakeResponse(200, []) : fakeResponse(200, radarOf([volume('2026-10-30')]))));
    })));
    const pending = refreshReleaseReminders({ now: () => NOW });
    await waitFor(() => expect(answers).toHaveLength(2));
    stop();
    answers.forEach((answer) => answer());
    expect(await pending).toEqual({ ran: false, reason: 'stale' });
    await waitFor(() => expect(fake.own()).toEqual([]));
    expect(fake.listenerCount()).toBe(0);
  });

  it('clearReleaseReminders (session data cleanup) removes pending and shown reminders and turns the switch off', async () => {
    for (const platform of ['android', 'ios']) {
      const fake = fakeNotificationsBridge({ platform, pending: [{ id: REMINDER_ID_BASE + 2, title: 'x', body: '' }, { id: REMINDER_ID_BASE + 7, title: 'heute', body: '' }, { id: 9, title: 'y', body: '' }] });
      fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
      fake.fire(REMINDER_ID_BASE + 7);
      fake.fire(9);
      expect(await clearReleaseReminders({ mangashelfNative: fake.native })).toBe(true);
      expect(fake.scheduled().map((n) => n.id), platform).toEqual([]);
      expect(fake.delivered().map((n) => n.id), platform).toEqual([9]);
      expect(await readEnabled(fake.native), platform).toBe(false);
    }
    expect(await clearReleaseReminders({})).toBe(false);
  });

  it('a restore of the same collection clears the reminders but keeps the switch', async () => {
    const fake = fakeNotificationsBridge({ pending: [{ id: REMINDER_ID_BASE + 2, title: 'x', body: '' }] });
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    expect(await clearReleaseReminders({ mangashelfNative: fake.native }, { keepSetting: true })).toBe(true);
    expect(fake.own()).toEqual([]);
    expect(await readEnabled(fake.native)).toBe(true);
  });

  it('logout: the next account on the device starts with the switch off and no reminder of the previous one', async () => {
    const fake = fakeNotificationsBridge();
    window.mangashelfNative = fake.native;
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    const fetchMock = stubLists({ radar: radarOf([volume('2026-10-23'), volume('2026-10-25')]) });
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now: () => NOW });
    await waitFor(() => expect(fake.own()).toHaveLength(2));
    fake.fire(reminderIdFor(at(2026, 10, 23)));
    // App: clearSessionData, then the user goes and the hook stops the session
    await clearReleaseReminders();
    stop();
    await waitFor(() => expect(fake.scheduled()).toEqual([]));
    expect(fake.delivered()).toEqual([]);

    fetchMock.mockClear();
    const next = startReleaseReminders({ user: { id: 8, role: 'editor' }, native: fake.native, now: () => NOW });
    expect(await refreshReleaseReminders({ now: () => NOW })).toEqual({ ran: false, reason: 'off' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.own()).toEqual([]);
    next();
  });

  it('a volume marked owned (or bought in the basket) is planned out at once; when that fails, going to the background does it', async () => {
    const fake = fakeNotificationsBridge();
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    stubLists({ radar: radarOf([volume('2026-10-24'), volume('2026-10-26', { manga_title: 'Dandadan' })]) });
    let clock = NOW.getTime();
    const now = () => new Date(clock);
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now });
    await waitFor(() => expect(fake.own().map((n) => n.extra.day)).toEqual(['2026-10-24', '2026-10-26']));
    await waitFor(() => expect(fake.listenerCount()).toBe(1));

    // the radar no longer lists an owned volume
    stubLists({ radar: radarOf([volume('2026-10-26', { manga_title: 'Dandadan' })]) });
    clock += 60 * 1000;
    releaseRemindersChanged();
    await waitFor(() => expect(fake.own().map((n) => n.extra.day)).toEqual(['2026-10-26']));

    // a basket booking whose replan cannot read the lists: the change stays pending
    const failing = stubLists({ fail: true });
    clock += 60 * 1000;
    window.dispatchEvent(new CustomEvent(PURCHASE_RECORDED_EVENT, { detail: { volumeId: 2 } }));
    await waitFor(() => expect(listCalls(failing)).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.own()).toHaveLength(1);
    const fetchMock = stubLists({ radar: radarOf([]) });
    clock += 4 * 60 * 1000;
    fake.background();
    await waitFor(() => expect(fake.own()).toEqual([]));
    expect(listCalls(fetchMock)).toBe(1);

    // nothing pending: within 15 minutes going away again reads nothing, later it plans again
    fake.background();
    fake.foreground();
    await new Promise((r) => setTimeout(r, 10));
    expect(listCalls(fetchMock)).toBe(1);
    clock += REFRESH_FLOOR_MS;
    fake.background();
    await waitFor(() => expect(listCalls(fetchMock)).toBe(2));
    stop();
    window.dispatchEvent(new CustomEvent('mangashelf:reminders-changed'));
    await new Promise((r) => setTimeout(r, 10));
    expect(listCalls(fetchMock)).toBe(2);
  });

  it('planning again keeps a reminder already shown today in the shade', async () => {
    const fake = fakeNotificationsBridge();
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    stubLists({ radar: radarOf([volume('2026-10-23'), volume('2026-10-25')]) });
    let clock = NOW.getTime();
    const now = () => new Date(clock);
    const stop = startReleaseReminders({ user: EDITOR, native: fake.native, now });
    await waitFor(() => expect(fake.own()).toHaveLength(2));
    const today = reminderIdFor(at(2026, 10, 23));
    fake.fire(today);
    clock = at(2026, 10, 23, 10).getTime();
    expect(await refreshReleaseReminders({ now })).toMatchObject({ ran: true, scheduled: 1 });
    expect(fake.own().map((n) => n.id)).toEqual([reminderIdFor(at(2026, 10, 25))]);
    expect(fake.delivered().map((n) => n.id)).toEqual([today]);
    stop();
  });
});

describe('useReleaseReminders (App.jsx)', () => {
  it('no bridge plugin, the web build or a guest: the scheduler never starts', async () => {
    startReleaseReminders.mockClear();
    renderHook(() => useReleaseReminders(EDITOR, 'srv-1'));
    window.mangashelfNative = fakeNotificationsBridge().native;
    renderHook(() => useReleaseReminders({ id: 4, role: 'visitor' }, 'srv-1'));
    vi.stubEnv('VITE_APP_MODE', '');
    renderHook(() => useReleaseReminders(EDITOR, 'srv-1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(startReleaseReminders).not.toHaveBeenCalled();
  });

  it('starts for an editor, survives going offline and stops (cancels) on logout', async () => {
    const fake = fakeNotificationsBridge({ pending: [{ id: REMINDER_ID_BASE, title: 'x', body: '' }] });
    window.mangashelfNative = fake.native;
    stubLists();
    startReleaseReminders.mockClear();
    const { rerender } = renderHook(({ user }) => useReleaseReminders(user, 'srv-1'), { initialProps: { user: EDITOR } });
    await waitFor(() => expect(fake.listenerCount()).toBe(1));
    expect(startReleaseReminders).toHaveBeenCalledTimes(1);
    rerender({ user: { ...EDITOR, role: 'visitor', realRole: 'editor', offline: true } });
    await new Promise((r) => setTimeout(r, 10));
    expect(startReleaseReminders).toHaveBeenCalledTimes(1);
    expect(fake.own()).toHaveLength(1);
    rerender({ user: null });
    await waitFor(() => expect(fake.listenerCount()).toBe(0));
    await waitFor(() => expect(fake.own()).toEqual([]));
  });
});

describe('ReminderSwitch', () => {
  it('off by default; on asks for the permission, a refusal shows the hint and stays off', async () => {
    const fake = fakeNotificationsBridge({ permission: 'prompt', request: 'denied' });
    window.mangashelfNative = fake.native;
    render(<ReminderSwitch />);
    const toggle = await screen.findByRole('checkbox', { name: REMINDER_TEXTS.toggle });
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect((await screen.findByRole('alert')).textContent).toBe(REMINDER_TEXTS.denied);
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute('aria-describedby')).toMatch(/-help .+-denied$/);
    expect(fake.LocalNotifications.requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('shows the stored setting and turns it off', async () => {
    const fake = fakeNotificationsBridge({ pending: [{ id: REMINDER_ID_BASE, title: 'x', body: '' }] });
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    window.mangashelfNative = fake.native;
    render(<ReminderSwitch />);
    const toggle = await screen.findByRole('checkbox', { name: REMINDER_TEXTS.toggle });
    await waitFor(() => expect(toggle.checked).toBe(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(false));
    expect(fake.own()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a permission revoked in the system settings (Android then reports "prompt") shows the hint under a switch that is on', async () => {
    const fake = fakeNotificationsBridge({ permission: 'prompt' });
    fake.prefs.set(REMINDER_KEY, JSON.stringify({ enabled: true }));
    window.mangashelfNative = fake.native;
    render(<ReminderSwitch />);
    const toggle = await screen.findByRole('checkbox', { name: REMINDER_TEXTS.toggle });
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect((await screen.findByRole('alert')).textContent).toBe(REMINDER_TEXTS.denied);
  });

  it('renders nothing without the plugin', () => {
    const { container } = render(<ReminderSwitch />);
    expect(container.innerHTML).toBe('');
  });

  it('the account dialog shows it on the tab "Sprache" for editors with the plugin, never for guests', async () => {
    window.mangashelfNative = fakeNotificationsBridge().native;
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).endsWith('/api/auth/me')
      ? fakeResponse(200, { user: { ...EDITOR, default_anime_visibility: 'public' } })
      : fakeResponse(404, { error: 'Nicht gefunden' }))));
    const { default: AccountModal } = await import('../components/modals/AccountModal');
    const view = render(<AccountModal isOpen onClose={() => {}} user={EDITOR} initialTab="language" />);
    expect(await screen.findByRole('checkbox', { name: REMINDER_TEXTS.toggle })).toBeTruthy();
    view.unmount();
    render(<AccountModal isOpen onClose={() => {}} user={{ id: 4, role: 'visitor' }} initialTab="language" />);
    await screen.findByRole('tab', { name: 'Sprache' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('checkbox', { name: REMINDER_TEXTS.toggle })).toBeNull();
  });
});
