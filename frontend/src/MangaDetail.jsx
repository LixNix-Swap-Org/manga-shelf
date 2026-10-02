import VolumeEditModal from './components/detail/VolumeEditModal';
import BatchAddModal from './components/detail/BatchAddModal';
import BatchReadModal from './components/detail/BatchReadModal';
import GapFillModal from './components/detail/GapFillModal';
import LightboxGallery from './components/detail/LightboxGallery';
import MpEditionModal from './components/detail/MpEditionModal';
import VolumeListView from './components/detail/VolumeListView';
import { useState, useEffect, useMemo, useRef } from 'react';
import { normalizePubName, getVolumeSortInfo, getVolumeDisplayTitle, getSpinePublisherTheme } from './utils/volumeHelpers';
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
    fetchMpGaps();
  }, [id]);

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

  const fetchManga = async () => {
    try {
      setLoading(true);
      setNotFound(false);
      const res = await fetch(`/api/mangas/${id}`);
      if (res.ok) {
        const data = await res.json();
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
      } else if (res.status === 404) {
        setNotFound(true);
      } else {
        // 500 or other error - show not found
        setNotFound(true);
      }
    } catch (e) {
      console.error(e);
      setNotFound(true);
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
      ? vol.read_users.some(u => String(u.user_id) === String(effUserId))
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
        ? v.read_users.some(u => String(u.user_id) === String(effUserId))
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
    const gapsSet = new Set(detectedGaps.map(g => (typeof g === 'string' && /^\d+$/.test(g)) ? parseInt(g, 10) : g));
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
        <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl flex flex-col md:flex-row gap-8 mb-8 relative overflow-hidden">
          
          {/* Subtle glow background */}
          <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>

          {/* Cover Column */}
          <div className="w-full md:w-64 lg:w-72 shrink-0 flex flex-col items-center">
            <div className="relative group w-48 sm:w-56 md:w-full aspect-[2/3] rounded-2xl overflow-hidden shadow-2xl border border-slate-700/80 bg-slate-950 flex items-center justify-center">
              {manga.cover_image && !failedCover ? (
                <img 
                  src={manga.cover_image} 
                  alt={manga.title} 
                  onError={() => setFailedCover(true)}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-slate-600 gap-2 p-4 text-center">
                  <BookOpen className="w-12 h-12 stroke-[1.5]" />
                  <span className="text-xs font-medium">Kein Cover vorhanden</span>
                </div>
              )}

              {/* Cover Upload Overlay */}
              {canEdit && (
                <label 
                  htmlFor="cover-upload" 
                  className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center gap-2 cursor-pointer transition-opacity backdrop-blur-sm text-white text-xs font-semibold"
                >
                  <Upload className="w-6 h-6 text-brand-400" />
                  <span>Cover ändern</span>
                  <input 
                    id="cover-upload" 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    onChange={handleCoverUpload}
                    disabled={uploadingCover}
                  />
                </label>
              )}

              {uploadingCover && (
                <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              )}
            </div>

            {/* Quick stats under cover */}
            <div className="w-full mt-4 bg-slate-950/60 rounded-xl p-3 border border-slate-800/80 flex justify-around text-center">
              <div>
                <span className="text-[10px] uppercase font-semibold text-slate-400 block">Bände</span>
                <span className="text-sm font-bold text-white">{ownedCount} / {totalTarget || '?'}</span>
              </div>
              <div className="w-[1px] bg-slate-800"></div>
              <div>
                <span className="text-[10px] uppercase font-semibold text-emerald-400 block">Sammlungswert</span>
                <span className="text-sm font-bold text-emerald-400 font-mono">
                  {totalOwnedValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                </span>
              </div>
            </div>
          </div>

          {/* Details Column */}
          <div className="flex-1 relative z-10">
            {editing ? (
              /* EDIT MODE */
              <form onSubmit={handleUpdate} className="space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Edit3 className="w-4 h-4 text-brand-400" /> Manga bearbeiten
                  </h2>
                  <div className="flex gap-2">
                    <button 
                      type="button" 
                      onClick={() => setEditing(false)} 
                      className="btn-secondary text-xs py-1.5 px-3"
                    >
                      Abbrechen
                    </button>
                    <button 
                      type="submit" 
                      className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                      disabled={saving}
                    >
                      <Save className="w-3.5 h-3.5" /> {saving ? 'Speichert...' : 'Speichern'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Titel der Reihe</label>
                    <div className="flex gap-2 items-center">
                      <input 
                        type="text" 
                        className="input-field flex-1" 
                        required
                        value={formData.title} 
                        onChange={e => setFormData({ ...formData, title: e.target.value })} 
                      />
                      <button
                        type="button"
                        onClick={handleEditLookup}
                        disabled={editLookingUp || !formData.title.trim()}
                        className="btn-secondary text-xs flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 bg-gradient-to-r hover:from-emerald-600/30 hover:to-sky-600/30 border-brand-500/40 text-brand-300 hover:text-white shrink-0"
                        title="Sucht offizielle deutsche Ausgaben über Manga Passion (mit AniList-Fallback)"
                      >
                        {editLookingUp ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Suche...</span>
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-3.5 h-3.5 text-brand-400" />
                            <span>Auto-Fill</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Alternativer Titel</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      value={formData.alt_title} 
                      onChange={e => setFormData({ ...formData, alt_title: e.target.value })} 
                    />
                  </div>
                </div>

                {/* Edit Lookup Error */}
                {editLookupError && (
                  <div className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
                    <span>{editLookupError}</span>
                  </div>
                )}

                {/* Edit Lookup Results Selector */}
                {editLookupResults && editLookupResults.length > 0 && (
                  <div className="bg-slate-950/95 border border-brand-500/40 rounded-xl p-3 space-y-2.5 shadow-xl">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-semibold text-brand-400 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5" /> Treffer auswählen (Manga Passion zuerst):
                      </span>
                      <button 
                        type="button" 
                        onClick={() => setEditLookupResults(null)}
                        className="text-slate-400 hover:text-white text-[11px]"
                      >
                        Schließen
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto custom-scrollbar pr-1">
                      {editLookupResults.map(item => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => applyEditLookupResult(item)}
                          className={`flex items-center gap-2.5 p-2 rounded-lg border text-left transition-all group ${
                            item.source === 'manga_passion'
                              ? 'bg-gradient-to-r from-emerald-950/30 to-slate-900/90 border-emerald-500/40 hover:border-emerald-400 hover:from-emerald-950/50'
                              : 'bg-slate-900/80 hover:bg-brand-950/60 border-slate-800 hover:border-brand-500/50'
                          }`}
                        >
                          {item.cover_image ? (
                            <img 
                              src={item.cover_image} 
                              alt={item.title} 
                              className="w-10 h-14 object-cover rounded shadow shrink-0" 
                            />
                          ) : (
                            <div className="w-10 h-14 bg-slate-800 rounded shrink-0 flex items-center justify-center text-slate-500">
                              <BookOpen className="w-5 h-5" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              {item.source === 'manga_passion' ? (
                                <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-1 py-0.2 rounded text-[9px] font-bold shrink-0">
                                  🇩🇪 Manga Passion
                                </span>
                              ) : (
                                <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 px-1 py-0.2 rounded text-[9px] font-medium shrink-0">
                                  🌐 AniList
                                </span>
                              )}
                            </div>
                            <p className="text-xs font-semibold text-white truncate group-hover:text-brand-300">
                              {item.title}
                            </p>
                            <p className="text-[11px] text-slate-400 truncate">
                              {item.author || item.alt_title || 'Unbekannt'}
                            </p>
                            <div className="flex flex-wrap gap-1 mt-1 text-[10px]">
                              {item.publisher && (
                                <span className="bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded font-medium truncate max-w-[120px]">
                                  {item.publisher}
                                </span>
                              )}
                              {item.total_volumes && (
                                <span className="bg-slate-800 text-slate-200 border border-slate-700/80 px-1.5 py-0.5 rounded font-bold">
                                  {item.total_volumes} Bände
                                </span>
                              )}
                              <span className="bg-slate-800/80 px-1.5 py-0.5 rounded text-slate-400">
                                {item.status}
                              </span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Autor / Mangaka</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      value={formData.author} 
                      onChange={e => setFormData({ ...formData, author: e.target.value })} 
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Standard-Verlag</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      value={formData.publisher} 
                      onChange={e => setFormData({ ...formData, publisher: e.target.value })} 
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Status</label>
                    <select 
                      className="input-field bg-slate-950"
                      value={formData.status} 
                      onChange={e => setFormData({ ...formData, status: e.target.value })}
                    >
                      <option value="Laufend">Laufend</option>
                      <option value="Abgeschlossen">Abgeschlossen</option>
                      <option value="Pausiert">Pausiert</option>
                      <option value="Geplant">Geplant</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Geplante Gesamtbände</label>
                    <input 
                      type="number" 
                      min="1"
                      className="input-field" 
                      value={formData.total_volumes} 
                      onChange={e => setFormData({ ...formData, total_volumes: e.target.value })} 
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Cover-Bild</label>
                    <div className="flex gap-2 items-center">
                      <input 
                        type="text" 
                        className="input-field flex-1" 
                        placeholder="URL oder Datei hochladen"
                        value={formData.cover_image} 
                        onChange={e => setFormData({ ...formData, cover_image: e.target.value })} 
                      />
                      <label className="btn-secondary text-xs flex items-center gap-1.5 cursor-pointer shrink-0 py-2.5 px-3">
                        <Upload className="w-3.5 h-3.5" />
                        Bild
                        <input 
                          type="file" 
                          accept="image/*" 
                          className="hidden" 
                          onChange={handleCoverUpload}
                          disabled={uploadingCover}
                        />
                      </label>
                    </div>
                    {uploadingCover && (
                      <p className="text-xs text-brand-400 mt-1 flex items-center gap-1.5">
                        <span className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin inline-block"></span>
                        Cover wird hochgeladen...
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">Beschreibung</label>
                  <textarea 
                    rows="3" 
                    className="input-field resize-none" 
                    value={formData.description} 
                    onChange={e => setFormData({ ...formData, description: e.target.value })} 
                  />
                </div>
              </form>
            ) : (
              /* VIEW MODE */
              <div className="flex flex-col h-full justify-between">
                <div>
                  {/* Title & Action Buttons */}
                  <div className="flex flex-col sm:flex-row justify-between items-start gap-4 mb-3">
                    <div>
                      <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                        {manga.title}
                      </h1>
                      {manga.alt_title && (
                        <p className="text-sm text-slate-400 mt-0.5">{manga.alt_title}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {canEdit ? (
                        <>
                          <button 
                            onClick={() => setEditing(true)} 
                            className="btn-secondary text-xs flex items-center gap-1.5 py-2 px-3"
                          >
                            <Edit3 className="w-3.5 h-3.5" /> Bearbeiten
                          </button>
                          <button 
                            onClick={handleDeleteManga} 
                            className="btn-danger text-xs flex items-center gap-1.5 py-2 px-3"
                            title="Reihe löschen"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <span className="text-xs bg-slate-800/80 text-slate-400 px-3 py-1.5 rounded-xl border border-slate-700/60 font-medium">
                          Nur Leseansicht (Gast)
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Badges */}
                  <div className="flex flex-wrap items-center gap-2 text-xs mb-6">
                    <span className="bg-slate-800/90 text-slate-200 px-3 py-1 rounded-xl border border-slate-700/80 font-medium">
                      Autor: <strong className="text-white">{manga.author || 'Unbekannt'}</strong>
                    </span>
                    <span className="bg-slate-800/90 text-slate-200 px-3 py-1 rounded-xl border border-slate-700/80 font-medium flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-brand-400" />
                      Verlag: <strong className="text-white">{manga.publisher || 'Unbekannt'}</strong>
                    </span>
                    <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 px-3 py-1 rounded-xl font-semibold">
                      {manga.status || 'Laufend'}
                    </span>
                    <span className="bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 px-3 py-1 rounded-xl font-semibold">
                      Gesamt: {totalTarget > 0 ? `${totalTarget} Bände` : 'Unbekannt'}
                    </span>
                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-3 py-1 rounded-xl font-semibold flex items-center gap-1.5">
                      <Coins className="w-3.5 h-3.5 text-emerald-400" />
                      Sammlungswert: <strong className="text-white font-mono">{totalOwnedValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</strong>
                    </span>
                  </div>

                  {/* Description */}
                  <div className="mb-6">
                    <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2">Beschreibung</h3>
                    <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-line max-w-2xl bg-slate-950/40 p-4 rounded-2xl border border-slate-800/60">
                      {manga.description || 'Keine Beschreibung vorhanden. Klicke auf "Bearbeiten", um eine Inhaltsangabe hinzuzufügen.'}
                    </p>
                  </div>
                </div>

                {/* Progress bar */}
                <div className="pt-4 border-t border-slate-800/80">
                  <div className="flex justify-between items-center text-xs mb-2">
                    <span className="font-semibold text-slate-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      Sammlungs-Fortschritt
                    </span>
                    <span className="text-slate-400 font-mono">
                      <strong className="text-emerald-400">{ownedCount}</strong> {totalTarget > 0 ? `/ ${totalTarget}` : 'im Besitz'} 
                      {completionPct !== null && ` (${completionPct}%)`}
                    </span>
                  </div>
                  <div className="w-full h-2.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                    <div 
                      className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 transition-all duration-500"
                      style={{ width: `${completionPct !== null ? completionPct : 0}%` }}
                    />
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>

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
          <div className="flex flex-col gap-3 mb-6 p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800/80 shadow-lg">
            {/* Top Bar: View Mode Switcher + Gap Indicator */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800/60">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-400 flex items-center gap-1.5">
                  <Library className="w-3.5 h-3.5 text-brand-400" />
                  Ansicht:
                </span>
                <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 text-xs">
                  <button
                    type="button"
                    onClick={() => handleSetVolumeViewMode('grid')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                      volumeViewMode === 'grid'
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                    title="Kachelansicht mit Coverbildern"
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    <span>Karten</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetVolumeViewMode('spine')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                      volumeViewMode === 'spine'
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                    title="3D-Buchrückenansicht / Echtes Manga-Regal"
                  >
                    <Library className="w-3.5 h-3.5" />
                    <span>Regal</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetVolumeViewMode('list')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                      volumeViewMode === 'list'
                        ? 'bg-brand-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                    title="Kompakte Listenansicht"
                  >
                    <List className="w-3.5 h-3.5" />
                    <span>Liste</span>
                  </button>
                </div>
              </div>

              {/* Lücken-Erkennung Toggle & Manga Passion Pill */}
              <div className="flex items-center gap-2">
                {detectedGaps.length > 0 && (
                  <button
                    type="button"
                    onClick={handleToggleShowGaps}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 border ${
                      showGaps
                        ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-sm shadow-amber-950/40'
                        : 'bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300'
                    }`}
                    title={showGaps ? 'Lücken-Erkennung in Regal & Karten aktiv (Klicken zum Ausblenden)' : 'Lücken-Erkennung ausgeblendet (Klicken zum Aktivieren)'}
                  >
                    {showGaps ? <Eye className="w-3.5 h-3.5 text-amber-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-500" />}
                    <span>Lücken: <strong>{detectedGaps.length} fehlend</strong></span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${showGaps ? 'bg-amber-400/20 text-amber-300' : 'bg-slate-800 text-slate-500'}`}>
                      {showGaps ? 'AN' : 'AUS'}
                    </span>
                  </button>
                )}

                {/* Manga Passion Pill / Discrepancy indicator */}
                <button
                  type="button"
                  onClick={() => {
                    setShowMpEditionModal(true);
                  }}
                  className={`px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 border ${
                    mpGapData?.discrepancy 
                      ? 'bg-amber-500/15 border-amber-500/50 text-amber-300 hover:bg-amber-500/25 shadow-sm' 
                      : mpGapData?.matched
                        ? 'bg-slate-900/90 border-slate-800 text-slate-400 hover:text-white hover:border-slate-700'
                        : 'bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300'
                  }`}
                  title="Klicken für Manga-Passion Editionsabgleich"
                >
                  <Globe className="w-3.5 h-3.5 text-brand-400" />
                  <span className="hidden sm:inline">Manga-Passion:</span>
                  <span className="font-semibold text-white truncate max-w-[130px]">
                    {mpGapData?.edition ? mpGapData.edition.publisher : (mpGapLoading ? 'Prüfe...' : 'Abgleich')}
                  </span>
                  {mpGapData?.discrepancy && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-amber-500/30 text-amber-200">
                      {mpGapData.discrepancy.official_total} statt {mpGapData.discrepancy.db_total}
                    </span>
                  )}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              
              {/* Status Filter Tabs */}
              <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 text-xs">
                <button
                  onClick={() => setVolumeFilter('ALL')}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    volumeFilter === 'ALL' 
                      ? 'bg-brand-600 text-white shadow-sm' 
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Alle ({volumes.length})
                </button>
                <button
                  onClick={() => setVolumeFilter('Vorhanden')}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    volumeFilter === 'Vorhanden' 
                      ? 'bg-emerald-600 text-white shadow-sm' 
                      : 'text-emerald-400 hover:text-emerald-300'
                  }`}
                >
                  ✓ Im Besitz ({ownedCount})
                </button>
                <button
                  onClick={() => setVolumeFilter('Fehlt')}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    volumeFilter === 'Fehlt' 
                      ? 'bg-amber-600 text-white shadow-sm' 
                      : 'text-amber-400 hover:text-amber-300'
                  }`}
                >
                  ✕ Fehlt noch ({missingCount}{showGaps && detectedGaps.length > 0 ? ` + ${detectedGaps.length} Lücken` : ''})
                </button>
                {preorderedCount > 0 && (
                  <button
                    onClick={() => setVolumeFilter('Vorbestellt')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                      volumeFilter === 'Vorbestellt' 
                        ? 'bg-sky-600 text-white shadow-sm' 
                        : 'text-sky-400 hover:text-sky-300'
                    }`}
                  >
                    📦 Vorbestellt ({preorderedCount})
                  </button>
                )}
                {upcomingCount > 0 && (
                  <button
                    onClick={() => setVolumeFilter('Erscheint bald')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                      volumeFilter === 'Erscheint bald' 
                        ? 'bg-purple-600 text-white shadow-sm' 
                        : 'text-purple-400 hover:text-purple-300'
                    }`}
                  >
                    📅 Erscheint bald ({upcomingCount})
                  </button>
                )}
                <button
                  onClick={() => setVolumeFilter('Gelesen')}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    volumeFilter === 'Gelesen' 
                      ? 'bg-teal-600 text-white shadow-sm' 
                      : 'text-teal-400 hover:text-teal-300'
                  }`}
                >
                  📖 Gelesen ({currentReaderReadCount})
                </button>
                <button
                  onClick={() => setVolumeFilter('Ungelesen')}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                    volumeFilter === 'Ungelesen' 
                      ? 'bg-rose-600 text-white shadow-sm' 
                      : 'text-rose-400 hover:text-rose-300'
                  }`}
                  title="Im Besitz, aber noch nicht gelesen (Stapel ungelesener Bücher)"
                >
                  ⏳ Ungelesen / SuB ({currentReaderUnreadCount})
                </button>
              </div>

              {/* Search & Sort Controls */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {/* Verlag Filter Dropdown */}
                <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
                  <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
                  <select
                    value={volumePublisherFilter}
                    onChange={e => setVolumePublisherFilter(e.target.value)}
                    className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
                  >
                    <option value="ALL">Alle Verlage</option>
                    {availablePublishers.map(pub => (
                      <option key={pub} value={pub}>{pub}</option>
                    ))}
                  </select>
                  <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
                </label>

                {/* Zustand Filter Dropdown */}
                <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <select
                    value={volumeConditionFilter}
                    onChange={e => setVolumeConditionFilter(e.target.value)}
                    className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
                  >
                    <option value="ALL">Alle Zustände</option>
                    {conditionsList.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
                </label>

                {/* Sort Dropdown */}
                <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
                  <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <select
                    value={volumeSort}
                    onChange={e => setVolumeSort(e.target.value)}
                    className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
                  >
                    <option value="number_asc">Band-Nr. (1 → 99)</option>
                    <option value="number_desc">Band-Nr. (99 → 1)</option>
                    <option value="publisher_asc">Verlag (A → Z)</option>
                    <option value="publisher_desc">Verlag (Z → A)</option>
                    <option value="price_desc">Preis (Höchster zuerst)</option>
                    <option value="price_asc">Preis (Niedrigster zuerst)</option>
                    <option value="year_desc">Erscheinungsjahr (Neueste)</option>
                    <option value="year_asc">Erscheinungsjahr (Älteste)</option>
                    <option value="condition">Zustand</option>
                  </select>
                  <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
                </label>

                {/* Fast search input */}
                <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-xl px-2.5 py-1 focus-within:border-brand-500">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input 
                    type="text" 
                    placeholder="Suchen..." 
                    value={volumeSearch}
                    onChange={e => setVolumeSearch(e.target.value)}
                    className="bg-transparent border-0 text-xs text-white placeholder-slate-500 focus:outline-none w-24 sm:w-32 py-1"
                  />
                  {volumeSearch && (
                    <button onClick={() => setVolumeSearch('')} className="text-slate-400 hover:text-white">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Reset Filters Button (visible when filters are active) */}
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={handleResetFilters}
                    className="inline-flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800 text-slate-300 hover:text-white border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 text-xs font-medium transition-all shadow-sm cursor-pointer"
                    title="Alle Filter zurücksetzen"
                  >
                    <RotateCcw className="w-3.5 h-3.5 text-brand-400" />
                    <span className="hidden sm:inline">Filter zurücksetzen</span>
                  </button>
                )}

              </div>
            </div>

            {/* Optional Type Filter Chips (if manga contains Special Editions, Schuber or Specials) */}
            {(specialEditionCount > 0 || schuberCount > 0 || specialCount > 0) && (
              <div className="flex flex-wrap items-center gap-1.5 pt-2.5 border-t border-slate-800/60 text-xs">
                <span className="text-[11px] text-slate-400 font-semibold mr-1 flex items-center gap-1">
                  <Filter className="w-3 h-3 text-brand-400" /> Typ:
                </span>
                <button
                  type="button"
                  onClick={() => setVolumeTypeFilter('ALL')}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
                    volumeTypeFilter === 'ALL'
                      ? 'bg-slate-700 text-white shadow-sm'
                      : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  Alle ({baseVolumesForType.length})
                </button>
                <button
                  type="button"
                  onClick={() => setVolumeTypeFilter('volume')}
                  className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
                    volumeTypeFilter === 'volume'
                      ? 'bg-brand-600 text-white shadow-sm'
                      : 'bg-slate-900/80 text-slate-400 hover:text-slate-200 border border-slate-800'
                  }`}
                >
                  <BookOpen className="w-3 h-3 text-brand-400" /> Nur Bände ({regularVolumeCount})
                </button>
                {specialEditionCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setVolumeTypeFilter('special_edition')}
                    className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
                      volumeTypeFilter === 'special_edition'
                        ? 'bg-fuchsia-600 text-white shadow-sm ring-1 ring-fuchsia-400'
                        : 'bg-fuchsia-950/40 text-fuchsia-300 hover:bg-fuchsia-900/50 border border-fuchsia-800/50'
                    }`}
                  >
                    <Sparkles className="w-3 h-3 text-fuchsia-400" /> ✨ Special Editions ({specialEditionCount})
                  </button>
                )}
                {schuberCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setVolumeTypeFilter('schuber')}
                    className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
                      volumeTypeFilter === 'schuber'
                        ? 'bg-indigo-600 text-white shadow-sm ring-1 ring-indigo-400'
                        : 'bg-indigo-950/40 text-indigo-300 hover:bg-indigo-900/50 border border-indigo-800/50'
                    }`}
                  >
                    <Package className="w-3 h-3 text-indigo-400" /> 📦 Nur Schuber ({schuberCount})
                  </button>
                )}
                {specialCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setVolumeTypeFilter('special')}
                    className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1 ${
                      volumeTypeFilter === 'special'
                        ? 'bg-amber-600 text-white shadow-sm ring-1 ring-amber-400'
                        : 'bg-amber-950/40 text-amber-300 hover:bg-amber-900/50 border border-amber-800/50'
                    }`}
                  >
                    <Sparkles className="w-3 h-3 text-amber-400" /> ⭐ Specials ({specialCount})
                  </button>
                )}
              </div>
            )}
          </div>

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
                <div className="mb-8">
                  {/* Shelf Controls Toolbar */}
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-3 px-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                        <Library className="w-4 h-4 text-brand-400" />
                        Manga-Regal
                      </span>
                      <span className="text-[11px] text-slate-500 font-mono">
                        ({spineShelfItems.length} {spineShelfItems.length === 1 ? 'Band' : 'Bände'})
                      </span>
                      <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700/60 text-[10px] text-slate-400 font-medium" title="Tastatur-Navigation im Regal">
                        <span>Tasten:</span>
                        <kbd className="px-1 bg-slate-900 border border-slate-700 rounded text-slate-300 font-mono text-[9px]">J</kbd>
                        <kbd className="px-1 bg-slate-900 border border-slate-700 rounded text-slate-300 font-mono text-[9px]">K</kbd>
                        <span className="text-slate-600">•</span>
                        <kbd className="px-1 bg-slate-900 border border-slate-700 rounded text-slate-300 font-mono text-[9px]">Space</kbd>
                        <span className="text-slate-500">Gelesen</span>
                        <span className="text-slate-600">•</span>
                        <kbd className="px-1 bg-slate-900 border border-slate-700 rounded text-slate-300 font-mono text-[9px]">E</kbd>
                        <span className="text-slate-500">Edit</span>
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {/* Shelf Layout Mode: Auto-Fit | Regalbretter | Scrollen */}
                      <div className="flex items-center bg-slate-900/90 p-0.5 rounded-xl border border-slate-800 text-xs">
                        <button
                          type="button"
                          onClick={() => handleSetShelfMode('fit')}
                          className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                            shelfMode === 'fit'
                              ? 'bg-brand-600 text-white shadow-sm font-semibold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                          title="Auto-Fit: Alle Bände passen sich dynamisch an die Bildschirmbreite an"
                        >
                          <Maximize2 className="w-3.5 h-3.5" />
                          <span>Auto-Fit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSetShelfMode('rows')}
                          className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                            shelfMode === 'rows'
                              ? 'bg-brand-600 text-white shadow-sm font-semibold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                          title="Regalbretter: Mehrzeiliges Bücherregal mit Holzplanken pro Reihe"
                        >
                          <Layers className="w-3.5 h-3.5" />
                          <span>Regalbretter</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSetShelfMode('scroll')}
                          className={`px-2.5 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer ${
                            shelfMode === 'scroll'
                              ? 'bg-brand-600 text-white shadow-sm font-semibold'
                              : 'text-slate-400 hover:text-slate-200'
                          }`}
                          title="Scrollen: Klassische horizontale Leiste mit Scrollbalken"
                        >
                          <MoveHorizontal className="w-3.5 h-3.5" />
                          <span>Scrollen</span>
                        </button>
                      </div>

                      {/* Shelf Scale (S / M / L) */}
                      <div className="flex items-center bg-slate-900/90 p-0.5 rounded-xl border border-slate-800 text-xs">
                        <button
                          type="button"
                          onClick={() => handleSetShelfScale('s')}
                          className={`px-2 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                            shelfScale === 's'
                              ? 'bg-slate-700 text-white shadow-sm'
                              : 'text-slate-500 hover:text-slate-300'
                          }`}
                          title="Kompakte Ansicht (S)"
                        >
                          S
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSetShelfScale('m')}
                          className={`px-2 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                            shelfScale === 'm'
                              ? 'bg-slate-700 text-white shadow-sm'
                              : 'text-slate-500 hover:text-slate-300'
                          }`}
                          title="Standard Ansicht (M)"
                        >
                          M
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSetShelfScale('l')}
                          className={`px-2 py-1 rounded-lg font-bold text-[11px] transition-all cursor-pointer ${
                            shelfScale === 'l'
                              ? 'bg-slate-700 text-white shadow-sm'
                              : 'text-slate-500 hover:text-slate-300'
                          }`}
                          title="Große Ansicht (L)"
                        >
                          L
                        </button>
                      </div>

                      {/* Quick Scroll Left/Right arrows when in scroll mode */}
                      {shelfMode === 'scroll' && (
                        <div className="flex items-center gap-0.5 bg-slate-900/90 p-0.5 rounded-xl border border-slate-800">
                          <button
                            type="button"
                            onClick={() => scrollShelf(-350)}
                            className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
                            title="Nach links scrollen"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => scrollShelf(350)}
                            className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
                            title="Nach rechts scrollen"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Physical Shelf Container */}
                  <div className="relative bg-slate-950/70 p-4 sm:p-6 rounded-2xl border border-slate-800/80 shadow-2xl">
                    {/* MODE 1: AUTO-FIT — Single responsive row (few items) OR multi-row (many items) */}
                    {shelfMode === 'fit' && (
                      isFitMultiRow ? (
                        /* Auto-multi-row: too many books for single row → display as balanced rows */
                        <div className="space-y-5 pt-2 pb-2 px-1">
                          <div className="text-[10px] text-slate-500 mb-1 flex items-center gap-1.5">
                            <Layers className="w-3 h-3 text-slate-600" />
                            Auto-Fit: {shelfRows.length} Reihen für {spineShelfItems.length} Einträge
                          </div>
                          {shelfRows.map((row, rIdx) => (
                            <div key={rIdx} className="relative">
                              <div className="flex items-end gap-1 sm:gap-1.5 w-full pb-1">
                                {row.map((item, idx) => renderShelfSpine(item, idx, 'fit'))}
                              </div>
                              <div className="shelf-plank w-full mt-[-2px]" />
                            </div>
                          ))}
                        </div>
                      ) : (
                        /* Single-row auto-fit: few items, stretch to fill width */
                        <div className="pb-2 pt-2 px-1">
                          <div className="flex items-end gap-1 sm:gap-1.5 w-full justify-between pb-1">
                            {spineShelfItems.map((item, idx) => renderShelfSpine(item, idx, 'fit'))}
                          </div>
                          <div className="shelf-plank w-full mt-[-2px]" />
                        </div>
                      )
                    )}

                    {/* MODE 2: REGALBRETTER (Multi-tier bookcase shelves) */}
                    {shelfMode === 'rows' && (
                      <div className="space-y-5 pt-2 pb-2 px-1">
                        {shelfRows.map((row, rIdx) => (
                          <div key={rIdx} className="relative">
                            <div className="flex items-end gap-1 sm:gap-1.5 w-full pb-1">
                              {row.map((item, idx) => renderShelfSpine(item, idx, 'rows'))}
                            </div>
                            <div className="shelf-plank w-full mt-[-2px]" />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* MODE 3: SCROLL (Classic horizontal single-row with scrollbar) */}
                    {shelfMode === 'scroll' && (
                      <div 
                        ref={shelfScrollRef}
                        className="overflow-x-auto pb-2 pt-4 px-2 custom-scrollbar scroll-smooth"
                      >
                        <div className="flex items-end gap-1.5 sm:gap-2 min-w-max px-2 pb-1">
                          {spineShelfItems.map((item, idx) => renderShelfSpine(item, idx, 'scroll'))}
                        </div>
                        <div className="shelf-plank w-full mt-[-2px]" />
                      </div>
                    )}
                  </div>
                </div>
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
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 min-[1800px]:grid-cols-7 gap-3 sm:gap-3.5 mb-8">
                  {displayVolumeItems.map((item, itemIdx) => {
                    if (item.isGap) {
                      const gapMeta = item.gapMeta || mpGapMap.get(String(item.gapNumber).toLowerCase());
                      return (
                        <div 
                          key={`gap-card-${item.gapNumber}-${itemIdx}`}
                          onClick={() => canEdit && setFillingGapNumber(item.gapNumber)}
                          className={`group relative flex flex-col justify-between p-3 rounded-2xl border border-dashed border-amber-500/40 hover:border-amber-400 bg-slate-900/60 hover:bg-slate-900/90 text-sm select-none shadow-sm shadow-amber-950/20 transition-all duration-200 overflow-hidden ${
                            canEdit ? 'cursor-pointer hover:scale-[1.01]' : 'cursor-default'
                          }`}
                          title={gapMeta?.price ? `Fehlender Band ${item.gapNumber} (${gapMeta.price.toFixed(2).replace('.', ',')} €) • Klicken zum schnellen Erfassen` : `Fehlender Band ${item.gapNumber} fehlt in der Sammlung • Klicken zum Erfassen`}
                        >
                          {/* Top Row: Gap Indicator & Number & Action */}
                          <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-amber-500/20 w-full shrink-0">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <div className="w-5 h-5 rounded-lg flex items-center justify-center shrink-0 bg-amber-500/20 border border-amber-500/50 text-amber-400 font-bold text-xs">
                                +
                              </div>
                              <div className="font-bold text-amber-300 text-sm tracking-tight flex items-center gap-1.5 min-w-0">
                                <span className="truncate">Band {item.gapNumber}</span>
                                <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1 shrink-0 shadow-xs">
                                  <Sparkles className="w-2.5 h-2.5 text-amber-400" /> Fehlend
                                </span>
                              </div>
                            </div>

                            {canEdit && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFillingGapNumber(item.gapNumber);
                                }}
                                className="px-2 py-0.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-semibold flex items-center gap-1 transition-all shrink-0 cursor-pointer"
                                title="Band in Sammlung erfassen"
                              >
                                <Plus className="w-3 h-3" /> Erfassen
                              </button>
                            )}
                          </div>

                          {/* Middle: Cover Ghost / Official Image & Metadata */}
                          <div className="flex gap-2.5 items-start flex-1 py-2.5 min-w-0">
                            {gapMeta?.cover_image ? (
                              <div className="relative shrink-0 rounded-xl overflow-hidden shadow-md border border-amber-500/40 bg-slate-950 w-12 h-16 sm:w-13 sm:h-18 group-hover:scale-105 transition-transform duration-200">
                                <img 
                                  src={gapMeta.cover_image} 
                                  alt={`Band ${item.gapNumber}`}
                                  className="w-full h-full object-cover opacity-60 group-hover:opacity-85 transition-opacity"
                                  loading="lazy"
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-transparent to-transparent flex items-end justify-center p-1">
                                  <span className="text-[8px] font-black text-amber-300 uppercase tracking-wider">Lücke</span>
                                </div>
                              </div>
                            ) : (
                              <div className="w-12 h-16 sm:w-13 sm:h-18 rounded-xl border border-dashed border-amber-500/30 bg-amber-950/20 shrink-0 flex flex-col items-center justify-center text-amber-500/60 p-1">
                                <BookOpen className="w-4 h-4 mb-1 opacity-50" />
                                <span className="text-[9px] font-bold text-center leading-tight">Band {item.gapNumber}</span>
                              </div>
                            )}

                            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-amber-300 bg-amber-950/60 border border-amber-500/30 text-[10px]">
                                <AlertCircle className="w-3 h-3 text-amber-400" />
                                Lücke in Reihe
                              </span>

                              {gapMeta?.price !== undefined && gapMeta?.price !== null && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-500/30 text-[10px]">
                                  <Coins className="w-3 h-3 text-emerald-400" />
                                  {gapMeta.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                                </span>
                              )}

                              {(gapMeta?.publisher || manga.publisher) && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-slate-300 bg-slate-800/70 border border-slate-700/60 truncate max-w-[110px]" title={`Verlag: ${gapMeta?.publisher || manga.publisher}`}>
                                  <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                                  <span className="truncate">{gapMeta?.publisher || manga.publisher}</span>
                                </span>
                              )}

                              {gapMeta?.release_date && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-sky-300 bg-sky-950/60 border border-sky-500/30 text-[10px]" title={`Erscheinungsdatum: ${gapMeta.release_date}`}>
                                  <Calendar className="w-3 h-3 text-sky-400" />
                                  {gapMeta.release_date}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Bottom Row: Quick Add Prompt */}
                          <div className="w-full mt-auto pt-2 border-t border-amber-500/20 flex items-center justify-between gap-1.5 shrink-0 text-xs">
                            <span className="text-slate-400 text-[11px] flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                              {canEdit ? 'Klicken zum Erfassen' : 'Noch zu sammeln'}
                            </span>
                            {canEdit && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFillingGapNumber(item.gapNumber);
                                }}
                                className="text-amber-400 hover:text-amber-300 font-semibold text-xs flex items-center gap-1 hover:underline cursor-pointer"
                              >
                                <span>+ Zu Sammlung</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }

                    const vol = item.volume;
                    const isOwned = vol.status === 'Vorhanden';
                const effectivePublisher = (vol.publisher && vol.publisher.trim()) || (manga.publisher && manga.publisher.trim());
                const hasCover = Boolean(vol.cover_image);

                return (
                  <div 
                    key={vol.id}
                    onClick={() => canEdit && handleOpenEditVolume(vol)}
                    className={`group relative flex flex-col justify-between p-3 rounded-2xl border text-sm select-none shadow-sm transition-all duration-200 overflow-hidden ${
                      canEdit 
                        ? 'cursor-pointer' 
                        : 'cursor-default'
                    } ${
                      isOwned 
                        ? 'bg-slate-900/90 border-emerald-500/40 text-slate-100 shadow-emerald-950/20' + (canEdit ? ' hover:border-emerald-400 hover:bg-slate-850' : '') 
                        : vol.status === 'Vorbestellt'
                          ? 'bg-sky-950/30 border-sky-500/40 text-slate-100 shadow-sky-950/20' + (canEdit ? ' hover:border-sky-400 hover:bg-sky-900/30' : '')
                          : vol.status === 'Erscheint bald'
                            ? 'bg-purple-950/30 border-purple-500/40 text-slate-100 shadow-purple-950/20' + (canEdit ? ' hover:border-purple-400 hover:bg-purple-900/30' : '')
                            : 'bg-slate-950/70 border-slate-800 text-slate-400' + (canEdit ? ' hover:border-slate-700 hover:text-slate-200' : '')
                    }`}
                  >
                    {/* Top Row: Checkmark / Status + Volume Number + Actions (Full width across card) */}
                    <div className="flex items-center justify-between gap-1.5 pb-2 border-b border-slate-800/70 w-full shrink-0">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <button
                          type="button"
                          disabled={!canEdit}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (canEdit) handleToggleVolume(vol);
                          }}
                          className={`w-5 h-5 rounded-lg flex items-center justify-center transition-all shrink-0 ${
                            !canEdit ? 'cursor-default' : 'cursor-pointer'
                          } ${
                            isOwned 
                              ? 'bg-emerald-500/20 border border-emerald-500/60 text-emerald-400' + (canEdit ? ' hover:bg-emerald-500/30' : '') 
                              : vol.status === 'Vorbestellt'
                                ? 'bg-sky-500/20 border border-sky-500/60 text-sky-400' + (canEdit ? ' hover:bg-sky-500/30' : '')
                                : vol.status === 'Erscheint bald'
                                  ? 'bg-purple-500/20 border border-purple-500/60 text-purple-400' + (canEdit ? ' hover:bg-purple-500/30' : '')
                                  : 'bg-slate-800/80 border border-slate-700 text-slate-500' + (canEdit ? ' hover:border-slate-500 hover:text-slate-300' : '')
                          }`}
                          title={!canEdit ? `Status: ${vol.status || 'Fehlt'}` : `Status: ${vol.status || 'Fehlt'} (Klicken zum Umschalten)`}
                        >
                          {isOwned ? (
                            <Check className="w-3 h-3 stroke-[2.5]" />
                          ) : vol.status === 'Vorbestellt' ? (
                            <Truck className="w-3 h-3" />
                          ) : vol.status === 'Erscheint bald' ? (
                            <Calendar className="w-3 h-3" />
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                          )}
                        </button>
                        <div 
                          className="font-bold text-white text-sm tracking-tight flex items-center gap-1.5 min-w-0 overflow-hidden"
                          title={getVolumeDisplayTitle(vol)}
                        >
                          {vol.type === 'schuber' || String(vol.volume_number).toLowerCase().includes('schuber') ? (
                            <>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-indigo-500/25 text-indigo-300 border border-indigo-500/40 flex items-center gap-1 shrink-0 shadow-sm">
                                <Package className="w-2.5 h-2.5 text-indigo-400" /> Schuber
                              </span>
                              <span className="truncate">{String(vol.volume_number).replace(/schuber\s*/i, '')}</span>
                            </>
                          ) : vol.type === 'special_edition' || (
                            vol.type !== 'schuber' && (
                              String(vol.volume_number).toLowerCase().includes('special edition') ||
                              String(vol.volume_number).toLowerCase().includes('limited edition') ||
                              String(vol.volume_number).toLowerCase().includes('spezial edition') ||
                              (vol.notes && (vol.notes.toLowerCase().includes('special edition') || vol.notes.toLowerCase().includes('limited edition')))
                            )
                          ) ? (
                            <>
                              <span className="shrink-0 font-bold">
                                {(() => {
                                  const rawNum = String(vol.volume_number || '');
                                  const cleaned = rawNum.replace(/special\s*edition|limited\s*edition|spezial\s*edition/gi, '').trim();
                                  const match = (cleaned || rawNum).match(/\d+(\.\d+)?/);
                                  return match ? `Band ${match[0]}` : (cleaned || rawNum || 'Special');
                                })()}
                              </span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-fuchsia-500/25 text-fuchsia-300 border border-fuchsia-500/40 flex items-center gap-1 shrink-0 shadow-sm">
                                <Sparkles className="w-2.5 h-2.5 text-fuchsia-400" /> Special Edition
                              </span>
                            </>
                          ) : vol.type === 'special' || String(vol.volume_number).toLowerCase().includes('special') || String(vol.volume_number).toLowerCase().includes('extra') ? (
                            <>
                              <span className="text-[10px] px-1.5 py-0.5 rounded-md font-bold bg-amber-500/25 text-amber-300 border border-amber-500/40 flex items-center gap-1 shrink-0 shadow-sm">
                                <Sparkles className="w-2.5 h-2.5 text-amber-400" /> Special
                              </span>
                              <span className="truncate">{String(vol.volume_number).replace(/special\s*|extra\s*|sonderband\s*/i, '')}</span>
                            </>
                          ) : (
                            <span className="truncate">Band {vol.volume_number}</span>
                          )}
                        </div>
                      </div>

                      {canEdit && (
                        <div className="flex items-center gap-0.5 opacity-80 group-hover:opacity-100 transition-opacity shrink-0">
                          {!hasCover && (
                            <button
                              type="button"
                              onClick={(e) => handleOpenEditVolume(vol, e)}
                              className="p-1 text-slate-500 hover:text-brand-300 hover:bg-slate-800 rounded-md transition-all"
                              title="Foto für Band hochladen"
                            >
                              <Camera className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => handleOpenEditVolume(vol, e)}
                            className="p-1 text-slate-400 hover:text-brand-300 hover:bg-slate-800 rounded-md transition-all"
                            title="Band-Details & Fotos bearbeiten"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteVolume(e, vol.id)}
                            className="p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/20 rounded-md transition-all"
                            title="Band löschen"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Middle: Harmonious Cover Thumbnail + Badges */}
                    <div className="flex gap-2.5 items-start flex-1 py-2.5 min-w-0">
                      {hasCover && (
                        <div 
                          className="relative shrink-0 group/cover rounded-xl overflow-hidden shadow-md border border-slate-700/80 bg-slate-950 cursor-pointer"
                          onClick={(e) => {
                            e.stopPropagation();
                            openVolumeGallery(vol);
                          }}
                          title="Klicken zum Öffnen der Fotogalerie"
                        >
                          <img 
                            src={vol.cover_image} 
                            alt={getVolumeDisplayTitle(vol)} 
                            className="w-12 h-16 sm:w-13 sm:h-18 object-cover group-hover/cover:scale-105 transition-transform duration-200" 
                            loading="lazy"
                            onError={(e) => {
                              e.currentTarget.onerror = null;
                              e.currentTarget.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="150" viewBox="0 0 100 150" fill="%231e293b"><rect width="100" height="150" fill="%230f172a"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-size="10" font-family="sans-serif">Kein Bild</text></svg>';
                            }}
                          />
                          {vol.images && vol.images.length > 1 && (
                            <span className="absolute bottom-1 right-1 bg-black/85 text-brand-300 font-mono text-[9px] px-1.5 py-0.5 rounded-md font-bold shadow flex items-center gap-1 border border-brand-500/30 backdrop-blur-xs">
                              <Camera className="w-2.5 h-2.5 text-brand-400" />
                              {vol.images.length}
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-[11px]">
                        {vol.status === 'Vorbestellt' ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-sky-300 bg-sky-950/70 border border-sky-500/40 text-[10px]">
                            <Truck className="w-3 h-3 text-sky-400" />
                            Vorbestellt
                          </span>
                        ) : vol.status === 'Erscheint bald' ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-purple-300 bg-purple-950/70 border border-purple-500/40 text-[10px]">
                            <Calendar className="w-3 h-3 text-purple-400" />
                            Erscheint bald
                          </span>
                        ) : null}

                        {vol.release_date ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono text-sky-300 bg-sky-950/60 border border-sky-500/30 text-[10px]" title={`Erscheinungsdatum: ${vol.release_date}`}>
                            <Calendar className="w-3 h-3 text-sky-400" />
                            {vol.release_date}
                          </span>
                        ) : null}

                        {vol.price !== null && vol.price !== undefined ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-500/30">
                            <Coins className="w-3 h-3 text-emerald-400" />
                            {vol.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </span>
                        ) : null}

                        {effectivePublisher ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-slate-300 bg-slate-800/70 border border-slate-700/60 truncate max-w-[110px]" title={`Verlag: ${effectivePublisher}`}>
                            <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                            <span className="truncate">{effectivePublisher}</span>
                          </span>
                        ) : null}

                        {vol.condition ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-amber-300 bg-amber-950/50 border border-amber-500/30 truncate" title={`Zustand: ${vol.condition}`}>
                            {vol.condition}
                          </span>
                        ) : null}

                        {vol.release_year ? (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-slate-400 bg-slate-900 border border-slate-800 font-mono" title={`Erscheinungsjahr: ${vol.release_year}`}>
                            <Calendar className="w-3 h-3 text-slate-500" />
                            {vol.release_year}
                          </span>
                        ) : null}

                        {vol.pages ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-slate-400 bg-slate-900 border border-slate-800 text-[10px]" title={`${vol.pages} Seiten`}>
                            {vol.pages} S.
                          </span>
                        ) : null}

                        {vol.isbn ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md text-sky-400 bg-sky-950/40 border border-sky-500/20 font-mono text-[10px]" title={`ISBN: ${vol.isbn}`}>
                            ISBN
                          </span>
                        ) : null}

                        {vol.notes ? (
                          <span className="inline-flex items-center px-1 py-0.5 rounded text-slate-400 hover:text-white" title={`Notiz: ${vol.notes}`}>
                            <FileText className="w-3 h-3 text-brand-400" />
                          </span>
                        ) : null}

                        {vol.images && vol.images.length > 1 && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openVolumeGallery(vol); }}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-brand-300 bg-brand-950/60 border border-brand-500/30 text-[10px] hover:bg-brand-900/80 transition-colors font-medium cursor-pointer"
                            title="Fotogalerie öffnen"
                          >
                            <Camera className="w-3 h-3 text-brand-400" />
                            <span>{vol.images.length} Fotos</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Bottom Row: Reading Status & Non-overlapping Multi-User Markers */}
                    {isOwned && (
                      <div className="w-full mt-auto pt-2 border-t border-slate-800/80 flex items-center justify-between gap-1.5 shrink-0">
                        {(() => {
                          const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
                          const isRead = vol.read_users 
                            ? vol.read_users.some(u => String(u.user_id || u.id) === String(effUserId)) 
                            : (Boolean(vol.is_read) && String(effUserId) === String(user?.id));
                          const canToggleStatus = canEdit;

                          return (
                            <button
                              type="button"
                              disabled={!canToggleStatus}
                              onClick={(e) => {
                                if (canToggleStatus) handleToggleVolumeRead(vol, effUserId, e);
                              }}
                              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-semibold transition-all shrink-0 ${
                                !canToggleStatus ? 'cursor-default opacity-80' : 'cursor-pointer'
                              } ${
                                isRead
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' + (canToggleStatus ? ' hover:bg-emerald-500/30' : '')
                                  : 'bg-slate-800/60 text-slate-400 border border-slate-700/60' + (canToggleStatus ? ' hover:text-slate-200 hover:border-slate-600' : '')
                              }`}
                              title={!canToggleStatus ? `Lesestatus: ${isRead ? 'Gelesen' : 'Ungelesen'} (Nur Leseansicht)` : 'Lesestatus umschalten (Gelesen / Ungelesen)'}
                            >
                              <BookCheck className={`w-3.5 h-3.5 ${isRead ? 'text-emerald-400' : 'text-slate-500'}`} />
                              <span>{isRead ? 'Gelesen' : 'Ungelesen'}</span>
                            </button>
                          );
                        })()}

                        {/* Reader Badges: Dynamic, non-overlapping, with clear tooltip */}
                        {readers.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap justify-end">
                            {readers.map(r => {
                              const isReaderDone = vol.read_users 
                                ? vol.read_users.some(u => String(u.user_id || u.id) === String(r.user_id))
                                : (Boolean(vol.is_read) && String(r.user_id) === String(user?.id));
                              const initial = (r.display_name || r.username || '?').charAt(0).toUpperCase();
                              const canToggleReader = canEdit;

                              return (
                                <button
                                  key={r.user_id}
                                  type="button"
                                  disabled={!canToggleReader}
                                  onClick={(e) => {
                                    if (canToggleReader) {
                                      handleToggleVolumeRead(vol, r.user_id, e);
                                    }
                                  }}
                                  className={`relative w-5 h-5 sm:w-6 sm:h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                                    canToggleReader ? 'cursor-pointer hover:scale-110' : 'cursor-default'
                                  } ${
                                    isReaderDone
                                      ? 'bg-emerald-500/25 border border-emerald-400/70 text-emerald-300 shadow-sm shadow-emerald-950/40'
                                      : 'bg-slate-900 border border-slate-800 text-slate-500'
                                  }`}
                                  title={`${r.display_name || r.username}: ${isReaderDone ? 'Gelesen ✓' : 'Noch ungelesen'}${canToggleReader ? ' (Klicken zum Umschalten)' : ''}`}
                                >
                                  <span>{initial}</span>
                                  <span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-slate-900 ${
                                    isReaderDone ? 'bg-emerald-400' : 'bg-slate-600'
                                  }`} />
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
              )}
            </>
          )}

          {/* Add Single Volume / Schuber Bar */}
          {canEdit && (
            <form onSubmit={handleAddSingleVolume} className="pt-6 border-t border-slate-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div>
                <span className="text-xs font-semibold text-slate-300 uppercase tracking-wider block flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5 text-brand-400" />
                  Band, Special Edition oder Schuber hinzufügen
                </span>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Typ (Einzelband, Special Edition, Schuber oder Special), Nummer, Status und optional Preis oder Coverfoto eingeben
                </p>
              </div>
              
              <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto">
                {/* Type Selection */}
                <div className="w-36 sm:w-40 shrink-0">
                  <select 
                    className="input-field bg-slate-950 text-sm py-2 px-2.5 w-full cursor-pointer font-medium"
                    value={newVolumeType}
                    onChange={e => setNewVolumeType(e.target.value)}
                  >
                    <option value="volume">📖 Einzelband</option>
                    <option value="special_edition">✨ Special Edition</option>
                    <option value="schuber">📦 Schuber</option>
                    <option value="special">⭐ Special / Extra</option>
                  </select>
                </div>

                <div className="w-28 sm:w-32 shrink-0">
                  <input 
                    type="text" 
                    placeholder={
                      newVolumeType === 'schuber' ? 'Schuber-Nr. (z.B. 1)' :
                      newVolumeType === 'special_edition' ? 'Band-Nr. (z.B. 1)' :
                      newVolumeType === 'special' ? 'Bezeichnung (z.B. 1)' :
                      'Band-Nr. (z.B. 11)'
                    }
                    className="input-field text-sm py-2 px-3 w-full font-medium" 
                    value={newVolumeNum} 
                    onChange={e => setNewVolumeNum(e.target.value)} 
                  />
                </div>

                <div className="w-28 sm:w-32 shrink-0">
                  <input 
                    type="text" 
                    placeholder="Preis (€, z.B. 7.99)" 
                    className="input-field text-sm py-2 px-3 w-full font-mono text-emerald-400" 
                    value={newVolumePrice} 
                    onChange={e => setNewVolumePrice(e.target.value)} 
                  />
                </div>

                {/* Status Selection */}
                <div className="w-36 sm:w-40 shrink-0">
                  <select 
                    className="input-field bg-slate-950 text-sm py-2 px-2.5 w-full cursor-pointer font-medium"
                    value={newVolumeStatus}
                    onChange={e => setNewVolumeStatus(e.target.value)}
                  >
                    <option value="Vorhanden">✓ Im Besitz</option>
                    <option value="Vorbestellt">📦 Vorbestellt</option>
                    <option value="Erscheint bald">⏳ Erscheint bald</option>
                    <option value="Fehlt">✕ Fehlt noch</option>
                  </select>
                </div>

                {/* Release Date for Radar */}
                <div className="w-36 sm:w-40 shrink-0" title="Erscheinungsdatum (für Release-Radar)">
                  <input 
                    type="date" 
                    className="input-field text-sm py-2 px-2.5 w-full font-mono bg-slate-950" 
                    value={newVolumeReleaseDate} 
                    onChange={e => setNewVolumeReleaseDate(e.target.value)} 
                  />
                </div>

                {/* Optional Cover upload for new volume */}
                <label className="cursor-pointer btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 shrink-0" title="Foto/Cover für diesen Band auswählen">
                  <Camera className="w-3.5 h-3.5 text-brand-400" />
                  <span>{uploadingNewCover ? 'Lädt...' : (newVolumeCover ? '✓ Foto' : 'Foto')}</span>
                  <input 
                    type="file" 
                    accept="image/*" 
                    className="hidden" 
                    onChange={e => {
                      if (e.target.files && e.target.files[0]) {
                        handleUploadNewSingleCover(e.target.files[0]);
                      }
                    }} 
                  />
                </label>

                {newVolumeCover && (
                  <div className="relative group shrink-0">
                    <img src={newVolumeCover} alt="Cover" className="w-8 h-8 rounded-lg object-cover border border-brand-500" />
                    <button 
                      type="button" 
                      onClick={() => setNewVolumeCover('')} 
                      className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-0.5 text-[8px]"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                )}

                <button 
                  type="submit" 
                  className="btn-primary text-sm py-2 px-4 flex items-center gap-1.5 shadow-lg shrink-0"
                >
                  <Plus className="w-4 h-4" /> Hinzufügen
                </button>
              </div>
            </form>
          )}

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
