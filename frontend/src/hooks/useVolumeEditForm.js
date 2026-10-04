import { useState, useEffect, useRef } from 'react';
import { applyLookupToForm } from '../utils/volumeFormHelpers';
import {
  buildEditorForm, readJsonSafe, isAbortError, validateVolumeForm, buildSaveBody, priceForQuery, isAllowedImageUrl,
  filterUploadFiles, chunk, addImages, removeImage, moveImage, deleteVolumeRequest, MAX_UPLOAD_FILES, FIELD_NAMES
} from '../components/detail/volumeEdit/editorUtils';
import { apiFetch, TIMEOUTS } from '../utils/api';
import { prepareImagesForUpload } from '../utils/imageResize';

/**
 * State and actions of the volume editor: form, photo upload / URL / ordering, Manga-Passion autofill, save and delete.
 * Mount it once per opened volume (VolumeEditModal keys it by id): requests still running when the editor closes are
 * aborted, so their results can never land in another volume's form.
 */
export default function useVolumeEditForm({ activeVolume, mangaId, canEdit, onClose, onSuccess }) {
  const [editVolForm, setEditVolForm] = useState(() => buildEditorForm(activeVolume));
  const [savingVol, setSavingVol] = useState(false);
  const [uploadingVolImage, setUploadingVolImage] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [manualImageUrl, setManualImageUrl] = useState('');
  const [autofillingVolume, setAutofillingVolume] = useState(false);
  const [autofillMessage, setAutofillMessage] = useState(null);
  const [photoError, setPhotoError] = useState(null);
  const [formError, setFormError] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [initialForm] = useState(editVolForm);
  // status as the server last stored it: the PUT only sends a status the user picked himself
  const serverStatusRef = useRef(editVolForm.status);
  // same for the purchase date, which an owner toggle can clear on the server while the editor is open
  const serverPurchaseDateRef = useRef(editVolForm.purchase_date ?? '');
  // latest committed form, for messages computed outside a state updater
  const formRef = useRef(editVolForm);
  formRef.current = editVolForm;

  const abortRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);
  const signal = () => abortRef.current?.signal;

  const fieldErrors = validateVolumeForm(editVolForm, initialForm);

  const handleUploadVolumeImages = async (files) => {
    if (!canEdit || !files || files.length === 0) return;
    setPhotoError(null);
    setUploadingVolImage(true);
    const { accepted, rejected } = filterUploadFiles(await prepareImagesForUpload(files));
    const problems = rejected.map(r => `${r.name} (${r.reason})`);
    let uploaded = 0;
    let failure = null;
    if (accepted.length === 0) setUploadingVolImage(false);
    if (accepted.length > 0) {
      try {
        for (const part of chunk(accepted, MAX_UPLOAD_FILES)) {
          const fd = new FormData();
          part.forEach(f => fd.append('images', f));
          const res = await apiFetch('/api/upload/multiple', { method: 'POST', body: fd, signal: signal() });
          const data = await readJsonSafe(res);
          if (!res.ok) {
            failure = data.error || `Fehler beim Hochladen der Bilder (HTTP ${res.status})`;
            break;
          }
          const urls = data.urls || [];
          uploaded += urls.length;
          // built from the current form state: photos removed or reordered during the upload must stay that way
          setEditVolForm(prev => addImages(prev, urls));
        }
      } catch (e) {
        if (isAbortError(e)) return;
        failure = 'Netzwerkfehler beim Bild-Upload';
      } finally {
        setUploadingVolImage(false);
      }
    }
    if (failure || problems.length > 0) {
      const parts = [];
      if (failure) parts.push(uploaded > 0 ? `${failure} (${uploaded} von ${accepted.length} Fotos hochgeladen)` : failure);
      if (problems.length > 0) parts.push(`Nicht hochgeladen: ${problems.join(', ')}`);
      setPhotoError({ text: parts.join('. ') });
    }
  };

  const addExternalImageUrl = (url) => {
    setEditVolForm(prev => addImages(prev, [url]));
    setPhotoError(null);
    setManualImageUrl('');
    setShowUrlInput(false);
  };

  const handleAddImageUrl = async () => {
    if (!canEdit || !manualImageUrl.trim()) return;
    const url = manualImageUrl.trim();
    setPhotoError(null);

    const mpMatch = url.match(/manga-passion\.de\/volumes\/(\d+)/i) || url.match(/^#?(\d{4,8})$/);
    if (mpMatch) {
      setShowUrlInput(false);
      setManualImageUrl('');
      await handleAutofillVolumeData({ url, mp_volume_id: mpMatch[1], force_cover: true });
      return;
    }

    if (!isAllowedImageUrl(url)) {
      setPhotoError({ text: 'Bitte eine Bild-URL mit http:// oder https:// eingeben.' });
      return;
    }
    if (url.startsWith('/uploads/')) {
      addExternalImageUrl(url);
      return;
    }

    let error;
    try {
      const upRes = await apiFetch('/api/upload-remote', {
        method: 'POST',
        body: { url },
        signal: signal(),
        timeout: TIMEOUTS.remote
      });
      const upData = await readJsonSafe(upRes);
      if (upRes.ok && upData.url) {
        setEditVolForm(prev => addImages(prev, [upData.url]));
        setManualImageUrl('');
        setShowUrlInput(false);
        return;
      }
      error = upData.error || `Bild konnte nicht geladen werden (HTTP ${upRes.status})`;
    } catch (e) {
      if (isAbortError(e)) return;
      error = 'Netzwerkfehler beim Laden des Bildes';
    }
    // the server cannot reach every host the browser can (LAN, hotlink protection): linking stays an explicit choice
    setPhotoError({ text: error, externalUrl: url });
  };

  const handleMoveVolumeImage = (fromIdx, toIdx) => {
    if (!canEdit) return;
    const url = (editVolForm.images || [])[fromIdx];
    if (!url) return;
    setEditVolForm(prev => moveImage(prev, url, toIdx - fromIdx));
  };

  const handleRemoveVolumeImage = (imgUrl) => {
    if (!canEdit) return;
    setEditVolForm(prev => removeImage(prev, imgUrl));
  };

  const handleSetVolumeCover = (imgUrl) => {
    if (!canEdit) return;
    setEditVolForm(prev => ({
      ...prev,
      cover_image: imgUrl
    }));
  };

  const handleAutofillVolumeData = async (extraOpts = {}) => {
    const form = formRef.current;
    const targetUrl = extraOpts.url || (manualImageUrl && manualImageUrl.includes('manga-passion.de') ? manualImageUrl.trim() : '');
    const mpVolId = extraOpts.mp_volume_id || '';
    if (!form.volume_number && !form.isbn && !targetUrl && !mpVolId) {
      setAutofillMessage({ type: 'warning', text: 'Bitte gib zuerst eine Band-Nummer, ISBN oder Manga Passion URL ein.' });
      return;
    }
    setAutofillingVolume(true);
    setAutofillMessage(null);
    try {
      const params = new URLSearchParams({
        manga_id: mangaId ?? '',
        volume_number: form.volume_number || '',
        isbn: form.isbn || '',
        type: form.type || '',
        notes: form.notes || '',
        price: priceForQuery(form.price),
        url: targetUrl || '',
        mp_volume_id: mpVolId || ''
      });
      const res = await apiFetch(`/api/volumes/lookup?${params}`, { signal: signal(), timeout: TIMEOUTS.lookup });
      const result = await readJsonSafe(res);

      if (res.ok && result.success && result.data) {
        const d = result.data;
        const opts = { forceCover: extraOpts.force_cover };
        const { updatedFields } = applyLookupToForm(formRef.current, d, opts);
        // merged into the state at commit time: an upload or removal queued meanwhile must survive
        setEditVolForm(prev => applyLookupToForm(prev, d, opts).next);
        const source = d.source || 'Manga Passion';
        setAutofillMessage(updatedFields.length > 0
          ? { type: 'success', text: `Erfolgreich von ${source} ausgefüllt: ${updatedFields.join(', ')}!` }
          : { type: 'info', text: `Alle Daten von ${source} stimmen bereits mit deinen Eingaben überein.` });
      } else if (!res.ok) {
        setAutofillMessage({
          type: 'warning',
          text: result.error || result.message || `Fehler beim Abrufen der Metadaten (HTTP ${res.status}).`
        });
      } else {
        setAutofillMessage({
          type: 'warning',
          text: result.message || `Keine Daten für "${form.volume_number || targetUrl}" auf Manga Passion gefunden.`
        });
      }
    } catch (err) {
      if (isAbortError(err)) return;
      setAutofillMessage({ type: 'warning', text: 'Fehler beim Abrufen der Metadaten.' });
    } finally {
      setAutofillingVolume(false);
    }
  };

  /** Result of an immediate owner toggle (POST /owners): the server derived a new status from the owners. */
  const handleOwnersChanged = (data) => {
    if (data?.status) {
      serverStatusRef.current = data.status;
      // the server already stored this status, so it also replaces a status the user had picked before the toggle
      setEditVolForm(prev => ({ ...prev, status: data.status }));
    }
    // without owners the server dropped the purchase date; a date the user typed meanwhile stays his
    const serverDate = typeof data?.purchase_date === 'string' || data?.purchase_date === null
      ? (data.purchase_date ?? '')
      : (Array.isArray(data?.owners) && data.owners.length === 0 ? '' : null);
    if (serverDate !== null) {
      const before = serverPurchaseDateRef.current;
      serverPurchaseDateRef.current = serverDate;
      setEditVolForm(prev => ((prev.purchase_date ?? '') === before ? { ...prev, purchase_date: serverDate } : prev));
    }
    if (onSuccess) onSuccess();
  };

  /** PUT body: status and purchase date only when the user changed them, so a value the server set meanwhile stays. */
  const saveBody = () => {
    const body = buildSaveBody(editVolForm, serverStatusRef.current);
    if ((body.purchase_date ?? '') === serverPurchaseDateRef.current) delete body.purchase_date;
    return body;
  };

  const handleSaveVolume = async (e) => {
    e.preventDefault();
    if (!canEdit || !activeVolume || savingVol) return;
    const errors = validateVolumeForm(editVolForm, initialForm);
    const invalid = Object.keys(errors);
    if (invalid.length > 0) {
      setShowErrors(true);
      setFormError(`Bitte prüfen: ${invalid.map(k => FIELD_NAMES[k] || k).join(', ')}`);
      return;
    }
    setFormError('');
    setSavingVol(true);
    try {
      const res = await apiFetch(`/api/volumes/${activeVolume.id}`, {
        method: 'PUT',
        body: saveBody(),
        signal: signal()
      });
      if (res.ok) {
        onClose();
        if (onSuccess) await onSuccess();
        return;
      }
      const err = await readJsonSafe(res);
      setFormError(err.error || `Fehler beim Speichern des Bands (HTTP ${res.status})`);
    } catch (err) {
      if (isAbortError(err)) return;
      setFormError('Netzwerkfehler beim Speichern');
    } finally {
      setSavingVol(false);
    }
  };

  const handleDeleteVolume = async (e, volId) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    if (!confirm('Band wirklich entfernen?')) return;
    setFormError('');
    const result = await deleteVolumeRequest(volId, { signal: signal() });
    if (result.aborted) return;
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    onClose();
    if (onSuccess) await onSuccess();
  };

  return {
    editVolForm,
    setEditVolForm,
    savingVol,
    uploadingVolImage,
    showUrlInput,
    setShowUrlInput,
    manualImageUrl,
    setManualImageUrl,
    autofillingVolume,
    autofillMessage,
    setAutofillMessage,
    photoError,
    setPhotoError,
    formError,
    fieldErrors,
    showErrors,
    addExternalImageUrl,
    handleUploadVolumeImages,
    handleAddImageUrl,
    handleMoveVolumeImage,
    handleRemoveVolumeImage,
    handleSetVolumeCover,
    handleAutofillVolumeData,
    handleOwnersChanged,
    handleSaveVolume,
    handleDeleteVolume
  };
}
