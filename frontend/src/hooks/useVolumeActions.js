import { useState, useRef } from 'react';
import { hasUserRead, getVolumeDisplayTitle } from '../utils/volumeHelpers';
import { deleteVolumeRequest } from '../components/detail/volumeEdit/editorUtils';
import { apiFetch, errorFromResponse, readJson } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import { prepareImageForUpload } from '../utils/imageResize';

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
const READ_FAILED = 'Fehler beim Aktualisieren des Lesestatus';

const postRead = (volumeId, userId, read, readAt) => apiFetch(`/api/volumes/${volumeId}/read`, {
  method: 'POST',
  body: { user_id: userId, read, is_read: read, ...(read && readAt ? { read_at: readAt } : {}) }
});

/**
 * Undo of "ungelesen" puts the read back with its original date, which the server reports as previous_read_at.
 * Without it the undo would rewrite the reading history with today's date, so none is offered.
 */
export const previousReadAt = (data) => (typeof data?.previous_read_at === 'string' && data.previous_read_at
  ? data.previous_read_at
  : null);

/** Per-volume actions: add a single volume, toggle owned/read, open the editor, delete. */
export default function useVolumeActions({ id, user, canEdit, selectedReaderId, fetchManga, volumes, onUnauthorized }) {
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

  const reportFailure = async (res, fallback) => {
    if (res.status === 401 && onUnauthorized) {
      onUnauthorized();
      return;
    }
    await notifyResponseError(res, fallback);
    // the volume was deleted elsewhere: drop the stale card
    if (res.status === 404) await fetchManga();
  };

  const addingVolumeRef = useRef(false);
  const uploadingRef = useRef(false);
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
    uploadingRef.current = true;
    setUploadingNewCover(true);
    try {
      const fd = new FormData();
      fd.append('image', await prepareImageForUpload(file));
      const res = await apiFetch('/api/upload', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await readJson(res);
        if (!data?.url) throw new Error('Antwort ohne Bild-URL');
        if (current()) setNewVolumeCover(data.url);
      } else if (current()) {
        await reportFailure(res, 'Fehler beim Hochladen');
      }
    } catch (e) {
      if (current()) notify.error(e, { fallback: 'Upload-Fehler' });
    } finally {
      if (uploadId === latestUploadRef.current) {
        uploadingRef.current = false;
        setUploadingNewCover(false);
      }
    }
  };

  const handleToggleVolume = (vol) => {
    if (!canEdit) return undefined;
    return withVolumeLock(vol.id, async () => {
      try {
        let res;
        const postOwners = (body) => apiFetch(`/api/volumes/${vol.id}/owners`, { method: 'POST', body });
        // Hat der Band schon Besitzer, schaltet der Klick nur den eigenen Besitz um (Mehrbenutzer-Besitz)
        if (vol.status === 'Vorhanden' && Array.isArray(vol.owners) && vol.owners.length > 0) {
          res = await postOwners(typeof vol.owned_by_me === 'boolean' ? { owned: !vol.owned_by_me } : {});
        } else if (vol.status !== 'Vorhanden') {
          // own ownership, not a status write: someone may have bought it meanwhile, their date stays theirs
          const hasOwners = Array.isArray(vol.owners) && vol.owners.length > 0;
          res = await postOwners(hasOwners && vol.purchase_date ? { owned: true } : { owned: true, purchase_date: localDateString() });
        } else {
          res = await apiFetch(`/api/volumes/${vol.id}`, { method: 'PUT', body: { status: 'Fehlt' } });
        }
        if (res.ok) await fetchManga();
        else await reportFailure(res, 'Fehler beim Ändern des Status');
      } catch (err) {
        console.error(err);
        notify.error(err);
      }
    });
  };

  const handleToggleVolumeRead = (vol, targetUserId, e) => {
    if (e) e.stopPropagation();
    if (!canEdit) return undefined;
    const effUserId = targetUserId || (selectedReaderId && selectedReaderId !== 'ALL' ? selectedReaderId : user?.id);
    // the server answers 403 for another user's id; never derive "read" from someone else's state and apply it to oneself
    if (!canToggleOthers && String(effUserId) !== String(user?.id)) {
      notify.error(READ_OTHERS_ADMIN_ONLY);
      return undefined;
    }
    const hasRead = hasUserRead(vol, effUserId, user?.id);
    const setRead = (read, readAt) => withVolumeLock(vol.id, async () => {
      try {
        const res = await postRead(vol.id, effUserId, read, readAt);
        if (!res.ok) {
          await reportFailure(res, READ_FAILED);
          return null;
        }
        const data = (await readJson(res)) ?? {};
        await fetchManga();
        return data;
      } catch (err) {
        console.error(err);
        notify.error(err);
        return null;
      }
    });
    return setRead(!hasRead).then((data) => {
      if (!data) return;
      const restoreAt = hasRead ? previousReadAt(data) : null;
      const undoable = !hasRead || restoreAt;
      notify.success(`„${getVolumeDisplayTitle(vol)}“ als ${hasRead ? 'ungelesen' : 'gelesen'} markiert`, undoable ? {
        action: { label: 'Rückgängig', onClick: () => setRead(hasRead, restoreAt) }
      } : undefined);
    });
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
    handleAddSingleVolume, handleUploadNewSingleCover,
    handleToggleVolume, handleToggleVolumeRead, handleOpenEditVolume, handleDeleteVolume
  };
}
