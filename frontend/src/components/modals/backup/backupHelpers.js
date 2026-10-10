import { formatCount, formatMegabytes, formatTime } from '../../../utils/format';
import { t } from '../../../i18n/index.js';
import { serverText } from '../../../i18n/serverText.js';

// i18n
export const SESSION_EXPIRED = 'Deine Sitzung ist abgelaufen oder ungültig. Bitte lade die Seite neu und melde dich an.';

// i18n
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

/**
 * Message for a failed response in the UI language; the server's own error text wins except for 401. `fallback` is
 * translated by the caller, `tooLarge`/`timeout` are `// i18n`-marked texts translated here.
 */
export function httpErrorMessage(status, data, fallback, { tooLarge, timeout } = {}) {
  if (status === 401) return t(SESSION_EXPIRED);
  const server = serverText(data);
  if (server) return server;
  // i18n-dynamic: the callers' marked RESTORE_HTTP/INSPECT_HTTP/CSV_TOO_LARGE texts
  if (status === 413) return tooLarge ? t(tooLarge) : t('Die Anfrage ist zu groß für den Server oder Proxy.');
  if (status === 502 || status === 503 || status === 504) {
    // i18n-dynamic: as above
    return timeout ? t(timeout) : t('Der Server hat nicht rechtzeitig geantwortet. Bitte später erneut versuchen.');
  }
  return t('{message} (HTTP {status})', { message: fallback, status });
}

const PASSWORD_MISSING = /^Bitte das aktuelle Passwort eingeben$/;

function retryTime(res, data) {
  const header = Number(res.headers?.get?.('retry-after'));
  const seconds = Number.isFinite(header) && header > 0 ? header : Number(data?.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? formatTime(Date.now() + seconds * 1000) : '';
}

/** Inline text when a restore refused the current password (wrong, missing, locked); '' for any other answer. */
export function passwordRefusalText(res, data) {
  if (data?.code === 'WRONG_PASSWORD') return serverText(data) || t('Das aktuelle Passwort stimmt nicht');
  if (res.status === 400 && PASSWORD_MISSING.test(data?.error)) return serverText(data);
  if (res.status !== 429) return '';
  const time = retryTime(res, data);
  if (data?.code === 'TOO_MANY_ATTEMPTS') {
    return time
      ? t('Zu viele Fehlversuche. Erneut möglich ab {time} Uhr; so lange ist auch die Anmeldung mit diesem Konto gesperrt.', { time })
      : t('Zu viele Fehlversuche. Die Anmeldung mit diesem Konto ist vorübergehend gesperrt.');
  }
  return time ? t('Zu viele Versuche. Erneut möglich ab {time} Uhr.', { time }) : (serverText(data) || t('Zu viele Anfragen – bitte kurz warten.'));
}

/** '120 Reihen · 2.400 Bände · 35 Bilder (1,20 MB)'; 'nur Datenbank' instead of the images when the ZIP has none. */
export function manifestSummary(manifest) {
  const counts = manifest?.counts;
  if (!counts) return '';
  const parts = [formatCount(counts.mangas, 'Reihe', 'Reihen'), formatCount(counts.volumes, 'Band', 'Bände')];
  const uploads = manifest.uploads;
  if (uploads) parts.push(`${formatCount(uploads.count, 'Bild', 'Bilder')}${uploads.bytes ? ` (${formatMegabytes(uploads.bytes)})` : ''}`);
  else parts.push(t('nur Datenbank'));
  return parts.join(' · ');
}

/** 'App 2.20.0 · Schema v14', or only the part the manifest knows. */
export function versionSummary(manifest) {
  if (!manifest) return '';
  const parts = [];
  if (manifest.app_version) parts.push(t('App {version}', { version: manifest.app_version }));
  if (Number.isFinite(manifest.schema_version)) parts.push(t('Schema v{version}', { version: manifest.schema_version }));
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
