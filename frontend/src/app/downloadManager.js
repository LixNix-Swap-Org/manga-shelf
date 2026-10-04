import { downloadFile, isAbortError } from '../utils/api';
import { notify } from '../utils/notify';
import { formatNumber } from '../utils/format';

const MB = 1024 * 1024;
const UNKNOWN_SIZE_STEP = 5 * MB;

/** "Lädt… 3,2 von 10 MB" (or "Lädt… 3,2 MB" without a known size); '' without progress. */
export function downloadProgressText(progress) {
  if (!progress) return '';
  const loaded = formatNumber(progress.loaded / MB, 1);
  return progress.total > 0
    ? `Lädt… ${loaded} von ${formatNumber(progress.total / MB, 1)} MB`
    : `Lädt… ${loaded} MB`;
}

// path -> running download; path -> number of mounted links showing it
const downloads = new Map();
const views = new Map();
const listeners = new Set();

const changed = () => { for (const listener of [...listeners]) listener(); };

export function subscribeDownloads(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** { loaded, total } of the running download of `path`, else null. */
export const downloadProgress = (path) => downloads.get(path)?.progress ?? null;
export const downloadsRunning = () => downloads.size > 0;

// a toast per tenth of a known size (or per 5 MB), not per chunk
const toastStep = ({ loaded, total }) => (total > 0 ? Math.floor((loaded / total) * 10) : Math.floor(loaded / UNKNOWN_SIZE_STEP));

// a toast the user closed is not shown again for this background phase
function showToast(d) {
  d.toastStep = toastStep(d.progress);
  const text = `Download läuft weiter (${downloadProgressText(d.progress)})`;
  if (d.toastId !== null) {
    notify.update(d.toastId, text);
    return;
  }
  d.toastId = notify.info(text, { duration: 0, action: { label: 'Abbrechen', onClick: () => d.controller.abort() } });
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
  const running = downloads.get(path);
  if (running) hideToast(running);
  return () => {
    const left = (views.get(path) || 1) - 1;
    if (left > 0) views.set(path, left);
    else views.delete(path);
    // a remount in the same tick (StrictMode, a re-keyed row) keeps the link
    setTimeout(() => {
      const d = downloads.get(path);
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
  const running = downloads.get(path);
  if (running) return running.promise;
  const d = {
    controller: new AbortController(), progress: { loaded: 0, total: 0 }, toastId: null, toastStep: 0, background: false
  };
  const onProgress = (loaded, total) => {
    d.progress = { loaded, total };
    if (d.toastId !== null && toastStep(d.progress) !== d.toastStep) showToast(d);
    changed();
  };
  downloads.set(path, d);
  d.promise = (async () => {
    try {
      const saved = await downloadFile(path, { filename, signal: d.controller.signal, onProgress });
      if (d.background) notify.success(`Download gespeichert: ${saved?.filename || filename || 'Datei'}`);
      return true;
    } catch (e) {
      if (!isAbortError(e)) notify.error(e, { fallback: 'Download fehlgeschlagen' });
      else if (d.background) notify.info('Download abgebrochen');
      return false;
    } finally {
      hideToast(d);
      if (downloads.get(path) === d) downloads.delete(path);
      changed();
    }
  })();
  changed();
  return d.promise;
}

export const cancelDownload = (path) => downloads.get(path)?.controller.abort();

export function cancelAllDownloads() {
  for (const d of downloads.values()) d.controller.abort();
}
