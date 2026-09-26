import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  Search, Plus, Download, LogOut, BookOpen, Trash2, 
  Sparkles, CheckCircle2, Library, X, Upload, Layers,
  Users, UserPlus, Shield, User, Lock, Key, Coins, Tag,
  Building2, ArrowUpDown, ChevronDown, UploadCloud, AlertTriangle,
  FileArchive, RefreshCw, BarChart3, TrendingUp, Calendar, Clock, 
  BookCheck, Wallet, Award, PieChart, ShoppingCart, ShoppingBag, Check
} from 'lucide-react';

export default function Dashboard({ user, onLogout }) {
  const isVisitor = !user || user.role === 'visitor' || user.role === 'guest';
  const canEdit = user && (user.role === 'admin' || user.role === 'editor');

  const [mangas, setMangas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [publisherFilter, setPublisherFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('title_asc');
  const [showAddModal, setShowAddModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [failedImages, setFailedImages] = useState({});

  // Statistics & Finance State
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [statsData, setStatsData] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [editingStartDate, setEditingStartDate] = useState(false);
  const [newStartDate, setNewStartDate] = useState('');
  const [savingStartDate, setSavingStartDate] = useState(false);
  const [statsTab, setStatsTab] = useState('overview'); // 'overview' | 'publishers' | 'reading'

  // Detailed Reader Stats State
  const [detailedReaderStats, setDetailedReaderStats] = useState(null);
  const [loadingDetailedStats, setLoadingDetailedStats] = useState(false);

  // User Management State (Admin only)
  const [showUsersModal, setShowUsersModal] = useState(false);
  const [usersList, setUsersList] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userError, setUserError] = useState('');
  const [userSuccess, setUserSuccess] = useState('');
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'editor' });
  const [creatingUser, setCreatingUser] = useState(false);

  // Backup Restore State (Admin only)
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreSuccess, setRestoreSuccess] = useState('');

  // Form State for creating manga
  const [form, setForm] = useState({
    title: '',
    alt_title: '',
    author: '',
    publisher: '',
    status: 'Laufend',
    total_volumes: '',
    description: '',
    cover_image: ''
  });
  const [coverFile, setCoverFile] = useState(null);
  const [coverPreview, setCoverPreview] = useState('');

  // Metadata Auto-Fill state (AniList API)
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupResults, setLookupResults] = useState(null);
  const [lookupError, setLookupError] = useState('');

  // Main view switcher: 'shelf' | 'shopping'
  const [activeMainView, setActiveMainView] = useState('shelf');

  // Shopping / Wishlist state
  const [shoppingData, setShoppingData] = useState(null);
  const [loadingShopping, setLoadingShopping] = useState(false);
  const [shoppingPublisherFilter, setShoppingPublisherFilter] = useState('ALL');
  const [shoppingSearch, setShoppingSearch] = useState('');
  const [buyingId, setBuyingId] = useState(null);

  useEffect(() => {
    fetchMangas();
    fetchShoppingList();
  }, []);

  const fetchShoppingList = async () => {
    try {
      setLoadingShopping(true);
      const res = await fetch('/api/shopping-list');
      if (res.ok) {
        const data = await res.json();
        setShoppingData(data);
      }
    } catch (e) {
      console.error('Failed to fetch shopping list:', e);
    } finally {
      setLoadingShopping(false);
    }
  };

  const handleQuickBuy = async (volumeId) => {
    setBuyingId(volumeId);
    try {
      const res = await fetch(`/api/volumes/${volumeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Vorhanden' })
      });
      if (res.ok) {
        setShoppingData(prev => {
          if (!prev) return prev;
          const updatedItems = prev.items.filter(item => item.id !== volumeId);
          const boughtItem = prev.items.find(item => item.id === volumeId);
          const newCost = Math.max(0, prev.total_cost - (boughtItem?.price || 0));
          return {
            ...prev,
            total_missing: updatedItems.length,
            total_cost: Math.round(newCost * 100) / 100,
            items: updatedItems
          };
        });
        fetchMangas();
      } else {
        alert('Fehler beim Aktualisieren des Bands');
      }
    } catch (e) {
      alert('Netzwerkfehler');
    } finally {
      setBuyingId(null);
    }
  };

  const fetchMangas = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/mangas');
      if (res.ok) {
        const data = await res.json();
        setMangas(data);
      }
    } catch (e) {
      console.error('Failed to fetch mangas:', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      setLoadingStats(true);
      const res = await fetch('/api/stats');
      if (res.ok) {
        const data = await res.json();
        setStatsData(data);
        setNewStartDate(data.settings?.collection_start_date || '2021-04-09');
      }
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    } finally {
      setLoadingStats(false);
    }
  };

  const handleOpenStats = () => {
    setShowStatsModal(true);
    fetchStats();
  };

  const fetchReaderDetailedStats = async (userId) => {
    try {
      setLoadingDetailedStats(true);
      const res = await fetch(`/api/users/${userId}/stats`);
      if (res.ok) {
        const data = await res.json();
        setDetailedReaderStats(data);
      } else {
        alert('Fehler beim Laden der Leser-Details');
      }
    } catch (e) {
      console.error(e);
      alert('Netzwerkfehler');
    } finally {
      setLoadingDetailedStats(false);
    }
  };

  const handleSaveStartDate = async (e) => {
    e.preventDefault();
    if (!newStartDate) return;
    try {
      setSavingStartDate(true);
      const res = await fetch('/api/stats/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_start_date: newStartDate })
      });
      if (res.ok) {
        setEditingStartDate(false);
        await fetchStats();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Speichern');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setSavingStartDate(false);
    }
  };

  const handleOpenModal = () => {
    if (!canEdit) return;
    setForm({
      title: '',
      alt_title: '',
      author: '',
      publisher: '',
      status: 'Laufend',
      total_volumes: '',
      description: '',
      cover_image: ''
    });
    setCoverFile(null);
    setCoverPreview('');
    setErrorMessage('');
    setShowAddModal(true);
  };

  const closeAddModal = () => {
    if (coverPreview && coverPreview.startsWith('blob:')) {
      URL.revokeObjectURL(coverPreview);
    }
    setCoverFile(null);
    setCoverPreview('');
    setErrorMessage('');
    setLookingUp(false);
    setLookupResults(null);
    setLookupError('');
    setShowAddModal(false);
  };

  const handleLookupMetadata = async () => {
    if (!form.title.trim()) {
      setLookupError('Bitte gib zuerst einen Titel ein.');
      return;
    }
    setLookingUp(true);
    setLookupError('');
    setLookupResults(null);
    try {
      const res = await fetch(`/api/lookup/manga?q=${encodeURIComponent(form.title.trim())}`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          if (data.length === 1) {
            await applyLookupResult(data[0]);
          } else {
            setLookupResults(data);
          }
        } else {
          setLookupError('Keine Treffer gefunden.');
        }
      } else {
        const err = await res.json();
        setLookupError(err.error || 'Fehler bei der Suche');
      }
    } catch (e) {
      setLookupError('Netzwerkfehler bei der Metadatensuche');
    } finally {
      setLookingUp(false);
    }
  };

  const applyLookupResult = async (item) => {
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

    setForm(prev => ({
      ...prev,
      title: item.title || prev.title,
      alt_title: item.alt_title || prev.alt_title,
      author: item.author || prev.author,
      status: item.status || prev.status,
      total_volumes: item.total_volumes ? String(item.total_volumes) : prev.total_volumes,
      description: item.description || prev.description,
      cover_image: localCoverUrl || prev.cover_image
    }));
    if (localCoverUrl) {
      if (coverPreview && coverPreview.startsWith('blob:')) {
        URL.revokeObjectURL(coverPreview);
      }
      setCoverFile(null);
      setCoverPreview(localCoverUrl);
    }
    setLookupResults(null);
    setLookupError('');
  };

  const handleCoverChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      if (coverPreview && coverPreview.startsWith('blob:')) {
        URL.revokeObjectURL(coverPreview);
      }
      setCoverFile(file);
      setCoverPreview(URL.createObjectURL(file));
    }
  };

  const handleCreateManga = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) {
      setErrorMessage('Bitte gib einen Titel ein.');
      return;
    }

    setSubmitting(true);
    setErrorMessage('');

    try {
      let finalCover = form.cover_image.trim();

      if (coverFile) {
        const fd = new FormData();
        fd.append('image', coverFile);
        const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
        if (upRes.ok) {
          const upData = await upRes.json();
          finalCover = upData.url;
        } else {
          const errData = await upRes.json();
          throw new Error(errData.error || 'Fehler beim Cover-Upload');
        }
      }

      const res = await fetch('/api/mangas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          alt_title: form.alt_title.trim() || null,
          author: form.author.trim() || null,
          publisher: form.publisher.trim() || null,
          status: form.status,
          total_volumes: form.total_volumes ? parseInt(form.total_volumes, 10) : null,
          description: form.description.trim() || null,
          cover_image: finalCover || null
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Fehler beim Erstellen des Mangas');
      }

      closeAddModal();
      await fetchMangas();
    } catch (err) {
      setErrorMessage(err.message);
    } finally {
      setSubmitting(false);
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

  // --- User Management Functions ---
  const fetchUsers = async () => {
    try {
      setLoadingUsers(true);
      const res = await fetch('/api/users');
      if (res.ok) {
        setUsersList(await res.json());
      }
    } catch (e) {
      console.error('Failed to fetch users:', e);
    } finally {
      setLoadingUsers(false);
    }
  };

  const handleOpenUsersModal = () => {
    setUserError('');
    setUserSuccess('');
    setNewUser({ username: '', password: '', role: 'editor' });
    setShowUsersModal(true);
    fetchUsers();
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    if (!newUser.username.trim() || !newUser.password) {
      setUserError('Bitte Benutzername und Passwort eingeben.');
      return;
    }
    if (newUser.password.length < 4) {
      setUserError('Passwort muss mindestens 4 Zeichen lang sein.');
      return;
    }

    setCreatingUser(true);
    setUserError('');
    setUserSuccess('');

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      });
      const data = await res.json();
      if (res.ok) {
        setUserSuccess(`Benutzer "${newUser.username.trim()}" erfolgreich angelegt!`);
        setNewUser({ username: '', password: '', role: 'editor' });
        await fetchUsers();
      } else {
        setUserError(data.error || 'Fehler beim Erstellen des Benutzers');
      }
    } catch (err) {
      setUserError('Netzwerkfehler');
    } finally {
      setCreatingUser(false);
    }
  };

  const handleDeleteUser = async (userId, targetUsername) => {
    if (!confirm(`Möchtest du den Benutzer "${targetUsername}" wirklich löschen?`)) return;
    try {
      const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchUsers();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Löschen');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    }
  };

  const handleRestoreSubmit = async (e) => {
    e.preventDefault();
    if (!restoreFile) {
      setRestoreError('Bitte wähle eine Backup-ZIP-Datei (.zip) aus.');
      return;
    }
    setRestoring(true);
    setRestoreError('');
    setRestoreSuccess('');

    try {
      const formData = new FormData();
      formData.append('backup', restoreFile);

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Fehler beim Wiederherstellen des Backups');
      }

      setRestoreSuccess(data.message || 'Backup erfolgreich eingespielt!');
      await fetchMangas();
      setTimeout(() => {
        setShowRestoreModal(false);
        setRestoreSuccess('');
        setRestoreFile(null);
      }, 2000);
    } catch (err) {
      setRestoreError(err.message || 'Netzwerkfehler beim Wiederherstellen');
    } finally {
      setRestoring(false);
    }
  };

  // Available publishers for filtering
  const availablePublishers = Array.from(new Set(
    mangas.map(m => m.publisher && m.publisher.trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  // Filter & sort logic
  const filtered = mangas
    .filter(m => {
      const q = search.toLowerCase();
      const matchesSearch = 
        m.title.toLowerCase().includes(q) || 
        (m.alt_title && m.alt_title.toLowerCase().includes(q)) ||
        (m.author && m.author.toLowerCase().includes(q)) ||
        (m.publisher && m.publisher.toLowerCase().includes(q));
      
      if (!matchesSearch) return false;
      if (statusFilter !== 'ALL' && m.status !== statusFilter) return false;
      if (publisherFilter !== 'ALL') {
        const p = (m.publisher && m.publisher.trim()) || '';
        if (p.toLowerCase() !== publisherFilter.toLowerCase()) return false;
      }
      return true;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'title_desc':
          return (b.title || '').localeCompare(a.title || '');
        case 'publisher_asc':
          return (a.publisher || 'ZZZ').localeCompare(b.publisher || 'ZZZ') || (a.title || '').localeCompare(b.title || '');
        case 'volumes_desc':
          return (b.owned_volumes || 0) - (a.owned_volumes || 0);
        case 'value_desc':
          return (b.total_value || 0) - (a.total_value || 0);
        case 'title_asc':
        default:
          return (a.title || '').localeCompare(b.title || '');
      }
    });

  // Summary stats
  const totalSeries = mangas.length;
  const totalOwnedVolumes = mangas.reduce((acc, m) => acc + (m.owned_volumes || 0), 0);
  const totalCollectionValue = mangas.reduce((acc, m) => acc + (m.total_value || 0), 0);
  const completedSeries = mangas.filter(m => m.status === 'Abgeschlossen').length;

  const getStatusBadge = (status) => {
    switch (status) {
      case 'Abgeschlossen':
        return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
      case 'Pausiert':
        return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      case 'Geplant':
        return 'bg-purple-500/20 text-purple-300 border-purple-500/40';
      default:
        return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
    }
  };

  return (
    <div className="min-h-screen pb-16">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 glass-panel border-b border-slate-800/80 mb-8 px-4 sm:px-8 py-3.5">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          
          {/* Logo & Title */}
          <div className="flex items-center gap-3.5 w-full md:w-auto justify-between md:justify-start">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center shadow-lg shadow-brand-500/30">
                <BookOpen className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
                  MangaShelf
                </h1>
                <p className="text-xs text-slate-400 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-pulse"></span>
                  Sammlung & Tracker
                </p>
              </div>
            </div>

            {/* Mobile Actions */}
            <div className="flex md:hidden items-center gap-2">
              <button 
                onClick={() => {
                  const next = activeMainView === 'shelf' ? 'shopping' : 'shelf';
                  setActiveMainView(next);
                  if (next === 'shopping') fetchShoppingList();
                }}
                className={`text-xs p-2 rounded-xl border transition-all ${
                  activeMainView === 'shopping'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                    : 'btn-secondary text-slate-300'
                }`}
                title="Einkaufsliste umschalten"
              >
                <ShoppingCart className="w-4 h-4 text-emerald-400" />
              </button>

              <button 
                onClick={handleOpenStats}
                className="btn-secondary text-xs p-2 text-emerald-400 border-emerald-500/30"
                title="Statistiken & Finanzen"
              >
                <BarChart3 className="w-4 h-4" />
              </button>

              {canEdit && (
                <button 
                  onClick={handleOpenModal}
                  className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Neu
                </button>
              )}

              {user?.role === 'admin' && (
                <button
                  onClick={handleOpenUsersModal}
                  className="btn-secondary text-xs p-2 text-brand-400"
                  title="Benutzer verwalten"
                >
                  <Users className="w-4 h-4" />
                </button>
              )}

              <button onClick={onLogout} className="btn-secondary p-2 text-slate-400" title="Abmelden">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Search bar */}
          <div className="flex items-center gap-2.5 bg-slate-950/70 border border-slate-700/80 rounded-xl px-3.5 py-2.5 w-full md:w-80 focus-within:ring-2 focus-within:ring-brand-500/50 focus-within:border-brand-500 transition-all">
            <Search className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" />
            <input 
              type="text" 
              placeholder="Titel, Autor oder Verlag suchen..." 
              className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 text-sm" 
              value={search} 
              onChange={e => setSearch(e.target.value)} 
            />
            {search && (
              <button 
                type="button"
                onClick={() => setSearch('')}
                className="text-slate-400 hover:text-white shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Action buttons (Desktop) */}
          <div className="hidden md:flex items-center gap-2.5">
            <button 
              onClick={handleOpenStats} 
              className="btn-secondary flex items-center gap-2 text-sm text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10 shadow-sm"
              title="Statistik- & Finanz-Dashboard öffnen"
            >
              <BarChart3 className="w-4 h-4 text-emerald-400" /> Statistiken & Finanzen
            </button>

            {canEdit && (
              <button 
                onClick={handleOpenModal} 
                className="btn-primary flex items-center gap-2 text-sm shadow-md"
              >
                <Plus className="w-4 h-4" /> Neuer Manga
              </button>
            )}

            {user?.role === 'admin' && (
              <>
                <button
                  onClick={handleOpenUsersModal}
                  className="btn-secondary flex items-center gap-2 text-sm text-slate-200"
                  title="Benutzer anlegen und verwalten"
                >
                  <Users className="w-4 h-4 text-brand-400" /> Benutzer
                </button>

                <a 
                  href="/api/backup" 
                  className="btn-secondary flex items-center gap-2 text-sm text-slate-200" 
                  download
                  title="Sicherung der Datenbank und Coverbilder herunterladen"
                >
                  <Download className="w-4 h-4 text-sky-400" /> Backup
                </a>

                <button
                  onClick={() => {
                    setRestoreFile(null);
                    setRestoreError('');
                    setRestoreSuccess('');
                    setShowRestoreModal(true);
                  }}
                  className="btn-secondary flex items-center gap-2 text-sm text-slate-200 hover:text-emerald-400 transition-colors"
                  title="Vorhandenes Backup (.zip) einspielen"
                >
                  <UploadCloud className="w-4 h-4 text-emerald-400" /> Backup einspielen
                </button>
              </>
            )}

            <div className="h-6 w-[1px] bg-slate-800 mx-1"></div>

            <div className="flex items-center gap-2 text-xs bg-slate-800/60 px-3 py-1.5 rounded-xl border border-slate-700/50">
              <span className="text-slate-400">User:</span>
              <span className="font-semibold text-slate-200">{user?.username}</span>
              {user?.role === 'admin' ? (
                <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase">
                  Admin
                </span>
              ) : isVisitor ? (
                <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase">
                  Gast
                </span>
              ) : (
                <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] px-1.5 py-0.5 rounded font-mono font-bold uppercase">
                  Editor
                </span>
              )}
            </div>

            <button 
              onClick={onLogout} 
              className="btn-secondary p-2 text-slate-300 hover:text-red-400 transition-colors" 
              title="Abmelden"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-8">
        
        {/* Main View Switcher: Sammlung vs. Einkaufsliste */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
          <div className="flex items-center bg-slate-900/90 border border-slate-800 p-1 rounded-2xl shadow-inner">
            <button
              onClick={() => setActiveMainView('shelf')}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
                activeMainView === 'shelf'
                  ? 'bg-gradient-to-r from-brand-600 to-sky-500 text-white shadow-lg shadow-brand-500/25'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Library className="w-4 h-4" />
              <span>Sammlung ({mangas.length})</span>
            </button>
            <button
              onClick={() => {
                setActiveMainView('shopping');
                fetchShoppingList();
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
                activeMainView === 'shopping'
                  ? 'bg-gradient-to-r from-brand-600 to-sky-500 text-white shadow-lg shadow-brand-500/25'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <ShoppingCart className="w-4 h-4 text-emerald-400" />
              <span>Einkaufsliste</span>
              {shoppingData && shoppingData.total_missing > 0 && (
                <span className="bg-emerald-500/30 text-emerald-300 text-[11px] font-mono px-2 py-0.5 rounded-full font-bold">
                  {shoppingData.total_missing}
                </span>
              )}
            </button>
          </div>

          {activeMainView === 'shopping' && (
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>Laden-Modus: Fehlende Bände abhaken & direkt einbuchen</span>
            </div>
          )}
        </div>

        {/* SHELF VIEW */}
        {activeMainView === 'shelf' && (
          <>
            {/* Quick Stats Bar */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mb-8">
          <div className="glass-panel p-4 rounded-2xl flex items-center gap-3.5 border border-slate-800/80">
            <div className="w-11 h-11 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
              <Library className="w-5 h-5 text-sky-400" />
            </div>
            <div>
              <p className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">Reihen</p>
              <p className="text-xl sm:text-2xl font-extrabold text-white">{totalSeries}</p>
            </div>
          </div>

          <div className="glass-panel p-4 rounded-2xl flex items-center gap-3.5 border border-slate-800/80">
            <div className="w-11 h-11 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <Layers className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <p className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">Bände im Besitz</p>
              <p className="text-xl sm:text-2xl font-extrabold text-white">{totalOwnedVolumes}</p>
            </div>
          </div>

          <div 
            onClick={handleOpenStats}
            className="glass-panel p-4 rounded-2xl flex items-center gap-3.5 border border-slate-800/80 hover:border-emerald-500/50 hover:bg-slate-900/90 cursor-pointer transition-all duration-200 group"
            title="Klicken für das vollständige Finanz- & Statistik-Dashboard"
          >
            <div className="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/30 group-hover:scale-105 group-hover:bg-emerald-500/20 transition-all flex items-center justify-center shrink-0">
              <Coins className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <p className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">Sammlungswert</p>
                <span className="text-[10px] text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity font-semibold">Details ↗</span>
              </div>
              <p className="text-xl sm:text-2xl font-extrabold text-emerald-400 font-mono truncate">
                {totalCollectionValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
              </p>
            </div>
          </div>

          <div className="glass-panel p-4 rounded-2xl flex items-center gap-3.5 border border-slate-800/80">
            <div className="w-11 h-11 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <p className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">Abgeschlossen</p>
              <p className="text-xl sm:text-2xl font-extrabold text-white">{completedSeries}</p>
            </div>
          </div>
        </section>

        {/* Filter Toolbar */}
        <div className="flex flex-col sm:flex-row flex-wrap items-start sm:items-center justify-between gap-3 mb-6 p-3 bg-slate-950/70 rounded-2xl border border-slate-800/80">
          {/* Status Tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 text-xs overflow-x-auto">
            {['ALL', 'Laufend', 'Abgeschlossen', 'Pausiert', 'Geplant'].map(st => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                  statusFilter === st 
                    ? 'bg-brand-600 text-white shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {st === 'ALL' ? 'Alle anzeigen' : st}
              </button>
            ))}
          </div>

          {/* Publisher & Sort Controls */}
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {/* Publisher Filter */}
            <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
              <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <select
                value={publisherFilter}
                onChange={e => setPublisherFilter(e.target.value)}
                className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
              >
                <option value="ALL">Alle Verlage</option>
                {availablePublishers.map(pub => (
                  <option key={pub} value={pub}>{pub}</option>
                ))}
              </select>
              <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
            </label>

            {/* Sort Control */}
            <label className="flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
              <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                className="filter-chip-select font-medium text-slate-200 group-hover:text-white"
              >
                <option value="title_asc">Titel (A → Z)</option>
                <option value="title_desc">Titel (Z → A)</option>
                <option value="publisher_asc">Verlag (A → Z)</option>
                <option value="volumes_desc">Meiste Bände</option>
                <option value="value_desc">Höchster Wert (€)</option>
              </select>
              <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
            </label>

            <div className="text-xs text-slate-400 ml-1">
              {filtered.length} {filtered.length === 1 ? 'Manga' : 'Mangas'}
            </div>
          </div>
        </div>

        {/* Grid or Empty State */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
            <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm">Lade Sammlung...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="glass-panel p-12 rounded-3xl text-center max-w-lg mx-auto my-12 border border-slate-800">
            <div className="w-16 h-16 rounded-2xl bg-brand-500/10 border border-brand-500/20 text-brand-400 flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">
              {search ? 'Keine Treffer gefunden' : 'Deine Sammlung ist noch leer'}
            </h3>
            <p className="text-sm text-slate-400 mb-6">
              {search 
                ? `Für "${search}" konnte kein Manga gefunden werden.` 
                : 'Füge deinen ersten Manga hinzu, um Bände und deinen Fortschritt zu verfolgen.'}
            </p>
            {search ? (
              <button onClick={() => setSearch('')} className="btn-secondary text-sm">
                Suche zurücksetzen
              </button>
            ) : (
              <button onClick={handleOpenModal} className="btn-primary text-sm inline-flex items-center gap-2">
                <Plus className="w-4 h-4" /> Ersten Manga anlegen
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-6">
            {filtered.map(manga => {
              const total = manga.total_volumes || 0;
              const owned = manga.owned_volumes || 0;
              const pct = total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : null;

              return (
                <div key={manga.id} className="group relative flex flex-col">
                  <Link 
                    to={`/manga/${manga.id}`} 
                    className="glass-card rounded-2xl overflow-hidden border border-slate-800 flex flex-col h-full hover:shadow-2xl hover:shadow-brand-500/10 hover:-translate-y-1.5 transition-all duration-300"
                  >
                    {/* Cover Aspect Container */}
                    <div className="aspect-[2/3] bg-slate-950 relative overflow-hidden">
                      {manga.cover_image && !failedImages[manga.id] ? (
                        <img 
                          src={manga.cover_image} 
                          alt="" 
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                          loading="lazy"
                          onError={() => setFailedImages(prev => ({ ...prev, [manga.id]: true }))}
                        />
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 bg-gradient-to-b from-slate-900 to-slate-950 p-4 text-center">
                          <BookOpen className="w-10 h-10 mb-2 opacity-50" />
                          <span className="text-xs text-slate-500">Kein Cover</span>
                        </div>
                      )}

                      {/* Top Badges */}
                      <div className="absolute top-2 left-2 right-2 flex justify-between items-start pointer-events-none">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider backdrop-blur-md border ${getStatusBadge(manga.status)}`}>
                          {manga.status}
                        </span>

                        <span className="bg-slate-950/80 border border-slate-800 text-white text-[11px] font-bold px-2 py-0.5 rounded-lg backdrop-blur-md">
                          {owned} {total > 0 ? `/ ${total}` : 'Bde.'}
                        </span>
                      </div>

                      {/* Progress Bar at bottom of poster */}
                      {pct !== null && (
                        <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/60 backdrop-blur-xs">
                          <div 
                            className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 transition-all duration-500" 
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      )}
                    </div>

                    {/* Card Body */}
                    <div className="p-3.5 flex flex-col flex-1 justify-between bg-slate-900/40">
                      <div>
                        <h3 className="font-bold text-sm text-white line-clamp-2 min-h-[2.5rem] leading-snug group-hover:text-brand-400 transition-colors" title={manga.title}>
                          {manga.title}
                        </h3>
                        <p className="text-xs text-slate-400 truncate mt-0.5" title={manga.author || ''}>
                          {manga.author || 'Kein Autor'}
                        </p>
                        {manga.publisher && (
                          <p className="text-[11px] text-slate-500 flex items-center gap-1 mt-1 truncate" title={`Verlag: ${manga.publisher}`}>
                            <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                            <span className="truncate">{manga.publisher}</span>
                          </p>
                        )}
                      </div>

                      <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
                        {manga.total_value > 0 ? (
                          <span className="font-mono font-bold text-emerald-400 flex items-center gap-1">
                            <Coins className="w-3 h-3 text-emerald-400" />
                            {manga.total_value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </span>
                        ) : (
                          <span className="text-slate-500">
                            {pct !== null ? `${pct}% komplett` : `${owned} Bände`}
                          </span>
                        )}
                        <span className="text-brand-400 font-semibold group-hover:translate-x-0.5 transition-transform">Details &rarr;</span>
                      </div>
                    </div>
                  </Link>

                  {/* Delete button (hover) */}
                  {canEdit && (
                    <button
                      onClick={(e) => handleDeleteManga(e, manga.id, manga.title)}
                      className="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 bg-red-950/90 hover:bg-red-900 text-red-300 p-1.5 rounded-lg border border-red-700/50 backdrop-blur-md transition-all shadow-lg hover:scale-105 z-10"
                      title="Manga löschen"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </>
    )}

    {/* SHOPPING LIST VIEW */}
    {activeMainView === 'shopping' && (
      <div className="space-y-6 animate-fade-in">
        {/* Shopping Summary Card */}
        <div className="glass-panel p-5 sm:p-6 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gradient-to-r from-slate-900/90 via-slate-900/70 to-emerald-950/20">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
              <ShoppingCart className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <span>Einkaufsliste & Wunschbände</span>
                {shoppingData && (
                  <span className="bg-emerald-500/20 text-emerald-300 text-xs px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                    {shoppingData.total_missing} Bände
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Alle Bände mit Status „Fehlt“, sortiert nach Verlag zum schnellen Finden und Abhaken im Laden
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
            <div className="bg-slate-950/70 border border-slate-800 px-4 py-2 rounded-xl text-right flex-1 sm:flex-initial">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Geschätzter Gesamtpreis</p>
              <p className="text-lg font-extrabold text-emerald-400 font-mono">
                {shoppingData ? shoppingData.total_cost.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00'} €
              </p>
            </div>
            <button
              onClick={fetchShoppingList}
              disabled={loadingShopping}
              className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5"
              title="Liste aktualisieren"
            >
              <RefreshCw className={`w-4 h-4 ${loadingShopping ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Shopping Filters Bar */}
        <div className="glass-panel p-4 rounded-2xl border border-slate-800/80 flex flex-col sm:flex-row justify-between items-center gap-3">
          {/* Search */}
          <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full sm:w-72">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Titel oder Band filtern..."
              className="w-full bg-transparent border-0 p-0 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-0"
              value={shoppingSearch}
              onChange={e => setShoppingSearch(e.target.value)}
            />
            {shoppingSearch && (
              <button onClick={() => setShoppingSearch('')} className="text-slate-500 hover:text-white">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Publisher Filter Chips */}
          {shoppingData?.publishers && shoppingData.publishers.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0 scrollbar-none">
              <button
                onClick={() => setShoppingPublisherFilter('ALL')}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
                  shoppingPublisherFilter === 'ALL'
                    ? 'bg-brand-600 text-white shadow'
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-700/50'
                }`}
              >
                Alle Verlage ({shoppingData.total_missing})
              </button>
              {shoppingData.publishers.map(p => (
                <button
                  key={p.publisher}
                  onClick={() => setShoppingPublisherFilter(p.publisher)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 ${
                    shoppingPublisherFilter === p.publisher
                      ? 'bg-brand-600 text-white shadow'
                      : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-700/50'
                  }`}
                >
                  <span>{p.publisher}</span>
                  <span className="text-[10px] bg-slate-900/80 px-1.5 py-0.5 rounded-full font-mono">
                    {p.count}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Loading State */}
        {loadingShopping && !shoppingData && (
          <div className="flex justify-center items-center py-20 text-slate-400 gap-2">
            <RefreshCw className="w-5 h-5 animate-spin text-brand-400" />
            <span>Einkaufsliste wird geladen...</span>
          </div>
        )}

        {/* Empty State */}
        {!loadingShopping && (!shoppingData || shoppingData.items.length === 0) && (
          <div className="glass-panel p-12 rounded-3xl border border-slate-800 text-center max-w-lg mx-auto">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
            <h3 className="text-lg font-bold text-white">Alles komplett im Regal!</h3>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              Aktuell hast du keine Bände mit dem Status „Fehlt“. Sobald du bei einer Reihe Bände als fehlend markierst, erscheinen sie hier automatisch in deiner Einkaufsliste.
            </p>
            <button
              onClick={() => setActiveMainView('shelf')}
              className="btn-primary text-xs mt-6 px-4 py-2"
            >
              Zurück zur Sammlung
            </button>
          </div>
        )}

        {/* Shopping List Items Grid */}
        {shoppingData && shoppingData.items.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5">
            {shoppingData.items
              .filter(item => {
                const matchPub = shoppingPublisherFilter === 'ALL' || item.effective_publisher === shoppingPublisherFilter;
                const matchSearch = !shoppingSearch || 
                  item.manga_title.toLowerCase().includes(shoppingSearch.toLowerCase()) || 
                  String(item.volume_number).includes(shoppingSearch) ||
                  (item.effective_publisher && item.effective_publisher.toLowerCase().includes(shoppingSearch.toLowerCase()));
                return matchPub && matchSearch;
              })
              .map(item => (
                <div
                  key={item.id}
                  className="glass-card rounded-2xl p-3 border border-slate-800/80 flex gap-3 relative group hover:border-emerald-500/50 transition-all bg-slate-900/60"
                >
                  {/* Cover Thumbnail */}
                  <Link to={`/manga/${item.manga_id}`} className="shrink-0 relative group/cover">
                    {item.manga_cover ? (
                      <img
                        src={item.manga_cover}
                        alt={item.manga_title}
                        className="w-16 h-24 object-cover rounded-xl shadow-md border border-slate-800 group-hover/cover:scale-105 transition-transform"
                      />
                    ) : (
                      <div className="w-16 h-24 bg-slate-800 rounded-xl flex items-center justify-center text-slate-500 border border-slate-700/60">
                        <BookOpen className="w-6 h-6" />
                      </div>
                    )}
                    <span className="absolute top-1 left-1 bg-amber-500/90 text-slate-950 font-black text-[9px] px-1.5 py-0.5 rounded shadow uppercase">
                      Fehlt
                    </span>
                  </Link>

                  {/* Info & Buy Button */}
                  <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                    <div>
                      <Link
                        to={`/manga/${item.manga_id}`}
                        className="text-xs font-bold text-white hover:text-brand-300 truncate block transition-colors"
                        title={item.manga_title}
                      >
                        {item.manga_title}
                      </Link>
                      
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                          Band {item.volume_number}
                        </span>
                        {item.price > 0 && (
                          <span className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono px-2 py-0.5 rounded-lg font-bold">
                            {item.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </span>
                        )}
                      </div>

                      <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                        <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                        <span className="truncate">{item.effective_publisher}</span>
                      </p>
                      {item.isbn && (
                        <p className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">
                          ISBN: {item.isbn}
                        </p>
                      )}
                    </div>

                    {/* Quick Buy Button */}
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleQuickBuy(item.id)}
                        disabled={buyingId === item.id}
                        className="mt-2.5 w-full bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 hover:border-emerald-500 py-1.5 px-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all active:scale-95 shadow-sm"
                        title="Als gekauft markieren und ins Regal stellen"
                      >
                        {buyingId === item.id ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5 text-emerald-400 group-hover:text-white" />
                        )}
                        <span>Gekauft</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    )}
  </main>

      {/* CREATE MANGA MODAL */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto animate-fade-in">
          <div className="glass-panel w-full max-w-xl rounded-3xl p-6 sm:p-8 border border-slate-700/80 shadow-2xl my-8 relative">
            
            {/* Header */}
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-brand-500/20 border border-brand-500/40 text-brand-400 flex items-center justify-center">
                  <Plus className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Neuen Manga anlegen</h2>
                  <p className="text-xs text-slate-400">Erfasse eine neue Reihe in deiner Sammlung</p>
                </div>
              </div>
              <button 
                onClick={closeAddModal}
                aria-label="Schließen"
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Error Banner */}
            {errorMessage && (
              <div className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Form */}
            <form onSubmit={handleCreateManga} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5 flex justify-between items-center">
                  <span>Titel <span className="text-red-400">*</span></span>
                  <span className="text-[11px] text-brand-400 font-normal">Tipp: Titel eingeben & auf „Auto-Fill“ klicken</span>
                </label>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder="z.B. One Piece, Chainsaw Man, Frieren..." 
                    className="input-field flex-1" 
                    required
                    autoFocus
                    value={form.title} 
                    onChange={e => setForm({ ...form, title: e.target.value })} 
                  />
                  <button
                    type="button"
                    onClick={handleLookupMetadata}
                    disabled={lookingUp || !form.title.trim()}
                    className="btn-secondary text-xs flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 bg-gradient-to-r hover:from-brand-600/30 hover:to-sky-600/30 border-brand-500/40 text-brand-300 hover:text-white"
                    title="Sucht Cover, Autor, Genres und Beschreibung automatisch über AniList"
                  >
                    {lookingUp ? (
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

              {/* Lookup Error Banner */}
              {lookupError && (
                <div className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-2.5 rounded-xl text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                  <span>{lookupError}</span>
                </div>
              )}

              {/* Lookup Results Selector */}
              {lookupResults && lookupResults.length > 0 && (
                <div className="bg-slate-950/90 border border-brand-500/40 rounded-xl p-3 space-y-2.5">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-brand-400 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" /> Treffer auswählen:
                    </span>
                    <button 
                      type="button" 
                      onClick={() => setLookupResults(null)}
                      className="text-slate-400 hover:text-white text-[11px]"
                    >
                      Schließen
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                    {lookupResults.map(item => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => applyLookupResult(item)}
                        className="flex items-center gap-2.5 p-2 rounded-lg bg-slate-900/80 hover:bg-brand-950/60 border border-slate-800 hover:border-brand-500/50 text-left transition-all group"
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
                          <p className="text-xs font-semibold text-white truncate group-hover:text-brand-300">
                            {item.title}
                          </p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {item.author || item.alt_title || 'Unbekannt'}
                          </p>
                          <div className="flex gap-1.5 mt-1 text-[10px] text-slate-500">
                            <span className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">
                              {item.status}
                            </span>
                            {item.total_volumes && (
                              <span className="bg-slate-800 px-1.5 py-0.5 rounded text-slate-300">
                                {item.total_volumes} Bände
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    Autor / Mangaka
                  </label>
                  <input 
                    type="text" 
                    placeholder="z.B. Eiichiro Oda" 
                    className="input-field" 
                    value={form.author} 
                    onChange={e => setForm({ ...form, author: e.target.value })} 
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    Verlag
                  </label>
                  <input 
                    type="text" 
                    placeholder="z.B. Carlsen Manga, Tokyopop..." 
                    className="input-field" 
                    value={form.publisher} 
                    onChange={e => setForm({ ...form, publisher: e.target.value })} 
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    Status
                  </label>
                  <select 
                    className="input-field bg-slate-950"
                    value={form.status} 
                    onChange={e => setForm({ ...form, status: e.target.value })}
                  >
                    <option value="Laufend">Laufend</option>
                    <option value="Abgeschlossen">Abgeschlossen</option>
                    <option value="Pausiert">Pausiert</option>
                    <option value="Geplant">Geplant</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                    Geplante / Gesamtbände
                  </label>
                  <input 
                    type="number" 
                    min="1"
                    placeholder="z.B. 108" 
                    className="input-field" 
                    value={form.total_volumes} 
                    onChange={e => setForm({ ...form, total_volumes: e.target.value })} 
                  />
                </div>
              </div>

              {/* Cover Upload / URL */}
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Cover-Bild (Datei hochladen oder URL)
                </label>
                <div className="flex flex-col sm:flex-row gap-3 items-center">
                  <input 
                    type="url" 
                    placeholder="https://example.com/cover.jpg" 
                    className="input-field flex-1 text-sm"
                    value={form.cover_image} 
                    onChange={e => {
                      setForm({ ...form, cover_image: e.target.value });
                      setCoverPreview(e.target.value);
                      setCoverFile(null);
                    }} 
                  />
                  <span className="text-xs text-slate-500">oder</span>
                  <label className="btn-secondary text-xs flex items-center gap-2 cursor-pointer shrink-0 py-2.5">
                    <Upload className="w-4 h-4" /> Datei wählen
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      onChange={handleCoverChange} 
                    />
                  </label>
                </div>
                {coverPreview && (
                  <div className="mt-2.5 flex items-center gap-3 p-2 bg-slate-950/80 rounded-xl border border-slate-800">
                    <img src={coverPreview} alt="Preview" className="w-10 h-14 object-cover rounded-lg" />
                    <span className="text-xs text-slate-300 truncate">Vorschau aktiv</span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Beschreibung
                </label>
                <textarea 
                  rows="3" 
                  placeholder="Kurze Inhaltsangabe..." 
                  className="input-field resize-none text-sm" 
                  value={form.description} 
                  onChange={e => setForm({ ...form, description: e.target.value })}
                />
              </div>

              {/* Buttons */}
              <div className="flex justify-end gap-3 pt-4 border-t border-slate-800">
                <button 
                  type="button" 
                  onClick={closeAddModal} 
                  className="btn-secondary text-sm"
                  disabled={submitting}
                >
                  Abbrechen
                </button>
                <button 
                  type="submit" 
                  className="btn-primary text-sm flex items-center gap-2"
                  disabled={submitting}
                >
                  {submitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      Wird angelegt...
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4" /> Manga anlegen
                    </>
                  )}
                </button>
              </div>
            </form>

          </div>
        </div>
      )}

      {/* USER MANAGEMENT MODAL (ADMIN ONLY) */}
      {showUsersModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto animate-fade-in">
          <div className="glass-panel w-full max-w-2xl rounded-3xl p-6 sm:p-8 border border-slate-700/80 shadow-2xl my-8 relative">
            
            {/* Header */}
            <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/40 text-purple-400 flex items-center justify-center">
                  <Users className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white">Benutzerverwaltung</h2>
                  <p className="text-xs text-slate-400">Verwalte Zugänge und lege neue Benutzer an</p>
                </div>
              </div>
              <button 
                onClick={() => setShowUsersModal(false)}
                className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Feedback messages */}
            {userError && (
              <div className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
                <span>{userError}</span>
              </div>
            )}
            {userSuccess && (
              <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
                <span>{userSuccess}</span>
              </div>
            )}

            {/* Section 1: Create New User */}
            <div className="bg-slate-950/60 p-4 sm:p-5 rounded-2xl border border-slate-800 mb-6">
              <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-brand-400" /> Neuen Benutzer anlegen
              </h3>
              
              <form onSubmit={handleCreateUser} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      Benutzername
                    </label>
                    <input 
                      type="text" 
                      placeholder="z.B. alex" 
                      className="input-field text-xs py-2"
                      required
                      value={newUser.username} 
                      onChange={e => setNewUser({ ...newUser, username: e.target.value })} 
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      Passwort
                    </label>
                    <input 
                      type="password" 
                      placeholder="Mind. 4 Zeichen" 
                      className="input-field text-xs py-2"
                      required
                      value={newUser.password} 
                      onChange={e => setNewUser({ ...newUser, password: e.target.value })} 
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      Rolle
                    </label>
                    <select 
                      className="input-field bg-slate-950 text-xs py-2"
                      value={newUser.role}
                      onChange={e => setNewUser({ ...newUser, role: e.target.value })}
                    >
                      <option value="editor">Editor (Mangas verwalten)</option>
                      <option value="visitor">Besucher / Gast (Nur Lesezugriff)</option>
                      <option value="admin">Administrator (Vollzugriff)</option>
                    </select>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <button 
                    type="submit" 
                    className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                    disabled={creatingUser}
                  >
                    {creatingUser ? (
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    ) : (
                      <UserPlus className="w-3.5 h-3.5" />
                    )}
                    Benutzer erstellen
                  </button>
                </div>
              </form>
            </div>

            {/* Section 2: List of Users */}
            <div>
              <h3 className="text-sm font-bold text-slate-200 mb-3 flex items-center gap-2">
                <Users className="w-4 h-4 text-slate-400" /> Registrierte Benutzer ({usersList.length})
              </h3>

              {loadingUsers ? (
                <div className="p-6 text-center text-slate-500 text-xs">Lade Benutzerliste...</div>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                  {usersList.map(u => {
                    const isSelf = u.id === user?.id;

                    return (
                      <div 
                        key={u.id}
                        className="flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs ${
                            u.role === 'admin' 
                              ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' 
                              : (u.role === 'visitor' || u.role === 'guest')
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                          }`}>
                            {u.role === 'admin' ? (
                              <Shield className="w-4 h-4" />
                            ) : (u.role === 'visitor' || u.role === 'guest') ? (
                              <Lock className="w-4 h-4" />
                            ) : (
                              <User className="w-4 h-4" />
                            )}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-white">{u.username}</span>
                              {isSelf && (
                                <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                                  Du
                                </span>
                              )}
                            </div>
                            <span className="text-[10px] text-slate-500">
                              Erstellt am {u.created_at ? new Date(u.created_at).toLocaleDateString('de-DE') : 'unbekannt'}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider border ${
                            u.role === 'admin' 
                              ? 'bg-purple-500/20 text-purple-300 border-purple-500/40' 
                              : (u.role === 'visitor' || u.role === 'guest')
                              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                              : 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                          }`}>
                            {u.role === 'visitor' || u.role === 'guest' ? 'Besucher' : u.role}
                          </span>

                          {!isSelf && (
                            <button
                              onClick={() => handleDeleteUser(u.id, u.username)}
                              className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors"
                              title={`Benutzer "${u.username}" löschen`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Close Button */}
            <div className="flex justify-end pt-5 mt-5 border-t border-slate-800">
              <button 
                type="button" 
                onClick={() => setShowUsersModal(false)} 
                className="btn-secondary text-xs"
              >
                Schließen
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Backup Restore Modal */}
      {showRestoreModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="glass-panel p-6 sm:p-7 rounded-2xl w-full max-w-lg border border-slate-700/60 shadow-2xl relative">
            <button 
              onClick={() => !restoring && setShowRestoreModal(false)}
              className="absolute top-5 right-5 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
              disabled={restoring}
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                <UploadCloud className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">Backup einspielen</h2>
                <p className="text-xs text-slate-400">Stelle deine SQLite-Datenbank und Coverbilder wieder her</p>
              </div>
            </div>

            {/* Warning Callout */}
            <div className="bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3.5 rounded-xl text-xs flex gap-3 mb-5 leading-relaxed">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-amber-300">Wichtiger Hinweis:</span> Das Einspielen überschreibt die aktuelle Datenbank (<code className="bg-amber-500/20 px-1 py-0.5 rounded text-[11px]">manga.db</code>) und alle Coverbilder mit dem Stand aus dem ausgewählten Backup-Archiv.
              </div>
            </div>

            {restoreError && (
              <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 p-3.5 rounded-xl text-xs flex items-center gap-2 mb-4 animate-shake">
                <X className="w-4 h-4 shrink-0" />
                <span>{restoreError}</span>
              </div>
            )}

            {restoreSuccess && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 p-3.5 rounded-xl text-xs flex items-center gap-2 mb-4">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{restoreSuccess}</span>
              </div>
            )}

            <form onSubmit={handleRestoreSubmit} className="space-y-4">
              <div className="border-2 border-dashed border-slate-700/80 hover:border-emerald-500/50 rounded-2xl p-6 text-center transition-colors bg-slate-900/40">
                <input
                  type="file"
                  id="backup-file-input"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setRestoreFile(file);
                      setRestoreError('');
                    }
                  }}
                  disabled={restoring}
                />
                
                {restoreFile ? (
                  <div className="flex flex-col items-center">
                    <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300 mb-3">
                      <FileArchive className="w-6 h-6" />
                    </div>
                    <span className="text-sm font-semibold text-white truncate max-w-xs">{restoreFile.name}</span>
                    <span className="text-xs text-slate-400 mt-1">
                      {(restoreFile.size / (1024 * 1024)).toFixed(2)} MB
                    </span>
                    <button
                      type="button"
                      onClick={() => setRestoreFile(null)}
                      className="mt-3 text-xs text-rose-400 hover:underline"
                      disabled={restoring}
                    >
                      Andere Datei auswählen
                    </button>
                  </div>
                ) : (
                  <label htmlFor="backup-file-input" className="cursor-pointer flex flex-col items-center">
                    <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 mb-3 hover:text-emerald-400 transition-colors">
                      <UploadCloud className="w-6 h-6" />
                    </div>
                    <span className="text-sm font-semibold text-slate-200">Klicke hier, um dein Backup auszuwählen</span>
                    <span className="text-xs text-slate-500 mt-1">Nur .zip-Dateien (z. B. manga-shelf-backup.zip)</span>
                  </label>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setShowRestoreModal(false)}
                  className="btn-secondary text-xs"
                  disabled={restoring}
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  className="btn-primary flex items-center gap-2 text-xs !bg-emerald-600 hover:!bg-emerald-500 disabled:opacity-50"
                  disabled={restoring || !restoreFile}
                >
                  {restoring ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" /> Backup wird eingespielt...
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-4 h-4" /> Backup jetzt einspielen
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* STATISTIK- & FINANZ-DASHBOARD MODAL */}
      {showStatsModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 animate-fade-in">
          <div className="glass-panel w-full max-w-4xl max-h-[90vh] rounded-3xl p-6 sm:p-8 border border-slate-700/80 shadow-2xl relative flex flex-col overflow-hidden">
            
            {/* Modal Header */}
            <div className="flex items-start justify-between pb-5 border-b border-slate-800 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-950/40">
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-xl font-extrabold text-white tracking-tight flex items-center gap-2">
                    Statistik- & Finanz-Dashboard
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Finanzen, Monatsausgaben, Verlagsdiagramm, Sammelzeit & Lese-Tracking
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setShowStatsModal(false)} 
                className="text-slate-400 hover:text-white p-1 rounded-xl hover:bg-slate-800 transition-colors"
                title="Schließen"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="flex items-center gap-2 pt-4 pb-2 shrink-0 border-b border-slate-800/80">
              <button
                onClick={() => setStatsTab('overview')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  statsTab === 'overview'
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Coins className="w-3.5 h-3.5" /> Finanzen & Sammelzeit
              </button>
              <button
                onClick={() => setStatsTab('publishers')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  statsTab === 'publishers'
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <Building2 className="w-3.5 h-3.5" /> Verlagsdiagramm
              </button>
              <button
                onClick={() => setStatsTab('reading')}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  statsTab === 'reading'
                    ? 'bg-emerald-600 text-white shadow-md'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                }`}
              >
                <BookCheck className="w-3.5 h-3.5" /> Lese-Tracking (User)
              </button>
            </div>

            {/* Modal Body / Scrollable */}
            <div className="overflow-y-auto flex-1 pr-1 pt-4 space-y-6">
              {loadingStats ? (
                <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3">
                  <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-xs">Berechne Statistiken & Finanzdaten...</p>
                </div>
              ) : !statsData ? (
                <div className="py-12 text-center text-slate-400 text-sm">
                  Keine Statistikdaten verfügbar.
                </div>
              ) : (() => {
                  const summary = statsData.summary || statsData || {};
                  const totalOwnedVal = typeof summary.total_owned_value === 'number' ? summary.total_owned_value : (parseFloat(summary.total_owned_value) || 0);
                  const totalPossibleVal = typeof summary.total_possible_value === 'number' ? summary.total_possible_value : (parseFloat(summary.total_possible_value) || 0);
                  const avgMonthly = typeof summary.avg_monthly_spending === 'number' ? summary.avg_monthly_spending : (parseFloat(summary.avg_monthly_spending) || 0);
                  const avgPrice = typeof summary.avg_price_per_volume === 'number' ? summary.avg_price_per_volume : (parseFloat(summary.avg_price_per_volume) || 0);
                  const collMonths = summary.collection_months || statsData.duration?.months || 1;
                  const collYears = summary.collection_years || statsData.duration?.years || 0;
                  const collDays = summary.collection_days || statsData.duration?.days || 0;
                  const ownedVols = summary.total_owned_volumes || 0;
                  const totalVolsRecorded = summary.total_volumes_recorded || (summary.total_owned_volumes || 0) + (summary.total_missing_volumes || 0);
                  const publishersList = Array.isArray(statsData.publishers) ? statsData.publishers : [];
                  const readersList = Array.isArray(statsData.user_reading_stats) ? statsData.user_reading_stats : [];
                  const topSeriesList = Array.isArray(statsData.top_series) ? statsData.top_series : [];

                  return (
                    <>
                      {/* TAB 1: OVERVIEW & FINANCES */}
                      {statsTab === 'overview' && (
                        <div className="space-y-6 animate-fade-in">
                          {/* Top 4 KPI Cards */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                            
                            {/* 1: Sammlungswert (Besitz) */}
                            <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-950/40 via-slate-900/90 to-slate-950 border border-emerald-500/30 shadow-lg">
                              <div className="flex items-center justify-between text-emerald-400 mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider">Sammlungswert</span>
                                <Coins className="w-4 h-4" />
                              </div>
                              <div className="text-2xl font-extrabold text-white font-mono">
                                {totalOwnedVal.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                              </div>
                              <p className="text-[11px] text-slate-400 mt-1">
                                {ownedVols} Bände im Besitz (Ø {avgPrice.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €/Band)
                              </p>
                            </div>

                            {/* 2: Monatsausgaben */}
                            <div className="p-4 rounded-2xl bg-gradient-to-br from-sky-950/40 via-slate-900/90 to-slate-950 border border-sky-500/30 shadow-lg">
                              <div className="flex items-center justify-between text-sky-400 mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider">Monatsausgaben</span>
                                <TrendingUp className="w-4 h-4" />
                              </div>
                              <div className="text-2xl font-extrabold text-sky-300 font-mono">
                                {avgMonthly.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                              </div>
                              <p className="text-[11px] text-slate-400 mt-1">
                                Durchschnitt pro Monat über {collMonths} Monate
                              </p>
                            </div>

                            {/* 3: Sammelzeit */}
                            <div className="p-4 rounded-2xl bg-gradient-to-br from-amber-950/40 via-slate-900/90 to-slate-950 border border-amber-500/30 shadow-lg">
                              <div className="flex items-center justify-between text-amber-400 mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider">Sammelzeit</span>
                                <Clock className="w-4 h-4" />
                              </div>
                              <div className="text-2xl font-extrabold text-amber-300 font-mono">
                                {collYears} Jahre
                              </div>
                              <p className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
                                <span>{collDays} Tage aktiv</span>
                                <button
                                  type="button"
                                  onClick={() => setEditingStartDate(!editingStartDate)}
                                  className="text-amber-400 hover:text-amber-300 underline font-medium text-[10px]"
                                >
                                  {editingStartDate ? 'Schließen' : 'Datum ändern'}
                                </button>
                              </p>
                            </div>

                            {/* 4: Gesamtwert (inkl. fehlende) */}
                            <div className="p-4 rounded-2xl bg-gradient-to-br from-purple-950/40 via-slate-900/90 to-slate-950 border border-purple-500/30 shadow-lg">
                              <div className="flex items-center justify-between text-purple-400 mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider">Vollständiger Wert</span>
                                <Wallet className="w-4 h-4" />
                              </div>
                              <div className="text-2xl font-extrabold text-purple-300 font-mono">
                                {totalPossibleVal.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                              </div>
                              <p className="text-[11px] text-slate-400 mt-1">
                                Gesamtwert aller {totalVolsRecorded} erfassten Bände
                              </p>
                            </div>

                          </div>

                      {/* Collection Start Date Editor */}
                      {editingStartDate && (
                        <form onSubmit={handleSaveStartDate} className="p-4 bg-slate-950/90 rounded-2xl border border-amber-500/40 flex flex-wrap items-center gap-3">
                          <Calendar className="w-4 h-4 text-amber-400 shrink-0" />
                          <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-semibold text-slate-300 mb-1">
                              Sammlungs-Startdatum festlegen (Berechnung der Sammelzeit & Monatsausgaben)
                            </label>
                            <input
                              type="date"
                              required
                              className="input-field text-xs py-1.5"
                              value={newStartDate}
                              onChange={e => setNewStartDate(e.target.value)}
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={savingStartDate}
                            className="btn-primary text-xs py-2 px-3 !bg-amber-600 hover:!bg-amber-500 text-white mt-auto"
                          >
                            {savingStartDate ? 'Speichert...' : 'Datum speichern'}
                          </button>
                        </form>
                      )}

                      {/* Quick Summary Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Reading Summary Card */}
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
                            <BookCheck className="w-4 h-4 text-emerald-400" /> Lese-Fortschritt der Community
                          </h4>
                          <div className="space-y-3.5">
                            {readersList.map(r => {
                              const pct = r.read_pct !== undefined ? r.read_pct : (r.percentage || 0);
                              return (
                                <div key={r.user_id} className="space-y-1.5">
                                  <div className="flex justify-between items-center text-xs">
                                    <span className="font-semibold text-white">{r.display_name || r.username}</span>
                                    <span className="text-slate-400 font-mono">
                                      <strong className="text-emerald-400">{r.read_count}</strong> / {r.total_owned || ownedVols} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                                    <div 
                                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <div className="flex justify-between text-[10px] text-slate-500">
                                    <span>Gelesen: {r.read_count} Bände</span>
                                    <span>Noch ungelesen (SuB): {r.unread_count} Bände</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* Top Publishers Quick View */}
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center justify-between">
                            <span className="flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-sky-400" /> Größte Verlage im Regal
                            </span>
                            <button
                              type="button"
                              onClick={() => setStatsTab('publishers')}
                              className="text-sky-400 hover:text-sky-300 font-medium text-xs normal-case"
                            >
                              Alle anzeigen ↗
                            </button>
                          </h4>
                          <div className="space-y-3">
                            {publishersList.slice(0, 4).map(pub => (
                              <div key={pub.publisher} className="space-y-1">
                                <div className="flex justify-between items-center text-xs">
                                  <span className="font-medium text-slate-200 truncate">{pub.publisher}</span>
                                  <span className="font-mono text-slate-400 shrink-0">
                                    <strong className="text-white">{pub.volumes_count}</strong> Bände ({pub.percentage}%)
                                  </span>
                                </div>
                                <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                                  <div 
                                    className="h-full bg-sky-500 rounded-full"
                                    style={{ width: `${Math.min(100, pub.percentage * 2)}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Top Series Showcase */}
                      {topSeriesList && topSeriesList.length > 0 && (
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
                            <Award className="w-4 h-4 text-amber-400" /> Top Reihen mit den meisten Bänden
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                            {topSeriesList.map((ts, idx) => (
                              <Link
                                key={ts.id}
                                to={`/manga/${ts.id}`}
                                onClick={() => setShowStatsModal(false)}
                                className="group p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-850 transition-all flex flex-col items-center text-center"
                              >
                                <div className="relative w-full aspect-[2/3] rounded-lg overflow-hidden mb-2 bg-slate-950 border border-slate-800">
                                  {ts.cover_image ? (
                                    <img src={ts.cover_image} alt={ts.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-slate-700">
                                      <BookOpen className="w-6 h-6" />
                                    </div>
                                  )}
                                  <span className="absolute top-1 left-1 bg-black/80 text-amber-400 font-mono text-[10px] px-1.5 py-0.5 rounded font-bold">
                                    #{idx + 1}
                                  </span>
                                </div>
                                <span className="font-semibold text-xs text-white truncate w-full group-hover:text-brand-300">
                                  {ts.title}
                                </span>
                                <span className="text-[11px] font-mono text-emerald-400 mt-0.5">
                                  {ts.owned_volumes} Bände
                                </span>
                              </Link>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 2: PUBLISHERS DIAGRAM & BREAKDOWN */}
                  {statsTab === 'publishers' && (
                    <div className="space-y-6 animate-fade-in">
                      <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
                          <div>
                            <h4 className="text-sm font-bold text-white flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-sky-400" />
                              Verlagsverteilung & Sammlungsanteile
                            </h4>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Prozentualer Anteil jedes Verlags an allen vorhandenen Bänden
                            </p>
                          </div>
                          <span className="text-xs font-mono font-semibold text-slate-300 bg-slate-900 px-3 py-1 rounded-xl border border-slate-800">
                            {publishersList.length} Verlage gesamt
                          </span>
                        </div>

                        {/* Visual Colored Bar Diagram */}
                        <div className="mb-6 space-y-2">
                          <div className="w-full h-5 rounded-xl overflow-hidden flex bg-slate-900 border border-slate-800">
                            {publishersList.slice(0, 8).map((pub, idx) => {
                              const colors = [
                                'bg-sky-500', 'bg-indigo-500', 'bg-emerald-500', 'bg-amber-500',
                                'bg-rose-500', 'bg-purple-500', 'bg-teal-500', 'bg-orange-500'
                              ];
                              const colorClass = colors[idx % colors.length];
                              return (
                                <div
                                  key={pub.publisher}
                                  className={`${colorClass} hover:opacity-90 transition-opacity`}
                                  style={{ width: `${pub.percentage}%` }}
                                  title={`${pub.publisher}: ${pub.percentage}% (${pub.volumes_count} Bände)`}
                                />
                              );
                            })}
                          </div>
                          <p className="text-[11px] text-slate-500 text-center">
                            Fahre mit der Maus über die Segmente, um Anteile zu sehen
                          </p>
                        </div>

                        {/* Detailed Table / Cards */}
                        <div className="space-y-2.5">
                          {publishersList.map((pub, idx) => {
                            const colors = [
                              'bg-sky-500', 'bg-indigo-500', 'bg-emerald-500', 'bg-amber-500',
                              'bg-rose-500', 'bg-purple-500', 'bg-teal-500', 'bg-orange-500'
                            ];
                            const dotColor = colors[idx % colors.length] || 'bg-slate-500';
                            return (
                              <div
                                key={pub.publisher}
                                className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs"
                              >
                                <div className="flex items-center gap-2.5 min-w-[200px]">
                                  <span className={`w-3 h-3 rounded-full ${dotColor} shrink-0`}></span>
                                  <div>
                                    <span className="font-bold text-white text-sm">{pub.publisher}</span>
                                    <span className="text-[11px] text-slate-400 block">{pub.series_count} Reihen</span>
                                  </div>
                                </div>

                                <div className="flex-1 w-full sm:w-auto sm:max-w-xs mx-0 sm:mx-4">
                                  <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                                    <span>Anteil:</span>
                                    <strong className="text-white font-mono">{pub.percentage}%</strong>
                                  </div>
                                  <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                                    <div
                                      className={`h-full ${dotColor} rounded-full`}
                                      style={{ width: `${pub.percentage}%` }}
                                    />
                                  </div>
                                </div>

                                <div className="flex items-center gap-4 text-right shrink-0">
                                  <div>
                                    <span className="font-mono font-bold text-white text-sm">{pub.volumes_count}</span>
                                    <span className="text-[11px] text-slate-400 block">Bände</span>
                                  </div>
                                  <div className="min-w-[80px]">
                                    <span className="font-mono font-bold text-emerald-400 text-sm">
                                      {pub.total_value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                                    </span>
                                    <span className="text-[11px] text-slate-400 block">Gesamtwert</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 3: USER READING STATS */}
                  {statsTab === 'reading' && (
                    <div className="space-y-6 animate-fade-in">
                      {detailedReaderStats ? (
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <div className="flex items-center gap-3 mb-6">
                            <button 
                              onClick={() => setDetailedReaderStats(null)} 
                              className="p-2 bg-slate-800/80 hover:bg-slate-700 rounded-lg text-slate-300 hover:text-white transition-colors"
                            >
                              Zurück
                            </button>
                            <div>
                              <h4 className="text-sm font-bold text-white">Gelesene Mangas von {detailedReaderStats.user.username}</h4>
                              <p className="text-xs text-slate-400">
                                {detailedReaderStats.stats.totalVolumes} Bände ({detailedReaderStats.stats.totalPages} Seiten) insgesamt gelesen
                              </p>
                            </div>
                          </div>
                          
                          <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
                            {detailedReaderStats.stats.readMangas.map(m => (
                              <div key={m.id} className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex gap-4 items-start">
                                <div className="w-12 h-16 bg-slate-800 rounded overflow-hidden shrink-0 shadow-md">
                                  {m.cover_image ? (
                                    <img src={m.cover_image} alt={m.title} className="w-full h-full object-cover" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-slate-600">
                                      <BookOpen className="w-5 h-5"/>
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <Link to={`/manga/${m.id}`} onClick={() => setShowStatsModal(false)} className="font-bold text-white text-sm mb-2 hover:text-emerald-400 transition-colors inline-block">
                                    {m.title}
                                  </Link>
                                  <div className="flex flex-wrap gap-1.5">
                                    {m.volumes.map(v => (
                                      <span 
                                        key={v.volume_number} 
                                        className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-mono flex items-center gap-1"
                                        title={`Gelesen am: ${new Date(v.read_at).toLocaleString('de-DE')}`}
                                      >
                                        <CheckCircle2 className="w-3 h-3" />
                                        Bd. {v.volume_number}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            ))}
                            {detailedReaderStats.stats.readMangas.length === 0 && (
                              <div className="text-center py-8 bg-slate-900/50 rounded-xl border border-slate-800/50">
                                <BookOpen className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                                <p className="text-xs text-slate-400">Noch keine Bände als gelesen markiert.</p>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-sm font-bold text-white flex items-center gap-2 mb-2">
                            <BookCheck className="w-4 h-4 text-emerald-400" />
                            Lese-Tracking & SuB (Stapel ungelesener Bücher)
                          </h4>
                          <p className="text-xs text-slate-400 mb-6">
                            Übersicht aller Leser und deren Lesestatus über die gesamte Manga-Sammlung.
                          </p>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {readersList.map(r => {
                              const pct = r.read_pct !== undefined ? r.read_pct : (r.percentage || 0);
                              return (
                                <div key={r.user_id} className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
                                  <div>
                                    <div className="flex items-center justify-between mb-3">
                                      <div className="flex items-center gap-2.5">
                                        <div className="w-9 h-9 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center font-bold text-brand-300">
                                          {(r.display_name || r.username || '?').charAt(0).toUpperCase()}
                                        </div>
                                        <div>
                                          <h5 className="font-bold text-white text-base">{r.display_name || r.username}</h5>
                                          <span className="text-[11px] text-slate-400">@{r.username}</span>
                                        </div>
                                      </div>
                                      <div className="text-right">
                                        <span className="text-xl font-extrabold font-mono text-emerald-400">{pct}%</span>
                                        <span className="text-[10px] text-slate-400 block">gelesen</span>
                                      </div>
                                    </div>

                                    <div className="w-full h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800 mb-4">
                                      <div 
                                        className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>

                                    <div className="grid grid-cols-3 gap-2 text-center p-3 rounded-xl bg-slate-950/60 border border-slate-800/60 text-xs">
                                      <div>
                                        <span className="text-slate-400 text-[10px] block">Gelesen</span>
                                        <strong className="font-mono text-emerald-400 text-sm">{r.read_count}</strong>
                                      </div>
                                      <div>
                                        <span className="text-slate-400 text-[10px] block">SuB (Offen)</span>
                                        <strong className="font-mono text-amber-400 text-sm">{r.unread_count}</strong>
                                      </div>
                                      <div>
                                        <span className="text-slate-400 text-[10px] block">Im Besitz</span>
                                        <strong className="font-mono text-white text-sm">{r.total_owned || ownedVols}</strong>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="mt-4 pt-4 border-t border-slate-800">
                                    <button 
                                      onClick={() => fetchReaderDetailedStats(r.user_id)}
                                      disabled={loadingDetailedStats}
                                      className="w-full py-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-700/80 border border-slate-700 hover:border-slate-600 text-slate-300 text-xs font-semibold transition-colors flex items-center justify-center gap-2"
                                    >
                                      {loadingDetailedStats ? 'Lädt...' : 'Alle gelesenen Bände anzeigen'}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
            </div>

            {/* Modal Footer */}
            <div className="pt-4 mt-4 border-t border-slate-800 flex justify-end shrink-0">
              <button 
                type="button" 
                onClick={() => setShowStatsModal(false)} 
                className="btn-secondary text-xs px-4 py-2"
              >
                Schließen
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
