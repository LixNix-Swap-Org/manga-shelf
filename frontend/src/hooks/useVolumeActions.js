import { useState, useRef } from 'react';
import { hasUserRead, getVolumeDisplayTitle } from '../utils/volumeHelpers';
import { apiFetch, errorFromResponse, readJson, sessionEndAnnounced, isAbortError } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import { formatCount, formatDate } from '../utils/format';
import { prepareImageForUpload } from '../utils/imageResize';
import { submitChange, applyChangeToCaches } from '../utils/outbox';
import { applyVolumeChange } from '../utils/volumePatch';
import { t, tn } from '../i18n/index.js';
import { serverText } from '../i18n/serverText.js';

/** Error text of a failed response: the JSON `error`, else the fallback (proxies answer 502/504/413 with HTML). */
export async function readApiError(res, fallback) {
  return (await errorFromResponse(res, fallback)).message;
}

/** YYYY-MM-DD in local time; toISOString() is UTC and gives yesterday's date shortly after midnight. */
export function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function volumeDeleteConfirmText(vol) {
  if (!vol) return t('Diesen Band wirklich entfernen? Der Band kommt mit Besitz und Lesestatus aller Benutzer in den Papierkorb (30 Tage wiederherstellbar).');
  return t('"{title}" wirklich entfernen? Der Band kommt mit Besitz und Lesestatus aller Benutzer in den Papierkorb (30 Tage wiederherstellbar).', { title: getVolumeDisplayTitle(vol) });
}

// i18n
export const READ_OTHERS_ADMIN_ONLY = 'Nur Admins können den Lesestatus anderer Benutzer ändern.';
// i18n
export const UNAUTHORIZED_TEXT = 'Nicht autorisiert (HTTP 401) – bitte die Seite neu laden oder neu anmelden.';
// i18n
export const QUEUED_TEXT = 'Keine Verbindung – die Änderung ist vorgemerkt und wird automatisch übertragen.';
// i18n
export const UPLOAD_CANCELLED = 'Upload abgebrochen';
// i18n
const NOT_STORED_TEXT = 'Keine Verbindung, und die Änderung ließ sich auf diesem Gerät nicht speichern (Speicher voll oder gesperrt).';
// i18n
const READ_FAILED = 'Fehler beim Aktualisieren des Lesestatus';
// i18n
const STATUS_FAILED = 'Fehler beim Ändern des Status';

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/**
 * Undo of "ungelesen" puts the read back with its original date, which the server reports as previous_read_at.
 * Without it the undo would rewrite the reading history with today's date, so none is offered.
 */
export const previousReadAt = (data) => (typeof data?.previous_read_at === 'string' && data.previous_read_at
  ? data.previous_read_at
  : null);

export const BULK_UNDO_MS = 10000;
export const TRASH_UNDO_MS = 10000;

/**
 * read_at for a 'Gelesen am' date (YYYY-MM-DD, local): null for today, an empty or a future date (the server stamps
 * the current time), else local noon of that day as the server's UTC 'YYYY-MM-DD HH:MM:SS'.
 */
export function readAtForDate(date, today = localDateString()) {
  const value = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value >= today) return null;
  const noon = new Date(`${value}T12:00:00`);
  if (Number.isNaN(noon.getTime())) return null;
  return noon.toISOString().slice(0, 19).replace('T', ' ');
}

/** POST /api/trash/:id/restore; `onDone(ok)` runs afterwards either way (refresh). Resolves to ok. */
export async function restoreTrashed(trashId, onDone) {
  let ok = false;
  try {
    const res = await apiFetch(`/api/trash/${trashId}/restore`, { method: 'POST' });
    if (res.ok) ok = true;
    else await notifyResponseError(res, t('Wiederherstellen fehlgeschlagen'));
  } catch (err) {
    notify.error(err);
  }
  if (onDone) await onDone(ok);
  return ok;
}

/** "<label> in den Papierkorb gelegt" with "Rückgängig"; nothing without a trash id (older server, already gone). */
export function notifyTrashed(label, trashId, onDone) {
  if (!trashId) return null;
  // no label: the generic 'Band' sentence
  const text = label ? t('{label} in den Papierkorb gelegt', { label }) : t('Band in den Papierkorb gelegt');
  return notify.success(text, {
    duration: TRASH_UNDO_MS,
    action: { label: t('Rückgängig'), onClick: () => restoreTrashed(trashId, onDone) }
  });
}

/**
 * The outbox change of an owned-toggle click: { kind, value, purchase_date? }. With owners it switches the user's own
 * ownership; without, a missing volume becomes the user's and an owned one (old data) goes back to 'Fehlt'.
 */
export function ownedToggleChange(vol, user, today = localDateString()) {
  const owners = Array.isArray(vol.owners) ? vol.owners : [];
  if (vol.status === 'Vorhanden' && owners.length > 0) {
    const mine = typeof vol.owned_by_me === 'boolean' ? vol.owned_by_me : owners.some((o) => String(o.user_id) === String(user?.id));
    return { kind: 'owned', value: !mine };
  }
  if (vol.status !== 'Vorhanden') {
    // someone may have bought it meanwhile: their date stays theirs
    return owners.length > 0 && vol.purchase_date ? { kind: 'owned', value: true } : { kind: 'owned', value: true, purchase_date: today };
  }
  return { kind: 'status', value: 'Fehlt' };
}

/**
 * Per-volume actions: add, toggle owned/read, open the editor, delete. Toggles go through the outbox: applied at once
 * (patchManga and cached copies), sent now or replayed later. `canToggle` (default canEdit) gates only the toggles.
 */
export default function useVolumeActions({
  id, user, canEdit, canToggle = canEdit, selectedReaderId, fetchManga, volumes, onUnauthorized, patchManga
}) {
  const [newVolumeType, setNewVolumeType] = useState('volume'); // 'volume' | 'special_edition' | 'schuber' | 'special'
  const [newVolumeNum, setNewVolumeNum] = useState('');
  const [newVolumeStatus, setNewVolumeStatus] = useState('Vorhanden');
  const [newVolumeReleaseDate, setNewVolumeReleaseDate] = useState('');
  const [newVolumePrice, setNewVolumePrice] = useState('');
  const [newVolumeCover, setNewVolumeCover] = useState('');
  const [newVolumeIsbn, setNewVolumeIsbn] = useState(''); // a scanned ISBN the new volume is stored with
  const [uploadingNewCover, setUploadingNewCover] = useState(false);
  // 'Gelesen am' of the read toggle: only a date the user picked for this series (null = now); `on` is the day of the pick
  const [readPick, setReadPick] = useState(null);
  if (readPick && readPick.id !== id) setReadPick(null);
  const readDate = readPick && readPick.id === id ? readPick.date : null;
  const setReadDate = (value) => setReadPick(value ? { id, date: value, on: localDateString() } : null);

  const [activeVolume, setActiveVolume] = useState(null);

  const canToggleOthers = user?.role === 'admin';
  const pendingVolumesRef = useRef(new Set());

  // a double click must not send the same toggle twice
  const withVolumeLock = async (volId, fn) => {
    if (pendingVolumesRef.current.has(volId)) return;
    pendingVolumesRef.current.add(volId);
    try {
      return await fn();
    } finally {
      pendingVolumesRef.current.delete(volId);
    }
  };

  // only a 401 the client announced as the end of the session logs out; a proxy's 401 must not wipe the session
  const reportFailure = async (res, fallback) => {
    if (res.status === 401) {
      if (sessionEndAnnounced(res)) onUnauthorized?.();
      else notify.error(t(UNAUTHORIZED_TEXT));
      return;
    }
    await notifyResponseError(res, fallback);
    // the volume was deleted elsewhere: drop the stale card
    if (res.status === 404) await fetchManga();
  };

  const me = { id: user?.id, username: user?.username };
  const applyOptimistic = (change) => {
    patchManga?.((detail) => applyVolumeChange(detail, change, me));
    return applyChangeToCaches({ user, mangaId: id, change }).catch(() => false);
  };

  /** Records a toggle; resolves to the response data when the server took it now, else null. */
  const submitToggle = async (change, fallback) => {
    const cached = applyOptimistic(change);
    const offline = Boolean(user?.offline) || browserOffline();
    let result;
    try {
      result = await submitChange(change, { userId: user?.id, offline });
    } catch (err) {
      console.error(err);
      notify.error(err);
      await fetchManga();
      return null;
    }
    const { status, res } = result;
    if (status === 'sent' && res?.ok) {
      const data = (await readJson(res)) ?? {};
      await fetchManga();
      return data;
    }
    if (status === 'queued') {
      // the app itself answered with an error (5xx): its text; no answer or a proxy page: queued for later
      const err = res ? await errorFromResponse(res) : null;
      if (err?.data?.error) notify.error(err);
      else notify.info(t(QUEUED_TEXT));
      // offline: the patched offline copy (once written); online without answer: patchManga already shows the change
      if (offline) {
        await cached;
        await fetchManga();
      }
      return null;
    }
    if (res) await reportFailure(res, fallback);
    else if (result.reason === 'storage') notify.error(t(NOT_STORED_TEXT));
    // refused (4xx): back to the server state; 401: the change stays queued for the next login
    if (status === 'failed' && res?.status !== 404) await fetchManga();
    return null;
  };

  const addingVolumeRef = useRef(false);
  const uploadingRef = useRef(false);
  const uploadAbortRef = useRef(null);
  const latestUploadRef = useRef(0);
  // bumped when an upload starts, the cover is removed or the volume was added: an older upload result is dropped
  const uploadSeqRef = useRef(0);

  const setNewVolumeCoverValue = (value) => {
    uploadSeqRef.current++;
    setNewVolumeCover(value);
  };

  const handleAddSingleVolume = async (e) => {
    e.preventDefault();
    if (!canEdit || !newVolumeNum.trim() || addingVolumeRef.current || uploadingRef.current) return;
    addingVolumeRef.current = true;

    try {
      const res = await apiFetch('/api/volumes', {
        method: 'POST',
        body: {
          manga_id: id,
          type: newVolumeType,
          volume_number: newVolumeNum.trim(),
          status: newVolumeStatus,
          release_date: newVolumeReleaseDate ? newVolumeReleaseDate.trim() : null,
          price: newVolumePrice ? newVolumePrice.trim() : null,
          cover_image: newVolumeCover || null,
          images: newVolumeCover ? [newVolumeCover] : [],
          ...(newVolumeIsbn ? { isbn: newVolumeIsbn } : {})
        }
      });
      if (res.ok) {
        setNewVolumeNum('');
        setNewVolumeIsbn('');
        setNewVolumePrice('');
        setNewVolumeReleaseDate('');
        setNewVolumeCoverValue('');
        setNewVolumeType('volume');
        await fetchManga();
      } else {
        await reportFailure(res, t('Fehler beim Hinzufügen'));
      }
    } catch (err) {
      notify.error(err);
    } finally {
      addingVolumeRef.current = false;
    }
  };

  const handleUploadNewSingleCover = async (file) => {
    if (!canEdit || !file) return;
    const seq = ++uploadSeqRef.current;
    const uploadId = ++latestUploadRef.current;
    const current = () => seq === uploadSeqRef.current;
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    uploadingRef.current = true;
    setUploadingNewCover(true);
    try {
      const fd = new FormData();
      fd.append('image', await prepareImageForUpload(file));
      if (controller.signal.aborted) return;
      const res = await apiFetch('/api/upload', { method: 'POST', body: fd, signal: controller.signal });
      if (res.ok) {
        const data = await readJson(res);
        if (!data?.url) throw new Error(t('Antwort ohne Bild-URL'));
        if (current()) setNewVolumeCover(data.url);
      } else if (current()) {
        await reportFailure(res, t('Fehler beim Hochladen'));
      }
    } catch (e) {
      if (isAbortError(e)) {
        if (uploadId === latestUploadRef.current) notify.info(t(UPLOAD_CANCELLED));
      } else if (current()) {
        notify.error(e, { fallback: t('Upload-Fehler') });
      }
    } finally {
      if (uploadId === latestUploadRef.current) {
        uploadingRef.current = false;
        uploadAbortRef.current = null;
        setUploadingNewCover(false);
      }
    }
  };

  /** Cancels a running cover upload: the form is usable again at once. */
  const cancelNewCoverUpload = () => {
    if (!uploadAbortRef.current) return;
    uploadSeqRef.current++;
    uploadAbortRef.current.abort();
  };
  // AddVolumeBar finds the cancel here until the page passes it as onCancelUpload
  handleUploadNewSingleCover.cancel = cancelNewCoverUpload;

  // undo of an un-own: the owner row comes back with its own price and date, the volume date as it was before
  const undoUnown = (vol, data) => withVolumeLock(vol.id, async () => {
    const removed = data.removed_owner;
    const body = { owned: true, previous_purchase_date: data.previous_purchase_date ?? null };
    if (removed.purchase_date) body.purchase_date = removed.purchase_date;
    if (removed.price !== null && removed.price !== undefined) body.price = removed.price;
    if (String(removed.user_id) !== String(user?.id)) body.user_id = removed.user_id;
    try {
      const res = await apiFetch(`/api/volumes/${vol.id}/owners`, { method: 'POST', body });
      if (res.ok) await fetchManga();
      else await reportFailure(res, t(STATUS_FAILED));
    } catch (err) {
      notify.error(err);
    }
  });

  const handleToggleVolume = (vol) => {
    if (!canToggle) return undefined;
    return withVolumeLock(vol.id, async () => {
      const change = { ...ownedToggleChange(vol, user), volumeId: vol.id, mangaId: id };
      const data = await submitToggle(change, t(STATUS_FAILED));
      if (data?.removed_owner && change.kind === 'owned' && change.value === false) {
        notify.success(t('„{title}“ nicht mehr im Besitz', { title: getVolumeDisplayTitle(vol) }), {
          action: { label: t('Rückgängig'), onClick: () => undoUnown(vol, data) }
        });
      }
    });
  };

  const handleToggleVolumeRead = (vol, targetUserId, e) => {
    if (e) e.stopPropagation();
    if (!canToggle) return undefined;
    const effUserId = targetUserId || (selectedReaderId && selectedReaderId !== 'ALL' ? selectedReaderId : user?.id);
    // the server answers 403 for another user's id; never derive "read" from someone else's state and apply it to oneself
    if (!canToggleOthers && String(effUserId) !== String(user?.id)) {
      notify.error(t(READ_OTHERS_ADMIN_ONLY));
      return undefined;
    }
    const hasRead = hasUserRead(vol, effUserId, user?.id);
    const setRead = (read, readAt) => withVolumeLock(vol.id, () => submitToggle({
      kind: 'read', volumeId: vol.id, mangaId: id, targetUserId: effUserId, value: read, ...(read && readAt ? { read_at: readAt } : {})
    }, t(READ_FAILED)));
    // a pick of "today" stays "now" after midnight
    const pickedReadAt = hasRead || !readDate ? null : readAtForDate(readDate, readPick.on);
    return setRead(!hasRead, pickedReadAt).then((data) => {
      if (!data) return;
      const restoreAt = hasRead ? previousReadAt(data) : null;
      const undoable = !hasRead || restoreAt;
      const title = getVolumeDisplayTitle(vol);
      let text;
      if (hasRead) text = t('„{title}“ als ungelesen markiert', { title });
      else if (pickedReadAt) text = t('„{title}“ als gelesen markiert (gelesen am {date})', { title, date: formatDate(readDate) });
      else text = t('„{title}“ als gelesen markiert', { title });
      notify.success(text, undoable ? {
        action: { label: t('Rückgängig'), onClick: () => setRead(hasRead, restoreAt) }
      } : undefined);
    });
  };

  const bulkRef = useRef(false);

  /** Puts back what a bulk edit changed: the server keeps the old values under `undo_token`, one request sends it back. */
  const revertBulk = async (token) => {
    try {
      const res = await apiFetch('/api/volumes/bulk', { method: 'POST', body: { revert: token } });
      if (!res.ok && res.status !== 409) {
        await reportFailure(res, t('Rückgängig fehlgeschlagen'));
      } else {
        const data = (await readJson(res)) ?? {};
        const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
        const gone = Array.isArray(data.not_found) ? data.not_found.length : 0;
        if (conflicts.length) {
          notify.error(t('{volumes} nicht wiederhergestellt werden: {error}', { volumes: formatCount(conflicts.length, 'Band konnte', 'Bände konnten'), error: serverText(conflicts[0]) }));
        } else if (gone) {
          notify.info(tn('{volumes} inzwischen gelöscht und bleibt unverändert.', '{volumes} inzwischen gelöscht und bleiben unverändert.', gone, {
            volumes: formatCount(gone, 'Band wurde', 'Bände wurden')
          }));
        }
      }
    } catch (err) {
      notify.error(err);
    }
    await fetchManga();
  };

  /**
   * One request for many volumes (POST /api/volumes/bulk): `change` is { set } | { owners } | { read } | { delete: true }.
   * One refetch afterwards and a 10 s "Rückgängig" toast that sends the undo token back. Resolves to true on success.
   */
  const handleBulkEdit = async (ids, change, doneText) => {
    if (!canEdit || !ids?.length || bulkRef.current) return false;
    bulkRef.current = true;
    try {
      const res = await apiFetch('/api/volumes/bulk', { method: 'POST', body: { ids, ...change } });
      if (!res.ok) {
        await reportFailure(res, t('Sammelbearbeitung fehlgeschlagen'));
        return false;
      }
      const data = (await readJson(res)) ?? {};
      if (change.delete && data.ids?.some((volId) => String(volId) === String(activeVolume?.id))) setActiveVolume(null);
      await fetchManga();
      const token = typeof data.undo_token === 'string' && data.undo_token ? data.undo_token : null;
      const skippedCount = data.read_skipped?.length || 0;
      // `updated` counts every matched volume; a pure read change did nothing to the skipped ones
      const readOnly = change.read && !change.set && !change.owners;
      const changed = Math.max(0, (data.updated ?? ids.length) - (readOnly ? skippedCount : 0));
      // doneText ('als gelesen markiert' …) comes from the caller already translated (BulkActionBar runs t())
      const done = doneText;
      const volumes = formatCount(changed, 'Band', 'Bände');
      const text = skippedCount
        ? t('{volumes} {done} ({skipped} nicht im Besitz übersprungen)', { volumes, done, skipped: formatCount(skippedCount, 'Band', 'Bände') })
        : t('{volumes} {done}', { volumes, done });
      notify.success(text, token ? {
        duration: BULK_UNDO_MS,
        action: { label: t('Rückgängig'), onClick: () => revertBulk(token) }
      } : undefined);
      return true;
    } catch (err) {
      notify.error(err);
      return false;
    } finally {
      bulkRef.current = false;
    }
  };

  const handleOpenEditVolume = (vol, e) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    setActiveVolume(vol);
  };

  /** Accepts the volume or its id (the id is looked up in `volumes` for the dialog text). */
  const handleDeleteVolume = async (e, volOrId) => {
    if (e) e.stopPropagation();
    if (!canEdit || volOrId === undefined || volOrId === null) return;
    const vol = typeof volOrId === 'object'
      ? volOrId
      : (volumes || []).find(v => String(v.id) === String(volOrId))
        || (activeVolume && String(activeVolume.id) === String(volOrId) ? activeVolume : null);
    const volId = typeof volOrId === 'object' ? volOrId.id : volOrId;
    if (!confirm(volumeDeleteConfirmText(vol))) return;
    let res;
    try {
      res = await apiFetch(`/api/volumes/${volId}`, { method: 'DELETE' });
    } catch (err) {
      notify.error(err, { fallback: t('Netzwerkfehler beim Löschen des Bands') });
      return;
    }
    // 404 counts as done: the volume was already removed in another tab
    if (!res.ok && res.status !== 404) {
      await reportFailure(res, t('Fehler beim Löschen des Bands'));
      return;
    }
    if (String(activeVolume?.id) === String(volId)) setActiveVolume(null);
    await fetchManga();
    const trashId = res.ok ? (await readJson(res))?.trash_id : null;
    notifyTrashed(vol ? `„${getVolumeDisplayTitle(vol)}“` : null, trashId, () => fetchManga());
  };

  return {
    newVolumeType, setNewVolumeType, newVolumeNum, setNewVolumeNum, newVolumeStatus, setNewVolumeStatus,
    newVolumeReleaseDate, setNewVolumeReleaseDate, newVolumePrice, setNewVolumePrice,
    newVolumeCover, setNewVolumeCover: setNewVolumeCoverValue, uploadingNewCover, newVolumeIsbn, setNewVolumeIsbn,
    readDate, setReadDate,
    activeVolume, setActiveVolume, canToggleOthers,
    handleAddSingleVolume, handleUploadNewSingleCover, cancelNewCoverUpload,
    handleToggleVolume, handleToggleVolumeRead, handleOpenEditVolume, handleDeleteVolume, handleBulkEdit
  };
}
