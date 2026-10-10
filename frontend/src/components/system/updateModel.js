import { formatDay } from '../../utils/format.js';
import { serverText } from '../../i18n/serverText.js';
import { t } from '../../i18n/index.js';

export const REPO_URL = 'https://github.com/LixNix-Swap-Org/manga-shelf';
export const ISSUES_URL = `${REPO_URL}/issues`;
export const README_UPDATING_URL = `${REPO_URL}#updating`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const DEFAULT_IMAGE = 'ghcr.io/lixnix-swap-org/manga-shelf';

export const DOWNLOAD_PHASES = new Set(['downloading', 'verifying', 'preflight']);
export const APPLY_PHASES = new Set(['applying', 'swapping', 'restarting', 'pending_start']);

export const SIGNATURE_CODES = new Set(['SIGNATURE_INVALID', 'SIGNATURE_IDENTITY', 'BUNDLE_FORMAT', 'VERSION_UNBOUND', 'CHECKSUM_MISSING']);

// i18n
export const RELEASE_REASON_TEXT = {
  installed: 'installiert',
  older: 'älter: kein Zurück per Klick',
  unsigned: 'ohne Signatur',
  no_asset: 'keine Datei für dieses System'
};

// i18n
export const PHASE_TEXT = {
  downloading: 'Download läuft',
  verifying: 'Signatur wird geprüft',
  preflight: 'Installierbarkeit wird geprüft',
  ready: 'Bereit zur Installation'
};

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** > 0 when a is newer than b, < 0 when older, 0 when equal or unreadable. */
export function compareVersions(a, b) {
  const pa = VERSION.exec(String(a ?? ''));
  const pb = VERSION.exec(String(b ?? ''));
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff) return diff;
  }
  return 0;
}

/** Release page of an entry of `releases` (`url`, else `html_url`), only https. */
export function releaseUrl(release) {
  const url = release?.url || release?.html_url;
  return typeof url === 'string' && /^https:\/\//.test(url) ? url : '';
}

/** Releases newest first. */
export const sortReleases = (releases) => (Array.isArray(releases) ? [...releases].sort((a, b) => compareVersions(b.version, a.version)) : []);

/** A release the picker offers: installable here, or (an install that only gets instructions) any newer one. */
export const isSelectable = (release, { current, canInstall }) => Boolean(release?.installable)
  || (!canInstall && compareVersions(release?.version, current) > 0);

/** Option text: 'v3.1.0 – 10.10.2026' plus the reason when it cannot be chosen. */
export function releaseLabel(release, selectable = Boolean(release.installable)) {
  const date = formatDay(release.published_at);
  const reason = !selectable && RELEASE_REASON_TEXT[release.reason] ? ` – ${t(RELEASE_REASON_TEXT[release.reason])}` : '';
  return `v${release.version}${date ? ` – ${date}` : ''}${reason}`;
}

/** 'supervised' | 'pterodactyl' | 'manual': who starts the server after the swap. */
export function restartKind(install) {
  if (['supervised', 'pterodactyl', 'manual'].includes(install?.restart)) return install.restart;
  if (install?.mode === 'pterodactyl') return 'pterodactyl';
  return ['systemd', 'launchd', 'wings'].includes(install?.supervisor) ? 'supervised' : 'manual';
}

const quote = (arg) => {
  const s = String(arg);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
};

const isOption = (arg) => String(arg).startsWith('-');

/** Start command of the running server from `instructions.argv` (program first, then its options); '' without the program. */
export function startCommand(argv) {
  if (Array.isArray(argv)) return argv.length && !isOption(argv[0]) ? argv.map(quote).join(' ') : '';
  return typeof argv === 'string' && argv.trim() && !isOption(argv.trim()) ? argv.trim() : '';
}

/** Options of the running server from `instructions.argv` (the program, if given, left out). */
export function runningOptions(argv) {
  if (Array.isArray(argv)) return (argv.length && !isOption(argv[0]) ? argv.slice(1) : argv).map(quote).join(' ');
  if (typeof argv !== 'string') return '';
  const s = argv.trim();
  return isOption(s) ? s : s.split(/\s+/).slice(1).join(' ');
}

/** UI text of an update error: { text } from the client, else the server's { code, message[, msg, params] } or error body. */
export function errorText(error) {
  if (!error) return '';
  if (typeof error.text === 'string' && error.text) return error.text;
  if (typeof error.message === 'string' && error.message) {
    return serverText({ error: error.message, code: error.code, msg: error.msg, params: error.params });
  }
  return serverText(error);
}

/** The `### Before updating` texts of the status as [{ version, body }]. */
export function adminNotes(status) {
  const raw = status?.admin_notes;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  return list
    .map((note) => (typeof note === 'string' ? { version: status.version, body: note } : { version: note?.version || status.version, body: note?.text ?? note?.body ?? '' }))
    .map((note) => ({ ...note, body: String(note.body).trim().slice(0, 4000) }))
    .filter((note) => note.body);
}

/** Releases after `current` up to and including `target`, newest first. */
export const releasesBetween = (releases, current, target) => sortReleases(releases)
  .filter((r) => compareVersions(r.version, current) > 0 && compareVersions(r.version, target) <= 0);
