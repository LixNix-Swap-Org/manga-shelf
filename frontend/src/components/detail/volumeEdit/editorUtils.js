import { buildVolumeForm } from '../../../utils/volumeFormHelpers';
import { apiFetch, readJson } from '../../../utils/api';
import { formatDate } from '../../../utils/format';
import { t } from '../../../i18n/index.js';
import { serverText } from '../../../i18n/serverText.js';

// i18n
export const EDITOR_STATUSES = ['Vorhanden', 'Bestellt', 'Vorbestellt', 'Erscheint bald', 'Fehlt'];

// Same limits as middleware/upload.js and POST /api/upload/multiple
export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const UPLOAD_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const UPLOAD_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

export const isAbortError = (err) => err?.name === 'AbortError';

/** Error bodies can be HTML from a proxy (413, 502): never let the parse throw. */
export const readJsonSafe = async (res) => (await readJson(res)) ?? {};

/** Editor form for a volume; the legacy status 'Gelesen' is 'Vorhanden' plus a read entry on the server. */
export const buildEditorForm = (vol) => {
  const form = buildVolumeForm(vol || {});
  if (String(form.status || '').trim().toLowerCase() === 'gelesen') form.status = 'Vorhanden';
  return form;
};

/** Normalises a price the way core/lib/validate.js parsePrice reads it; null for empty, NaN for invalid. */
export const parsePriceInput = (val) => {
  if (val === null || val === undefined) return null;
  let s = String(val).replace(/€|eur/gi, '').replace(/\s/g, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const num = Number(s);
  return num <= 99999 ? num : NaN;
};

export const isValidPriceInput = (val) => !Number.isNaN(parsePriceInput(val));

/** Price as a plain decimal for query strings (the lookup reads it with parseFloat). */
export const priceForQuery = (val) => {
  const num = parsePriceInput(val);
  return num === null || Number.isNaN(num) ? '' : String(num);
};

export const isFullDate = (val) => /^\d{4}-\d{2}-\d{2}$/.test(String(val || ''));

/** 'November 2026' for '2026-11', '2026' for '2026'; null for a full date or an empty value. */
export const partialDateLabel = (val) => {
  const s = String(val || '').trim();
  if (!s || isFullDate(s)) return null;
  return formatDate(s, { long: true });
};

const unchanged = (form, initial, key) => initial && String(form[key] ?? '').trim() === String(initial[key] ?? '').trim();

/**
 * Field errors that the server would answer with 400 (keys are form fields, values messages in the UI language). Like PUT, a value
 * that still equals the one the editor opened with is not checked, so legacy rows stay saveable.
 */
export const validateVolumeForm = (form, initial = null) => {
  const errors = {};
  const num = String(form.volume_number ?? '').trim();
  if (!num) errors.volume_number = t('Bitte eine Bandnummer eingeben.');
  else if (num.length > 80 && !unchanged(form, initial, 'volume_number')) errors.volume_number = t('Höchstens 80 Zeichen.');
  if (!isValidPriceInput(form.price) && !unchanged(form, initial, 'price')) errors.price = t('Ungültiger Preis, z. B. 7,50');
  if (!isValidPriceInput(form.target_price) && !unchanged(form, initial, 'target_price')) errors.target_price = t('Ungültiger Zielpreis, z. B. 5,00');
  return errors;
};

// i18n
export const FIELD_NAMES = { volume_number: 'Bandnummer', price: 'Kaufpreis', target_price: 'Zielpreis' };

const sameField = (a, b) => (Array.isArray(a) || Array.isArray(b)
  ? JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
  : String(a ?? '') === String(b ?? ''));

const trimmedNumber = (form) => String(form?.volume_number ?? '').trim();

/**
 * PUT body: only the fields that differ from `base`, the form as the server last stored it. A field the user left
 * alone is never sent, so a value another user or device stored meanwhile is not overwritten with an older copy.
 */
export const buildSaveBody = (form, base) => {
  const body = {};
  for (const [key, value] of Object.entries(form)) {
    if (key === 'volume_number') {
      if (trimmedNumber(form) !== trimmedNumber(base)) body.volume_number = trimmedNumber(form);
    } else if (!sameField(value, base?.[key])) {
      body[key] = value;
    }
  }
  return body;
};

/**
 * Moves an open form onto a fresher server state: fields the user has not touched (still equal to the old base) take
 * the new value, touched fields stay. Returns the same object when nothing changes.
 */
export const rebaseForm = (form, oldBase, newBase) => {
  let next = form;
  for (const [key, value] of Object.entries(newBase)) {
    if (sameField(value, oldBase[key]) || !sameField(form[key], oldBase[key])) continue;
    if (next === form) next = { ...form };
    next[key] = value;
  }
  return next;
};

export const isAllowedImageUrl = (url) => /^(https?:\/\/|\/uploads\/)/i.test(String(url || '').trim());

/** Splits a selection into files the server accepts and named rejects (type or size). */
export const filterUploadFiles = (files) => {
  const accepted = [];
  const rejected = [];
  for (const file of Array.from(files || [])) {
    const ext = String(file.name || '').split('.').pop().toLowerCase();
    if (!UPLOAD_MIMES.has(file.type) || !UPLOAD_EXTS.has(ext)) rejected.push({ name: file.name, reason: t('kein JPG, PNG, WebP, GIF oder AVIF') });
    else if (file.size > MAX_UPLOAD_BYTES) rejected.push({ name: file.name, reason: t('größer als 15 MB') });
    else accepted.push(file);
  }
  return { accepted, rejected };
};

export const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** Appends images (no duplicates); the first one becomes the cover only when there is none. */
export const addImages = (form, urls) => {
  const images = [...(form.images || [])];
  for (const url of urls) if (url && !images.includes(url)) images.push(url);
  return { ...form, images, cover_image: form.cover_image || images[0] || '' };
};

export const removeImage = (form, url) => {
  const images = (form.images || []).filter(u => u !== url);
  const cover_image = form.cover_image === url ? (images[0] || '') : form.cover_image;
  return { ...form, images, cover_image };
};

/** Moves the image by its URL, so a list that changed since the render still moves the right photo. */
export const moveImage = (form, url, delta) => {
  const images = [...(form.images || [])];
  const from = images.indexOf(url);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= images.length) return form;
  images.splice(from, 1);
  images.splice(to, 0, url);
  return { ...form, images };
};

/**
 * DELETE /api/volumes/:id; a 404 means another tab already removed it, which counts as done. `trash_id` is the trash
 * entry the volume went to (null when the server sent none).
 */
export const deleteVolumeRequest = async (volId, { signal } = {}) => {
  try {
    const res = await apiFetch(`/api/volumes/${volId}`, { method: 'DELETE', signal });
    if (res.ok) return { ok: true, gone: false, trash_id: (await readJsonSafe(res)).trash_id ?? null };
    if (res.status === 404) return { ok: true, gone: true };
    const data = await readJsonSafe(res);
    return { ok: false, error: serverText(data) || t('Fehler beim Löschen des Bands (HTTP {status})', { status: res.status }) };
  } catch (err) {
    if (isAbortError(err)) return { ok: false, aborted: true };
    return { ok: false, error: t('Netzwerkfehler beim Löschen des Bands') };
  }
};
