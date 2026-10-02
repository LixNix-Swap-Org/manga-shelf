import { useState, useRef } from 'react';
import { hasUserRead } from '../utils/volumeHelpers';

/** Per-volume actions: add a single volume, toggle owned/read, open the editor, delete. */
export default function useVolumeActions({ id, user, canEdit, selectedReaderId, fetchManga }) {
  // Single volume add state
  const [newVolumeType, setNewVolumeType] = useState('volume'); // 'volume' | 'special_edition' | 'schuber' | 'special'
  const [newVolumeNum, setNewVolumeNum] = useState('');
  const [newVolumeStatus, setNewVolumeStatus] = useState('Vorhanden');
  const [newVolumeReleaseDate, setNewVolumeReleaseDate] = useState('');
  const [newVolumePrice, setNewVolumePrice] = useState('');
  const [newVolumePublisher, setNewVolumePublisher] = useState('');
  const [newVolumeCover, setNewVolumeCover] = useState('');
  const [uploadingNewCover, setUploadingNewCover] = useState(false);

  // Volume Detail & Edit Modal
  const [activeVolume, setActiveVolume] = useState(null);

  const addingVolumeRef = useRef(false);
  const handleAddSingleVolume = async (e) => {
    e.preventDefault();
    if (!canEdit || !newVolumeNum.trim() || addingVolumeRef.current) return; // a double click must not add it twice
    addingVolumeRef.current = true;

    try {
      const res = await fetch('/api/volumes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: id,
          type: newVolumeType,
          volume_number: newVolumeNum.trim(),
          status: newVolumeStatus,
          release_date: newVolumeReleaseDate ? newVolumeReleaseDate.trim() : null,
          price: newVolumePrice ? newVolumePrice.trim() : null,
          publisher: newVolumePublisher ? newVolumePublisher.trim() : null,
          cover_image: newVolumeCover || null,
          images: newVolumeCover ? [newVolumeCover] : []
        })
      });
      if (res.ok) {
        setNewVolumeNum('');
        setNewVolumePrice('');
        setNewVolumeReleaseDate('');
        setNewVolumePublisher('');
        setNewVolumeCover('');
        setNewVolumeType('volume');
        await fetchManga();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Hinzufügen');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      addingVolumeRef.current = false;
    }
  };

  const handleUploadNewSingleCover = async (file) => {
    if (!canEdit || !file) return;
    setUploadingNewCover(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        setNewVolumeCover(data.url);
      } else {
        alert('Fehler beim Hochladen');
      }
    } catch (e) {
      alert('Upload-Fehler');
    } finally {
      setUploadingNewCover(false);
    }
  };

  const handleToggleVolume = async (vol) => {
    if (!canEdit) return;
    let nextStatus = 'Vorhanden';
    let purchaseDate = vol.purchase_date;
    if (vol.status === 'Vorhanden') {
      nextStatus = 'Fehlt';
    } else {
      nextStatus = 'Vorhanden';
      if (!purchaseDate) {
        purchaseDate = new Date().toISOString().split('T')[0];
      }
    }
    try {
      const res = await fetch(`/api/volumes/${vol.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...vol, status: nextStatus, purchase_date: purchaseDate })
      });
      if (res.ok) {
        await fetchManga();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleVolumeRead = async (vol, targetUserId, e) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    const effUserId = targetUserId || (selectedReaderId !== 'ALL' ? selectedReaderId : user?.id);
    const hasRead = hasUserRead(vol, effUserId, user?.id);
    try {
      const res = await fetch(`/api/volumes/${vol.id}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: effUserId,
          read: !hasRead,
          is_read: !hasRead
        })
      });
      if (res.ok) {
        await fetchManga();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Aktualisieren des Lesestatus');
      }
    } catch (err) {
      console.error(err);
      alert('Netzwerkfehler');
    }
  };

  const handleOpenEditVolume = (vol, e) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    setActiveVolume(vol);
  };

  const handleDeleteVolume = async (e, volId) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    if (!confirm('Band wirklich entfernen?')) return;
    try {
      const res = await fetch(`/api/volumes/${volId}`, { method: 'DELETE' });
      if (res.ok) {
        if (activeVolume?.id === volId) setActiveVolume(null);
        await fetchManga();
      }
    } catch (err) {
      console.error(err);
    }
  };

  return {
    newVolumeType, setNewVolumeType, newVolumeNum, setNewVolumeNum, newVolumeStatus, setNewVolumeStatus,
    newVolumeReleaseDate, setNewVolumeReleaseDate, newVolumePrice, setNewVolumePrice,
    newVolumePublisher, setNewVolumePublisher, newVolumeCover, setNewVolumeCover, uploadingNewCover,
    activeVolume, setActiveVolume,
    handleAddSingleVolume, handleUploadNewSingleCover,
    handleToggleVolume, handleToggleVolumeRead, handleOpenEditVolume, handleDeleteVolume
  };
}
