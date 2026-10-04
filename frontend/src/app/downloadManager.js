import { downloadFile, isAbortError, isLocalMode } from '../utils/api';
import { notify } from '../utils/notify';
import { formatNumber } from '../utils/format';
import { getActiveServer, subscribeServers } from './serverStore';
import { getLocalProfile, subscribeMode } from '../local/profile';
import { t } from '../i18n/index.js';

const MB = 1024 * 1024;
const UNKNOWN_SIZE_STEP = 5 * MB;

/** "Lädt… 3,2 von 10 MB" (or "Lädt… 3,2 MB" without a known size); '' without progress. */
export function downloadProgressText(progress) {
  if (!progress) return '';
  const loaded = formatNumber(progress.loaded / MB, 1);
  return progress.total > 0
    ? t('Lädt… {loaded} von {total} MB', { loaded, total: formatNumber(progress.total / MB, 1) })
    : t('Lädt… {loaded} MB', { loaded });
}

// session key + path -> running download; path -> number of mounted links showing it
const downloads = new Map();
const views = new Map();
const listeners = new Set();

const changed = () => { for (const listener of [...listeners]) listener(); };

// Bumped by cancelAllDownloads (logout, 401, server or profile switch): a new session never joins an old download.
let epoch = 0;

function session() {
  if (isLocalMode()) {
    const id = `local:${getLocalProfile()?.id ?? ''}`;
    return { id, signature: id };
  }
  const server = getActiveServer();
  return { id: server?.id ?? '', signature: `${server?.id ?? ''}\n${server?.token ?? ''}` };
}

const keyOf = (path) => `${session().id}:${epoch}:${path}`;
const find = (path) => (downloads.size ? downloads.get(keyOf(path)) : undefined);

// read on the first start, not at import (the shells swap the server storage first)
let signature = null;
function sessionChanged() {
  if (signature === null) return;
  const next = session().signature;
  if (next === signature) return;
  signature = next;
  cancelAllDownloads();
}
subscribeServers(sessionChanged);
subscribeMode(sessionChanged);

export function subscribeDownloads(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** { loaded, total } of the running download of `path`, else null. */
export const downloadProgress = (path) => find(path)?.progress ?? null;
export const downloadsRunning = () => downloads.size > 0;

// a toast per tenth of a known size (or per 5 MB), not per chunk
const toastStep = ({ loaded, total }) => (total > 0 ? Math.floor((loaded / total) * 10) : Math.floor(loaded / UNKNOWN_SIZE_STEP));

// a toast the user closed is not shown again for this background phase
function showToast(d) {
  d.toastStep = toastStep(d.progress);
  const text = t('Download läuft weiter ({progress})', { progress: downloadProgressText(d.progress) });
  if (d.toastId !== null) {
    notify.update(d.toastId, text);
    return;
  }
  d.toastId = notify.info(text, { duration: 0, action: { label: t('Abbrechen'), onClick: () => d.controller.abort() } });
}

function hideToast(d) {
  if (d.toastId !== null) notify.dismiss(d.toastId);
  d.toastId = null;
}

/**
 * Registers a mounted link for `path`; returns its release function. While no link shows a running download (its
 * dialog closed), the progress goes to a toast and the end is reported with one.
 */
export function watchDownload(path) {
  views.set(path, (views.get(path) || 0) + 1);
  const running = find(path);
  if (running) hideToast(running);
  return () => {
    const left = (views.get(path) || 1) - 1;
    if (left > 0) views.set(path, left);
    else views.delete(path);
    // a remount in the same tick (StrictMode, a re-keyed row) keeps the link
    setTimeout(() => {
      const d = find(path);
      if (!d || views.get(path) || d.toastId !== null) return;
      d.background = true;
      showToast(d);
    }, 0);
  };
}

/**
 * Downloads `path` with the token (utils/api.js downloadFile) independently of the component that started it: the
 * file is saved even after its dialog closed. A second start of a running path joins it. Resolves to true when saved.
 */
export function startDownload(path, { filename } = {}) {
  if (signature === null) signature = session().signature;
  const key = keyOf(path);
  const running = downloads.get(key);
  if (running) return running.promise;
  const d = {
    controller: new AbortController(), progress: { loaded: 0, total: 0 }, toastId: null, toastStep: 0, background: false
  };
  const onProgress = (loaded, total) => {
    d.progress = { loaded, total };
    if (d.toastId !== null && toastStep(d.progress) !== d.toastStep) showToast(d);
    changed();
  };
  downloads.set(key, d);
  d.promise = (async () => {
    try {
      const saved = await downloadFile(path, { filename, signal: d.controller.signal, onProgress });
      if (d.background) notify.success(t('Download gespeichert: {filename}', { filename: saved?.filename || filename || t('Datei') }));
      return true;
    } catch (e) {
      if (!isAbortError(e)) notify.error(e, { fallback: t('Download fehlgeschlagen') });
      else if (d.background) notify.info(t('Download abgebrochen'));
      return false;
    } finally {
      hideToast(d);
      if (downloads.get(key) === d) downloads.delete(key);
      changed();
    }
  })();
  changed();
  return d.promise;
}

export const cancelDownload = (path) => find(path)?.controller.abort();

/** Aborts every download and forgets them at once, so a start right after it begins a new one. */
export function cancelAllDownloads() {
  epoch++;
  const running = [...downloads.values()];
  downloads.clear();
  for (const d of running) d.controller.abort();
  if (running.length) changed();
}
