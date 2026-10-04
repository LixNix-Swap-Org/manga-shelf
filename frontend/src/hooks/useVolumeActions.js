import { useState, useRef } from 'react';
import { hasUserRead, getVolumeDisplayTitle } from '../utils/volumeHelpers';
import { deleteVolumeRequest } from '../components/detail/volumeEdit/editorUtils';
import { apiFetch, errorFromResponse, readJson, sessionEndAnnounced, isAbortError } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import { formatCount } from '../utils/format';
import { prepareImageForUpload } from '../utils/imageResize';
import { submitChange, applyChangeToCaches } from '../utils/outbox';
import { applyVolumeChange } from '../utils/volumePatch';

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
  const name = vol ? `"${getVolumeDisplayTitle(vol)}"` : 'Diesen Band';
  return `${name} wirklich entfernen? Der Lesestatus aller Benutzer für diesen Band wird ebenfalls gelöscht.`;
}

export const READ_OTHERS_ADMIN_ONLY = 'Nur Admins können den Lesestatus anderer Benutzer ändern.';
export const UNAUTHORIZED_TEXT = 'Nicht autorisiert (HTTP 401) – bitte die Seite neu laden oder neu anmelden.';
export const QUEUED_TEXT = 'Keine Verbindung – die Änderung ist vorgemerkt und wird automatisch übertragen.';
export const UPLOAD_CANCELLED = 'Upload abgebrochen';
const NOT_STORED_TEXT = 'Keine Verbindung, und die Änderung ließ sich auf diesem Gerät nicht speichern (Speicher voll oder gesperrt).';
const READ_FAILED = 'Fehler beim Aktualisieren des Lesestatus';
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
// below the server's 100 kB JSON limit: a large undo (deleted volumes with notes and photos) goes in several requests
const REVERT_CHUNK_CHARS = 90000;

/** Splits the `previous` list of a bulk answer into requests whose JSON stays below `maxChars`. */
export function chunkRevert(previous, maxChars = REVERT_CHUNK_CHARS) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const entry of previous || []) {
    const length = JSON.stringify(entry).length + 1;
    if (current.length && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * The outbox change of a click on the owned toggle: { kind, value, purchase_date? }.
 * With owners it switches the user's own ownership; without, a missing volume becomes the user's own and an owned one
 * without owners (old data) goes back to 'Fehlt'.
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
 * Per-volume actions: add a single volume, toggle owned/read, open the editor, delete. Toggles go through the outbox:
 * applied at once (patchManga, when the page passes it, and the cached copies), sent now or replayed later.
 * `canToggle` (default canEdit) gates only the owned/read toggles: an editor in offline mode may queue them.
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
  const [uploadingNewCover, setUploadingNewCover] = useState(false);

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
      else notify.error(UNAUTHORIZED_TEXT);
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
      else notify.info(QUEUED_TEXT);
      // offline: the patched offline copy (once written); online without answer: patchManga already shows the change
      if (offline) {
        await cached;
        await fetchManga();
      }
      return null;
    }
    if (res) await reportFailure(res, fallback);
    else if (result.reason === 'storage') notify.error(NOT_STORED_TEXT);
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
          images: newVolumeCover ? [newVolumeCover] : []
        }
      });
      if (res.ok) {
        setNewVolumeNum('');
        setNewVolumePrice('');
        setNewVolumeReleaseDate('');
        setNewVolumeCoverValue('');
        setNewVolumeType('volume');
        await fetchManga();
      } else {
        await reportFailure(res, 'Fehler beim Hinzufügen');
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
        if (!data?.url) throw new Error('Antwort ohne Bild-URL');
        if (current()) setNewVolumeCover(data.url);
      } else if (current()) {
        await reportFailure(res, 'Fehler beim Hochladen');
      }
    } catch (e) {
      if (isAbortError(e)) {
        if (uploadId === latestUploadRef.current) notify.info(UPLOAD_CANCELLED);
      } else if (current()) {
        notify.error(e, { fallback: 'Upload-Fehler' });
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
      else await reportFailure(res, STATUS_FAILED);
    } catch (err) {
      notify.error(err);
    }
  });

  const handleToggleVolume = (vol) => {
    if (!canToggle) return undefined;
    return withVolumeLock(vol.id, async () => {
      const change = { ...ownedToggleChange(vol, user), volumeId: vol.id, mangaId: id };
      const data = await submitToggle(change, STATUS_FAILED);
      if (data?.removed_owner && change.kind === 'owned' && change.value === false) {
        notify.success(`„${getVolumeDisplayTitle(vol)}“ nicht mehr im Besitz`, {
          action: { label: 'Rückgängig', onClick: () => undoUnown(vol, data) }
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
      notify.error(READ_OTHERS_ADMIN_ONLY);
      return undefined;
    }
    const hasRead = hasUserRead(vol, effUserId, user?.id);
    const setRead = (read, readAt) => withVolumeLock(vol.id, () => submitToggle({
      kind: 'read', volumeId: vol.id, mangaId: id, targetUserId: effUserId, value: read, ...(read && readAt ? { read_at: readAt } : {})
    }, READ_FAILED));
    return setRead(!hasRead).then((data) => {
      if (!data) return;
      const restoreAt = hasRead ? previousReadAt(data) : null;
      const undoable = !hasRead || restoreAt;
      notify.success(`„${getVolumeDisplayTitle(vol)}“ als ${hasRead ? 'ungelesen' : 'gelesen'} markiert`, undoable ? {
        action: { label: 'Rückgängig', onClick: () => setRead(hasRead, restoreAt) }
      } : undefined);
    });
  };

  const bulkRef = useRef(false);

  /** Puts back what a bulk edit changed (its `previous`); deleted volumes whose number was taken again are reported. */
  const revertBulk = async (previous) => {
    const conflicts = [];
    try {
      for (const chunk of chunkRevert(previous)) {
        const res = await apiFetch('/api/volumes/bulk', { method: 'POST', body: { revert: chunk } });
        const data = await readJson(res);
        if (Array.isArray(data?.conflicts)) conflicts.push(...data.conflicts);
        if (!res.ok && res.status !== 409) {
          await reportFailure(res, 'Rückgängig fehlgeschlagen');
          break;
        }
      }
    } catch (err) {
      notify.error(err);
    }
    if (conflicts.length) {
      notify.error(`${formatCount(conflicts.length, 'Band konnte', 'Bände konnten')} nicht wiederhergestellt werden: ${conflicts[0].error}`);
    }
    await fetchManga();
  };

  /**
   * One request for many volumes (POST /api/volumes/bulk): `change` is { set } | { owners } | { read } | { delete: true }.
   * One refetch afterwards and a 10 s "Rückgängig" toast that sends the previous values back. Resolves to true on success.
   */
  const handleBulkEdit = async (ids, change, doneText) => {
    if (!canEdit || !ids?.length || bulkRef.current) return false;
    bulkRef.current = true;
    try {
      const res = await apiFetch('/api/volumes/bulk', { method: 'POST', body: { ids, ...change } });
      if (!res.ok) {
        await reportFailure(res, 'Sammelbearbeitung fehlgeschlagen');
        return false;
      }
      const data = (await readJson(res)) ?? {};
      if (change.delete && data.ids?.some((volId) => String(volId) === String(activeVolume?.id))) setActiveVolume(null);
      await fetchManga();
      const previous = Array.isArray(data.previous) ? data.previous : [];
      const skipped = data.read_skipped?.length ? ` (${formatCount(data.read_skipped.length, 'Band', 'Bände')} nicht im Besitz übersprungen)` : '';
      notify.success(`${formatCount(data.updated ?? ids.length, 'Band', 'Bände')} ${doneText}${skipped}`, previous.length ? {
        duration: BULK_UNDO_MS,
        action: { label: 'Rückgängig', onClick: () => revertBulk(previous) }
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
    // 404 counts as done: the volume was already removed in another tab
    const result = await deleteVolumeRequest(volId);
    if (result.ok) {
      if (String(activeVolume?.id) === String(volId)) setActiveVolume(null);
      await fetchManga();
    } else if (!result.aborted) {
      notify.error(result.error);
    }
  };

  return {
    newVolumeType, setNewVolumeType, newVolumeNum, setNewVolumeNum, newVolumeStatus, setNewVolumeStatus,
    newVolumeReleaseDate, setNewVolumeReleaseDate, newVolumePrice, setNewVolumePrice,
    newVolumeCover, setNewVolumeCover: setNewVolumeCoverValue, uploadingNewCover,
    activeVolume, setActiveVolume, canToggleOthers,
    handleAddSingleVolume, handleUploadNewSingleCover, cancelNewCoverUpload,
    handleToggleVolume, handleToggleVolumeRead, handleOpenEditVolume, handleDeleteVolume, handleBulkEdit
  };
}
