import api, { apiUrl } from './api.js';
import { notify } from './notify.js';
import { HEALTHY, PROBE_TIMEOUT_MS } from '../app/connection.js';
import { t } from '../i18n/index.js';

export const UPDATE_RESULT_KEY = 'mangashelf_update_result';
export const UPDATE_WATCH_KEY = 'mangashelf_update_watch';
export const POLL_MS = 2000;
export const SLOW_POLL_MS = 10000;
export const SLOW_AFTER_MS = 3 * 60 * 1000;
const RESUME_MAX_AGE_MS = 30 * 60 * 1000;
const GATEWAY = new Set([502, 503, 504]);
const WAITING = new Set(['waiting', 'slow', 'pending_start']);

let current = null;
let snapshot = null;
let views = 0;
const listeners = new Set();

function session() {
  try { return globalThis.sessionStorage ?? null; } catch (_) { return null; }
}

function store(key, value) {
  try {
    const s = session();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch (_) { /* storage blocked */ }
}

function read(key) {
  try {
    const raw = session()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/** '1:05' for 65 s. */
export function elapsedText(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Main line of a wait: restarting, slow, waiting for a manual start or failed. */
export function watchStatusText(w) {
  if (!w) return '';
  if (w.phase === 'pending_start') return t('v{version} ist installiert und wartet auf den Start von Hand', { version: w.version });
  if (w.phase === 'slow') return t('Dauert länger als üblich');
  if (w.phase === 'failed') return t('Update auf v{version} nicht installiert', { version: w.version });
  return t('Server startet neu auf v{version}', { version: w.version });
}

/** 'Wartet seit 1:05 Min.' */
export const elapsedLine = (w) => t('Wartet seit {elapsed} Min.', { elapsed: elapsedText(w?.elapsedMs) });

function emit() {
  const w = current;
  snapshot = w ? {
    phase: w.phase, version: w.version, from: w.from, restart: w.restart, mode: w.mode, supervisor: w.supervisor,
    command: w.command, elapsedMs: w.elapsedMs, error: w.error, result: w.result
  } : null;
  for (const listener of [...listeners]) listener();
}

export const getUpdateWatch = () => snapshot;

export function subscribeUpdateWatch(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function showToast(w) {
  const text = `${watchStatusText(w)} · ${elapsedLine(w)}`;
  if (w.toastId !== null) notify.update(w.toastId, text);
  else w.toastId = notify.info(text, { duration: 0 });
}

function hideToast(w) {
  if (w.toastId !== null) notify.dismiss(w.toastId);
  w.toastId = null;
}

/** Registers a mounted view of the wait; while none is mounted the wait shows as a standing toast. Returns the release. */
export function watchUpdateView() {
  views++;
  if (current) hideToast(current);
  return () => {
    views = Math.max(0, views - 1);
    setTimeout(() => {
      if (!views && current && WAITING.has(current.phase)) showToast(current);
    }, 0);
  };
}

/** GET /api/health without credentials: { ok, version, uptime } or { ok: false } (network, timeout, 502-504, error status, another server). */
export async function probeHealth({ fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = PROBE_TIMEOUT_MS, instanceId = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(apiUrl('/api/health'), { credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (GATEWAY.has(res.status)) return { ok: false };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object' || body.name !== 'Manga Shelf' || !HEALTHY.has(body.status)) return { ok: false };
    if (instanceId && body.instance_id !== instanceId) return { ok: false };
    return { ok: true, version: body.version || null, uptime: Number.isFinite(body.uptime) ? body.uptime : null };
  } catch (_) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function finish(w, result) {
  clearTimeout(w.timer);
  store(UPDATE_RESULT_KEY, { result, version: w.version, from: w.from });
  store(UPDATE_WATCH_KEY, null);
  w.phase = 'done';
  w.result = result;
  hideToast(w);
  emit();
  w.reload();
}

function fail(w, error) {
  clearTimeout(w.timer);
  store(UPDATE_WATCH_KEY, null);
  w.phase = 'failed';
  w.error = error || null;
  hideToast(w);
  if (!views) notify.error(`${watchStatusText(w)}. ${t('Details auf der Systemseite.')}`);
  emit();
}

async function tick(w) {
  if (current !== w) return;
  const elapsed = w.now() - w.acceptedAt;
  const probe = await probeHealth({ fetchImpl: w.fetchImpl, instanceId: w.instanceId });
  if (current !== w) return;
  if (probe.ok) {
    const restarted = w.sawDown || (probe.uptime !== null && (probe.uptime + 1) * 1000 < elapsed);
    if (restarted) {
      finish(w, probe.version === w.version ? 'ok' : 'rolled_back');
      return;
    }
    const status = await api.get('/api/system/update/status', { timeout: PROBE_TIMEOUT_MS }).catch(() => null);
    if (current !== w) return;
    if (status?.phase === 'failed') {
      fail(w, status.error);
      return;
    }
  } else {
    w.sawDown = true;
  }
  w.elapsedMs = w.now() - w.acceptedAt;
  if (w.phase === 'waiting' && w.elapsedMs >= SLOW_AFTER_MS) w.phase = 'slow';
  if (w.toastId !== null) showToast(w);
  emit();
  w.timer = setTimeout(() => tick(w), w.elapsedMs >= SLOW_AFTER_MS ? SLOW_POLL_MS : POLL_MS);
}

/** Waits for the restarted server (target version: reload with a toast; old version: rollback; failed status: stop). */
export function startUpdateWatch(
  { version, from = null, restart = 'supervised', mode = null, supervisor = null, command = null, instanceId = null, acceptedAt } = {},
  { fetchImpl = (...args) => globalThis.fetch(...args), reload = () => globalThis.location?.reload(), now = Date.now } = {}
) {
  stopUpdateWatch();
  const w = {
    version, from, restart, mode, supervisor, command, instanceId, acceptedAt: acceptedAt ?? now(),
    phase: restart === 'manual' ? 'pending_start' : 'waiting', sawDown: false, elapsedMs: 0, error: null, result: null,
    timer: null, toastId: null, fetchImpl, reload, now
  };
  w.elapsedMs = Math.max(0, now() - w.acceptedAt);
  current = w;
  store(UPDATE_WATCH_KEY, { version, from, restart, mode, supervisor, command, instanceId, acceptedAt: w.acceptedAt });
  if (!views) showToast(w);
  emit();
  w.timer = setTimeout(() => tick(w), POLL_MS);
  return snapshot;
}

/** Ends the wait (and its toast) without a result. */
export function stopUpdateWatch() {
  const w = current;
  if (!w) return;
  clearTimeout(w.timer);
  hideToast(w);
  current = null;
  store(UPDATE_WATCH_KEY, null);
  emit();
}

/** After the reload of an update: the result toast once, or resumes a wait a manual reload cut off. Returns the result or null. */
export function announceUpdateOutcome(deps) {
  const outcome = read(UPDATE_RESULT_KEY);
  if (outcome) {
    store(UPDATE_RESULT_KEY, null);
    if (outcome.result === 'ok') notify.success(t('Aktualisiert auf v{version}', { version: outcome.version }));
    else notify.error(t('v{version} ist nicht gestartet, die vorherige Version läuft wieder. Details auf der Systemseite.', { version: outcome.version }), { duration: 0 });
    return outcome;
  }
  const pending = read(UPDATE_WATCH_KEY);
  const now = deps?.now ?? Date.now;
  if (!current && pending?.version && now() - Number(pending.acceptedAt) < RESUME_MAX_AGE_MS) startUpdateWatch(pending, deps);
  return null;
}
