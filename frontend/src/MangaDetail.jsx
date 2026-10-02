import VolumeEditModal from './components/detail/VolumeEditModal';
import BatchAddModal from './components/detail/BatchAddModal';
import BatchReadModal from './components/detail/BatchReadModal';
import GapFillModal from './components/detail/GapFillModal';
import LightboxGallery from './components/detail/LightboxGallery';
import MpEditionModal from './components/detail/MpEditionModal';
import VolumeListView from './components/detail/VolumeListView';
import VolumeShelfView from './components/detail/VolumeShelfView';
import VolumeGridView from './components/detail/VolumeGridView';
import { useState, useEffect, useMemo, useRef } from 'react';
import { loadMangaDetail, updateCachedManga } from './utils/offlineStore';
import { normalizePubName, gapVolumeNumber, getVolumeSortInfo, getVolumeDisplayTitle, getSpinePublisherTheme } from './utils/volumeHelpers';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, Edit3, Image as ImageIcon, Check, Plus, 
  Trash2, BookOpen, Layers, Sparkles, CheckCircle2, 
  Upload, X, AlertCircle, Save, Coins, Tag, Calendar, 
  FileText, Filter, ArrowUpDown, Info, Bookmark, Hash, 
  Building2, Search, SlidersHorizontal, ChevronDown,
  Star, Maximize2, Camera, Link as LinkIcon,
  BookCheck, CheckCheck, Package, Truck,
  Library, LayoutGrid, List, Eye, EyeOff, ShoppingCart,
  ChevronLeft, ChevronRight, ExternalLink, Globe, RefreshCw, RotateCcw, MoveHorizontal, AlertTriangle
} from 'lucide-react';
import AddVolumeBar from './components/detail/AddVolumeBar';
import VolumeFilterBar from './components/detail/VolumeFilterBar';
import MangaHeroCard from './components/detail/MangaHeroCard';

export default function MangaDetail({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  // Role permissions (visitor / guest are read-only)
  const isVisitor = !user || user.role === 'visitor' || user.role === 'guest';
  const canEdit = user && (user.role === 'admin' || user.role === 'editor');

  const [manga, setManga] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Filters & Sorting for Volumes
  const [volumeFilter, setVolumeFilter] = useState('ALL'); // 'ALL' | 'Vorhanden' | 'Fehlt' | 'Gelesen' | 'Ungelesen'
  const [volumeTypeFilter, setVolumeTypeFilter] = useState('ALL'); // 'ALL' | 'volume' | 'special_edition' | 'schuber' | 'special'
  const [selectedReaderId, setSelectedReaderId] = useState(user?.id || 'ALL');

  useEffect(() => {
    if (user?.id && (selectedReaderId === 'ALL' || !selectedReaderId)) {
      setSelectedReaderId(user.id);
    }
  }, [user?.id]);

  const [showBatchReadModal, setShowBatchReadModal] = useState(false);
  const [volumePublisherFilter, setVolumePublisherFilter] = useState('ALL');
  const [volumeConditionFilter, setVolumeConditionFilter] = useState('ALL');
  const [volumeSort, setVolumeSort] = useState('number_asc');
  const [volumeSearch, setVolumeSearch] = useState('');

  // View mode & Gap Detection states
  const [volumeViewMode, setVolumeViewMode] = useState(() => {
    return localStorage.getItem('mangashelf_volume_view_mode') || 'grid';
  });
  // 3D Shelf scaling and layout modes: 'fit' (Auto-Fit) | 'rows' (Mehrzeilig) | 'scroll' (Horizontal scrollen)
  const [shelfMode, setShelfMode] = useState(() => {
    return localStorage.getItem('mangashelf_shelf_mode') || 'rows';
  });
  // Shelf scale presets: 's' (Kompakt) | 'm' (Standard) | 'l' (Groß)
  const [shelfScale, setShelfScale] = useState(() => {
    return localStorage.getItem('mangashelf_shelf_scale') || 'm';
  });
  const [focusedVolumeId, setFocusedVolumeId] = useState(null);
  const shelfScrollRef = useRef(null);

  const handleSetShelfMode = (mode) => {
    setShelfMode(mode);
    localStorage.setItem('mangashelf_shelf_mode', mode);
  };

  const handleSetShelfScale = (scale) => {
    setShelfScale(scale);
    localStorage.setItem('mangashelf_shelf_scale', scale);
  };

  const scrollShelf = (offset) => {
    if (shelfScrollRef.current) {
      shelfScrollRef.current.scrollBy({ left: offset, behavior: 'smooth' });
    }
  };

  const [showGaps, setShowGaps] = useState(() => {
    return localStorage.getItem('mangashelf_show_gaps') !== 'false';
  });
  const [fillingGapNumber, setFillingGapNumber] = useState(null);
  const [fillingGapLoading, setFillingGapLoading] = useState(false);

  // Manga Passion Live Gap Reconciliation States
  const [mpGapData, setMpGapData] = useState(null);
  const [mpGapLoading, setMpGapLoading] = useState(false);
  const [showMpEditionModal, setShowMpEditionModal] = useState(false);

  // Edit form state
  const [formData, setFormData] = useState({});

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
  const [lightboxData, setLightboxData] = useState(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [failedCover, setFailedCover] = useState(false);
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchAutofilling, setBatchAutofilling] = useState(false);

  const handleBatchAutofillManga = async (overwrite = false) => {
    if (!canEdit) return;
    const confirmMsg = overwrite 
      ? 'Möchtest du wirklich alle Bände dieser Reihe mit den offiziellen Daten (Erscheinungsdatum, Jahr, Seitenzahl, Preise) überschreiben?' 
      : 'Möchtest du alle fehlenden Erscheinungsdaten, Jahre, Seitenzahlen und Preise für die Bände dieser Reihe automatisch ausfüllen?';
    if (!confirm(confirmMsg)) return;

    setBatchAutofilling(true);
    try {
      const res = await fetch(`/api/mangas/${id}/autofill-volumes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overwrite })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchManga();
        alert(`Erfolg: ${data.updated_count} von ${data.total_user_volumes} Bänden wurden mit offiziellen Daten aktualisiert!`);
      } else {
        alert(data.message || data.error || 'Fehler beim automatischen Ausfüllen');
      }
    } catch (err) {
      alert('Netzwerkfehler beim automatischen Ausfüllen der Bände');
    } finally {
      setBatchAutofilling(false);
    }
  };

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

  useEffect(() => {
    fetchManga();
    if (!user?.offline) fetchMpGaps();
  }, [id, user?.offline]);

  const fetchMpGaps = async (forcedEditionId = null, forceRefresh = false) => {
    try {
      setMpGapLoading(true);
      let url = `/api/mangas/${id}/gaps`;
      const params = [];
      if (forcedEditionId) params.push(`edition_id=${forcedEditionId}`);
      if (forceRefresh) params.push(`force_refresh=true`);
      if (params.length > 0) url += `?${params.join('&')}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setMpGapData(data);
      }
    } catch (e) {
      console.warn('Manga Passion gaps fetch failed:', e);
    } finally {
      setMpGapLoading(false);
    }
  };

  const applyMangaData = (data) => {
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
      setLoading(true);
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
        await fetch(`/api/mangas/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cover_image: data.url })
        });
        setFormData(prev => ({ ...prev, cover_image: data.url }));
        await fetchManga();
      }
    } catch (err) {
      alert('Fehler beim Hochladen des Covers');
    } finally {
      setUploadingCover(false);
    }
  };

  const handleAddSingleVolume = async (e) => {
    e.preventDefault();
    if (!canEdit || !newVolumeNum.trim()) return;

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

  const openVolumeGallery = (vol, initialImageOrIndex = 0) => {
    if (!vol) return;
    const allImages = [];
    if (vol.cover_image) allImages.push(vol.cover_image);
    if (Array.isArray(vol.images)) {
      vol.images.forEach(img => {
        if (img && !allImages.includes(img)) allImages.push(img);
      });
    }
    if (allImages.length === 0) return;

    let startIndex = 0;
    if (typeof initialImageOrIndex === 'number') {
      startIndex = initialImageOrIndex;
    } else if (typeof initialImageOrIndex === 'string') {
      const found = allImages.indexOf(initialImageOrIndex);
      if (found !== -1) startIndex = found;
    }

    setLightboxData({
      volumeId: vol.id,
      volume: vol,
      title: getVolumeDisplayTitle(vol),
      subtitle: `${manga?.title || ''}${vol.publisher ? ` • ${vol.publisher}` : ''}${vol.price ? ` • ${vol.price} €` : ''}`,
      images: allImages,
      currentIndex: Math.max(0, Math.min(startIndex, allImages.length - 1))
    });
  };

  const setPreviewImage = (url) => {
    if (!url) {
      setLightboxData(null);
      return;
    }
    const vol = (manga?.volumes || []).find(v => v.cover_image === url || (Array.isArray(v.images) && v.images.includes(url)));
    if (vol) {
      openVolumeGallery(vol, url);
    } else {
      setLightboxData({
        title: manga?.title || 'Vorschau',
        subtitle: 'Foto-Ansicht',
        images: [url],
        currentIndex: 0
      });
    }
  };

  const handleSetCoverFromLightbox = async () => {
    if (!canEdit || !lightboxData || !lightboxData.volumeId) return;
    const currentImg = lightboxData.images[lightboxData.currentIndex];
    if (!currentImg) return;
    try {
      const res = await fetch(`/api/volumes/${lightboxData.volumeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...lightboxData.volume,
          cover_image: currentImg
        })
      });
      if (res.ok) {
        await fetchManga();
        setLightboxData(prev => ({
          ...prev,
          volume: { ...prev.volume, cover_image: currentImg }
        }));
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Keyboard navigation & Escape handling for modals, edit mode and photo gallery lightbox
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (lightboxData) {
          setLightboxData(null);
          return;
        }
        if (activeVolume) {
          setActiveVolume(null);
          return;
        }
        if (showBatchModal) {
          setShowBatchModal(false);
          return;
        }
        if (showBatchReadModal) {
          setShowBatchReadModal(false);
          return;
        }
        if (fillingGapNumber !== null) {
          setFillingGapNumber(null);
          return;
        }
        if (showMpEditionModal) {
          setShowMpEditionModal(false);
          return;
        }
        if (editing) {
          setEditing(false);
          return;
        }
      } else if (lightboxData && e.key === 'ArrowLeft') {
        setLightboxData(prev => {
          if (!prev || prev.images.length <= 1) return prev;
          const nextIdx = (prev.currentIndex - 1 + prev.images.length) % prev.images.length;
          return { ...prev, currentIndex: nextIdx };
        });
      } else if (lightboxData && e.key === 'ArrowRight') {
        setLightboxData(prev => {
          if (!prev || prev.images.length <= 1) return prev;
          const nextIdx = (prev.currentIndex + 1) % prev.images.length;
          return { ...prev, currentIndex: nextIdx };
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxData, activeVolume, showBatchModal, showBatchReadModal, fillingGapNumber, showMpEditionModal, editing]);

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
    const hasRead = vol.read_users 
      ? vol.read_users.some(u => String(u.user_id ?? u.id) === String(effUserId))
      : (Boolean(vol.is_read) && String(effUserId) === String(user?.id));
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

  const volumes = manga?.volumes || [];
  const ownedCount = volumes.filter(v => v.status === 'Vorhanden').length;
  const missingCount = volumes.filter(v => v.status === 'Fehlt').length;
  const preorderedCount = volumes.filter(v => v.status === 'Vorbestellt').length;
  const upcomingCount = volumes.filter(v => v.status === 'Erscheint bald').length;
  const totalTarget = manga?.total_volumes || 0;
  const completionPct = totalTarget > 0 ? Math.min(100, Math.round((ownedCount / totalTarget) * 100)) : null;

  // Total value calculation
  const totalOwnedValue = manga?.total_value !== undefined ? manga.total_value : volumes
    .filter(v => v.status === 'Vorhanden')
    .reduce((sum, v) => sum + (typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0)), 0);

  const totalPossibleValue = manga?.full_value !== undefined ? manga.full_value : volumes
    .reduce((sum, v) => sum + (typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0)), 0);

  // Readers stats
  const readers = manga?.user_reading_stats || [];
  const currentReaderStats = readers.find(r => String(r.user_id) === String(selectedReaderId)) || readers.find(r => String(r.user_id) === String(user?.id)) || null;
  const currentReaderReadCount = currentReaderStats ? currentReaderStats.read_count : volumes.filter(v => v.is_read).length;
  const currentReaderUnreadCount = currentReaderStats ? currentReaderStats.unread_count : Math.max(0, ownedCount - currentReaderReadCount);

  // Available publishers for filtering (deduplicated case-insensitively & canonicalized)
  const availablePublishers = useMemo(() => {
    const pubMap = new Map();
    volumes.forEach(v => {
      const raw = (v.publisher && v.publisher.trim()) || (manga?.publisher && manga.publisher.trim());
      if (!raw) return;
      const canonical = normalizePubName(raw);
      const key = canonical.toLowerCase();
      if (!pubMap.has(key)) {
        pubMap.set(key, canonical);
      }
    });
    return Array.from(pubMap.values()).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  }, [volumes, manga?.publisher]);

  // Available conditions
  const conditionsList = ['Neuwertig', 'Sehr gut', 'Gut', 'Akzeptabel', 'Mängelexemplar'];

  // Base volumes matching all filters EXCEPT the type filter (for computing accurate type badge counts)
  const baseVolumesForType = useMemo(() => {
    return volumes.filter(v => {
      const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
      const isReadByTarget = v.read_users 
        ? v.read_users.some(u => String(u.user_id ?? u.id) === String(effUserId))
        : (Boolean(v.is_read) && String(effUserId) === String(user?.id));

      if (volumeFilter === 'Vorhanden' && v.status !== 'Vorhanden') return false;
      if (volumeFilter === 'Fehlt' && v.status !== 'Fehlt') return false;
      if (volumeFilter === 'Vorbestellt' && v.status !== 'Vorbestellt') return false;
      if (volumeFilter === 'Erscheint bald' && v.status !== 'Erscheint bald') return false;
      if (volumeFilter === 'Gelesen' && !isReadByTarget) return false;
      if (volumeFilter === 'Ungelesen') {
        if (v.status !== 'Vorhanden' || isReadByTarget) return false;
      }
      
      if (volumePublisherFilter !== 'ALL') {
        const rawPub = (v.publisher && v.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '';
        const pub = normalizePubName(rawPub);
        if (pub.toLowerCase() !== volumePublisherFilter.toLowerCase()) return false;
      }

      if (volumeConditionFilter !== 'ALL') {
        if (volumeConditionFilter === 'Ohne') {
          if (v.condition) return false;
        } else if (v.condition !== volumeConditionFilter) {
          return false;
        }
      }

      if (volumeSearch.trim()) {
        const q = volumeSearch.toLowerCase();
        const numMatch = String(v.volume_number).toLowerCase().includes(q);
        const isbnMatch = v.isbn && String(v.isbn).toLowerCase().includes(q);
        const notesMatch = v.notes && String(v.notes).toLowerCase().includes(q);
        const pubMatch = ((v.publisher || manga?.publisher || '')).toLowerCase().includes(q);
        if (!numMatch && !isbnMatch && !notesMatch && !pubMatch) return false;
      }

      return true;
    });
  }, [volumes, selectedReaderId, user?.id, volumeFilter, volumePublisherFilter, volumeConditionFilter, volumeSearch, manga?.publisher]);

  const schuberCount = useMemo(() => baseVolumesForType.filter(v => v.type === 'schuber' || String(v.volume_number).toLowerCase().includes('schuber')).length, [baseVolumesForType]);

  const specialEditionCount = useMemo(() => baseVolumesForType.filter(v => v.type === 'special_edition' || (
    v.type !== 'schuber' && (
      String(v.volume_number).toLowerCase().includes('special edition') ||
      String(v.volume_number).toLowerCase().includes('limited edition') ||
      String(v.volume_number).toLowerCase().includes('spezial edition') ||
      (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition')))
    )
  )).length, [baseVolumesForType]);

  const specialCount = useMemo(() => baseVolumesForType.filter(v => {
    if (v.type === 'special_edition' || v.type === 'schuber') return false;
    const vLower = String(v.volume_number).toLowerCase();
    if (vLower.includes('special edition') || vLower.includes('limited edition') || vLower.includes('spezial edition') || vLower.includes('schuber')) return false;
    return v.type === 'special' || vLower.includes('special') || vLower.includes('extra') || vLower.includes('sonderband');
  }).length, [baseVolumesForType]);

  const regularVolumeCount = useMemo(() => baseVolumesForType.filter(v => {
    const isSchuber = v.type === 'schuber' || String(v.volume_number).toLowerCase().includes('schuber');
    const isSpecialEd = v.type === 'special_edition' || (
      String(v.volume_number).toLowerCase().includes('special edition') ||
      String(v.volume_number).toLowerCase().includes('limited edition') ||
      String(v.volume_number).toLowerCase().includes('spezial edition') ||
      (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition')))
    );
    const isSpecial = v.type === 'special' || String(v.volume_number).toLowerCase().includes('special') || String(v.volume_number).toLowerCase().includes('extra') || String(v.volume_number).toLowerCase().includes('sonderband');
    return !isSchuber && !isSpecialEd && !isSpecial;
  }).length, [baseVolumesForType]);

  // Filter & sort volumes
  const filteredVolumes = useMemo(() => {
    return baseVolumesForType
      .filter(v => {
        if (volumeTypeFilter !== 'ALL') {
          const t = v.type || (
            String(v.volume_number).toLowerCase().includes('schuber') ? 'schuber' :
            String(v.volume_number).toLowerCase().includes('special edition') || String(v.volume_number).toLowerCase().includes('limited edition') || String(v.volume_number).toLowerCase().includes('spezial edition') || (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition'))) ? 'special_edition' :
            String(v.volume_number).toLowerCase().includes('special') || String(v.volume_number).toLowerCase().includes('extra') || String(v.volume_number).toLowerCase().includes('sonderband') ? 'special' :
            'volume'
          );
          if (t !== volumeTypeFilter) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const infoA = getVolumeSortInfo(a);
        const infoB = getVolumeSortInfo(b);
        const priceA = a.price !== null && a.price !== undefined ? a.price : -1;
        const priceB = b.price !== null && b.price !== undefined ? b.price : -1;
        const pubA = ((a.publisher && a.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '').toLowerCase();
        const pubB = ((b.publisher && b.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '').toLowerCase();
        const yearA = a.release_year || 0;
        const yearB = b.release_year || 0;

        switch (volumeSort) {
          case 'number_desc':
            if (infoA.rank !== infoB.rank) return infoA.rank - infoB.rank;
            if (infoB.num !== infoA.num) return infoB.num - infoA.num;
            if (infoA.subRank !== infoB.subRank) return infoA.subRank - infoB.subRank;
            return infoB.raw.localeCompare(infoA.raw, undefined, { numeric: true });
          case 'publisher_asc':
            return pubA.localeCompare(pubB) || (infoA.rank - infoB.rank) || (infoA.num - infoB.num);
          case 'publisher_desc':
            return pubB.localeCompare(pubA) || (infoA.rank - infoB.rank) || (infoA.num - infoB.num);
          case 'price_desc':
            return priceB - priceA;
          case 'price_asc':
            return (priceA === -1 ? 999999 : priceA) - (priceB === -1 ? 999999 : priceB);
          case 'year_desc':
            return yearB - yearA;
          case 'year_asc':
            return (yearA || 9999) - (yearB || 9999);
          case 'condition':
            return (a.condition || 'ZZZ').localeCompare(b.condition || 'ZZZ');
          case 'number_asc':
          default:
            if (infoA.rank !== infoB.rank) return infoA.rank - infoB.rank;
            if (infoA.num !== infoB.num) return infoA.num - infoB.num;
            if (infoA.subRank !== infoB.subRank) return infoA.subRank - infoB.subRank;
            return infoA.raw.localeCompare(infoB.raw, undefined, { numeric: true });
        }
      });
  }, [baseVolumesForType, volumeTypeFilter, volumeSort, manga?.publisher]);

  // Desktop keyboard shortcuts (J / K / Space / E) for shelf & volume navigation (declared AFTER filteredVolumes)
  useEffect(() => {
    const handleVolumeKeyboardNav = (e) => {
      const isInputActive = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
      if (isInputActive) return;

      const hasModalOpen = lightboxData || activeVolume || showBatchModal || showBatchReadModal || fillingGapNumber !== null || showMpEditionModal || editing;
      if (hasModalOpen) return;

      const volList = filteredVolumes || [];
      if (volList.length === 0) return;

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        setFocusedVolumeId(prev => {
          if (!prev) return volList[0].id;
          const currIdx = volList.findIndex(v => v.id === prev);
          const nextIdx = (currIdx + 1) % volList.length;
          return volList[nextIdx].id;
        });
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setFocusedVolumeId(prev => {
          if (!prev) return volList[volList.length - 1].id;
          const currIdx = volList.findIndex(v => v.id === prev);
          const nextIdx = (currIdx - 1 + volList.length) % volList.length;
          return volList[nextIdx].id;
        });
      } else if (e.key === ' ' || e.code === 'Space') {
        if (focusedVolumeId) {
          e.preventDefault();
          const targetVol = volList.find(v => v.id === focusedVolumeId);
          if (targetVol && canEdit) {
            handleToggleVolumeRead(targetVol);
          }
        }
      } else if (e.key === 'e' || e.key === 'E') {
        if (focusedVolumeId && canEdit) {
          e.preventDefault();
          const targetVol = volList.find(v => v.id === focusedVolumeId);
          if (targetVol) {
            handleOpenEditVolume(targetVol);
          }
        }
      }
    };
    window.addEventListener('keydown', handleVolumeKeyboardNav);
    return () => window.removeEventListener('keydown', handleVolumeKeyboardNav);
  }, [lightboxData, activeVolume, showBatchModal, showBatchReadModal, fillingGapNumber, showMpEditionModal, editing, filteredVolumes, focusedVolumeId, canEdit]);

  const hasActiveFilters = volumeFilter !== 'ALL' || volumeTypeFilter !== 'ALL' || volumePublisherFilter !== 'ALL' || volumeConditionFilter !== 'ALL' || Boolean(volumeSearch.trim());

  const handleResetFilters = () => {
    setVolumeFilter('ALL');
    setVolumeTypeFilter('ALL');
    setVolumePublisherFilter('ALL');
    setVolumeConditionFilter('ALL');
    setVolumeSearch('');
  };

  const handleSetVolumeViewMode = (mode) => {
    setVolumeViewMode(mode);
    localStorage.setItem('mangashelf_volume_view_mode', mode);
  };

  const handleToggleShowGaps = () => {
    setShowGaps(prev => {
      const next = !prev;
      localStorage.setItem('mangashelf_show_gaps', String(next));
      return next;
    });
  };

  const handleBatchFillGaps = async (targetStatus = 'Fehlt') => {
    if (!canEdit || detectedGaps.length === 0) return;
    if (!confirm(`${detectedGaps.length} fehlende Bände auf Status '${targetStatus}' erfassen?`)) return;
    setFillingGapLoading(true);
    try {
      const res = await fetch(`/api/mangas/${id}/batch-import-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          volume_numbers: detectedGaps.map(String),
          target_status: targetStatus,
          edition_id: mpGapData?.edition?.id || null
        })
      });
      if (res.ok) {
        await fetchManga();
        await fetchMpGaps();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Erfassen der Lücken');
      }
    } catch (err) {
      alert('Fehler beim Erfassen der Lücken');
    } finally {
      setFillingGapLoading(false);
    }
  };

  const handleSyncTotalVolumes = async (officialTotal) => {
    if (!canEdit || !mpGapData?.edition?.id) return;
    setMpGapLoading(true);
    try {
      const res = await fetch(`/api/mangas/${id}/sync-edition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edition_id: mpGapData.edition.id,
          update_total_volumes: true,
          update_status: true,
          update_publisher: false
        })
      });
      if (res.ok) {
        await fetchManga();
        await fetchMpGaps(mpGapData.edition.id, true);
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Abgleich');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setMpGapLoading(false);
    }
  };

  const handleSelectMpEdition = async (selectedEdition) => {
    if (!canEdit || !selectedEdition) return;
    setMpGapLoading(true);
    try {
      const res = await fetch(`/api/mangas/${id}/sync-edition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edition_id: selectedEdition.id,
          update_total_volumes: true,
          update_status: true,
          update_publisher: false
        })
      });
      if (res.ok) {
        setShowMpEditionModal(false);
        await fetchManga();
        await fetchMpGaps(selectedEdition.id, true);
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Auswählen der Edition');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setMpGapLoading(false);
    }
  };

  // Map of Manga Passion gaps by volume_number for quick lookup of price, cover, date
  const mpGapMap = useMemo(() => {
    const map = new Map();
    if (mpGapData && mpGapData.gaps) {
      mpGapData.gaps.forEach(g => {
        map.set(String(g.volume_number).trim().toLowerCase(), g);
      });
    }
    return map;
  }, [mpGapData]);

  // Gap Detection for numeric volumes:
  // Prioritizes verified Manga Passion official edition data if available;
  // falls back to local detection.
  // Filters out volumes already present in user's collection to avoid duplicates!
  const detectedGaps = useMemo(() => {
    // Collect all existing volume numbers and notes currently in the DB/collection:
    const existingVolNums = new Set(
      volumes.map(v => String(v.volume_number || '').trim().toLowerCase())
    );
    const existingNotes = new Set(
      volumes.map(v => String(v.notes || '').trim().toLowerCase()).filter(Boolean)
    );

    // If Manga Passion matched the German edition, use the verified official missing volumes:
    if (mpGapData && mpGapData.matched && Array.isArray(mpGapData.gaps)) {
      return mpGapData.gaps
        .filter(g => {
          const strNum = String(g.volume_number || '').trim().toLowerCase();
          if (existingVolNums.has(strNum)) return false;

          const cleanTitle = String(g.title || '').trim().toLowerCase();
          if (cleanTitle && existingNotes.has(cleanTitle)) return false;
          if (cleanTitle) {
            const hasMatch = volumes.some(v => {
              const vn = String(v.notes || '').trim().toLowerCase();
              const vnum = String(v.volume_number || '').trim().toLowerCase();
              return (vn && (vn.includes(cleanTitle) || cleanTitle.includes(vn))) ||
                     (vnum && (vnum.includes(cleanTitle) || cleanTitle.includes(vnum)));
            });
            if (hasMatch) return false;
          }

          // Check range bundle (e.g. "21-25", "26-30")
          const rangeMatch = strNum.match(/^(\d+)\s*[-–]\s*(\d+)$/);
          if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            let allOwned = true;
            for (let k = start; k <= end; k++) {
              if (!existingVolNums.has(String(k))) {
                allOwned = false;
                break;
              }
            }
            if (allOwned) return false;
          }

          if (g.title && (g.title.toLowerCase().includes('schuber') || g.title.toLowerCase().includes('box')) && rangeMatch) {
            return false;
          }

          return true;
        })
        .map(g => {
          const match = String(g.volume_number).trim().match(/^(\d+)$/);
          if (match) {
            return g.title ? `${match[1]} (${g.title.trim()})` : parseInt(match[1], 10);
          }
          return g.title || g.volume_number;
        });
    }

    // Local fallback:
    const existingNums = new Set();
    let maxFound = 0;
    
    volumes.forEach(v => {
      const isRegular = (!v.type || v.type === 'volume') && 
        !String(v.volume_number).toLowerCase().includes('schuber') && 
        !String(v.volume_number).toLowerCase().includes('special');
      if (isRegular) {
        const match = String(v.volume_number).trim().match(/^(\d+)$/);
        if (match) {
          const parsed = parseInt(match[1], 10);
          if (parsed > 0 && parsed <= 300) {
            existingNums.add(parsed);
            if (parsed > maxFound) maxFound = parsed;
          }
        }
      }
    });

    const targetMax = Math.min(200, Math.max(maxFound, parseInt(manga?.total_volumes, 10) || 0));
    if (targetMax <= 1 || existingNums.size === 0) return [];

    const gaps = [];
    for (let i = 1; i <= targetMax; i++) {
      if (!existingNums.has(i)) {
        gaps.push(i);
      }
    }
    return gaps;
  }, [mpGapData, volumes, manga?.total_volumes]);

  // Items to render across Spine Shelf, Grid View, and Table View (interleaving gaps if showGaps is active)
  const displayVolumeItems = useMemo(() => {
    const isNumberSort = volumeSort === 'number_asc' || volumeSort === 'number_desc';
    const allowTypeFilter = volumeTypeFilter === 'ALL' || volumeTypeFilter === 'volume';
    const allowStatusFilter = volumeFilter === 'ALL' || volumeFilter === 'Fehlt';

    if (!showGaps || detectedGaps.length === 0 || !allowTypeFilter || !allowStatusFilter || volumeSearch.trim() || !isNumberSort) {
      return filteredVolumes.map(v => ({ isGap: false, volume: v }));
    }

    const items = [];
    // titled gaps ("26 (Titel)") must resolve to their volume number, otherwise no ghost entry is drawn for them
    const gapsSet = new Set(detectedGaps.map(gapVolumeNumber).filter(n => n !== null));
    const sorted = [...filteredVolumes];

    // Ensure no volume that actually exists in sorted is treated as a gap:
    sorted.forEach(v => {
      const match = String(v.volume_number).trim().match(/^(\d+)$/);
      if (match) gapsSet.delete(parseInt(match[1], 10));
    });

    const maxTarget = Math.max(
      ...Array.from(gapsSet).map(g => typeof g === 'number' ? g : 0),
      ...sorted.map(v => {
        const match = String(v.volume_number).trim().match(/^(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
    );

    let volIndex = 0;
    for (let i = 1; i <= maxTarget; i++) {
      if (gapsSet.has(i)) {
        const gapMeta = mpGapMap.get(String(i).toLowerCase());
        items.push({ isGap: true, gapNumber: i, gapMeta });
      }
      while (volIndex < sorted.length) {
        const v = sorted[volIndex];
        const match = String(v.volume_number).trim().match(/^(\d+)$/);
        const parsed = match ? parseInt(match[1], 10) : null;
        if (parsed !== null && parsed === i) {
          items.push({ isGap: false, volume: v });
          volIndex++;
        } else if (parsed !== null && parsed < i) {
          items.push({ isGap: false, volume: v });
          volIndex++;
        } else {
          break;
        }
      }
    }
    while (volIndex < sorted.length) {
      items.push({ isGap: false, volume: sorted[volIndex] });
      volIndex++;
    }

    if (volumeSort === 'number_desc') {
      items.reverse();
    }

    return items;
  }, [showGaps, detectedGaps, volumeTypeFilter, volumeFilter, volumeSearch, volumeSort, filteredVolumes, mpGapMap]);

  // Keep spineShelfItems as alias for Spine Shelf
  const spineShelfItems = displayVolumeItems;

  // Smart Balanced Shelf Rows calculation for 'rows' mode AND auto-multi-row in 'fit' mode
  const AUTO_FIT_MULTIROW_THRESHOLD = 36; // beyond this, auto-fit becomes multi-row too

  const shelfRows = useMemo(() => {
    const count = spineShelfItems.length;

    // In 'fit' mode with few items: single row
    if (shelfMode === 'fit' && count <= AUTO_FIT_MULTIROW_THRESHOLD) {
      return [spineShelfItems];
    }

    // In 'scroll' mode: always single (horizontally scrollable) row
    if (shelfMode === 'scroll') {
      return [spineShelfItems];
    }

    // 'rows' mode OR 'fit' mode with many books → calculate balanced rows:
    // Optimal books per shelf plank based on scale:
    //  S = compact spines (~42px) → ~20 per row on a 900px shelf
    //  M = standard spines (~52px) → ~16 per row
    //  L = large spines (~66px) → ~12 per row
    const targetPerRow = shelfScale === 's' ? 20 : shelfScale === 'l' ? 12 : 16;

    if (count <= targetPerRow) {
      return [spineShelfItems];
    }

    // Compute balanced row count so rows are evenly filled
    const rowCount = Math.ceil(count / targetPerRow);
    const itemsPerRow = Math.ceil(count / rowCount);

    const rows = [];
    for (let i = 0; i < count; i += itemsPerRow) {
      rows.push(spineShelfItems.slice(i, i + itemsPerRow));
    }
    return rows;
  }, [spineShelfItems, shelfMode, shelfScale]);

  // Derived: is fit-mode actually rendering as multi-row (auto-rows)?
  const isFitMultiRow = shelfMode === 'fit' && spineShelfItems.length > AUTO_FIT_MULTIROW_THRESHOLD;

  const renderShelfSpine = (item, idx, currentMode = shelfMode) => {
    // Determine effective layout mode:
    //  - isFitSingleRow: true auto-fit with few items → flex-1 WITH max-width
    //  - isFlexFill: rows or fit-multirow → flex-1 WITHOUT max-width (fill full shelf width)
    //  - isScrollFixed: scroll mode → fixed pixel widths, no flex
    const isFitSingleRow = currentMode === 'fit' && !isFitMultiRow;
    const isScrollFixed = currentMode === 'scroll';
    const isFlexFill = !isFitSingleRow && !isScrollFixed; // rows mode or fit-multirow

    const totalCount = spineShelfItems.length;
    const isVeryCompact = isFitSingleRow && totalCount > 24;
    const isUltraCompact = isFitSingleRow && totalCount > 34;

    // Proportional spine height based on scale + mode:
    let spineHeightPx;
    if (shelfScale === 's') {
      spineHeightPx = isFitSingleRow && isUltraCompact ? '150px' : '170px';
    } else if (shelfScale === 'l') {
      spineHeightPx = isFitSingleRow ? (isUltraCompact ? '210px' : '260px') : '240px';
    } else {
      spineHeightPx = isFitSingleRow ? (isUltraCompact ? '175px' : isVeryCompact ? '195px' : '220px') : '210px';
    }

    if (item.isGap) {
      const gapMeta = item.gapMeta || mpGapMap.get(String(item.gapNumber).toLowerCase());
      // Width class depends on layout mode:
      // KEY MATH: max-width must satisfy (targetPerRow × max-width > ~950px container)
      //   so flex-1 is forced to shrink items in full rows → row fills entire width.
      //   For partial rows (few items), max-width caps growth → books look normal.
      let ghostWidthClass;
      if (isFitSingleRow) {
        ghostWidthClass = 'flex-1 min-w-[18px] max-w-[56px]';
      } else if (isScrollFixed) {
        ghostWidthClass = shelfScale === 's' ? 'w-[36px]' : shelfScale === 'l' ? 'w-[56px]' : 'w-[46px]';
      } else {
        // Rows / fit-multirow: flex-1 with generous max-width
        // S(20/row): 20×56=1120>950 ✓  M(16/row): 16×70=1120>950 ✓  L(12/row): 12×92=1104>950 ✓
        ghostWidthClass = shelfScale === 's' ? 'flex-1 min-w-[20px] max-w-[56px]'
          : shelfScale === 'l' ? 'flex-1 min-w-[20px] max-w-[92px]'
          : 'flex-1 min-w-[20px] max-w-[70px]';
      }

      return (
        <div
          key={`gap-${item.gapNumber}-${idx}`}
          onClick={() => canEdit && setFillingGapNumber(item.gapNumber)}
          style={{ height: spineHeightPx, '--spine-height': spineHeightPx }}
          className={`manga-spine-ghost relative group ${ghostWidthClass} flex flex-col justify-between items-center py-2 sm:py-2.5 px-0.5 text-center ${isFlexFill ? '' : 'shrink-0'} rounded-lg overflow-hidden border border-dashed transition-all ${
            canEdit ? 'cursor-pointer hover:border-amber-400 hover:scale-[1.03]' : 'cursor-default'
          } border-amber-500/40 bg-slate-900/60 backdrop-blur-sm`}
          title={gapMeta?.price ? `Lücke: Band ${item.gapNumber} (${gapMeta.price.toFixed(2).replace('.', ',')} €${gapMeta.release_date ? ' • ' + gapMeta.release_date : ''}). Klicken zum Erfassen!` : `Lücke: Band ${item.gapNumber} fehlt.`}
        >
          {gapMeta?.cover_image && (
            <div 
              className="absolute inset-0 bg-cover bg-center opacity-25 group-hover:opacity-40 transition-opacity pointer-events-none"
              style={{ backgroundImage: `url(${gapMeta.cover_image})` }}
            />
          )}
          <div className={`relative z-10 font-bold text-amber-400/90 flex items-center justify-center rounded-full bg-amber-500/20 border border-amber-500/40 ${
            isUltraCompact ? 'w-4 h-4 text-[9px]' : 'w-5 h-5 text-[10px]'
          }`}>
            +
          </div>
          <div className="relative z-10 flex flex-col items-center">
            {!isUltraCompact && (
              <span className="text-[10px] font-black text-amber-300/80 tracking-tight leading-none mb-0.5">Band</span>
            )}
            <span className={`${isUltraCompact ? 'text-xs sm:text-sm' : isVeryCompact ? 'text-sm' : 'text-base'} font-black text-amber-400 leading-tight drop-shadow`}>
              {item.gapNumber}
            </span>
            {gapMeta?.price && !isUltraCompact && (
              <span className="text-[8px] sm:text-[9px] font-mono font-bold text-amber-300/90 mt-0.5 truncate max-w-full">
                {gapMeta.price.toFixed(2).replace('.', ',')} €
              </span>
            )}
          </div>
          <div className={`relative z-10 uppercase tracking-wider text-amber-400/90 bg-amber-500/20 px-0.5 sm:px-1 py-0.5 rounded border border-amber-500/30 truncate max-w-full ${
            isUltraCompact ? 'text-[7px] leading-none' : 'text-[8px] font-bold'
          }`}>
            Lücke
          </div>
        </div>
      );
    }

    const vol = item.volume;
    const isOwned = vol.status === 'Vorhanden';
    const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
    const isRead = vol.read_users 
      ? vol.read_users.some(u => String(u.user_id || u.id) === String(effUserId)) 
      : (Boolean(vol.is_read) && String(effUserId) === String(user?.id));

    const theme = getSpinePublisherTheme(vol.publisher || manga.publisher);
    const isSchuber = vol.type === 'schuber' || String(vol.volume_number).toLowerCase().includes('schuber');
    const isSpecialEd = vol.type === 'special_edition' || (
      vol.type !== 'schuber' && (
        String(vol.volume_number).toLowerCase().includes('special edition') ||
        String(vol.volume_number).toLowerCase().includes('limited edition') ||
        String(vol.volume_number).toLowerCase().includes('spezial edition') ||
        (vol.notes && (vol.notes.toLowerCase().includes('special edition') || vol.notes.toLowerCase().includes('limited edition')))
      )
    );
    const isSpecial = vol.type === 'special' || String(vol.volume_number).toLowerCase().includes('special') || String(vol.volume_number).toLowerCase().includes('extra');

    // Page-count realistic spine thickness factor (Standard manga ~192p = 1.0, Double-vol ~380p = 1.5)
    const pageFactor = (vol.pages && Number(vol.pages) > 40)
      ? Math.max(0.85, Math.min(1.75, Number(vol.pages) / 192))
      : 1.0;

    let spineWidth = '';
    let customWidthStyle = {};
    if (isFitSingleRow) {
      // Single-row auto-fit: flex-1 WITH max-width to prevent overflow on one line
      spineWidth = isSchuber ? 'flex-[1.8] min-w-[32px] max-w-[95px]' : isSpecialEd ? 'flex-[1.2] min-w-[24px] max-w-[65px]' : 'flex-1 min-w-[18px] max-w-[56px]';
    } else if (isScrollFixed) {
      // Scroll mode: fixed pixel widths for predictable horizontal scrolling with page factor
      const isS = shelfScale === 's';
      const isL = shelfScale === 'l';
      const baseW = isSchuber ? (isS ? 68 : isL ? 100 : 84) : isSpecialEd ? (isS ? 42 : isL ? 62 : 52) : (isS ? 36 : isL ? 56 : 46);
      const calculatedW = Math.round(baseW * pageFactor);
      customWidthStyle = { width: `${calculatedW}px` };
    } else {
      // Rows / fit-multirow: flex-1 with CALCULATED max-width
      const isS = shelfScale === 's';
      const isL = shelfScale === 'l';
      if (isSchuber) {
        spineWidth = isS ? 'flex-[1.8] min-w-[36px] max-w-[100px]' : isL ? 'flex-[1.8] min-w-[50px] max-w-[165px]' : 'flex-[1.8] min-w-[40px] max-w-[126px]';
      } else if (isSpecialEd) {
        spineWidth = isS ? 'flex-[1.2] min-w-[24px] max-w-[67px]' : isL ? 'flex-[1.2] min-w-[30px] max-w-[110px]' : 'flex-[1.2] min-w-[26px] max-w-[84px]';
      } else {
        spineWidth = isS ? 'flex-1 min-w-[20px] max-w-[56px]' : isL ? 'flex-1 min-w-[26px] max-w-[92px]' : 'flex-1 min-w-[22px] max-w-[70px]';
      }
    }

    // In flex-fill modes, don't use shrink-0 so flex distributes space properly
    const shrinkClass = isFlexFill ? '' : 'shrink-0';
    const isFocused = vol.id === focusedVolumeId;

    return (
      <div
        key={vol.id}
        onClick={() => {
          setFocusedVolumeId(vol.id);
          if (canEdit) handleOpenEditVolume(vol);
        }}
        style={{ 
          height: spineHeightPx, 
          '--spine-height': spineHeightPx,
          ...customWidthStyle,
          ...(isFlexFill ? { flexGrow: (isSchuber ? 1.8 : isSpecialEd ? 1.25 : 1.0) * pageFactor } : {})
        }}
        className={`manga-spine ${spineWidth} bg-gradient-to-b ${theme.bg} ${theme.border} ${shrinkClass} flex flex-col justify-between items-center py-2 sm:py-2.5 px-0.5 sm:px-1 relative transition-all duration-200 ${
          isFocused ? 'ring-2 ring-brand-400 ring-offset-2 ring-offset-slate-950 scale-[1.04] z-20 shadow-xl shadow-brand-500/30' : ''
        } ${canEdit ? 'cursor-pointer' : 'cursor-default'} ${!isOwned ? 'opacity-70 saturate-50 hover:opacity-100 hover:saturate-100' : ''}`}
        title={`${getVolumeDisplayTitle(vol)}${vol.publisher ? ` • ${vol.publisher}` : ''}${vol.price ? ` • ${vol.price}€` : ''}${isRead ? ' • Gelesen ✓' : ''}`}
      >
        {/* Spine Top: Publisher Logo / Accent */}
        <div className="w-full flex justify-center shrink-0">
          <span className={`px-0.5 sm:px-1 py-0.5 rounded truncate max-w-full leading-tight text-center ${
            isUltraCompact ? 'text-[7px] max-w-[32px]' : 'text-[8px] sm:text-[9px] max-w-[42px] sm:max-w-[48px]'
          } ${theme.accentBadge}`}>
            {theme.accentName}
          </span>
        </div>

        {/* Spine Center: Vertical Manga Title */}
        <div className="flex-1 flex items-center justify-center my-1 overflow-hidden pointer-events-none w-full">
          <span className={`spine-vertical-text font-bold select-none truncate ${
            isUltraCompact ? 'text-[8px] sm:text-[9px] max-h-[70px]' : isVeryCompact ? 'text-[9px] sm:text-[10px] max-h-[85px]' : 'text-[11px] sm:text-xs tracking-wider max-h-[110px]'
          } ${theme.text} opacity-90 drop-shadow-sm`}>
            {manga.title}
          </span>
        </div>

        {/* Spine Bottom: Volume Number & Status Badges */}
        <div className="w-full flex flex-col items-center gap-0.5 sm:gap-1 shrink-0 pt-1 border-t border-white/10">
          {isSchuber ? (
            <div className="text-[9px] sm:text-[10px] font-black text-indigo-300 flex items-center gap-0.5 bg-indigo-950/60 px-1 py-0.5 rounded border border-indigo-500/30 truncate max-w-full">
              <Package className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
              <span className="truncate">{String(vol.volume_number).replace(/schuber\s*/i, '')}</span>
            </div>
          ) : isSpecialEd ? (
            <div className="flex flex-col items-center">
              <span className="text-xs sm:text-sm font-black text-fuchsia-300 drop-shadow">
                {String(vol.volume_number).replace(/special\s*edition|limited\s*edition/gi, '').trim() || 'SE'}
              </span>
              <span className="text-[7px] sm:text-[8px] font-bold text-fuchsia-300 bg-fuchsia-950/70 px-0.5 sm:px-1 rounded border border-fuchsia-500/40">
                SPEC
              </span>
            </div>
          ) : isSpecial ? (
            <div className="flex flex-col items-center">
              <span className="text-xs sm:text-sm font-black text-amber-300 drop-shadow">
                {String(vol.volume_number).replace(/special\s*|extra\s*/gi, '').trim() || 'SP'}
              </span>
              <span className="text-[7px] sm:text-[8px] font-bold text-amber-300 bg-amber-950/70 px-0.5 sm:px-1 rounded border border-amber-500/40">
                EXTRA
              </span>
            </div>
          ) : (
            <span className={`${
              isUltraCompact ? 'text-xs sm:text-sm' : isVeryCompact ? 'text-sm sm:text-base' : 'text-base sm:text-lg'
            } font-black text-white tracking-tight leading-none drop-shadow`}>
              {vol.volume_number}
            </span>
          )}

          {/* Status Badges Row (Owned / Read) */}
          <div className="flex items-center gap-1 mt-0.5">
            {/* Read Checkmark */}
            {isOwned && isRead && (
              <span className={`${isUltraCompact ? 'w-3 h-3 text-[7px]' : 'w-3.5 h-3.5 text-[8px]'} rounded-full bg-emerald-500/25 border border-emerald-400 text-emerald-300 flex items-center justify-center font-bold`} title="Gelesen">
                ✓
              </span>
            )}
            {/* Status Badge */}
            {vol.status === 'Vorbestellt' ? (
              <span className="text-[7px] sm:text-[8px] font-extrabold bg-sky-500 text-slate-950 px-0.5 sm:px-1 rounded-sm shadow-sm" title="Vorbestellt">
                BESTELLT
              </span>
            ) : vol.status === 'Erscheint bald' ? (
              <span className="text-[7px] sm:text-[8px] font-extrabold bg-purple-500 text-slate-950 px-0.5 sm:px-1 rounded-sm shadow-sm" title="Erscheint bald">
                BALD
              </span>
            ) : !isOwned ? (
              <span className="text-[7px] sm:text-[8px] font-extrabold bg-amber-500 text-slate-950 px-0.5 sm:px-1 rounded-sm" title="Fehlt in der Sammlung">
                FEHLT
              </span>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-slate-400 gap-3">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm">Lade Manga-Details...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-slate-400 gap-6 px-4">
        <div className="w-20 h-20 rounded-2xl bg-slate-800/60 border border-slate-700/50 flex items-center justify-center text-5xl">
          📚
        </div>
        <div className="text-center">
          <h2 className="text-2xl font-bold text-slate-200 mb-2">Manga nicht gefunden</h2>
          <p className="text-slate-400 text-sm">Dieser Manga existiert nicht oder wurde gelöscht.</p>
        </div>
        <Link
          to="/"
          className="btn-primary flex items-center gap-2 px-5 py-2.5"
        >
          <ArrowLeft className="w-4 h-4" />
          Zurück zur Übersicht
        </Link>
      </div>
    );
  }

  if (!manga) return null;

  return (
    <div className="min-h-screen pb-20 overflow-x-hidden">
      {/* Top Bar */}
      <div className="max-w-[1680px] 2xl:max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-4">
        <Link 
          to="/" 
          className="inline-flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium bg-slate-900/60 hover:bg-slate-800/80 px-3.5 py-2 rounded-xl border border-slate-800 shadow-sm"
        >
          <ArrowLeft className="w-4 h-4 text-brand-400" /> Zurück zur Übersicht
        </Link>
      </div>

      {/* Main Container */}
      <div className="max-w-[1680px] 2xl:max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* Hero Card */}
        <MangaHeroCard
          isOffline={Boolean(user?.offline)}
          applyEditLookupResult={applyEditLookupResult}
          canEdit={canEdit}
          completionPct={completionPct}
          editLookingUp={editLookingUp}
          editLookupError={editLookupError}
          editLookupResults={editLookupResults}
          editing={editing}
          failedCover={failedCover}
          formData={formData}
          handleCoverUpload={handleCoverUpload}
          handleDeleteManga={handleDeleteManga}
          handleEditLookup={handleEditLookup}
          handleUpdate={handleUpdate}
          manga={manga}
          ownedCount={ownedCount}
          saving={saving}
          setEditLookupResults={setEditLookupResults}
          setEditing={setEditing}
          setFailedCover={setFailedCover}
          setFormData={setFormData}
          totalOwnedValue={totalOwnedValue}
          totalTarget={totalTarget}
          uploadingCover={uploadingCover}
        />

        {/* VOLUMES CHECKLIST SECTION */}
        <section className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl">
          
          {/* Header & Controls */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 pb-6 border-b border-slate-800">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2.5">
                <Layers className="w-5 h-5 text-brand-400" />
                Bände-Checkliste
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Klicke auf das Häkchen für Schnell-Status, oder auf die Karte für <b>Preise & Detailangaben</b>
              </p>
            </div>

            {/* Quick Actions */}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2">
                <button 
                  onClick={() => setShowBatchReadModal(true)} 
                  className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                  title="Mehrere Bände auf einmal als gelesen oder ungelesen markieren"
                >
                  <BookCheck className="w-3.5 h-3.5 text-emerald-400" /> Bis Band X als gelesen
                </button>
                <button 
                  onClick={() => setShowBatchModal(true)} 
                  className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3"
                >
                  <Plus className="w-3.5 h-3.5 text-brand-400" /> Mehrere Bände (Batch)
                </button>
              </div>
            )}
          </div>

          {/* Lese-Tracking Bar */}
          {readers.length > 0 && (
            <div className="mb-4 p-3.5 bg-slate-950/80 rounded-2xl border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-inner">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                  <BookOpen className="w-4 h-4 text-emerald-400" />
                  Leser:
                </span>
                
                {/* Readers switcher */}
                <div className="flex flex-wrap items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs">
                  {readers.map(r => {
                    const isSelected = String(selectedReaderId) === String(r.user_id) || (selectedReaderId === 'ALL' && String(r.user_id) === String(user?.id));
                    return (
                      <button
                        key={r.user_id}
                        type="button"
                        onClick={() => setSelectedReaderId(r.user_id)}
                        className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-2 ${
                          isSelected 
                            ? 'bg-brand-600 text-white shadow-sm font-semibold' 
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <span>{r.display_name || r.username}</span>
                        <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded-md ${isSelected ? 'bg-black/30 text-emerald-200' : 'bg-slate-800 text-slate-300'}`}>
                          {r.read_count} / {r.total_owned}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Reading Progress Percentage Bar for current selected reader */}
              <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-end">
                <div className="text-xs text-slate-300 font-mono flex items-center gap-2">
                  <span>Gelesen: <strong className="text-emerald-400">{currentReaderReadCount}</strong> von {ownedCount}</span>
                  <span className="text-slate-600">|</span>
                  <span>SuB: <strong className="text-amber-400">{currentReaderUnreadCount}</strong></span>
                </div>
                <div className="w-24 sm:w-32 h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                  <div 
                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
                    style={{ width: `${ownedCount > 0 ? Math.round((currentReaderReadCount / ownedCount) * 100) : 0}%` }}
                    title={`${ownedCount > 0 ? Math.round((currentReaderReadCount / ownedCount) * 100) : 0}% gelesen`}
                  />
                </div>
                <span className="text-xs font-mono font-bold text-emerald-400">
                  {ownedCount > 0 ? Math.round((currentReaderReadCount / ownedCount) * 100) : 0}%
                </span>
              </div>
            </div>
          )}

          {/* Filter, View & Sort Controls */}
          <VolumeFilterBar
            availablePublishers={availablePublishers}
            baseVolumesForType={baseVolumesForType}
            conditionsList={conditionsList}
            currentReaderReadCount={currentReaderReadCount}
            currentReaderUnreadCount={currentReaderUnreadCount}
            detectedGaps={detectedGaps}
            handleResetFilters={handleResetFilters}
            handleSetVolumeViewMode={handleSetVolumeViewMode}
            handleToggleShowGaps={handleToggleShowGaps}
            hasActiveFilters={hasActiveFilters}
            missingCount={missingCount}
            mpGapData={mpGapData}
            mpGapLoading={mpGapLoading}
            ownedCount={ownedCount}
            preorderedCount={preorderedCount}
            regularVolumeCount={regularVolumeCount}
            schuberCount={schuberCount}
            setShowMpEditionModal={setShowMpEditionModal}
            setVolumeConditionFilter={setVolumeConditionFilter}
            setVolumeFilter={setVolumeFilter}
            setVolumePublisherFilter={setVolumePublisherFilter}
            setVolumeSearch={setVolumeSearch}
            setVolumeSort={setVolumeSort}
            setVolumeTypeFilter={setVolumeTypeFilter}
            showGaps={showGaps}
            specialCount={specialCount}
            specialEditionCount={specialEditionCount}
            upcomingCount={upcomingCount}
            volumeConditionFilter={volumeConditionFilter}
            volumeFilter={volumeFilter}
            volumePublisherFilter={volumePublisherFilter}
            volumeSearch={volumeSearch}
            volumeSort={volumeSort}
            volumeTypeFilter={volumeTypeFilter}
            volumeViewMode={volumeViewMode}
            volumes={volumes}
          />

          {/* Volumes Grid */}
          {displayVolumeItems.length === 0 ? (
            <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60 my-4">
              <BookOpen className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-sm text-slate-400">
                {volumes.length === 0 
                  ? 'Noch keine Bände erfasst. Nutze untenstehendes Feld oder "Mehrere Bände", um loszulegen.' 
                  : 'Keine Bände mit diesen Filtereinstellungen gefunden.'}
              </p>
              {volumes.length > 0 && hasActiveFilters && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="mt-3.5 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-brand-600/30 hover:bg-brand-600/50 text-brand-300 border border-brand-500/40 transition-all cursor-pointer shadow-sm"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Filter zurücksetzen
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Collection Gap Notice Banner (Shown in all view modes if gaps detected) */}
              {showGaps && detectedGaps.length > 0 && (volumeFilter === 'ALL' || volumeFilter === 'Fehlt') && !volumeSearch && (
                <div className="mb-4 space-y-2">
                  {/* Discrepancy warning banner if AniList total differs from German Edition total */}
                  {mpGapData?.discrepancy && canEdit && (
                    <div className="p-3 bg-amber-500/15 border border-amber-500/40 rounded-xl flex flex-wrap items-center justify-between gap-3 text-xs text-amber-200 shadow-md">
                      <div className="flex items-center gap-2.5">
                        <AlertCircle className="w-5 h-5 text-amber-400 shrink-0" />
                        <div>
                          <div className="font-bold text-amber-300">Sammlungs-Info korrigieren (Manga-Passion Abgleich)</div>
                          <div className="text-[11px] text-amber-200/90 leading-tight">
                            {mpGapData.discrepancy.message}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSyncTotalVolumes(mpGapData.discrepancy.official_total)}
                          disabled={mpGapLoading}
                          className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg text-xs transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>Auf {mpGapData.discrepancy.official_total} Bände anpassen</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Main Gaps Banner */}
                  <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs text-amber-200">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                      <span>
                        <strong>{detectedGaps.length} Lücke{detectedGaps.length === 1 ? '' : 'n'} entdeckt:</strong> {detectedGaps.slice(0, 8).map(g => typeof g === 'number' ? `Band ${g}` : (String(g).startsWith('Band') ? g : (String(g).match(/^\d+/) ? `Band ${g}` : g))).join(', ')}{detectedGaps.length > 8 ? ` (+ ${detectedGaps.length - 8} weitere)` : ''}
                        {mpGapData?.edition && (
                          <span className="ml-1.5 text-amber-300/80 text-[11px]">
                            (geprüft mit Manga-Passion: <em>{mpGapData.edition.title}</em>, {mpGapData.total_official_volumes} Bände)
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setShowMpEditionModal(true);
                        }}
                        className="px-2.5 py-1 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                        title="Manga-Passion Edition prüfen oder wechseln"
                      >
                        <Search className="w-3 h-3 text-brand-400" />
                        <span>Manga-Passion Edition</span>
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => handleBatchFillGaps('Fehlt')}
                          disabled={fillingGapLoading}
                          className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 rounded-lg text-amber-200 font-semibold transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {fillingGapLoading ? (
                            <div className="w-3 h-3 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <ShoppingCart className="w-3 h-3 text-amber-300" />
                          )}
                          <span>{fillingGapLoading ? 'Wird übertragen...' : 'Alle auf Einkaufsliste'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* SPINE VIEW */}
              {volumeViewMode === 'spine' && (
                <VolumeShelfView
                  handleSetShelfMode={handleSetShelfMode}
                  handleSetShelfScale={handleSetShelfScale}
                  isFitMultiRow={isFitMultiRow}
                  renderShelfSpine={renderShelfSpine}
                  scrollShelf={scrollShelf}
                  shelfMode={shelfMode}
                  shelfRows={shelfRows}
                  shelfScale={shelfScale}
                  shelfScrollRef={shelfScrollRef}
                  spineShelfItems={spineShelfItems}
                />
              )}

              {/* LIST VIEW */}
              {volumeViewMode === 'list' && (
                <VolumeListView
                  displayVolumeItems={displayVolumeItems}
                  mpGapMap={mpGapMap}
                  manga={manga}
                  user={user}
                  canEdit={canEdit}
                  selectedReaderId={selectedReaderId}
                  setFillingGapNumber={setFillingGapNumber}
                  openVolumeGallery={openVolumeGallery}
                  handleToggleVolume={handleToggleVolume}
                  handleToggleVolumeRead={handleToggleVolumeRead}
                  handleOpenEditVolume={handleOpenEditVolume}
                  handleDeleteVolume={handleDeleteVolume}
                />
              )}

              {/* GRID VIEW */}
              {volumeViewMode === 'grid' && (
                <VolumeGridView
                  canEdit={canEdit}
                  displayVolumeItems={displayVolumeItems}
                  handleDeleteVolume={handleDeleteVolume}
                  handleOpenEditVolume={handleOpenEditVolume}
                  handleToggleVolume={handleToggleVolume}
                  handleToggleVolumeRead={handleToggleVolumeRead}
                  manga={manga}
                  mpGapMap={mpGapMap}
                  openVolumeGallery={openVolumeGallery}
                  readers={readers}
                  selectedReaderId={selectedReaderId}
                  setFillingGapNumber={setFillingGapNumber}
                  user={user}
                />
              )}
            </>
          )}

          {/* Add Single Volume / Schuber Bar */}
          <AddVolumeBar
            canEdit={canEdit}
            handleAddSingleVolume={handleAddSingleVolume}
            handleUploadNewSingleCover={handleUploadNewSingleCover}
            newVolumeCover={newVolumeCover}
            newVolumeNum={newVolumeNum}
            newVolumePrice={newVolumePrice}
            newVolumeReleaseDate={newVolumeReleaseDate}
            newVolumeStatus={newVolumeStatus}
            newVolumeType={newVolumeType}
            setNewVolumeCover={setNewVolumeCover}
            setNewVolumeNum={setNewVolumeNum}
            setNewVolumePrice={setNewVolumePrice}
            setNewVolumeReleaseDate={setNewVolumeReleaseDate}
            setNewVolumeStatus={setNewVolumeStatus}
            setNewVolumeType={setNewVolumeType}
            uploadingNewCover={uploadingNewCover}
          />

        </section>
      </div>

      {/* MODALS & OVERLAYS */}
      <VolumeEditModal
        isOpen={Boolean(activeVolume)}
        activeVolume={activeVolume}
        onClose={() => setActiveVolume(null)}
        manga={manga}
        mangaId={id}
        canEdit={canEdit}
        onSuccess={fetchManga}
        onPreviewImage={setPreviewImage}
      />

      <BatchAddModal
        isOpen={showBatchModal}
        onClose={() => setShowBatchModal(false)}
        manga={manga}
        mangaId={id}
        onSuccess={fetchManga}
      />

      <BatchReadModal
        isOpen={showBatchReadModal}
        onClose={() => setShowBatchReadModal(false)}
        mangaId={id}
        readers={readers}
        selectedReaderId={selectedReaderId}
        setSelectedReaderId={setSelectedReaderId}
        user={user}
        onSuccess={fetchManga}
      />

      <GapFillModal
        isOpen={fillingGapNumber !== null}
        gapNumber={fillingGapNumber}
        onClose={() => setFillingGapNumber(null)}
        manga={manga}
        mangaId={id}
        mpGapMap={mpGapMap}
        canEdit={canEdit}
        onSuccess={async () => {
          await fetchManga();
          await fetchMpGaps();
        }}
      />

      <LightboxGallery
        lightboxData={lightboxData}
        setLightboxData={setLightboxData}
        onClose={() => setLightboxData(null)}
        canEdit={canEdit}
        onSuccess={fetchManga}
      />

      <MpEditionModal
        isOpen={showMpEditionModal}
        onClose={() => setShowMpEditionModal(false)}
        manga={manga}
        mangaId={id}
        mpGapData={mpGapData}
        mpGapLoading={mpGapLoading}
        fetchMpGaps={fetchMpGaps}
        handleSyncTotalVolumes={handleSyncTotalVolumes}
        handleBatchAutofillManga={handleBatchAutofillManga}
        batchAutofilling={batchAutofilling}
        handleSelectMpEdition={handleSelectMpEdition}
      />

    </div>
  );
}
