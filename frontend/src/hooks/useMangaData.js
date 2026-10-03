import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadMangaDetail, updateCachedManga } from '../utils/offlineStore';

/** Loads one manga (server, else the offline copy) and owns its edit form, cover upload and Manga-Passion metadata lookup. */
export default function useMangaData({ id, user, canEdit }) {
  const navigate = useNavigate();

  const [manga, setManga] = useState(null);
  const [loading, setLoading] = useState(true);
  const loadedIdRef = useRef(null); // the series shown right now: reloads after an action keep the page (no spinner, scroll stays)
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [formData, setFormData] = useState({});
  const [uploadingCover, setUploadingCover] = useState(false);
  const [failedCover, setFailedCover] = useState(false);

  // Edit Manga Auto-Fill state (Manga Passion First)
  const [editLookingUp, setEditLookingUp] = useState(false);
  const [editLookupResults, setEditLookupResults] = useState(null);
  const [editLookupError, setEditLookupError] = useState('');

  const handleEditLookup = async () => {
    if (!formData.title.trim()) {
      setEditLookupError('Bitte gib zuerst einen Titel ein.');
      return;
    }
    setEditLookingUp(true);
    setEditLookupError('');
    setEditLookupResults(null);
    try {
      const res = await fetch(`/api/lookup/manga?q=${encodeURIComponent(formData.title.trim())}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          if (data.length === 1) {
            await applyEditLookupResult(data[0]);
          } else {
            setEditLookupResults(data);
          }
        } else {
          setEditLookupError('Keine Treffer gefunden.');
        }
      } else {
        const err = await res.json();
        setEditLookupError(err.error || 'Fehler bei der Suche');
      }
    } catch (e) {
      setEditLookupError('Netzwerkfehler');
    } finally {
      setEditLookingUp(false);
    }
  };

  const applyEditLookupResult = async (item) => {
    let localCoverUrl = item.cover_image;
    if (item.cover_image && item.cover_image.startsWith('http')) {
      try {
        const upRes = await fetch('/api/upload-remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.cover_image })
        });
        if (upRes.ok) {
          const upData = await upRes.json();
          if (upData.url) localCoverUrl = upData.url;
        }
      } catch (e) {
        console.warn('Could not cache remote cover locally, using remote URL:', e);
      }
    }

    setFormData(prev => ({
      ...prev,
      title: item.title || prev.title,
      alt_title: item.alt_title || prev.alt_title,
      author: item.author || prev.author,
      publisher: item.publisher || prev.publisher,
      status: item.status || prev.status,
      total_volumes: item.total_volumes ? String(item.total_volumes) : prev.total_volumes,
      description: item.description || prev.description,
      cover_image: localCoverUrl || prev.cover_image,
      manga_passion_id: item.manga_passion_id || prev.manga_passion_id
    }));
    setEditLookupResults(null);
    setEditLookupError('');
  };

  const applyMangaData = (data) => {
    loadedIdRef.current = id;
    setManga(data);
    setFormData({
      title: data.title || '',
      alt_title: data.alt_title || '',
      author: data.author || '',
      publisher: data.publisher || '',
      language: data.language || 'Deutsch',
      status: data.status || 'Laufend',
      tags: data.tags || '',
      total_volumes: data.total_volumes || '',
      description: data.description || '',
      cover_image: data.cover_image || '',
      manga_passion_id: data.manga_passion_id || null
    });
  };

  const fetchManga = async () => {
    try {
      if (loadedIdRef.current !== id) setLoading(true);
      setNotFound(false);
      if (!user?.offline) {
        try {
          const res = await fetch(`/api/mangas/${id}`);
          if (res.ok) {
            const data = await res.json();
            applyMangaData(data);
            updateCachedManga(data);
            return;
          }
          // 404 or any server error - show not found
          setNotFound(true);
          return;
        } catch (e) {
          // server unreachable: show the read-only offline copy if we have one
          console.warn('Manga fetch failed, trying offline copy:', e);
        }
      }
      const cached = await loadMangaDetail(id);
      if (cached) applyMangaData(cached);
      else setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/mangas/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        setEditing(false);
        await fetchManga();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Speichern');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteManga = async () => {
    if (!canEdit) return;
    if (!confirm(`Möchtest du "${manga.title}" wirklich dauerhaft löschen?`)) return;
    try {
      const res = await fetch(`/api/mangas/${id}`, { method: 'DELETE' });
      if (res.ok) {
        navigate('/');
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Löschen');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    }
  };

  const handleCoverUpload = async (e) => {
    if (!canEdit) return;
    const file = e.target.files[0];
    if (!file) return;

    setUploadingCover(true);
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (res.ok) {
        const data = await res.json();
        const saveRes = await fetch(`/api/mangas/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cover_image: data.url })
        });
        if (!saveRes.ok) {
          const saveErr = await saveRes.json().catch(() => ({}));
          alert(saveErr.error || 'Das Cover konnte nicht gespeichert werden');
          return;
        }
        setFormData(prev => ({ ...prev, cover_image: data.url }));
        await fetchManga();
      } else {
        const upErr = await res.json().catch(() => ({}));
        alert(upErr.error || 'Fehler beim Hochladen des Covers');
      }
    } catch (err) {
      alert('Fehler beim Hochladen des Covers');
    } finally {
      setUploadingCover(false);
    }
  };

  return {
    manga, loading, notFound, editing, setEditing, saving, formData, setFormData,
    uploadingCover, failedCover, setFailedCover,
    editLookingUp, editLookupResults, setEditLookupResults, editLookupError,
    applyEditLookupResult, handleEditLookup,
    fetchManga, handleUpdate, handleDeleteManga, handleCoverUpload
  };
}
