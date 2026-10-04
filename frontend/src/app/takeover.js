// The three ways between the standalone mode and a server, all on the existing backup format:
// "Auf Server übertragen" (app ZIP -> inspect/restore on a fresh server), "Zusammenführen" (CSV -> dry run -> import)
// and "Vom Server holen" (backup ZIP as admin, the offline snapshot otherwise). Requests go to the given server
// address directly with the bearer token of a sign-in made here, never through the local transport.
import { normalizeBase, isSecureEnough, INSECURE_URL_TEXT } from './serverStore.js';
import { buildBackupZip, readBackupZip, restorableUploadName } from '../local/backupZip.js';
import { LOCAL_PASSWORD_HASH } from '../local/sanitize.js';
import imageCheck from '../../../core/lib/imageCheck.js';
import owners from '../../../core/lib/owners.js';
import { t } from '../i18n/index.js';
import { serverText } from '../i18n/serverText.js';

export class TakeoverError extends Error {
  constructor(message, { status = 0, code = null, data = null } = {}) {
    super(message);
    this.name = 'TakeoverError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// i18n
const NETWORK_TEXT = 'Server nicht erreichbar – Adresse und Verbindung prüfen.';

/** The server address as stored (https, or http in the home network); throws with a German message otherwise. */
export function checkedBase(url) {
  const base = normalizeBase(url);
  if (!base) throw new TakeoverError(t('Bitte eine Adresse mit http:// oder https:// eingeben.'));
  if (!isSecureEnough(base)) throw new TakeoverError(t(INSECURE_URL_TEXT));
  return base;
}

async function call(session, path, { method = 'GET', body, form, raw = false, fetchImpl = session.fetchImpl || globalThis.fetch } = {}) {
  const headers = { 'X-Client': 'app' };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetchImpl(`${session.base}${path}`, { method, headers, body: payload, credentials: 'omit' });
  } catch (err) {
    throw new TakeoverError(t(NETWORK_TEXT), { code: 'NETWORK' });
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok) {
    throw new TakeoverError(serverText(data) || t('Anfrage fehlgeschlagen (HTTP {status})', { status: res.status }), { status: res.status, code: data?.code || null, data });
  }
  return data;
}

/** Signs in at the server: { base, token, user }. */
export async function remoteLogin({ url, username, password, fetchImpl }) {
  const base = checkedBase(url);
  const data = await call({ base, fetchImpl }, '/api/auth/login', { method: 'POST', body: { username, password } });
  if (!data?.token || !data.user) throw new TakeoverError(t('Der Server hat keine Sitzung für die App ausgegeben (Version zu alt?).'));
  return { base, token: data.token, user: data.user, fetchImpl };
}

/**
 * The local database for a fresh server: the account the admin signed in with keeps its name and password there
 * (a restore swaps the users table), so the local profile becomes that admin account.
 */
export function assignProfileToAdmin(conn, { profileId, username, passwordHash }) {
  const existing = conn.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
  const targetId = existing ? existing.id : profileId;
  if (!existing) conn.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, profileId);
  conn.prepare("UPDATE users SET password_hash = ?, role = 'admin', password_changed_at = NULL WHERE id = ?").run(passwordHash, targetId);
  return targetId;
}

export async function hashPassword(password) {
  const { default: bcrypt } = await import('bcryptjs');
  return bcrypt.hash(password, 10);
}

const zipForm = (bytes) => {
  const form = new FormData();
  form.append('backup', new Blob([bytes], { type: 'application/zip' }), 'manga-shelf-app.zip');
  return form;
};

/**
 * Step 1 of "Auf Server übertragen": packs the local collection (profile = the signed-in admin) and lets the server
 * check it. Resolves with the server's inspect answer (counts, current_counts, warnings, staging_id).
 */
export async function inspectTransfer(session, runtime, { password, appVersion = '' }) {
  const passwordHash = await hashPassword(password);
  const profile = runtime.getProfile();
  const dbBytes = runtime.databaseCopy((conn) => assignProfileToAdmin(conn, { profileId: profile.id, username: session.user.username, passwordHash }));
  const zip = await buildBackupZip(runtime, { dbBytes, appVersion });
  return call(session, '/api/backup/inspect', { method: 'POST', form: zipForm(zip) });
}

/** The server already holds a collection (series, volumes or more than the one admin). */
export const serverHasData = (inspect) => Boolean(inspect?.current_counts)
  && (inspect.current_counts.mangas > 0 || inspect.current_counts.volumes > 0 || inspect.current_counts.users > 1);

/** Step 2: restores what step 1 staged; afterwards the app signs in again (the restore ended every session). */
export async function finishTransfer(session, stagingId, { username, password }) {
  const result = await call(session, `/api/backup/restore/${encodeURIComponent(stagingId)}`, { method: 'POST', body: {} });
  const again = await remoteLogin({ url: session.base, username, password, fetchImpl: session.fetchImpl });
  return { result, session: again };
}

export const cancelTransfer = (session, stagingId) => call(session, `/api/backup/restore/${encodeURIComponent(stagingId)}`, { method: 'DELETE' }).catch(() => null);

/** "Zusammenführen": the local CSV export into the server, as dry run first (the preview) or for real. */
export async function mergeCsv(session, runtime, { dryRun }) {
  const exported = await runtime.request('GET', '/api/export/csv');
  if (exported.status !== 200 || typeof exported.body !== 'string') throw new TakeoverError(t('Der CSV-Export der lokalen Sammlung ist fehlgeschlagen.'));
  return call(session, '/api/import/csv', { method: 'POST', body: { csv: exported.body.replace(/^\uFEFF/, ''), dry_run: Boolean(dryRun) } });
}

const uploadPaths = (snapshot) => {
  const paths = new Set();
  const add = (p) => { if (typeof p === 'string' && p.startsWith('/uploads/')) paths.add(p); };
  for (const m of Object.values(snapshot.details || {})) {
    add(m.cover_image);
    add(m.banner_image);
    for (const v of m.volumes || []) {
      add(v.cover_image);
      for (const img of Array.isArray(v.images) ? v.images : []) add(img);
    }
  }
  return [...paths];
};

function columnsOf(conn, table) {
  return new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

function insertRow(conn, table, columns, row) {
  const keys = Object.keys(row).filter((k) => columns.has(k));
  conn.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((k) => (row[k] === undefined ? null : row[k])));
}

// computed by buildMangaDetail or the triggers, never copied: owned_volumes is counted again by the volume inserts
const SKIP_MANGA = new Set(['volumes', 'reader_stats', 'updated_by', 'owned_volumes', 'wished', 'total_value', 'full_value']);
const SKIP_VOLUME = new Set(['number_sort', 'owners', 'owned_by_me', 'read_users', 'read_by', 'is_read']);
const scalars = (row, skip) => Object.fromEntries(Object.entries(row).filter(([k, v]) => !skip.has(k) && (v === null || typeof v !== 'object')));
const hasText = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Fills a database from a non-admin's offline snapshot: series, volumes, and the snapshot user's ownership, reads and
 * profile. Other users' ownership is absent, so a volume only they own counts as missing.
 */
export function fillFromSnapshot(conn, snapshot) {
  const me = snapshot.user;
  conn.prepare('DELETE FROM users').run();
  conn.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'admin')").run(me.id, me.username, LOCAL_PASSWORD_HASH);
  const mangaCols = columnsOf(conn, 'mangas');
  const volumeCols = columnsOf(conn, 'volumes');
  const insertOwner = conn.prepare('INSERT OR IGNORE INTO volume_owners (volume_id, user_id, price, purchase_date, condition, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))');
  const insertRead = conn.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, ?)');
  for (const manga of Object.values(snapshot.details || {})) {
    insertRow(conn, 'mangas', mangaCols, scalars(manga, SKIP_MANGA));
    for (const v of manga.volumes || []) {
      const vol = scalars(v, SKIP_VOLUME);
      // buildMangaDetail fills images from the cover (and the cover from the images): only real lists are stored
      const images = Array.isArray(v.images) ? v.images : [];
      const derived = images.length === 1 && images[0] === v.cover_image;
      vol.images = images.length && !derived ? JSON.stringify(images) : null;
      insertRow(conn, 'volumes', volumeCols, vol);
      for (const o of v.owners || []) {
        if (o.user_id !== me.id) continue;
        insertOwner.run(v.id, me.id, o.price ?? null, o.purchase_date ?? null, o.condition ?? null, hasText(o.created_at) ? o.created_at : null);
      }
      if ((v.read_by || []).includes(me.id)) {
        const read = (v.read_users || []).find((r) => (r.user_id ?? r.id) === me.id);
        insertRead.run(v.id, me.id, hasText(read?.read_at) ? read.read_at : null);
      }
      owners.syncStatusWithOwners(conn, v.id);
    }
  }
}

/** The name of a pulled upload under the server's restore rule (flat image file name), else null. */
export function pulledUploadName(path) {
  if (typeof path !== 'string' || !path.startsWith('/uploads/')) return null;
  let name;
  try { name = decodeURIComponent(path.slice('/uploads/'.length)); } catch (_) { return null; }
  return restorableUploadName(name);
}

async function downloadUploads(session, paths, onProgress) {
  const uploads = new Map();
  let done = 0;
  const queue = [...paths];
  const worker = async () => {
    while (queue.length) {
      const path = queue.shift();
      const name = pulledUploadName(path);
      try {
        if (name) {
          const res = await call(session, path, { raw: true });
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (imageCheck.detectImageExt(bytes)) uploads.set(name, bytes);
        }
      } catch (_) { /* a missing cover stays missing */ }
      onProgress?.(++done, paths.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return uploads;
}

/**
 * "Vom Server holen": admin gets the backup ZIP (replaceDatabase drops server secrets), others the snapshot plus covers.
 * Replaces the local collection; resolves with { kind: 'backup' | 'snapshot', profile, counts }.
 */
export async function pullFromServer(session, runtime, { onProgress } = {}) {
  if (session.user.role === 'admin') {
    const res = await call(session, '/api/backup', { raw: true });
    const { dbBytes, uploads } = readBackupZip(new Uint8Array(await res.arrayBuffer()));
    const profile = await runtime.replaceDatabase(dbBytes, { uploads, profileName: session.user.username });
    return { kind: 'backup', profile, counts: runtime.facts().counts };
  }
  const snapshot = await call(session, '/api/offline-snapshot');
  if (!snapshot?.user || !snapshot.details) throw new TakeoverError(t('Der Server hat keine vollständige Offline-Kopie geliefert.'));
  const dbBytes = runtime.databaseCopy((conn) => fillFromSnapshot(conn, snapshot), { from: 'empty' });
  const uploads = await downloadUploads(session, uploadPaths(snapshot), onProgress);
  const profile = await runtime.replaceDatabase(dbBytes, { uploads, profileName: snapshot.user.username });
  return { kind: 'snapshot', profile, counts: runtime.facts().counts };
}
