import { useState } from 'react';
import { loadMangaList } from '../utils/offlineStore';

/** The series list (server, else the offline copy) and deleting a series. */
export default function useMangaList({ user, canEdit }) {
  const [mangas, setMangas] = useState([]);
  const [loading, setLoading] = useState(true);

  // Falls back to the read-only offline copy when the server cannot be reached
  const loadOfflineMangas = async () => {
    const cached = await loadMangaList();
    if (cached && cached.length) setMangas(cached);
  };

  const fetchMangas = async () => {
    try {
      setLoading(true);
      if (user?.offline) {
        await loadOfflineMangas();
        return;
      }
      const res = await fetch('/api/mangas');
      if (res.ok) {
        const data = await res.json();
        setMangas(data);
      }
    } catch (e) {
      console.error('Failed to fetch mangas, using offline copy:', e);
      await loadOfflineMangas();
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteManga = async (e, id, title) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canEdit) return;
    if (!confirm(`Möchtest du "${title}" wirklich löschen? Alle zugehörigen Bände werden ebenfalls entfernt.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/mangas/${id}`, { method: 'DELETE' });
      if (res.ok) {
        fetchMangas();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Löschen');
      }
    } catch (err) {
      alert('Netzwerkfehler beim Löschen');
    }
  };

  return { mangas, loading, fetchMangas, handleDeleteManga };
}
