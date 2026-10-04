// ZIP export/import of the standalone mode in exactly the server's backup layout (services/backupArchive.js):
// manga.db + uploads/<name> + manifest.json. A server restores it through inspect/restore, the app restores a
// server backup the same way. fflate keeps it pure JS; the whole archive is held in memory.
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { t } from '../i18n/index.js';

export const MANIFEST_NAME = 'manifest.json';
const ALLOWED_IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
export const MAX_DB_BYTES = 512 * 1024 * 1024;

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The archive of a runtime (database + every upload) as bytes, with the server's manifest format 1. */
export async function buildBackupZip(runtime, { now = new Date(), appVersion = '', dbBytes: givenDb = null } = {}) {
  const dbBytes = givenDb || runtime.exportDatabase();
  const facts = runtime.facts();
  const entries = { 'manga.db': [dbBytes, { level: 6 }] };
  let uploadBytes = 0;
  const names = (await runtime.files.list()).filter((n) => !n.startsWith('.') && !/[/\\]/.test(n));
  for (const name of names) {
    const bytes = await runtime.files.read(name);
    if (!bytes) continue;
    uploadBytes += bytes.length;
    entries[`uploads/${name}`] = [bytes, { level: 0 }];
  }
  const manifest = {
    format: 1,
    app: 'manga-shelf',
    app_version: appVersion,
    schema_version: facts.schema_version,
    created_at: now.toISOString(),
    category: 'download',
    counts: facts.counts,
    uploads: { count: names.length, bytes: uploadBytes },
    db: { bytes: dbBytes.length, sha256: await sha256Hex(dbBytes) }
  };
  entries[MANIFEST_NAME] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(entries);
}

const isJunkPath = (name) => name.split('/').some((segment) => segment === '__MACOSX' || segment.startsWith('.'));

/** The server's restorableUploadName: a flat image file name (no folder, no dot file, no control character), else null. */
export function restorableUploadName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('.') || /[/\\:]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 32)) return null;
  return ALLOWED_IMAGE.test(name) ? name : null;
}

function uploadName(entryName, prefix) {
  const base = `${prefix}uploads/`;
  return entryName.startsWith(base) ? restorableUploadName(entryName.slice(base.length)) : null;
}

/** { dbBytes, uploads: Map(name -> bytes), manifest } of a backup ZIP; throws a German message for anything else. */
export function readBackupZip(bytes) {
  let files;
  try {
    files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  } catch (_) {
    throw new Error(t('Ungültiges ZIP-Archiv: Datei kann nicht gelesen werden'));
  }
  const dbName = Object.keys(files)
    .filter((n) => (n === 'manga.db' || n.endsWith('/manga.db')) && !isJunkPath(n))
    .sort((a, b) => a.length - b.length)[0];
  if (!dbName) throw new Error(t('Ungültiges Backup-Archiv: Keine manga.db Datenbank im ZIP gefunden.'));
  const dbBytes = files[dbName];
  if (dbBytes.length > MAX_DB_BYTES) throw new Error(t('Die Datenbank im Backup ist zu groß.'));
  const prefix = dbName.slice(0, -'manga.db'.length);
  const uploads = new Map();
  for (const [name, data] of Object.entries(files)) {
    const upload = uploadName(name, prefix);
    if (upload) uploads.set(upload, data);
  }
  let manifest = null;
  if (files[prefix + MANIFEST_NAME]) {
    try {
      const parsed = JSON.parse(strFromU8(files[prefix + MANIFEST_NAME]));
      manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) { /* unreadable manifest: the database decides */ }
  }
  return { dbBytes, uploads, manifest };
}
