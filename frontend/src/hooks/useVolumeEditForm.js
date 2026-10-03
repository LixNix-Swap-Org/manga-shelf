import { useState, useEffect, useRef } from 'react';
import { buildVolumeForm, applyLookupToForm } from '../utils/volumeFormHelpers';

/** State and actions of the volume editor: form, photo upload / URL / ordering, Manga-Passion autofill, save and delete. */
export default function useVolumeEditForm({ activeVolume, mangaId, canEdit, onClose, onSuccess }) {
  const [editVolForm, setEditVolForm] = useState({});
  const [savingVol, setSavingVol] = useState(false);
  const [uploadingVolImage, setUploadingVolImage] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [manualImageUrl, setManualImageUrl] = useState('');
  const [autofillingVolume, setAutofillingVolume] = useState(false);
  const [autofillMessage, setAutofillMessage] = useState(null);
  // latest form for async results (autofill) that must merge into what the user has typed meanwhile
  const formRef = useRef(editVolForm);
  formRef.current = editVolForm;

  useEffect(() => {
    if (activeVolume) {
      setEditVolForm(buildVolumeForm(activeVolume));
      setShowUrlInput(false);
      setManualImageUrl('');
      setAutofillMessage(null);
      setAutofillingVolume(false);
    }
  }, [activeVolume]);

  const handleUploadVolumeImages = async (files) => {
    if (!canEdit || !files || files.length === 0) return;
    setUploadingVolImage(true);
    try {
      const fd = new FormData();
      if (files.length === 1) {
        fd.append('image', files[0]);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          const currentImages = editVolForm.images || [];
          const newImages = [...currentImages, data.url];
          setEditVolForm(prev => ({
            ...prev,
            images: newImages,
            cover_image: prev.cover_image || data.url
          }));
        } else {
          const err = await res.json();
          alert(err.error || 'Fehler beim Hochladen des Bildes');
        }
      } else {
        for (let i = 0; i < files.length; i++) {
          fd.append('images', files[i]);
        }
        const res = await fetch('/api/upload/multiple', { method: 'POST', body: fd });
        if (res.ok) {
          const data = await res.json();
          const currentImages = editVolForm.images || [];
          const newImages = [...currentImages, ...(data.urls || [])];
          setEditVolForm(prev => ({
            ...prev,
            images: newImages,
            cover_image: prev.cover_image || (data.urls && data.urls[0]) || ''
          }));
        } else {
          const err = await res.json();
          alert(err.error || 'Fehler beim Hochladen der Bilder');
        }
      }
    } catch (e) {
      console.error(e);
      alert('Netzwerkfehler beim Bild-Upload');
    } finally {
      setUploadingVolImage(false);
    }
  };

  const handleAddImageUrl = async () => {
    if (!canEdit || !manualImageUrl.trim()) return;
    const url = manualImageUrl.trim();

    const mpMatch = url.match(/manga-passion\.de\/volumes\/(\d+)/i) || url.match(/^#?(\d{4,8})$/);
    if (mpMatch) {
      setShowUrlInput(false);
      setManualImageUrl('');
      await handleAutofillVolumeData({ url, mp_volume_id: mpMatch[1], force_cover: true });
      return;
    }

    try {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        const upRes = await fetch('/api/upload-remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        if (upRes.ok) {
          const upData = await upRes.json();
          if (upData.url) {
            const currentImages = editVolForm.images || [];
            setEditVolForm(prev => ({
              ...prev,
              images: [upData.url, ...currentImages.filter(u => u !== upData.url)],
              cover_image: upData.url
            }));
            setManualImageUrl('');
            setShowUrlInput(false);
            return;
          }
        }
      }
    } catch (_) {}

    const currentImages = editVolForm.images || [];
    setEditVolForm(prev => ({
      ...prev,
      images: [...currentImages, url],
      cover_image: prev.cover_image || url
    }));
    setManualImageUrl('');
    setShowUrlInput(false);
  };

  const handleMoveVolumeImage = (fromIdx, toIdx) => {
    if (!canEdit || !editVolForm.images) return;
    const imgs = [...editVolForm.images];
    if (toIdx < 0 || toIdx >= imgs.length) return;
    const [moved] = imgs.splice(fromIdx, 1);
    imgs.splice(toIdx, 0, moved);
    setEditVolForm(prev => ({
      ...prev,
      images: imgs
    }));
  };

  const handleRemoveVolumeImage = (imgUrl) => {
    if (!canEdit) return;
    const nextImages = (editVolForm.images || []).filter(u => u !== imgUrl);
    let nextCover = editVolForm.cover_image;
    if (nextCover === imgUrl) {
      nextCover = nextImages.length > 0 ? nextImages[0] : '';
    }
    setEditVolForm(prev => ({
      ...prev,
      images: nextImages,
      cover_image: nextCover
    }));
  };

  const handleSetVolumeCover = (imgUrl) => {
    if (!canEdit) return;
    setEditVolForm(prev => ({
      ...prev,
      cover_image: imgUrl
    }));
  };

  const handleAutofillVolumeData = async (extraOpts = {}) => {
    const targetUrl = extraOpts.url || (manualImageUrl && manualImageUrl.includes('manga-passion.de') ? manualImageUrl.trim() : '');
    const mpVolId = extraOpts.mp_volume_id || '';
    if (!editVolForm.volume_number && !editVolForm.isbn && !targetUrl && !mpVolId) {
      setAutofillMessage({ type: 'warning', text: 'Bitte gib zuerst eine Band-Nummer, ISBN oder Manga Passion URL ein.' });
      return;
    }
    setAutofillingVolume(true);
    setAutofillMessage(null);
    try {
      const qNum = encodeURIComponent(editVolForm.volume_number || '');
      const qIsbn = encodeURIComponent(editVolForm.isbn || '');
      const qType = encodeURIComponent(editVolForm.type || '');
      const qNotes = encodeURIComponent(editVolForm.notes || '');
      const qPrice = encodeURIComponent(editVolForm.price || '');
      const qUrl = encodeURIComponent(targetUrl || '');
      const qMpId = encodeURIComponent(mpVolId || '');

      const res = await fetch(`/api/volumes/lookup?manga_id=${mangaId}&volume_number=${qNum}&isbn=${qIsbn}&type=${qType}&notes=${qNotes}&price=${qPrice}&url=${qUrl}&mp_volume_id=${qMpId}`);
      const result = await res.json();

      if (res.ok && result.success && result.data) {
        const d = result.data;
        // merge into the latest form (the user may have typed while the lookup ran)
        const merged = applyLookupToForm(formRef.current, d, { forceCover: extraOpts.force_cover });
        const updatedFields = merged.updatedFields;
        setEditVolForm(merged.next);

        if (updatedFields.length > 0) {
          setAutofillMessage({
            type: 'success',
            text: `Erfolgreich von ${result.data.source || 'Manga Passion'} ausgefüllt: ${updatedFields.join(', ')}!`
          });
        } else {
          setAutofillMessage({
            type: 'info',
            text: `Alle Daten von ${result.data.source || 'Manga Passion'} stimmen bereits mit deinen Eingaben überein.`
          });
        }
      } else {
        setAutofillMessage({
          type: 'warning',
          text: result.message || `Keine Daten für "${editVolForm.volume_number || targetUrl}" auf Manga Passion gefunden.`
        });
      }
    } catch (err) {
      setAutofillMessage({ type: 'warning', text: 'Fehler beim Abrufen der Metadaten.' });
    } finally {
      setAutofillingVolume(false);
    }
  };

  const handleSaveVolume = async (e) => {
    e.preventDefault();
    if (!canEdit || !activeVolume) return;
    setSavingVol(true);
    try {
      const res = await fetch(`/api/volumes/${activeVolume.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editVolForm)
      });
      if (res.ok) {
        onClose();
        if (onSuccess) await onSuccess();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Speichern des Bands');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setSavingVol(false);
    }
  };

  const handleDeleteVolume = async (e, volId) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    if (!confirm('Band wirklich entfernen?')) return;
    try {
      const res = await fetch(`/api/volumes/${volId}`, { method: 'DELETE' });
      if (res.ok) {
        onClose();
        if (onSuccess) await onSuccess();
      }
    } catch (err) {
      console.error(err);
    }
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
    handleUploadVolumeImages,
    handleAddImageUrl,
    handleMoveVolumeImage,
    handleRemoveVolumeImage,
    handleSetVolumeCover,
    handleAutofillVolumeData,
    handleSaveVolume,
    handleDeleteVolume
  };
}
