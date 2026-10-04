// The three ways between the standalone mode and a server (spec-standalone §4), all on the existing backup format:
// "Auf Server übertragen" (app ZIP -> inspect/restore on a fresh server), "Zusammenführen" (CSV -> dry run -> import)
// and "Vom Server holen" (backup ZIP as admin, the offline snapshot otherwise). Requests go to the given server
// address directly with the bearer token of a sign-in made here, never through the local transport.
import { normalizeBase, isSecureEnough, INSECURE_URL_TEXT } from './serverStore.js';
import { buildBackupZip, readBackupZip } from '../local/backupZip.js';

export class TakeoverError extends Error {
  constructor(message, { status = 0, code = null, data = null } = {}) {
    super(message);
    this.name = 'TakeoverError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const NETWORK_TEXT = 'Server nicht erreichbar – Adresse und Verbindung prüfen.';

/** The server address as stored (https, or http in the home network); throws with a German message otherwise. */
export function checkedBase(url) {
  const base = normalizeBase(url);
  if (!base) throw new TakeoverError('Bitte eine Adresse mit http:// oder https:// eingeben.');
  if (!isSecureEnough(base)) throw new TakeoverError(INSECURE_URL_TEXT);
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
    throw new TakeoverError(NETWORK_TEXT, { code: 'NETWORK' });
  }
  if (raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch (_) { /* not JSON */ }
  if (!res.ok) {
    throw new TakeoverError(data?.error || `Anfrage fehlgeschlagen (HTTP ${res.status})`, { status: res.status, code: data?.code || null, data });
  }
  return data;
}

/** Signs in at the server: { base, token, user }. */
export async function remoteLogin({ url, username, password, fetchImpl }) {
  const base = checkedBase(url);
  const data = await call({ base, fetchImpl }, '/api/auth/login', { method: 'POST', body: { username, password } });
  if (!data?.token || !data.user) throw new TakeoverError('Der Server hat keine Sitzung für die App ausgegeben (Version zu alt?).');
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
  if (exported.status !== 200 || typeof exported.body !== 'string') throw new TakeoverError('Der CSV-Export der lokalen Sammlung ist fehlgeschlagen.');
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

/**
 * A database built from the offline snapshot of a non-admin: series and volumes as they are, ownership and reads of
 * the snapshot's user (the profile, same id and name). Other users' ownership is not part of it.
 */
export function fillFromSnapshot(conn, snapshot) {
  const me = snapshot.user;
  conn.prepare('DELETE FROM users').run();
  conn.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, '!local-profile', 'admin')").run(me.id, me.username);
  const mangaCols = columnsOf(conn, 'mangas');
  const volumeCols = columnsOf(conn, 'volumes');
  const skipManga = new Set(['volumes', 'reader_stats', 'updated_by']);
  for (const manga of Object.values(snapshot.details || {})) {
    const row = Object.fromEntries(Object.entries(manga).filter(([k, v]) => !skipManga.has(k) && (v === null || typeof v !== 'object')));
    insertRow(conn, 'mangas', mangaCols, row);
    for (const v of manga.volumes || []) {
      const vol = Object.fromEntries(Object.entries(v).filter(([k, val]) => k !== 'number_sort' && (val === null || typeof val !== 'object')));
      if (Array.isArray(v.images)) vol.images = v.images.length ? JSON.stringify(v.images) : null;
      insertRow(conn, 'volumes', volumeCols, vol);
      for (const o of v.owners || []) {
        if (o.user_id === me.id) conn.prepare('INSERT OR IGNORE INTO volume_owners (volume_id, user_id, price, purchase_date) VALUES (?, ?, ?, ?)').run(v.id, me.id, o.price ?? null, o.purchase_date ?? null);
      }
      if ((v.read_by || []).includes(me.id)) conn.prepare('INSERT OR IGNORE INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(v.id, me.id);
    }
  }
}

async function downloadUploads(session, paths, onProgress) {
  const uploads = new Map();
  let done = 0;
  const queue = [...paths];
  const worker = async () => {
    while (queue.length) {
      const path = queue.shift();
      try {
        const res = await call(session, path, { raw: true });
        uploads.set(decodeURIComponent(path.slice('/uploads/'.length)), new Uint8Array(await res.arrayBuffer()));
      } catch (_) { /* a missing cover stays missing */ }
      onProgress?.(++done, paths.length);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return uploads;
}

/**
 * "Vom Server holen": as admin the full backup ZIP (with covers), otherwise the offline snapshot (covers loaded one by
 * one). Replaces the local collection; resolves with { kind: 'backup' | 'snapshot', profile, counts }.
 */
export async function pullFromServer(session, runtime, { onProgress } = {}) {
  if (session.user.role === 'admin') {
    const res = await call(session, '/api/backup', { raw: true });
    const { dbBytes, uploads } = readBackupZip(new Uint8Array(await res.arrayBuffer()));
    const profile = await runtime.replaceDatabase(dbBytes, { uploads, profileName: session.user.username });
    return { kind: 'backup', profile, counts: runtime.facts().counts };
  }
  const snapshot = await call(session, '/api/offline-snapshot');
  if (!snapshot?.user || !snapshot.details) throw new TakeoverError('Der Server hat keine vollständige Offline-Kopie geliefert.');
  const dbBytes = runtime.databaseCopy((conn) => fillFromSnapshot(conn, snapshot), { from: 'empty' });
  const uploads = await downloadUploads(session, uploadPaths(snapshot), onProgress);
  const profile = await runtime.replaceDatabase(dbBytes, { uploads, profileName: snapshot.user.username });
  return { kind: 'snapshot', profile, counts: runtime.facts().counts };
}
