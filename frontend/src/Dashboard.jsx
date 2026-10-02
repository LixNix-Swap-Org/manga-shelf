import ShoppingListView from './components/dashboard/ShoppingListView';
import ReleaseRadarView from './components/dashboard/ReleaseRadarView';
import UserManagementModal from './components/modals/UserManagementModal';
import BackupRestoreModal from './components/modals/BackupRestoreModal';
import StatsModal from './components/modals/StatsModal';
import AddMangaModal from './components/modals/AddMangaModal';
import BarcodeScannerButton from './components/common/BarcodeScannerButton';
import { useState, useEffect, useRef, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { normalizePubName } from './utils/volumeHelpers';
import { 
  Search, Plus, Download, LogOut, BookOpen, Trash2, 
  Sparkles, CheckCircle2, Library, X, Upload, Layers,
  Users, UserPlus, Shield, User, Lock, Key, Coins, Tag,
  Building2, ArrowUpDown, ChevronDown, UploadCloud, AlertTriangle,
  FileArchive, RefreshCw, BarChart3, TrendingUp, Calendar, Clock, 
  BookCheck, Wallet, Award, PieChart, ShoppingCart, ShoppingBag, Check,
  LayoutGrid, List, Menu, Wifi, WifiOff, Package, Bookmark, Truck,
  ChevronLeft, ChevronRight, Globe, ExternalLink, BookmarkCheck, Star
} from 'lucide-react';
import MangaCollectionGrid from './components/dashboard/MangaCollectionGrid';
import CollectionToolbar from './components/dashboard/CollectionToolbar';
import DashboardHeader from './components/dashboard/DashboardHeader';

const GERMAN_MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
];

const formatGermanDate = (dateStr) => {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  const weekdays = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  const weekday = weekdays[d.getDay()] || '';
  const day = parts[2];
  const monthName = GERMAN_MONTHS[Number(parts[1]) - 1] || parts[1];
  const year = parts[0];
  return `${weekday}, ${day}. ${monthName} ${year}`;
};

export default function Dashboard({ user, onLogout }) {
  const isVisitor = !user || user.role === 'visitor' || user.role === 'guest';
  const canEdit = user && (user.role === 'admin' || user.role === 'editor');

  const navigate = useNavigate();
  const [mangas, setMangas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef(null);

  const handleBarcodeDetected = async (scannedCode) => {
    setSearch(scannedCode);
    try {
      const res = await fetch(`/api/lookup/isbn?isbn=${encodeURIComponent(scannedCode)}`);
      const data = await res.json();
      if (data && data.found && data.matched_manga) {
        setSearch(data.matched_manga.title);
        navigate(`/manga/${data.matched_manga.id}`);
      } else if (data && data.found && data.book) {
        setSearch(data.book.title);
      }
    } catch (e) {
      console.warn('Barcode lookup failed:', e);
    }
  };
  const [statusFilter, setStatusFilter] = useState(() => {
    try { return localStorage.getItem('mangashelf_status_filter') || 'ALL'; } catch (_) { return 'ALL'; }
  });
  const [publisherFilter, setPublisherFilter] = useState(() => {
    try { return localStorage.getItem('mangashelf_publisher_filter') || 'ALL'; } catch (_) { return 'ALL'; }
  });
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('mangashelf_sort_by') || 'title_asc'; } catch (_) { return 'title_asc'; }
  });
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('mangashelf_view_mode') || 'grid'; } catch (_) { return 'grid'; }
  }); // 'grid' | 'list'
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [failedImages, setFailedImages] = useState({});

  // Modal visibility states
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [showUsersModal, setShowUsersModal] = useState(false);
  const [showRestoreModal, setShowRestoreModal] = useState(false);

  // Main view switcher: 'shelf' | 'shopping' | 'radar' (initialized from URL if present)
  const [activeMainView, setActiveMainView] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('view');
      if (v === 'shopping' || v === 'radar') return v;
    } catch (_) {}
    return 'shelf';
  });

  // Shopping / Wishlist state with offline local storage cache
  const [shoppingData, setShoppingData] = useState(() => {
    try {
      const cached = localStorage.getItem('mangashelf_shopping_cache');
      return cached ? JSON.parse(cached) : null;
    } catch (_) { return null; }
  });
  const [loadingShopping, setLoadingShopping] = useState(false);
  const [shoppingPublisherFilter, setShoppingPublisherFilter] = useState('ALL');
  const [shoppingSearch, setShoppingSearch] = useState('');
  const [buyingId, setBuyingId] = useState(null);

  // Release-Radar State
  const [radarData, setRadarData] = useState(null);
  const [loadingRadar, setLoadingRadar] = useState(false);
  const [radarPublisherFilter, setRadarPublisherFilter] = useState('ALL');
  const [radarStatusFilter, setRadarStatusFilter] = useState('ALL');
  const [radarSearch, setRadarSearch] = useState('');
  const [markingDeliveredId, setMarkingDeliveredId] = useState(null);

  // Manga Passion Kalender State
  const initialDate = new Date();
  const [radarSubView, setRadarSubView] = useState('passion'); // 'passion' | 'personal'
  const [mpYear, setMpYear] = useState(initialDate.getFullYear());
  const [mpMonth, setMpMonth] = useState(initialDate.getMonth() + 1);
  const [mpData, setMpData] = useState(null);
  const [loadingMp, setLoadingMp] = useState(false);
  const [mpSearch, setMpSearch] = useState('');
  const [mpPublisherFilter, setMpPublisherFilter] = useState('ALL');
  const [mpPrintOnly, setMpPrintOnly] = useState(true);
  const [mpMySeriesOnly, setMpMySeriesOnly] = useState(false);
  const [importingMpId, setImportingMpId] = useState(null);

  // Network & PWA State
  const [isOfflineMode, setIsOfflineMode] = useState(!navigator.onLine);
  const [offlineLastUpdated, setOfflineLastUpdated] = useState(() => {
    try {
      const meta = localStorage.getItem('mangashelf_shopping_meta');
      return meta ? JSON.parse(meta)?.timestamp : null;
    } catch (_) { return null; }
  });

  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [isInstalledApp, setIsInstalledApp] = useState(() => {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  });

  // PWA Install Prompt Listener
  useEffect(() => {
    const handleBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setIsInstallable(true);
    };
    const handleAppInstalled = () => {
      setIsInstallable(false);
      setDeferredPrompt(null);
      setIsInstalledApp(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstallable(false);
    }
    setDeferredPrompt(null);
  };

  // Sync offline queued purchases once online
  const syncPendingPurchases = async () => {
    try {
      const queue = JSON.parse(localStorage.getItem('mangashelf_pending_purchases') || '[]');
      if (!queue.length) return;
      console.log(`[PWA] Synchronisiere ${queue.length} offline getätigte Käufe...`);
      for (const volId of queue) {
        await fetch(`/api/volumes/${volId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'Vorhanden' })
        });
      }
      localStorage.removeItem('mangashelf_pending_purchases');
      fetchShoppingList();
      fetchMangas();
    } catch (err) {
      console.warn('Sync pending purchases deferred:', err);
    }
  };

  // Online / Offline Network Listeners
  useEffect(() => {
    const handleOnline = () => {
      setIsOfflineMode(false);
      syncPendingPurchases();
      fetchShoppingList();
      fetchMangas();
    };
    const handleOffline = () => {
      setIsOfflineMode(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial sync check
    if (navigator.onLine) {
      syncPendingPurchases();
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    fetchMangas();
    fetchShoppingList();
    fetchReleaseRadar();
  }, []);

  // Fetch heavy Manga Passion monthly calendar releases only when radar view is active
  useEffect(() => {
    if (activeMainView === 'radar' && !mpData && !loadingMp) {
      fetchMangaPassionReleases(mpYear, mpMonth);
    }
  }, [activeMainView, mpData, loadingMp, mpYear, mpMonth]);

  useEffect(() => {
    try { localStorage.setItem('mangashelf_status_filter', statusFilter); } catch (_) {}
  }, [statusFilter]);

  useEffect(() => {
    try { localStorage.setItem('mangashelf_publisher_filter', publisherFilter); } catch (_) {}
  }, [publisherFilter]);

  useEffect(() => {
    try { localStorage.setItem('mangashelf_sort_by', sortBy); } catch (_) {}
  }, [sortBy]);

  useEffect(() => {
    try { localStorage.setItem('mangashelf_view_mode', viewMode); } catch (_) {}
  }, [viewMode]);

  const fetchShoppingList = async () => {
    try {
      setLoadingShopping(true);
      const res = await fetch('/api/shopping-list');
      if (res.ok) {
        const data = await res.json();
        setShoppingData(data);
        setIsOfflineMode(false);
        const now = new Date().toISOString();
        setOfflineLastUpdated(now);
        try {
          localStorage.setItem('mangashelf_shopping_cache', JSON.stringify(data));
          localStorage.setItem('mangashelf_shopping_meta', JSON.stringify({ timestamp: now }));
        } catch (_) {}
      } else {
        // Fallback to cache if server error
        const cached = localStorage.getItem('mangashelf_shopping_cache');
        if (cached) {
          setShoppingData(JSON.parse(cached));
          setIsOfflineMode(true);
        }
      }
    } catch (e) {
      console.warn('Network issue fetching shopping list, using offline cache:', e);
      try {
        const cached = localStorage.getItem('mangashelf_shopping_cache');
        if (cached) {
          setShoppingData(JSON.parse(cached));
          setIsOfflineMode(true);
        }
      } catch (_) {}
    } finally {
      setLoadingShopping(false);
    }
  };

  const handleQuickBuy = async (volumeId) => {
    setBuyingId(volumeId);

    const updateLocalState = () => {
      setShoppingData(prev => {
        if (!prev) return prev;
        const updatedItems = prev.items.filter(item => item.id !== volumeId);
        const boughtItem = prev.items.find(item => item.id === volumeId);
        const newCost = Math.max(0, prev.total_cost - (boughtItem?.price || 0));
        const updated = {
          ...prev,
          total_missing: updatedItems.length,
          total_cost: Math.round(newCost * 100) / 100,
          items: updatedItems
        };
        try {
          localStorage.setItem('mangashelf_shopping_cache', JSON.stringify(updated));
        } catch (_) {}
        if ('vibrate' in navigator) {
          try { navigator.vibrate([25, 45, 25]); } catch (_) {}
        }
        return updated;
      });
    };

    if (!navigator.onLine) {
      // Offline mode: queue purchase in local storage
      try {
        const queue = JSON.parse(localStorage.getItem('mangashelf_pending_purchases') || '[]');
        if (!queue.includes(volumeId)) queue.push(volumeId);
        localStorage.setItem('mangashelf_pending_purchases', JSON.stringify(queue));
      } catch (_) {}
      updateLocalState();
      setBuyingId(null);
      return;
    }

    try {
      const res = await fetch(`/api/volumes/${volumeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Vorhanden' })
      });
      if (res.ok) {
        updateLocalState();
        fetchMangas();
        fetchShoppingList();
      } else {
        alert('Fehler beim Aktualisieren des Bands');
      }
    } catch (e) {
      // Network drop: queue purchase offline
      try {
        const queue = JSON.parse(localStorage.getItem('mangashelf_pending_purchases') || '[]');
        if (!queue.includes(volumeId)) queue.push(volumeId);
        localStorage.setItem('mangashelf_pending_purchases', JSON.stringify(queue));
      } catch (_) {}
      updateLocalState();
      setIsOfflineMode(true);
    } finally {
      setBuyingId(null);
    }
  };

  const fetchReleaseRadar = async () => {
    try {
      setLoadingRadar(true);
      const res = await fetch('/api/release-radar');
      if (res.ok) {
        const data = await res.json();
        setRadarData(data);
      }
    } catch (err) {
      console.error('Error fetching release radar:', err);
    } finally {
      setLoadingRadar(false);
    }
  };

  const handleMarkDelivered = async (item) => {
    if (!canEdit) return;
    setMarkingDeliveredId(item.id);
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const res = await fetch(`/api/volumes/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'Vorhanden',
          purchase_date: item.purchase_date || todayStr
        })
      });
      if (res.ok) {
        await Promise.all([fetchReleaseRadar(), fetchMangas()]);
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Markieren als erhalten');
      }
    } catch (e) {
      console.error(e);
      alert('Netzwerkfehler');
    } finally {
      setMarkingDeliveredId(null);
    }
  };

  const fetchMangaPassionReleases = async (year, month, forceRefresh = false) => {
    try {
      setLoadingMp(true);
      const targetYear = year !== undefined ? year : mpYear;
      const targetMonth = month !== undefined ? month : mpMonth;
      const url = `/api/manga-passion/releases?year=${targetYear}&month=${targetMonth}${forceRefresh ? '&force_refresh=true' : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setMpData(data);
      }
    } catch (err) {
      console.error('Error fetching Manga Passion releases:', err);
    } finally {
      setLoadingMp(false);
    }
  };

  const handlePrevMonth = () => {
    let nextMonth = mpMonth - 1;
    let nextYear = mpYear;
    if (nextMonth < 1) {
      nextMonth = 12;
      nextYear -= 1;
    }
    setMpMonth(nextMonth);
    setMpYear(nextYear);
    fetchMangaPassionReleases(nextYear, nextMonth);
  };

  const handleNextMonth = () => {
    let nextMonth = mpMonth + 1;
    let nextYear = mpYear;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    setMpMonth(nextMonth);
    setMpYear(nextYear);
    fetchMangaPassionReleases(nextYear, nextMonth);
  };

  const handleCurrentMonth = () => {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    setMpYear(curYear);
    setMpMonth(curMonth);
    fetchMangaPassionReleases(curYear, curMonth);
  };

  const handleImportMangaPassion = async (item, targetStatus = 'Vorbestellt') => {
    if (!canEdit) return;
    setImportingMpId(item.id);
    try {
      const res = await fetch('/api/manga-passion/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: item.user_manga_id || null,
          title: item.title,
          volume_number: item.volume_number,
          publisher: item.publisher,
          release_date: item.date,
          price: item.price,
          cover_image: item.cover_image,
          target_status: targetStatus
        })
      });
      if (res.ok) {
        const resData = await res.json();
        setMpData(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map(it => {
              if (it.id === item.id) {
                return {
                  ...it,
                  in_collection: true,
                  user_manga_id: resData.manga_id,
                  user_volume_id: resData.volume_id,
                  user_volume_status: targetStatus
                };
              }
              return it;
            })
          };
        });
        fetchReleaseRadar();
        fetchMangas();
        fetchShoppingList();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Übernehmen des Bands');
      }
    } catch (e) {
      console.error(e);
      alert('Netzwerkfehler');
    } finally {
      setImportingMpId(null);
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

  const handleOpenStats = () => {
    setShowStatsModal(true);
  };

  const handleOpenModal = () => {
    if (!canEdit) return;
    setShowAddModal(true);
  };

  // Keyboard shortcuts: '/' to focus search, 'Escape' to close open modals or blur/clear
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showAddModal) {
          setShowAddModal(false);
          return;
        }
        if (showStatsModal) {
          setShowStatsModal(false);
          return;
        }
        if (showUsersModal) {
          setShowUsersModal(false);
          return;
        }
        if (showRestoreModal) {
          setShowRestoreModal(false);
          return;
        }
        if (mobileMenuOpen) {
          setMobileMenuOpen(false);
          return;
        }
        if (document.activeElement === searchInputRef.current) {
          setSearch('');
          searchInputRef.current?.blur();
        } else if (search) {
          setSearch('');
        }
      } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal, showStatsModal, showUsersModal, showRestoreModal, mobileMenuOpen, search]);

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

  const handleOpenUsersModal = () => {
    setShowUsersModal(true);
  };

  const handleOpenRestoreModal = () => {
    setShowRestoreModal(true);
  };

  // Available publishers for filtering (deduplicated case-insensitively & canonicalized)
  const availablePublishers = useMemo(() => {
    const pubMap = new Map();
    mangas.forEach(m => {
      const raw = m.publisher && m.publisher.trim();
      if (!raw) return;
      const canonical = normalizePubName(raw);
      const key = canonical.toLowerCase();
      if (!pubMap.has(key)) {
        pubMap.set(key, canonical);
      }
    });
    return Array.from(pubMap.values()).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  }, [mangas]);

  // Helper for reading progress calculation (0 - 100%)
  const getMangaProgress = (m) => {
    const total = m.owned_volumes || m.volume_count || 0;
    if (total === 0) return 0;
    const read = m.read_volume_count || 0;
    return Math.min(100, Math.round((read / total) * 100));
  };

  // Status Filter Counts for badges
  const filterCounts = useMemo(() => ({
    ALL: mangas.length,
    Laufend: mangas.filter(m => m.status === 'Laufend').length,
    Abgeschlossen: mangas.filter(m => m.status === 'Abgeschlossen').length,
    UNREAD: mangas.filter(m => {
      const total = m.owned_volumes || m.volume_count || 0;
      return total > 0 && (m.read_volume_count || 0) < total;
    }).length,
    READ_ALL: mangas.filter(m => {
      const total = m.owned_volumes || m.volume_count || 0;
      return total > 0 && (m.read_volume_count || 0) >= total;
    }).length,
    Pausiert: mangas.filter(m => m.status === 'Pausiert').length,
    Geplant: mangas.filter(m => m.status === 'Geplant').length,
  }), [mangas]);

  // Filter & sort logic
  const filtered = useMemo(() => {
    return mangas
      .filter(m => {
        const q = search.toLowerCase().trim();
        const matchesSearch = 
          !q ||
          m.title.toLowerCase().includes(q) || 
          (m.alt_title && m.alt_title.toLowerCase().includes(q)) ||
          (m.author && m.author.toLowerCase().includes(q)) ||
          (m.publisher && m.publisher.toLowerCase().includes(q));
        
        if (!matchesSearch) return false;

        // Status Filter logic
        if (statusFilter === 'UNREAD') {
          const total = m.owned_volumes || m.volume_count || 0;
          if (total === 0 || (m.read_volume_count || 0) >= total) return false;
        } else if (statusFilter === 'READ_ALL') {
          const total = m.owned_volumes || m.volume_count || 0;
          if (total === 0 || (m.read_volume_count || 0) < total) return false;
        } else if (statusFilter !== 'ALL' && m.status !== statusFilter) {
          return false;
        }

        // Publisher Filter logic
        if (publisherFilter !== 'ALL') {
          const p = normalizePubName(m.publisher);
          if (p.toLowerCase() !== publisherFilter.toLowerCase()) return false;
        }
        return true;
      })
      .sort((a, b) => {
        switch (sortBy) {
          case 'newest_first':
            return (b.id || 0) - (a.id || 0);
          case 'oldest_first':
            return (a.id || 0) - (b.id || 0);
          case 'progress_desc':
            return getMangaProgress(b) - getMangaProgress(a) || (a.title || '').localeCompare(b.title || '');
          case 'progress_asc':
            return getMangaProgress(a) - getMangaProgress(b) || (a.title || '').localeCompare(b.title || '');
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
  }, [mangas, search, statusFilter, publisherFilter, sortBy]);

  // Summary stats
  const totalSeries = mangas.length;
  const { totalOwnedVolumes, totalCollectionValue, completedSeries } = useMemo(() => {
    let owned = 0;
    let val = 0;
    let completed = 0;
    for (let i = 0; i < mangas.length; i++) {
      const m = mangas[i];
      owned += (m.owned_volumes || 0);
      val += (m.total_value || 0);
      if (m.status === 'Abgeschlossen') completed++;
    }
    return {
      totalOwnedVolumes: owned,
      totalCollectionValue: val,
      completedSeries: completed
    };
  }, [mangas]);

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
    <div className="min-h-screen pb-16 overflow-x-hidden">
      {/* Top Navbar */}
      <DashboardHeader
        activeMainView={activeMainView}
        canEdit={canEdit}
        fetchReleaseRadar={fetchReleaseRadar}
        fetchShoppingList={fetchShoppingList}
        handleBarcodeDetected={handleBarcodeDetected}
        handleInstallClick={handleInstallClick}
        handleOpenModal={handleOpenModal}
        handleOpenRestoreModal={handleOpenRestoreModal}
        handleOpenStats={handleOpenStats}
        handleOpenUsersModal={handleOpenUsersModal}
        isInstallable={isInstallable}
        isInstalledApp={isInstalledApp}
        isOfflineMode={isOfflineMode}
        isVisitor={isVisitor}
        mobileMenuOpen={mobileMenuOpen}
        onLogout={onLogout}
        radarData={radarData}
        search={search}
        searchInputRef={searchInputRef}
        setActiveMainView={setActiveMainView}
        setMobileMenuOpen={setMobileMenuOpen}
        setSearch={setSearch}
        shoppingData={shoppingData}
        user={user}
      />

      {/* Main Container */}
      <main className="max-w-[1720px] 2xl:max-w-[1840px] mx-auto px-4 sm:px-6 lg:px-8 2xl:px-10">
        
        {/* Main View Switcher: Sammlung vs. Einkaufsliste */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
          <div className="flex items-center bg-slate-900/90 border border-slate-800 p-1 rounded-2xl shadow-inner">
            <button
              id="btn-nav-shelf"
              onClick={() => {
                setActiveMainView('shelf');
                try { window.history.replaceState(null, '', window.location.pathname); } catch (_) {}
              }}
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
              id="btn-nav-shopping"
              onClick={() => {
                setActiveMainView('shopping');
                try { window.history.replaceState(null, '', '?view=shopping'); } catch (_) {}
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
            <button
              id="btn-nav-radar"
              onClick={() => {
                setActiveMainView('radar');
                try { window.history.replaceState(null, '', '?view=radar'); } catch (_) {}
                fetchReleaseRadar();
                fetchMangaPassionReleases();
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold transition-all ${
                activeMainView === 'radar'
                  ? 'bg-gradient-to-r from-brand-600 to-sky-500 text-white shadow-lg shadow-brand-500/25'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Calendar className="w-4 h-4 text-sky-400" />
              <span>Release-Radar</span>
              {radarData && radarData.total_releases > 0 && (
                <span className="bg-sky-500/30 text-sky-300 text-[11px] font-mono px-2 py-0.5 rounded-full font-bold">
                  {radarData.total_releases}
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

          {activeMainView === 'radar' && (
            <div className="text-xs text-slate-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse"></span>
              <span>Kalender-Modus: Vorbestellungen & Neuerscheinungen im Blick</span>
            </div>
          )}
        </div>

        {/* SHELF VIEW */}
        {activeMainView === 'shelf' && (
          <>
            {/* Quick Stats Bar */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-4 mb-6 sm:mb-8">
          <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
            <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
              <Library className="w-4 h-4 sm:w-5 sm:h-5 text-sky-400" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">Reihen</p>
              <p className="text-lg sm:text-2xl font-extrabold text-white">{totalSeries}</p>
            </div>
          </div>

          <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
            <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">Bände im Besitz</p>
              <p className="text-lg sm:text-2xl font-extrabold text-white">{totalOwnedVolumes}</p>
            </div>
          </div>

          <div 
            onClick={handleOpenStats}
            className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80 hover:border-emerald-500/50 hover:bg-slate-900/90 cursor-pointer transition-all duration-200 group"
            title="Klicken für das vollständige Finanz- & Statistik-Dashboard"
          >
            <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/30 group-hover:scale-105 group-hover:bg-emerald-500/20 transition-all flex items-center justify-center shrink-0">
              <Coins className="w-4 h-4 sm:w-5 sm:h-5 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium truncate">Sammlungswert</p>
                <span className="text-[10px] text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity font-semibold hidden sm:inline">Details ↗</span>
              </div>
              <p className="text-sm sm:text-xl lg:text-2xl font-extrabold text-emerald-400 font-mono tracking-tight whitespace-nowrap">
                {totalCollectionValue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
              </p>
            </div>
          </div>

          <div className="glass-panel p-3 sm:p-4 rounded-2xl flex items-center gap-2.5 sm:gap-3.5 border border-slate-800/80">
            <div className="w-9 h-9 sm:w-11 sm:h-11 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5 text-purple-400" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] sm:text-[11px] text-slate-400 uppercase tracking-wider font-medium">Abgeschlossen</p>
              <p className="text-lg sm:text-2xl font-extrabold text-white">{completedSeries}</p>
            </div>
          </div>
        </section>

        {/* Filter & Sort Toolbar */}
        <CollectionToolbar
          availablePublishers={availablePublishers}
          filterCounts={filterCounts}
          filtered={filtered}
          publisherFilter={publisherFilter}
          search={search}
          setPublisherFilter={setPublisherFilter}
          setSearch={setSearch}
          setSortBy={setSortBy}
          setStatusFilter={setStatusFilter}
          setViewMode={setViewMode}
          sortBy={sortBy}
          statusFilter={statusFilter}
          viewMode={viewMode}
        />
        {/* Grid or Empty State */}
        <MangaCollectionGrid
          canEdit={canEdit}
          failedImages={failedImages}
          filtered={filtered}
          getStatusBadge={getStatusBadge}
          handleDeleteManga={handleDeleteManga}
          handleOpenModal={handleOpenModal}
          loading={loading}
          publisherFilter={publisherFilter}
          search={search}
          setFailedImages={setFailedImages}
          setPublisherFilter={setPublisherFilter}
          setSearch={setSearch}
          setStatusFilter={setStatusFilter}
          statusFilter={statusFilter}
          viewMode={viewMode}
        />
      </>
    )}

    {/* SHOPPING LIST VIEW */}
    {activeMainView === 'shopping' && (
      <ShoppingListView
        shoppingData={shoppingData}
        loadingShopping={loadingShopping}
        fetchShoppingList={fetchShoppingList}
        isOfflineMode={isOfflineMode}
        offlineLastUpdated={offlineLastUpdated}
        syncPendingPurchases={syncPendingPurchases}
        shoppingSearch={shoppingSearch}
        setShoppingSearch={setShoppingSearch}
        shoppingPublisherFilter={shoppingPublisherFilter}
        setShoppingPublisherFilter={setShoppingPublisherFilter}
        normalizePubName={normalizePubName}
        setActiveMainView={setActiveMainView}
        canEdit={canEdit}
        handleQuickBuy={handleQuickBuy}
        buyingId={buyingId}
        failedImages={failedImages}
        setFailedImages={setFailedImages}
      />
    )}

    {/* RELEASE RADAR / ERSCHEINUNGSKALENDER VIEW */}
    {activeMainView === 'radar' && (
      <ReleaseRadarView
        radarSubView={radarSubView}
        setRadarSubView={setRadarSubView}
        radarData={radarData}
        loadingRadar={loadingRadar}
        fetchReleaseRadar={fetchReleaseRadar}
        radarPublisherFilter={radarPublisherFilter}
        setRadarPublisherFilter={setRadarPublisherFilter}
        radarStatusFilter={radarStatusFilter}
        setRadarStatusFilter={setRadarStatusFilter}
        radarSearch={radarSearch}
        setRadarSearch={setRadarSearch}
        mpData={mpData}
        loadingMp={loadingMp}
        fetchMangaPassionReleases={fetchMangaPassionReleases}
        mpYear={mpYear}
        setMpYear={setMpYear}
        mpMonth={mpMonth}
        setMpMonth={setMpMonth}
        handlePrevMonth={handlePrevMonth}
        handleNextMonth={handleNextMonth}
        handleCurrentMonth={handleCurrentMonth}
        mpPrintOnly={mpPrintOnly}
        setMpPrintOnly={setMpPrintOnly}
        mpMySeriesOnly={mpMySeriesOnly}
        setMpMySeriesOnly={setMpMySeriesOnly}
        mpPublisherFilter={mpPublisherFilter}
        setMpPublisherFilter={setMpPublisherFilter}
        mpSearch={mpSearch}
        setMpSearch={setMpSearch}
        canEdit={canEdit}
        handleImportMangaPassion={handleImportMangaPassion}
        importingMpId={importingMpId}
        handleMarkDelivered={handleMarkDelivered}
        markingDeliveredId={markingDeliveredId}
        failedImages={failedImages}
        setFailedImages={setFailedImages}
        setActiveMainView={setActiveMainView}
        GERMAN_MONTHS={GERMAN_MONTHS}
        formatGermanDate={formatGermanDate}
      />
    )}
    </main>

  {/* Footer with App Version, Status & PWA Install */}
  <footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 text-center text-xs text-slate-500 border-t border-slate-800/60 mt-12 flex flex-col sm:flex-row items-center justify-between gap-3">
    <div className="flex items-center gap-2">
      <span className="font-semibold text-slate-400">Manga Shelf</span>
      <span className="text-slate-600">•</span>
      <span className="inline-flex items-center gap-1 font-mono text-[11px] bg-slate-800/80 text-slate-300 px-2 py-0.5 rounded-md border border-slate-700/60">
        v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2.11.0'}
      </span>
    </div>
    <div className="flex flex-wrap items-center justify-center gap-3 text-slate-400">
      {isOfflineMode ? (
        <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
          <WifiOff className="w-3.5 h-3.5" />
          Offline-Modus aktiv
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Online & Synchronisiert
        </span>
      )}
      {isInstallable && !isInstalledApp && (
        <button
          onClick={handleInstallClick}
          className="inline-flex items-center gap-1.5 text-brand-400 hover:text-brand-300 font-medium hover:underline cursor-pointer transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          App installieren
        </button>
      )}
    </div>
  </footer>

      {/* MODALS */}
      <AddMangaModal 
        isOpen={showAddModal} 
        onClose={() => setShowAddModal(false)} 
        onSuccess={() => fetchMangas()} 
      />

      <UserManagementModal 
        isOpen={showUsersModal} 
        onClose={() => setShowUsersModal(false)} 
        currentUser={user} 
      />

      <BackupRestoreModal 
        isOpen={showRestoreModal} 
        onClose={() => setShowRestoreModal(false)} 
        user={user} 
        onRestoreSuccess={() => {
          fetchMangas();
          fetchShoppingList();
          fetchReleaseRadar();
        }} 
      />

      <StatsModal 
        isOpen={showStatsModal} 
        onClose={() => setShowStatsModal(false)} 
        user={user} 
      />

    </div>
  );
}
