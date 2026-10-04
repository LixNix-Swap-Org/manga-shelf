import { formatCount, formatMegabytes } from '../../../utils/format';

export const SESSION_EXPIRED = 'Deine Sitzung ist abgelaufen oder ungültig. Bitte lade die Seite neu und melde dich an.';

export const CATEGORY_LABELS = {
  daily: 'Täglich',
  manual: 'Manuell',
  'pre-restore': 'Vor Wiederherstellung',
  'pre-update': 'Vor Update'
};

export const UNDO_KEY = 'mangashelf_restore_undo';
export const UNDO_TTL_MS = 30 * 60 * 1000;

/** Parses a response body as JSON without throwing (proxy error pages are HTML). */
export async function readJson(res) {
  try {
    const data = JSON.parse(await res.text());
    return data && typeof data === 'object' ? data : {};
  } catch (_) {
    return {};
  }
}

/** German message for a failed response; the server's own error text wins except for 401. */
export function httpErrorMessage(status, data, fallback, { tooLarge, timeout } = {}) {
  if (status === 401) return SESSION_EXPIRED;
  if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
  if (status === 413) return tooLarge || 'Die Anfrage ist zu groß für den Server oder Proxy.';
  if (status === 502 || status === 503 || status === 504) {
    return timeout || 'Der Server hat nicht rechtzeitig geantwortet. Bitte später erneut versuchen.';
  }
  return `${fallback} (HTTP ${status})`;
}

/** '120 Reihen · 2.400 Bände · 35 Bilder (1,20 MB)'; 'nur Datenbank' instead of the images when the ZIP has none. */
export function manifestSummary(manifest) {
  const counts = manifest?.counts;
  if (!counts) return '';
  const parts = [formatCount(counts.mangas, 'Reihe', 'Reihen'), formatCount(counts.volumes, 'Band', 'Bände')];
  const uploads = manifest.uploads;
  if (uploads) parts.push(`${formatCount(uploads.count, 'Bild', 'Bilder')}${uploads.bytes ? ` (${formatMegabytes(uploads.bytes)})` : ''}`);
  else parts.push('nur Datenbank');
  return parts.join(' · ');
}

/** 'App 2.20.0 · Schema v14', or only the part the manifest knows. */
export function versionSummary(manifest) {
  if (!manifest) return '';
  const parts = [];
  if (manifest.app_version) parts.push(`App ${manifest.app_version}`);
  if (Number.isFinite(manifest.schema_version)) parts.push(`Schema v${manifest.schema_version}`);
  return parts.join(' · ');
}

const storage = () => {
  try {
    return window.sessionStorage;
  } catch (_) {
    return null;
  }
};

export function saveRestoreUndo(filename, now = Date.now()) {
  if (!filename) return;
  try {
    storage()?.setItem(UNDO_KEY, JSON.stringify({ filename, at: now }));
  } catch (_) {}
}

/** The pre-restore snapshot of a restore within the last 30 minutes, else null (an expired entry is dropped). */
export function readRestoreUndo(now = Date.now()) {
  try {
    const raw = storage()?.getItem(UNDO_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry && typeof entry.filename === 'string' && entry.filename && Number.isFinite(entry.at)
      && now - entry.at >= 0 && now - entry.at < UNDO_TTL_MS) {
      return { filename: entry.filename, at: entry.at };
    }
    storage()?.removeItem(UNDO_KEY);
  } catch (_) {}
  return null;
}

export function clearRestoreUndo() {
  try {
    storage()?.removeItem(UNDO_KEY);
  } catch (_) {}
}
