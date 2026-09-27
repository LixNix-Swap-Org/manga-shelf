import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, Edit3, Image as ImageIcon, Check, Plus, 
  Trash2, BookOpen, Layers, Sparkles, CheckCircle2, 
  Upload, X, AlertCircle, Save, Coins, Tag, Calendar, 
  FileText, Filter, ArrowUpDown, Info, Bookmark, Hash, 
  Building2, Search, SlidersHorizontal, ChevronDown,
  Star, Maximize2, Camera, Link as LinkIcon,
  BookCheck, CheckCheck, Package
} from 'lucide-react';

export default function MangaDetail({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  // Role permissions (visitor / guest are read-only)
  const isVisitor = !user || user.role === 'visitor' || user.role === 'guest';
  const canEdit = user && (user.role === 'admin' || user.role === 'editor');

  const [manga, setManga] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Filters & Sorting for Volumes
  const [volumeFilter, setVolumeFilter] = useState('ALL'); // 'ALL' | 'Vorhanden' | 'Fehlt' | 'Gelesen' | 'Ungelesen'
  const [volumeTypeFilter, setVolumeTypeFilter] = useState('ALL'); // 'ALL' | 'volume' | 'special_edition' | 'schuber' | 'special'
  const [selectedReaderId, setSelectedReaderId] = useState(user?.id || 'ALL');
  const [showBatchReadModal, setShowBatchReadModal] = useState(false);
  const [batchReadUpTo, setBatchReadUpTo] = useState('');
  const [batchReadAction, setBatchReadAction] = useState(true); // true = gelesen, false = ungelesen
  const [volumePublisherFilter, setVolumePublisherFilter] = useState('ALL');
  const [volumeConditionFilter, setVolumeConditionFilter] = useState('ALL');
  const [volumeSort, setVolumeSort] = useState('number_asc');
  const [volumeSearch, setVolumeSearch] = useState('');

  // Edit form state
  const [formData, setFormData] = useState({});

  // Single volume add state
  const [newVolumeType, setNewVolumeType] = useState('volume'); // 'volume' | 'special_edition' | 'schuber' | 'special'
  const [newVolumeNum, setNewVolumeNum] = useState('');
  const [newVolumeStatus, setNewVolumeStatus] = useState('Vorhanden');
  const [newVolumePrice, setNewVolumePrice] = useState('');
  const [newVolumePublisher, setNewVolumePublisher] = useState('');
  const [newVolumeCover, setNewVolumeCover] = useState('');
  const [uploadingNewCover, setUploadingNewCover] = useState(false);

  // Volume Detail & Edit Modal
  const [activeVolume, setActiveVolume] = useState(null);
  const [editVolForm, setEditVolForm] = useState({});
  const [savingVol, setSavingVol] = useState(false);
  const [uploadingVolImage, setUploadingVolImage] = useState(false);
  const [previewImage, setPreviewImage] = useState(null); // Lightbox
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [manualImageUrl, setManualImageUrl] = useState('');

  // Batch add state
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchFrom, setBatchFrom] = useState('1');
  const [batchTo, setBatchTo] = useState('10');
  const [batchStatus, setBatchStatus] = useState('Vorhanden');
  const [batchPrice, setBatchPrice] = useState('');
  const [batchPublisher, setBatchPublisher] = useState('');
  const [batchCondition, setBatchCondition] = useState('');
  const [batchReleaseYear, setBatchReleaseYear] = useState('');

  // Cover upload state
  const [uploadingCover, setUploadingCover] = useState(false);
  const [failedCover, setFailedCover] = useState(false);

  useEffect(() => {
    fetchManga();
  }, [id]);

  const fetchManga = async () => {
    try {
      setLoading(true);
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
          cover_image: data.cover_image || ''
        });
      } else if (res.status === 404) {
        navigate('/');
      }
    } catch (e) {
      console.error(e);
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
          body: JSON.stringify({ ...formData, cover_image: data.url })
        });
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
          price: newVolumePrice ? newVolumePrice.trim() : null,
          publisher: newVolumePublisher ? newVolumePublisher.trim() : null,
          cover_image: newVolumeCover || null,
          images: newVolumeCover ? [newVolumeCover] : []
        })
      });
      if (res.ok) {
        setNewVolumeNum('');
        setNewVolumePrice('');
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

  const handleAddImageUrl = () => {
    if (!canEdit || !manualImageUrl.trim()) return;
    const url = manualImageUrl.trim();
    const currentImages = editVolForm.images || [];
    setEditVolForm(prev => ({
      ...prev,
      images: [...currentImages, url],
      cover_image: prev.cover_image || url
    }));
    setManualImageUrl('');
    setShowUrlInput(false);
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

  const handleBatchAdd = async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    try {
      const res = await fetch('/api/volumes/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: id,
          from: batchFrom,
          to: batchTo,
          status: batchStatus,
          default_price: batchPrice ? batchPrice.trim() : null,
          publisher: batchPublisher ? batchPublisher.trim() : null,
          condition: batchCondition ? batchCondition.trim() : null,
          release_year: batchReleaseYear ? batchReleaseYear.trim() : null
        })
      });
      if (res.ok) {
        setShowBatchModal(false);
        setBatchPrice('');
        setBatchPublisher('');
        setBatchCondition('');
        setBatchReleaseYear('');
        await fetchManga();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Hinzufügen mehrerer Bände');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    }
  };

  const handleToggleVolume = async (vol) => {
    if (!canEdit) return;
    const nextStatus = vol.status === 'Vorhanden' ? 'Fehlt' : 'Vorhanden';
    try {
      const res = await fetch(`/api/volumes/${vol.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...vol, status: nextStatus })
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

  const handleBatchRead = async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    if (!batchReadUpTo || isNaN(parseFloat(batchReadUpTo))) {
      alert('Bitte eine gültige Band-Nummer eingeben');
      return;
    }
    try {
      const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
      const res = await fetch('/api/volumes/batch-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: id,
          up_to_volume: parseFloat(batchReadUpTo),
          is_read: batchReadAction,
          user_id: effUserId
        })
      });
      if (res.ok) {
        setShowBatchReadModal(false);
        setBatchReadUpTo('');
        await fetchManga();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Aktualisieren des Lesestatus');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    }
  };

  const handleOpenEditVolume = (vol, e) => {
    if (e) e.stopPropagation();
    if (!canEdit) return;
    setActiveVolume(vol);
    const volImages = Array.isArray(vol.images) 
      ? vol.images 
      : (vol.cover_image ? [vol.cover_image] : []);
    const detectedType = vol.type || (
      String(vol.volume_number).toLowerCase().includes('schuber') ? 'schuber' :
      String(vol.volume_number).toLowerCase().includes('special edition') || String(vol.volume_number).toLowerCase().includes('limited edition') || String(vol.volume_number).toLowerCase().includes('spezial edition') || (vol.notes && (vol.notes.toLowerCase().includes('special edition') || vol.notes.toLowerCase().includes('limited edition'))) ? 'special_edition' :
      String(vol.volume_number).toLowerCase().includes('special') || String(vol.volume_number).toLowerCase().includes('extra') || String(vol.volume_number).toLowerCase().includes('sonderband') ? 'special' :
      'volume'
    );
    setEditVolForm({
      type: detectedType,
      volume_number: vol.volume_number || '',
      status: vol.status || 'Vorhanden',
      price: vol.price !== null && vol.price !== undefined ? String(vol.price) : '',
      publisher: vol.publisher || '',
      condition: vol.condition || '',
      release_year: vol.release_year ? String(vol.release_year) : '',
      pages: vol.pages ? String(vol.pages) : '',
      isbn: vol.isbn || '',
      purchase_date: vol.purchase_date || '',
      notes: vol.notes || '',
      cover_image: vol.cover_image || (volImages.length > 0 ? volImages[0] : ''),
      images: volImages
    });
    setShowUrlInput(false);
    setManualImageUrl('');
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
        setActiveVolume(null);
        await fetchManga();
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
        if (activeVolume?.id === volId) setActiveVolume(null);
        await fetchManga();
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-slate-400 gap-3">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-sm">Lade Manga-Details...</p>
      </div>
    );
  }

  if (!manga) return null;

  const volumes = manga.volumes || [];
  const ownedCount = volumes.filter(v => v.status === 'Vorhanden').length;
  const missingCount = volumes.filter(v => v.status === 'Fehlt').length;
  const totalTarget = manga.total_volumes || 0;
  const completionPct = totalTarget > 0 ? Math.min(100, Math.round((ownedCount / totalTarget) * 100)) : null;

  // Total value calculation
  const totalOwnedValue = manga.total_value !== undefined ? manga.total_value : volumes
    .filter(v => v.status === 'Vorhanden')
    .reduce((sum, v) => sum + (typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0)), 0);

  const totalPossibleValue = manga.full_value !== undefined ? manga.full_value : volumes
    .reduce((sum, v) => sum + (typeof v.price === 'number' ? v.price : (parseFloat(v.price) || 0)), 0);

  // Readers stats
  const readers = manga.user_reading_stats || [];
  const currentReaderStats = readers.find(r => String(r.user_id) === String(selectedReaderId)) || readers.find(r => String(r.user_id) === String(user?.id)) || null;
  const currentReaderReadCount = currentReaderStats ? currentReaderStats.read_count : volumes.filter(v => v.is_read).length;
  const currentReaderUnreadCount = currentReaderStats ? currentReaderStats.unread_count : Math.max(0, ownedCount - currentReaderReadCount);

  // Available publishers for filtering (from volumes and manga)
  const availablePublishers = Array.from(new Set(
    volumes.map(v => (v.publisher && v.publisher.trim()) || (manga.publisher && manga.publisher.trim())).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  // Available conditions
  const conditionsList = ['Neuwertig', 'Sehr gut', 'Gut', 'Akzeptabel', 'Mängelexemplar'];

  const getVolumeSortInfo = (vol) => {
    const rawType = vol.type || (
      String(vol.volume_number).toLowerCase().includes('schuber') ? 'schuber' :
      String(vol.volume_number).toLowerCase().includes('special edition') || String(vol.volume_number).toLowerCase().includes('limited edition') || String(vol.volume_number).toLowerCase().includes('spezial edition') || (vol.notes && (vol.notes.toLowerCase().includes('special edition') || vol.notes.toLowerCase().includes('limited edition'))) ? 'special_edition' :
      String(vol.volume_number).toLowerCase().includes('special') || String(vol.volume_number).toLowerCase().includes('extra') || String(vol.volume_number).toLowerCase().includes('sonderband') ? 'special' :
      'volume'
    );
    
    // Check for number in volume_number
    const match = String(vol.volume_number).match(/(\d+(\.\d+)?)/);
    const num = match ? parseFloat(match[1]) : (parseFloat(vol.volume_number) || 999999);
    
    let rank = 1;
    let subRank = 0;
    if (rawType === 'volume') {
      rank = 1;
      subRank = 0;
    } else if (rawType === 'special_edition') {
      if (match) {
        rank = 1;
        subRank = 1;
      } else {
        rank = 1.5;
        subRank = 1;
      }
    } else if (rawType === 'schuber') {
      rank = 2;
      subRank = 2;
    } else if (rawType === 'special') {
      rank = 3;
      subRank = 3;
    } else if (isNaN(parseFloat(vol.volume_number)) && !match) {
      rank = 4;
      subRank = 4;
    }

    return { rank, num, subRank, raw: String(vol.volume_number), type: rawType };
  };

  const getVolumeDisplayTitle = (vol) => {
    const type = vol.type || (
      String(vol.volume_number).toLowerCase().includes('schuber') ? 'schuber' :
      String(vol.volume_number).toLowerCase().includes('special edition') || String(vol.volume_number).toLowerCase().includes('limited edition') || String(vol.volume_number).toLowerCase().includes('spezial edition') || (vol.notes && (vol.notes.toLowerCase().includes('special edition') || vol.notes.toLowerCase().includes('limited edition'))) ? 'special_edition' :
      String(vol.volume_number).toLowerCase().includes('special') || String(vol.volume_number).toLowerCase().includes('extra') || String(vol.volume_number).toLowerCase().includes('sonderband') ? 'special' :
      'volume'
    );
    const numStr = String(vol.volume_number || '').trim();
    if (type === 'schuber') {
      return numStr.toLowerCase().startsWith('schuber') ? numStr : `Schuber ${numStr}`;
    }
    if (type === 'special_edition') {
      return (numStr.toLowerCase().includes('special edition') || numStr.toLowerCase().includes('limited edition') || numStr.toLowerCase().includes('spezial edition'))
        ? numStr
        : `Band ${numStr} (Special Edition)`;
    }
    if (type === 'special') {
      return (numStr.toLowerCase().startsWith('special') || numStr.toLowerCase().startsWith('extra') || numStr.toLowerCase().startsWith('sonderband')) 
        ? numStr 
        : `Special ${numStr}`;
    }
    return numStr.toLowerCase().startsWith('band') ? numStr : `Band ${numStr}`;
  };

  const schuberCount = volumes.filter(v => v.type === 'schuber' || String(v.volume_number).toLowerCase().includes('schuber')).length;
  const specialEditionCount = volumes.filter(v => v.type === 'special_edition' || (
    v.type !== 'schuber' && (
      String(v.volume_number).toLowerCase().includes('special edition') ||
      String(v.volume_number).toLowerCase().includes('limited edition') ||
      String(v.volume_number).toLowerCase().includes('spezial edition') ||
      (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition')))
    )
  )).length;
  const specialCount = volumes.filter(v => {
    if (v.type === 'special_edition' || v.type === 'schuber') return false;
    const vLower = String(v.volume_number).toLowerCase();
    if (vLower.includes('special edition') || vLower.includes('limited edition') || vLower.includes('spezial edition') || vLower.includes('schuber')) return false;
    return v.type === 'special' || vLower.includes('special') || vLower.includes('extra') || vLower.includes('sonderband');
  }).length;
  const regularVolumeCount = volumes.filter(v => {
    const isSchuber = v.type === 'schuber' || String(v.volume_number).toLowerCase().includes('schuber');
    const isSpecialEd = v.type === 'special_edition' || (
      String(v.volume_number).toLowerCase().includes('special edition') ||
      String(v.volume_number).toLowerCase().includes('limited edition') ||
      String(v.volume_number).toLowerCase().includes('spezial edition') ||
      (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition')))
    );
    const isSpecial = v.type === 'special' || String(v.volume_number).toLowerCase().includes('special') || String(v.volume_number).toLowerCase().includes('extra') || String(v.volume_number).toLowerCase().includes('sonderband');
    return !isSchuber && !isSpecialEd && !isSpecial;
  }).length;

  // Filter & sort volumes
  const filteredVolumes = volumes
    .filter(v => {
      const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
      const isReadByTarget = v.read_users 
        ? v.read_users.some(u => String(u.user_id) === String(effUserId))
        : (Boolean(v.is_read) && String(effUserId) === String(user?.id));

      if (volumeFilter === 'Vorhanden' && v.status !== 'Vorhanden') return false;
      if (volumeFilter === 'Fehlt' && v.status !== 'Fehlt') return false;
      if (volumeFilter === 'Gelesen' && !isReadByTarget) return false;
      if (volumeFilter === 'Ungelesen') {
        if (v.status !== 'Vorhanden' || isReadByTarget) return false;
      }

      if (volumeTypeFilter !== 'ALL') {
        const t = v.type || (
          String(v.volume_number).toLowerCase().includes('schuber') ? 'schuber' :
          String(v.volume_number).toLowerCase().includes('special edition') || String(v.volume_number).toLowerCase().includes('limited edition') || String(v.volume_number).toLowerCase().includes('spezial edition') || (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition'))) ? 'special_edition' :
          String(v.volume_number).toLowerCase().includes('special') || String(v.volume_number).toLowerCase().includes('extra') || String(v.volume_number).toLowerCase().includes('sonderband') ? 'special' :
          'volume'
        );
        if (t !== volumeTypeFilter) return false;
      }
      
      if (volumePublisherFilter !== 'ALL') {
        const pub = (v.publisher && v.publisher.trim()) || (manga.publisher && manga.publisher.trim()) || '';
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
        const pubMatch = ((v.publisher || manga.publisher || '')).toLowerCase().includes(q);
        if (!numMatch && !isbnMatch && !notesMatch && !pubMatch) return false;
      }

      return true;
    })
    .sort((a, b) => {
      const infoA = getVolumeSortInfo(a);
      const infoB = getVolumeSortInfo(b);
      const priceA = a.price !== null && a.price !== undefined ? a.price : -1;
      const priceB = b.price !== null && b.price !== undefined ? b.price : -1;
      const pubA = ((a.publisher && a.publisher.trim()) || (manga.publisher && manga.publisher.trim()) || '').toLowerCase();
      const pubB = ((b.publisher && b.publisher.trim()) || (manga.publisher && manga.publisher.trim()) || '').toLowerCase();
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

  return (
    <div className="min-h-screen pb-20">
      {/* Top Bar */}
      <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-6 pb-4">
        <Link 
          to="/" 
          className="inline-flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium bg-slate-900/60 hover:bg-slate-800/80 px-3.5 py-2 rounded-xl border border-slate-800 shadow-sm"
        >
          <ArrowLeft className="w-4 h-4 text-brand-400" /> Zurück zur Übersicht
        </Link>
      </div>

      {/* Main Container */}
      <div className="max-w-6xl mx-auto px-4 sm:px-8">
        
        {/* Hero Card */}
        <div className="glass-panel p-6 sm:p-8 rounded-3xl border border-slate-800/80 shadow-2xl flex flex-col md:flex-row gap-8 mb-8 relative overflow-hidden">
          
          {/* Subtle glow background */}
          <div className="absolute top-0 right-0 w-96 h-96 bg-brand-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20"></div>

          {/* Cover Column */}
          <div className="w-full md:w-64 shrink-0 flex flex-col items-center">
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
                    <label className="block text-xs font-semibold text-slate-400 mb-1">Titel</label>
                    <input 
                      type="text" 
                      className="input-field" 
                      required
                      value={formData.title} 
                      onChange={e => setFormData({ ...formData, title: e.target.value })} 
                    />
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
                      style={{ width: `${completionPct !== null ? completionPct : Math.min(100, ownedCount * 5)}%` }}
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
                  onClick={() => {
                    setBatchReadUpTo('');
                    setBatchReadAction(true);
                    setShowBatchReadModal(true);
                  }} 
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

          {/* Filter & Sort Controls */}
          <div className="flex flex-col gap-3 mb-6 p-3.5 bg-slate-950/70 rounded-2xl border border-slate-800/80">
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
                  ✕ Fehlt noch ({missingCount})
                </button>
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
                  Alle ({volumes.length})
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
          {filteredVolumes.length === 0 ? (
            <div className="p-8 text-center bg-slate-950/40 rounded-2xl border border-slate-800/60 my-4">
              <BookOpen className="w-8 h-8 text-slate-600 mx-auto mb-2" />
              <p className="text-sm text-slate-400">
                {volumes.length === 0 
                  ? 'Noch keine Bände erfasst. Nutze untenstehendes Feld oder "Mehrere Bände", um loszulegen.' 
                  : 'Keine Bände mit diesen Filtereinstellungen gefunden.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mb-8">
              {filteredVolumes.map(vol => {
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
                              : 'bg-slate-800/80 border border-slate-700 text-slate-500' + (canEdit ? ' hover:border-slate-500 hover:text-slate-300' : '')
                          }`}
                          title={!canEdit ? (isOwned ? 'Status: Im Besitz' : 'Status: Fehlt') : (isOwned ? 'Status: Im Besitz (Klicken zum Umschalten)' : 'Status: Fehlt (Klicken zum Umschalten)')}
                        >
                          {isOwned ? <Check className="w-3 h-3 stroke-[2.5]" /> : <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>}
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
                          className="relative shrink-0 group/cover rounded-xl overflow-hidden shadow-md border border-slate-700/80 bg-slate-950 cursor-zoom-in"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewImage(vol.cover_image);
                          }}
                          title="Klicken zum Vergrößern"
                        >
                          <img 
                            src={vol.cover_image} 
                            alt={getVolumeDisplayTitle(vol)} 
                            className="w-12 h-16 sm:w-13 sm:h-18 object-cover group-hover/cover:scale-105 transition-transform duration-200" 
                            loading="lazy"
                          />
                          {vol.images && vol.images.length > 1 && (
                            <span className="absolute bottom-1 right-1 bg-black/80 text-white font-mono text-[9px] px-1 py-0.2 rounded-md font-bold shadow flex items-center gap-0.5">
                              <Camera className="w-2.5 h-2.5" />
                              {vol.images.length}
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 text-[11px]">
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

                {/* Status Toggle Switch */}
                <div className="inline-flex p-1 bg-slate-950 rounded-xl border border-slate-800 shrink-0 gap-1 shadow-inner">
                  <button
                    type="button"
                    onClick={() => setNewVolumeStatus('Vorhanden')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 select-none ${
                      newVolumeStatus === 'Vorhanden'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/40 ring-1 ring-emerald-500/30'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[2.5]" />
                    <span>Im Besitz</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewVolumeStatus('Fehlt')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 select-none ${
                      newVolumeStatus === 'Fehlt'
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/40 ring-1 ring-rose-500/30'
                        : 'text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    <X className="w-3.5 h-3.5 text-rose-400 stroke-[2.5]" />
                    <span>Fehlt</span>
                  </button>
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

      {/* VOLUME DETAIL & EDIT MODAL */}
      {activeVolume && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in overflow-y-auto">
          <div className="glass-panel w-full max-w-lg rounded-3xl p-6 border border-slate-700/80 shadow-2xl relative my-8">
            {/* Modal Header */}
            <div className="flex items-center justify-between mb-5 pb-3 border-b border-slate-800">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  {editVolForm.type === 'schuber' ? <Package className="w-5 h-5 text-indigo-400" /> :
                   editVolForm.type === 'special_edition' ? <Sparkles className="w-5 h-5 text-fuchsia-400" /> :
                   editVolForm.type === 'special' ? <Sparkles className="w-5 h-5 text-amber-400" /> :
                   <Layers className="w-5 h-5 text-brand-400" />}
                  {editVolForm.type === 'schuber' ? 'Schuber ' : 
                   editVolForm.type === 'special_edition' ? 'Special Edition ' :
                   editVolForm.type === 'special' ? 'Special ' : 'Band '} 
                  {String(editVolForm.volume_number || activeVolume.volume_number).replace(/schuber\s*|special\s*edition\s*|limited\s*edition\s*|spezial\s*edition\s*|special\s*|extra\s*/i, '')} bearbeiten
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Typ, Details, Preis und Sammlerangaben für diesen Eintrag
                </p>
              </div>
              <button 
                onClick={() => setActiveVolume(null)} 
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveVolume} className="space-y-4">
              {/* Row 1: Type & Volume Number */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5">
                <div className="sm:col-span-7">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-brand-400" /> Eintragstyp
                  </label>
                  <select 
                    className="input-field bg-slate-950 font-medium py-2.5 text-sm w-full cursor-pointer hover:border-slate-700"
                    value={editVolForm.type || 'volume'} 
                    onChange={e => setEditVolForm({ ...editVolForm, type: e.target.value })}
                  >
                    <option value="volume">📖 Einzelband</option>
                    <option value="special_edition">✨ Special Edition</option>
                    <option value="schuber">📦 Schuber</option>
                    <option value="special">⭐ Special / Extra</option>
                  </select>
                </div>

                <div className="sm:col-span-5">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Hash className="w-3.5 h-3.5 text-slate-400" />
                    {editVolForm.type === 'schuber' ? 'Schuber-Nr.' : 
                     editVolForm.type === 'special_edition' ? 'Band-Nr. (z.B. 1)' :
                     editVolForm.type === 'special' ? 'Bezeichnung' : 'Band-Nummer'} <span className="text-red-400">*</span>
                  </label>
                  <input 
                    type="text" 
                    required
                    className="input-field py-2.5 text-sm font-semibold" 
                    value={editVolForm.volume_number} 
                    onChange={e => setEditVolForm({ ...editVolForm, volume_number: e.target.value })} 
                  />
                </div>
              </div>

              {/* Row 2: Status & Price */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5 items-end">
                <div className="sm:col-span-7">
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Bookmark className="w-3.5 h-3.5 text-brand-400" /> Sammler-Status
                  </label>
                  {/* Segmented Switch Pill Control */}
                  <div className="grid grid-cols-2 p-1 bg-slate-950/90 rounded-xl border border-slate-800 gap-1.5 shadow-inner">
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, status: 'Vorhanden' })}
                      className={`py-2 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 select-none ${
                        editVolForm.status === 'Vorhanden'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/40 ring-1 ring-emerald-500/30'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                      }`}
                    >
                      <Check className="w-4 h-4 text-emerald-400 stroke-[2.5]" />
                      <span>Im Besitz</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, status: 'Fehlt' })}
                      className={`py-2 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 select-none ${
                        editVolForm.status === 'Fehlt'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/40 ring-1 ring-rose-500/30'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60 border border-transparent'
                      }`}
                    >
                      <X className="w-4 h-4 text-rose-400 stroke-[2.5]" />
                      <span>Fehlt noch</span>
                    </button>
                  </div>
                </div>

                <div className="sm:col-span-5">
                  <label className="block text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
                    <Coins className="w-3.5 h-3.5" /> Kaufpreis (€)
                  </label>
                  <div className="relative">
                    <input 
                      type="text" 
                      placeholder="0,00"
                      className="input-field border-emerald-500/40 focus:border-emerald-500 font-mono font-bold text-emerald-300 pr-8 py-2.5 text-sm" 
                      value={editVolForm.price} 
                      onChange={e => setEditVolForm({ ...editVolForm, price: e.target.value })} 
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-emerald-500/70 font-bold pointer-events-none">€</span>
                  </div>
                </div>
              </div>

              {/* Volume Cover & Images Section */}
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div>
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Camera className="w-4 h-4 text-brand-400" />
                      Fotos & Cover für diesen Band
                    </span>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Cover, Buchrücken oder Fotos vom Zustand hinzufügen
                    </p>
                  </div>

                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    <button
                      type="button"
                      onClick={() => setShowUrlInput(!showUrlInput)}
                      className="text-xs text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-850 border border-slate-800 px-2.5 py-1.5 rounded-xl transition-all flex items-center gap-1.5 shadow-sm"
                    >
                      <LinkIcon className="w-3.5 h-3.5 text-slate-400" />
                      <span>{showUrlInput ? 'Abbrechen' : 'URL eingeben'}</span>
                    </button>

                    <label className={`btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 cursor-pointer shadow-md ${uploadingVolImage ? 'opacity-50 pointer-events-none' : ''}`}>
                      <Upload className="w-3.5 h-3.5" />
                      <span>{uploadingVolImage ? 'Lädt hoch...' : 'Fotos hochladen'}</span>
                      <input 
                        type="file" 
                        multiple 
                        accept="image/*" 
                        className="hidden" 
                        onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                            handleUploadVolumeImages(Array.from(e.target.files));
                            e.target.value = '';
                          }
                        }}
                      />
                    </label>
                  </div>
                </div>

                {/* Manual URL Input dropdown if toggled */}
                {showUrlInput && (
                  <div className="flex items-center gap-2 p-2 bg-slate-900/90 rounded-xl border border-slate-800 animate-fade-in">
                    <input 
                      type="text"
                      placeholder="Bild-URL einfügen (https://... oder /uploads/...)"
                      className="input-field text-xs py-1.5 flex-1"
                      value={manualImageUrl}
                      onChange={e => setManualImageUrl(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddImageUrl(); } }}
                    />
                    <button
                      type="button"
                      onClick={handleAddImageUrl}
                      className="btn-primary text-xs py-1.5 px-3 shrink-0"
                    >
                      Hinzufügen
                    </button>
                  </div>
                )}

                {/* Uploaded Images Gallery */}
                {editVolForm.images && editVolForm.images.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5 pt-1">
                    {editVolForm.images.map((imgUrl, idx) => {
                      const isCover = editVolForm.cover_image === imgUrl;
                      return (
                        <div 
                          key={idx} 
                          className={`group relative rounded-xl border overflow-hidden aspect-[3/4] bg-slate-900 flex flex-col justify-between transition-all ${
                            isCover 
                              ? 'border-brand-500 shadow-md ring-2 ring-brand-500/40' 
                              : 'border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <img 
                            src={imgUrl} 
                            alt={`Foto ${idx + 1}`} 
                            className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform duration-200"
                            onClick={() => setPreviewImage(imgUrl)}
                          />

                          {/* Hover Actions Overlay */}
                          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 flex flex-col justify-between">
                            <div className="flex items-center justify-between">
                              {isCover ? (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-brand-500 text-white shadow">
                                  <Star className="w-2.5 h-2.5 fill-current" /> Cover
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => handleSetVolumeCover(imgUrl)}
                                  className="text-[10px] bg-slate-900/90 hover:bg-brand-600 text-slate-200 hover:text-white px-1.5 py-0.5 rounded shadow transition-colors"
                                  title="Als Hauptcover festlegen"
                                >
                                  Setze Cover
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() => handleRemoveVolumeImage(imgUrl)}
                                className="p-1 rounded-md bg-red-500/80 hover:bg-red-600 text-white shadow transition-colors"
                                title="Bild löschen"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>

                            <div className="flex justify-center">
                              <button
                                type="button"
                                onClick={() => setPreviewImage(imgUrl)}
                                className="text-[10px] text-white/90 hover:text-white flex items-center gap-1 bg-black/60 px-2 py-0.5 rounded-full backdrop-blur-xs"
                              >
                                <Maximize2 className="w-2.5 h-2.5" /> Vergrößern
                              </button>
                            </div>
                          </div>

                          {/* Permanent Cover indicator if selected */}
                          {isCover && (
                            <div className="absolute top-1.5 left-1.5 pointer-events-none group-hover:hidden">
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-brand-500 text-white shadow">
                                <Star className="w-2.5 h-2.5 fill-current" /> Cover
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Add More Photos tile */}
                    <label className="rounded-xl border-2 border-dashed border-slate-800 hover:border-brand-500/60 aspect-[3/4] bg-slate-900/40 hover:bg-slate-900/80 flex flex-col items-center justify-center text-slate-400 hover:text-brand-300 cursor-pointer transition-all group">
                      <Plus className="w-5 h-5 mb-1 text-slate-500 group-hover:text-brand-400 transition-colors" />
                      <span className="text-[11px] font-semibold">+ Foto</span>
                      <input 
                        type="file" 
                        multiple 
                        accept="image/*" 
                        className="hidden" 
                        onChange={(e) => {
                          if (e.target.files && e.target.files.length > 0) {
                            handleUploadVolumeImages(Array.from(e.target.files));
                            e.target.value = '';
                          }
                        }}
                      />
                    </label>
                  </div>
                ) : (
                  <label className="border-2 border-dashed border-slate-800 hover:border-brand-500/60 rounded-2xl p-6 text-center transition-all bg-slate-900/30 hover:bg-slate-900/70 cursor-pointer flex flex-col items-center justify-center group block">
                    <input 
                      type="file" 
                      multiple 
                      accept="image/*" 
                      className="hidden" 
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleUploadVolumeImages(Array.from(e.target.files));
                          e.target.value = '';
                        }
                      }}
                    />
                    <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/30 flex items-center justify-center text-brand-400 mb-2 group-hover:scale-110 group-hover:bg-brand-500/20 transition-all">
                      <Upload className="w-5 h-5" />
                    </div>
                    <span className="text-xs font-semibold text-slate-200 group-hover:text-brand-300 transition-colors">
                      {uploadingVolImage ? 'Fotos werden hochgeladen...' : 'Hier klicken oder Fotos auswählen'}
                    </span>
                    <span className="text-[11px] text-slate-500 mt-1">
                      Unterstützt JPG, PNG, WebP (Cover, Buchrücken, Detailfotos)
                    </span>
                  </label>
                )}
              </div>

              {/* Row 2: Publisher with "Vom Manga übernehmen" Button */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                    <Building2 className="w-3.5 h-3.5 text-brand-400" /> Verlag
                  </label>
                  {manga.publisher && (
                    <button
                      type="button"
                      onClick={() => setEditVolForm({ ...editVolForm, publisher: manga.publisher })}
                      className="text-[11px] text-brand-400 hover:text-brand-300 underline"
                    >
                      Vom Manga ({manga.publisher}) übernehmen
                    </button>
                  )}
                </div>
                <input 
                  type="text" 
                  placeholder={`z. B. ${manga.publisher || 'Carlsen Manga, Tokyopop, ...'}`}
                  className="input-field" 
                  value={editVolForm.publisher} 
                  onChange={e => setEditVolForm({ ...editVolForm, publisher: e.target.value })} 
                />
              </div>

              {/* Row 3: Condition & Release Year */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" /> Zustand
                  </label>
                  <select 
                    className="input-field bg-slate-950"
                    value={editVolForm.condition} 
                    onChange={e => setEditVolForm({ ...editVolForm, condition: e.target.value })}
                  >
                    <option value="">-- Keine Angabe --</option>
                    <option value="Neuwertig">Neuwertig (Mint / Wie neu)</option>
                    <option value="Sehr gut">Sehr gut (Leichte Spuren)</option>
                    <option value="Gut">Gut (Normal gelesen)</option>
                    <option value="Akzeptabel">Akzeptabel (Vergilbt / Knicke)</option>
                    <option value="Mängelexemplar">Mängelexemplar / Stempel</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-slate-400" /> Erscheinungsjahr
                  </label>
                  <input 
                    type="number" 
                    placeholder="z. B. 2023"
                    className="input-field" 
                    value={editVolForm.release_year} 
                    onChange={e => setEditVolForm({ ...editVolForm, release_year: e.target.value })} 
                  />
                </div>
              </div>

              {/* Row 4: Pages & ISBN */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <FileText className="w-3.5 h-3.5 text-slate-400" /> Seitenzahl
                  </label>
                  <input 
                    type="number" 
                    placeholder="z. B. 192"
                    className="input-field" 
                    value={editVolForm.pages} 
                    onChange={e => setEditVolForm({ ...editVolForm, pages: e.target.value })} 
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center gap-1">
                    <Hash className="w-3.5 h-3.5 text-slate-400" /> ISBN-Nummer
                  </label>
                  <input 
                    type="text" 
                    placeholder="z. B. 978-3-551-78901-2"
                    className="input-field font-mono" 
                    value={editVolForm.isbn} 
                    onChange={e => setEditVolForm({ ...editVolForm, isbn: e.target.value })} 
                  />
                </div>
              </div>

              {/* Row 5: Purchase date */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Kaufdatum</label>
                <input 
                  type="date" 
                  className="input-field bg-slate-950" 
                  value={editVolForm.purchase_date} 
                  onChange={e => setEditVolForm({ ...editVolForm, purchase_date: e.target.value })} 
                />
              </div>

              {/* Row 6: Notes & Extras */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Notizen & Besonderheiten (z. B. Extras, Erstauflage, Farbschnitt)
                </label>
                <textarea 
                  rows="2" 
                  placeholder="z. B. Erstauflage mit Postkarte, Limited Variant Cover"
                  className="input-field resize-none text-xs" 
                  value={editVolForm.notes} 
                  onChange={e => setEditVolForm({ ...editVolForm, notes: e.target.value })} 
                />
              </div>

              {/* Modal Buttons */}
              <div className="flex items-center justify-between pt-4 border-t border-slate-800">
                <button 
                  type="button" 
                  onClick={(e) => handleDeleteVolume(e, activeVolume.id)} 
                  className="btn-danger text-xs flex items-center gap-1.5"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Band löschen
                </button>

                <div className="flex items-center gap-2">
                  <button 
                    type="button" 
                    onClick={() => setActiveVolume(null)} 
                    className="btn-secondary text-xs"
                  >
                    Abbrechen
                  </button>
                  <button 
                    type="submit" 
                    disabled={savingVol}
                    className="btn-primary text-xs flex items-center gap-1.5"
                  >
                    <Save className="w-3.5 h-3.5" /> {savingVol ? 'Speichert...' : 'Änderungen speichern'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* BATCH ADD MODAL */}
      {showBatchModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-panel w-full max-w-md rounded-3xl p-6 border border-slate-700/80 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-brand-400" /> Bände in Serie hinzufügen
              </h3>
              <button onClick={() => setShowBatchModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400 mb-4">
              Fügt automatisch alle Bände in einem Zahlenbereich hinzu. Bereits vorhandene Bände werden übersprungen.
            </p>

            <form onSubmit={handleBatchAdd} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Von Band</label>
                  <input 
                    type="number" 
                    min="1" 
                    required 
                    className="input-field" 
                    value={batchFrom} 
                    onChange={e => setBatchFrom(e.target.value)} 
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Bis Band</label>
                  <input 
                    type="number" 
                    min="1" 
                    required 
                    className="input-field" 
                    value={batchTo} 
                    onChange={e => setBatchTo(e.target.value)} 
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
                    <Bookmark className="w-3.5 h-3.5 text-brand-400" /> Startstatus
                  </label>
                  <div className="grid grid-cols-2 p-1 bg-slate-950/90 rounded-xl border border-slate-800 gap-1.5 shadow-inner">
                    <button
                      type="button"
                      onClick={() => setBatchStatus('Vorhanden')}
                      className={`py-2 px-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 select-none ${
                        batchStatus === 'Vorhanden'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-sm shadow-emerald-950/30'
                          : 'text-slate-400 hover:text-slate-200 border border-transparent'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5 text-emerald-400 stroke-[2.5]" />
                      <span>Im Regal</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setBatchStatus('Fehlt')}
                      className={`py-2 px-2.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 select-none ${
                        batchStatus === 'Fehlt'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50 shadow-sm shadow-rose-950/30'
                          : 'text-slate-400 hover:text-slate-200 border border-transparent'
                      }`}
                    >
                      <X className="w-3.5 h-3.5 text-rose-400 stroke-[2.5]" />
                      <span>Fehlt noch</span>
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-emerald-400 mb-1.5 flex items-center gap-1">
                    <Coins className="w-3.5 h-3.5" /> Preis pro Band (€)
                  </label>
                  <div className="relative">
                    <input 
                      type="text" 
                      placeholder="z. B. 7,99 (optional)"
                      className="input-field text-xs font-mono text-emerald-300 pr-8 py-2.5 border-emerald-500/40 focus:border-emerald-500 font-bold"
                      value={batchPrice} 
                      onChange={e => setBatchPrice(e.target.value)} 
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-emerald-500/70 font-bold pointer-events-none">€</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Verlag (optional)</label>
                  <input 
                    type="text" 
                    placeholder={manga.publisher || 'z. B. Carlsen'}
                    className="input-field text-xs"
                    value={batchPublisher} 
                    onChange={e => setBatchPublisher(e.target.value)} 
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Zustand (optional)</label>
                  <select 
                    className="input-field bg-slate-950 text-xs"
                    value={batchCondition} 
                    onChange={e => setBatchCondition(e.target.value)}
                  >
                    <option value="">-- Keine Angabe --</option>
                    <option value="Neuwertig">Neuwertig</option>
                    <option value="Sehr gut">Sehr gut</option>
                    <option value="Gut">Gut</option>
                    <option value="Akzeptabel">Akzeptabel</option>
                    <option value="Mängelexemplar">Mängelexemplar</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-800">
                <button 
                  type="button" 
                  onClick={() => setShowBatchModal(false)} 
                  className="btn-secondary text-xs"
                >
                  Abbrechen
                </button>
                <button type="submit" className="btn-primary text-xs flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> Bände generieren
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* BATCH READ STATUS MODAL */}
      {showBatchReadModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-panel w-full max-w-md rounded-3xl p-6 border border-slate-700/80 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <BookCheck className="w-4 h-4 text-emerald-400" /> Lesestatus in Serie festlegen
              </h3>
              <button onClick={() => setShowBatchReadModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-400 mb-4">
              Markiere mehrere Bände bis zu einer bestimmten Band-Nummer mit einem Klick als gelesen oder ungelesen.
            </p>

            <form onSubmit={handleBatchRead} className="space-y-4">
              {readers.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">Leser</label>
                  <select
                    className="input-field bg-slate-950 text-xs"
                    value={selectedReaderId}
                    onChange={e => setSelectedReaderId(e.target.value)}
                  >
                    {readers.map(r => (
                      <option key={r.user_id} value={r.user_id}>
                        {r.display_name || r.username} ({r.read_count} gelesen)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Aktion</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setBatchReadAction(true)}
                    className={`py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 transition-all ${
                      batchReadAction 
                        ? 'bg-emerald-600/30 border-emerald-500 text-emerald-300 shadow-sm' 
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <BookCheck className="w-3.5 h-3.5 text-emerald-400" /> Als Gelesen markieren
                  </button>
                  <button
                    type="button"
                    onClick={() => setBatchReadAction(false)}
                    className={`py-2 px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 transition-all ${
                      !batchReadAction 
                        ? 'bg-rose-600/30 border-rose-500 text-rose-300 shadow-sm' 
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <X className="w-3.5 h-3.5 text-rose-400" /> Als Ungelesen markieren
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Bis einschließlich Band-Nummer</label>
                <input 
                  type="number" 
                  step="any"
                  min="1" 
                  required 
                  placeholder="z. B. 12"
                  className="input-field" 
                  value={batchReadUpTo} 
                  onChange={e => setBatchReadUpTo(e.target.value)} 
                />
                <span className="text-[11px] text-slate-500 mt-1 block">
                  Alle vorhandenen Bände von Band 1 bis zu dieser Nummer erhalten den gewählten Status.
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-800">
                <button 
                  type="button" 
                  onClick={() => setShowBatchReadModal(false)} 
                  className="btn-secondary text-xs"
                >
                  Abbrechen
                </button>
                <button type="submit" className="btn-primary text-xs flex items-center gap-1.5">
                  <CheckCheck className="w-3.5 h-3.5" /> Anwenden
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LIGHTBOX PREVIEW MODAL */}
      {previewImage && (
        <div 
          className="fixed inset-0 z-60 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setPreviewImage(null)}
        >
          <div className="relative max-w-3xl max-h-[90vh] flex flex-col items-center" onClick={e => e.stopPropagation()}>
            <button 
              onClick={() => setPreviewImage(null)}
              className="absolute -top-10 right-0 text-slate-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors"
              title="Schließen"
            >
              <X className="w-6 h-6" />
            </button>
            <img 
              src={previewImage} 
              alt="Vorschau" 
              className="max-h-[82vh] max-w-full rounded-2xl shadow-2xl object-contain border border-slate-800"
            />
            <div className="mt-3 flex items-center gap-3">
              <a 
                href={previewImage} 
                target="_blank" 
                rel="noreferrer" 
                className="text-xs text-brand-400 hover:text-brand-300 underline flex items-center gap-1 bg-slate-900/80 px-3 py-1 rounded-lg border border-slate-800"
              >
                In Originalgröße öffnen ↗
              </a>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
