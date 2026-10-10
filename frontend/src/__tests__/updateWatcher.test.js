import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import { subscribe } from '../utils/notify';
import {
  announceUpdateOutcome, elapsedText, getUpdateWatch, probeHealth, startUpdateWatch, stopUpdateWatch, watchUpdateView,
  POLL_MS, SLOW_AFTER_MS, SLOW_POLL_MS, UPDATE_RESULT_KEY, UPDATE_WATCH_KEY
} from '../utils/updateWatcher';

const health = (version, uptime, extra = {}) => fakeResponse(200, { name: 'Manga Shelf', instance_id: 'inst-1', status: 'ok', version, uptime, checks: {}, ...extra });
const down = () => { throw new TypeError('Failed to fetch'); };

function stubServer(answers, status = () => fakeResponse(200, { phase: 'applying', version: '3.2.0' })) {
  const queue = [...answers];
  const fetchMock = vi.fn(async (url) => {
    if (url === '/api/health') return (queue.length > 1 ? queue.shift() : queue[0])();
    if (url === '/api/system/update/status') return status();
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const healthCalls = (fetchMock) => fetchMock.mock.calls.filter(([u]) => u === '/api/health').length;

let toasts;
let updates;
let stopUpdates;
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  toasts = recordToasts();
  updates = [];
  stopUpdates = subscribe((event) => { if (event.type !== 'show') updates.push(event); });
});
afterEach(() => {
  stopUpdateWatch();
  stopUpdates();
  toasts.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('updateWatcher', () => {
  it('waits through the old process and the downtime, then reloads for the target version and greets after the reload', async () => {
    const fetchMock = stubServer([() => health('3.0.0', 5000), down, () => fakeResponse(503, { name: 'Manga Shelf', status: 'error' }), () => health('3.2.0', 2)]);
    const reload = vi.fn();
    startUpdateWatch({ version: '3.2.0', from: '3.0.0', instanceId: 'inst-1' }, { reload });
    expect(toasts.messages('info')).toEqual(['Server startet neu auf v3.2.0 · Wartet seit 0:00 Min.']);
    expect(JSON.parse(sessionStorage.getItem(UPDATE_WATCH_KEY))).toMatchObject({ version: '3.2.0', from: '3.0.0' });

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/system/update/status')).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getUpdateWatch()).toMatchObject({ phase: 'done', result: 'ok' });
    expect(JSON.parse(sessionStorage.getItem(UPDATE_RESULT_KEY))).toEqual({ result: 'ok', version: '3.2.0', from: '3.0.0' });
    expect(sessionStorage.getItem(UPDATE_WATCH_KEY)).toBeNull();
    expect(updates.some((e) => e.type === 'dismiss')).toBe(true);

    stopUpdateWatch();
    expect(announceUpdateOutcome()).toMatchObject({ result: 'ok' });
    expect(toasts.messages('success')).toEqual(['Aktualisiert auf v3.2.0']);
    expect(sessionStorage.getItem(UPDATE_RESULT_KEY)).toBeNull();
    expect(announceUpdateOutcome()).toBeNull();
  });

  it('the old version answering after the restart is a rollback; a fresh uptime counts as a restart without seen downtime', async () => {
    stubServer([down, () => health('3.0.0', 3)]);
    const reload = vi.fn();
    startUpdateWatch({ version: '3.2.0', from: '3.0.0', instanceId: 'inst-1' }, { reload });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(UPDATE_RESULT_KEY)).result).toBe('rolled_back');
    stopUpdateWatch();
    announceUpdateOutcome();
    expect(toasts.messages('error')).toEqual(['v3.2.0 ist nicht gestartet, die vorherige Version läuft wieder. Details auf der Systemseite.']);
    expect(toasts.list.find((x) => x.kind === 'error').duration).toBe(0);

    sessionStorage.clear();
    stubServer([() => health('3.0.0', 9000), () => health('3.2.0', 1)]);
    const reload2 = vi.fn();
    startUpdateWatch({ version: '3.2.0', from: '3.0.0' }, { reload: reload2 });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(reload2).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(reload2).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(UPDATE_RESULT_KEY)).result).toBe('ok');
  });

  it('after 3 minutes it says so, keeps the elapsed time in the toast and polls every 10 s', async () => {
    const fetchMock = stubServer([down]);
    startUpdateWatch({ version: '3.2.0', from: '3.0.0', mode: 'pterodactyl', supervisor: 'wings', restart: 'pterodactyl' }, { reload: vi.fn() });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS);
    expect(getUpdateWatch()).toMatchObject({ phase: 'slow', mode: 'pterodactyl' });
    expect(updates.filter((e) => e.type === 'update').at(-1).message).toBe('Dauert länger als üblich · Wartet seit 3:00 Min.');
    const before = healthCalls(fetchMock);
    await vi.advanceTimersByTimeAsync(SLOW_POLL_MS * 3);
    expect(healthCalls(fetchMock) - before).toBe(3);
    expect(elapsedText(65000)).toBe('1:05');
  });

  it('a failed update of the still running server ends the wait with an error toast', async () => {
    const fetchMock = stubServer([() => health('3.0.0', 5000)], () => fakeResponse(200, { phase: 'failed', version: '3.2.0', error: { code: 'BACKUP_FAILED', message: 'Das Backup vor dem Update ist fehlgeschlagen.' } }));
    const reload = vi.fn();
    startUpdateWatch({ version: '3.2.0', from: '3.0.0' }, { reload });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(getUpdateWatch()).toMatchObject({ phase: 'failed', error: { code: 'BACKUP_FAILED' } });
    expect(toasts.messages('error')).toEqual(['Update auf v3.2.0 nicht installiert. Details auf der Systemseite.']);
    expect(sessionStorage.getItem(UPDATE_WATCH_KEY)).toBeNull();
    const calls = healthCalls(fetchMock);
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(healthCalls(fetchMock)).toBe(calls);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a manual restart starts waiting for the start by hand; a mounted view keeps the toast away until it closes', async () => {
    stubServer([down]);
    const release = watchUpdateView();
    startUpdateWatch({ version: '3.2.0', from: '3.0.0', restart: 'manual', command: './manga-shelf-server-linux-x64' }, { reload: vi.fn() });
    expect(getUpdateWatch()).toMatchObject({ phase: 'pending_start', command: './manga-shelf-server-linux-x64' });
    expect(toasts.list).toHaveLength(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts.messages('info')).toEqual(['v3.2.0 ist installiert und wartet auf den Start von Hand · Wartet seit 0:00 Min.']);
    watchUpdateView();
    expect(updates.some((e) => e.type === 'dismiss')).toBe(true);
  });

  it('a manual reload during the wait resumes it from the session; an old record is dropped', async () => {
    stubServer([down]);
    sessionStorage.setItem(UPDATE_WATCH_KEY, JSON.stringify({ version: '3.2.0', from: '3.0.0', restart: 'supervised', acceptedAt: Date.now() - 60000 }));
    expect(announceUpdateOutcome({ reload: vi.fn() })).toBeNull();
    expect(getUpdateWatch()).toMatchObject({ phase: 'waiting', version: '3.2.0', elapsedMs: 60000 });
    stopUpdateWatch();
    sessionStorage.setItem(UPDATE_WATCH_KEY, JSON.stringify({ version: '3.2.0', acceptedAt: Date.now() - 31 * 60000 }));
    announceUpdateOutcome({ reload: vi.fn() });
    expect(getUpdateWatch()).toBeNull();
  });

  it('probeHealth: gateway answers, another server, an error status and timeouts are "not yet"', async () => {
    vi.useRealTimers();
    const probe = (res) => probeHealth({ fetchImpl: async () => (typeof res === 'function' ? res() : res), instanceId: 'inst-1' });
    expect(await probe(fakeResponse(502, undefined))).toEqual({ ok: false });
    expect(await probe(health('3.2.0', 1, { instance_id: 'other' }))).toEqual({ ok: false });
    expect(await probe(health('3.2.0', 1, { name: 'Proxy' }))).toEqual({ ok: false });
    expect(await probe(health('3.2.0', 1, { status: 'error' }))).toEqual({ ok: false });
    expect(await probe(down)).toEqual({ ok: false });
    expect(await probe(health('3.2.0', 7, { status: 'degraded' }))).toEqual({ ok: true, version: '3.2.0', uptime: 7 });
    const slow = await probeHealth({ timeoutMs: 20, fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) });
    expect(slow).toEqual({ ok: false });
  });
});
