import ShoppingListView from './components/dashboard/ShoppingListView';
import ReleaseRadarView from './components/dashboard/ReleaseRadarView';
import UserManagementModal from './components/modals/UserManagementModal';
import BackupRestoreModal from './components/modals/BackupRestoreModal';
import StatsModal from './components/modals/StatsModal';
import AddMangaModal from './components/modals/AddMangaModal';
import BarcodeScannerButton from './components/common/BarcodeScannerButton';
import { useState, useEffect, useRef, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

  // Known canonical German publishers map for clean display
  const CANONICAL_PUBLISHERS = {
    'altraverse': 'Altraverse',
    'carlsen manga': 'Carlsen Manga',
    'crunchyroll': 'Crunchyroll',
    'dani books': 'Dani Books',
    'dark horse manga': 'Dark Horse Manga',
    'egmont manga': 'Egmont Manga',
    'hayabusa': 'Hayabusa',
    'kazé manga': 'Kazé Manga',
    'kaze manga': 'Kazé Manga',
    'manga cult': 'Manga Cult',
    'manga jam session': 'Manga JAM Session',
    'panini verlag gmbh': 'Panini Verlags GmbH',
    'panini verlags gmbh': 'Panini Verlags GmbH',
    'panini': 'Panini Verlags GmbH',
    'papertoons': 'Papertoons',
    'schreiber&leser': 'Schreiber&Leser',
    'schreiber & leser': 'Schreiber&Leser',
    'tokyopop': 'TOKYOPOP'
  };

  const normalizePubName = (name) => {
    if (!name || typeof name !== 'string') return '';
    const trimmed = name.trim();
    const lower = trimmed.toLowerCase();
    return CANONICAL_PUBLISHERS[lower] || trimmed;
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
      <header className="sticky top-0 z-30 glass-panel border-b border-slate-800/80 mb-8 px-4 sm:px-6 lg:px-8 py-3">
        <div className="max-w-[1720px] 2xl:max-w-[1840px] mx-auto flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-3 sm:gap-4 min-w-0">
          
          {/* Top Bar for Mobile & Tablet / Left item for Desktop */}
          <div className="flex items-center justify-between gap-3 w-full xl:w-auto shrink-0 min-w-0">
            {/* Logo & Title */}
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center shadow-lg shadow-brand-500/30 shrink-0">
                <BookOpen className="w-5 h-5 text-white" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <h1 className="text-lg sm:text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent leading-tight truncate">
                    MangaShelf
                  </h1>
                  <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded-md bg-slate-800/80 text-slate-400 border border-slate-700/60 leading-none shrink-0">
                    v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '2.8.2'}
                  </span>
                </div>
                <p className="text-[11px] sm:text-xs text-slate-400 flex items-center gap-1.5 mt-0.5 truncate">
                  <span className={`w-1.5 h-1.5 rounded-full ${isOfflineMode ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400 animate-pulse'} inline-block shrink-0`}></span>
                  <span className="truncate">{isOfflineMode ? 'Offline-Modus' : 'Sammlung & Tracker'}</span>
                </p>
              </div>
            </div>

            {/* Tablet & Mobile Quick Controls (< xl) */}
            <div className="flex xl:hidden items-center gap-1 sm:gap-1.5 shrink-0">
              <button 
                id="btn-mobile-shopping"
                onClick={() => {
                  const next = activeMainView === 'shelf' ? 'shopping' : 'shelf';
                  setActiveMainView(next);
                  if (next === 'shopping') fetchShoppingList();
                }}
                className={`p-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all relative flex items-center gap-1.5 text-xs shrink-0 ${
                  activeMainView === 'shopping'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                    : 'btn-secondary text-slate-300'
                }`}
                title="Einkaufsliste umschalten"
              >
                <ShoppingCart className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="hidden sm:inline">Einkauf</span>
                {shoppingData && shoppingData.total_missing > 0 && (
                  <span className="bg-emerald-500 text-slate-950 font-bold text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-mono shrink-0">
                    {shoppingData.total_missing}
                  </span>
                )}
              </button>

              <button 
                id="btn-mobile-radar"
                onClick={() => {
                  const next = activeMainView === 'radar' ? 'shelf' : 'radar';
                  setActiveMainView(next);
                  if (next === 'radar') fetchReleaseRadar();
                }}
                className={`p-1.5 sm:px-3 sm:py-2 rounded-xl border transition-all relative flex items-center gap-1.5 text-xs shrink-0 ${
                  activeMainView === 'radar'
                    ? 'bg-sky-500/20 text-sky-300 border-sky-500/50 shadow-sm'
                    : 'btn-secondary text-slate-300'
                }`}
                title="Release-Radar umschalten"
              >
                <Calendar className="w-4 h-4 text-sky-400 shrink-0" />
                <span className="hidden sm:inline">Radar</span>
                {radarData && radarData.total_releases > 0 && (
                  <span className="bg-sky-500 text-slate-950 font-bold text-[9px] w-4 h-4 rounded-full flex items-center justify-center font-mono shrink-0">
                    {radarData.total_releases}
                  </span>
                )}
              </button>

              {canEdit && (
                <button 
                  onClick={handleOpenModal}
                  className="hidden sm:flex btn-primary text-xs py-2 px-3 items-center gap-1.5 shadow-sm shrink-0"
                  title="Neuen Manga anlegen"
                >
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">Neuer Manga</span>
                </button>
              )}

              <button 
                id="btn-mobile-menu-toggle"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="btn-secondary p-1.5 sm:p-2 text-slate-300 hover:text-white shrink-0"
                title="Menü öffnen"
              >
                {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Search bar: Full width on < xl, Centered & spacious on >= xl */}
          <div 
            onClick={() => searchInputRef.current?.focus()}
            className="flex items-center gap-2.5 bg-slate-950/80 border border-slate-700/80 hover:border-slate-600 rounded-xl px-3.5 py-2.5 w-full xl:flex-1 xl:max-w-xs 2xl:max-w-md xl:min-w-[200px] 2xl:min-w-[280px] focus-within:ring-2 focus-within:ring-brand-500/50 focus-within:border-brand-500 transition-all cursor-text shadow-inner"
          >
            <Search className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" />
            <input 
              ref={searchInputRef}
              id="main-search-input"
              type="text" 
              placeholder="Titel, Autor oder Verlag suchen..." 
              className="w-full min-w-0 bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-sm" 
              value={search} 
              onChange={e => setSearch(e.target.value)} 
            />
            <div className="shrink-0 flex items-center gap-1">
              <BarcodeScannerButton compact onDetected={handleBarcodeDetected} />
              {search && (
                <button 
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSearch('');
                    searchInputRef.current?.focus();
                  }}
                  className="text-slate-400 hover:text-white p-0.5 rounded hover:bg-slate-800 shrink-0 transition-colors"
                  title="Suche zurücksetzen"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Desktop Action buttons (>= xl) */}
          <div className="hidden xl:flex items-center gap-1.5 2xl:gap-2 shrink-0 flex-nowrap justify-end min-w-0">
            <button 
              id="btn-open-stats"
              onClick={handleOpenStats} 
              className="btn-secondary flex items-center gap-1.5 text-xs text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/10 shadow-sm py-2 px-2.5 2xl:px-3 whitespace-nowrap"
              title="Statistik- & Finanz-Dashboard öffnen"
            >
              <BarChart3 className="w-4 h-4 text-emerald-400 shrink-0" /> 
              <span>Statistiken<span className="hidden 2xl:inline"> & Finanzen</span></span>
            </button>

            {canEdit && (
              <button 
                id="btn-open-add-manga"
                onClick={handleOpenModal} 
                className="btn-primary flex items-center gap-1.5 text-xs shadow-md py-2 px-2.5 2xl:px-3 whitespace-nowrap"
              >
                <Plus className="w-4 h-4 shrink-0" /> 
                <span>Neuer Manga</span>
              </button>
            )}

            {isInstallable && !isInstalledApp && (
              <button
                id="btn-install-pwa"
                onClick={handleInstallClick}
                className="btn-secondary flex items-center gap-1.5 text-xs text-brand-300 hover:text-white border-brand-500/40 bg-brand-500/10 hover:bg-brand-500/20 py-2 px-2.5 2xl:px-3 shadow-sm transition-all whitespace-nowrap"
                title="Manga Shelf als native App auf deinem Gerät installieren"
              >
                <Download className="w-4 h-4 text-brand-400 shrink-0" />
                <span className="hidden 2xl:inline">App installieren</span>
              </button>
            )}

            {user?.role === 'admin' && (
              <>
                <button
                  id="btn-open-users"
                  onClick={handleOpenUsersModal}
                  className="btn-secondary flex items-center gap-1.5 text-xs text-slate-200 py-2 px-2.5 2xl:px-3 whitespace-nowrap"
                  title="Benutzer anlegen und verwalten"
                >
                  <Users className="w-4 h-4 text-brand-400 shrink-0" /> 
                  <span>Benutzer</span>
                </button>

                <button
                  id="btn-open-backups"
                  onClick={handleOpenRestoreModal}
                  className="btn-secondary flex items-center gap-1.5 text-xs text-slate-200 hover:text-emerald-400 transition-colors py-2 px-2.5 2xl:px-3 whitespace-nowrap"
                  title="Backup-Zentrale, automatische Snapshots, ZIP-Download & Wiederherstellung"
                >
                  <UploadCloud className="w-4 h-4 text-emerald-400 shrink-0" /> 
                  <span>Backups</span>
                </button>
              </>
            )}

            <div className="h-6 w-[1px] bg-slate-800 mx-0.5 shrink-0"></div>

            <div className="flex items-center gap-1.5 text-xs bg-slate-800/60 px-2 py-1.5 2xl:px-2.5 rounded-xl border border-slate-700/50 shrink-0">
              <span className="text-slate-400 hidden 2xl:inline">User:</span>
              <span className="font-semibold text-slate-200 truncate max-w-[90px] 2xl:max-w-none">{user?.username}</span>
              {user?.role === 'admin' ? (
                <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] px-1.5 py-0.2 rounded font-mono font-bold uppercase shrink-0">
                  Admin
                </span>
              ) : isVisitor ? (
                <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] px-1.5 py-0.2 rounded font-mono font-bold uppercase shrink-0">
                  Gast
                </span>
              ) : (
                <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] px-1.5 py-0.2 rounded font-mono font-bold uppercase shrink-0">
                  Editor
                </span>
              )}
            </div>

            <button 
              id="btn-logout"
              onClick={onLogout} 
              className="btn-secondary p-2 text-slate-300 hover:text-red-400 transition-colors shrink-0" 
              title="Abmelden"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

        </div>

        {/* Dropdown Menu Drawer for < xl */}
        {mobileMenuOpen && (
          <div className="xl:hidden mt-3 pt-3 border-t border-slate-800/80 space-y-2 animate-fade-in max-w-[1720px] 2xl:max-w-[1840px] mx-auto">
            <div className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Angemeldet als:</span>
                <span className="font-bold text-white">{user?.username}</span>
              </div>
              <span className="bg-brand-500/20 text-brand-300 border border-brand-500/40 text-[10px] px-2 py-0.5 rounded font-mono uppercase font-bold">
                {user?.role}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button 
                id="btn-mobile-menu-stats"
                onClick={() => { setMobileMenuOpen(false); handleOpenStats(); }}
                className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-emerald-300 border-emerald-500/30"
              >
                <BarChart3 className="w-4 h-4 text-emerald-400" /> Statistiken
              </button>

              <button 
                id="btn-mobile-menu-radar"
                onClick={() => { 
                  setMobileMenuOpen(false); 
                  setActiveMainView('radar'); 
                  fetchReleaseRadar(); 
                }}
                className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-sky-300 border-sky-500/30"
              >
                <Calendar className="w-4 h-4 text-sky-400" /> Release-Radar
              </button>

              {canEdit && (
                <button 
                  id="btn-mobile-menu-add"
                  onClick={() => { setMobileMenuOpen(false); handleOpenModal(); }}
                  className="btn-primary text-xs py-2 px-3 flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" /> Neuer Manga
                </button>
              )}

              {user?.role === 'admin' && (
                <>
                  <button 
                    id="btn-mobile-menu-users"
                    onClick={() => { setMobileMenuOpen(false); handleOpenUsersModal(); }}
                    className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-slate-200"
                  >
                    <Users className="w-4 h-4 text-brand-400" /> Benutzer
                  </button>

                  <button 
                    id="btn-mobile-menu-backups"
                    onClick={() => { setMobileMenuOpen(false); handleOpenRestoreModal(); }}
                    className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-2 text-slate-200 hover:text-emerald-400"
                  >
                    <UploadCloud className="w-4 h-4 text-emerald-400" /> Backups
                  </button>
                </>
              )}
            </div>

            {isInstallable && !isInstalledApp && (
              <button
                id="btn-mobile-install-pwa"
                onClick={() => { setMobileMenuOpen(false); handleInstallClick(); }}
                className="w-full btn-secondary text-xs py-2 text-brand-300 bg-brand-500/10 border-brand-500/40 hover:bg-brand-500/20 flex items-center justify-center gap-2 font-medium"
              >
                <Download className="w-4 h-4 text-brand-400" /> MangaShelf als App installieren
              </button>
            )}

            <button 
              id="btn-mobile-menu-logout"
              onClick={onLogout} 
              className="w-full btn-secondary text-xs py-2 text-red-300 hover:bg-red-950/40 border-red-900/40 flex items-center justify-center gap-2"
            >
              <LogOut className="w-4 h-4 text-red-400" /> Abmelden
            </button>
          </div>
        )}
      </header>

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
        <div className="flex flex-col xl:flex-row flex-wrap items-stretch xl:items-center justify-between gap-3 mb-6 p-2.5 sm:p-3 bg-slate-950/70 rounded-2xl border border-slate-800/80">
          {/* Status Tabs with Count Badges */}
          <div className="w-full xl:w-auto flex items-center gap-1.5 p-1 bg-slate-900/90 rounded-xl border border-slate-800 text-xs overflow-x-auto no-scrollbar">
            {[
              { id: 'ALL', label: 'Alle', count: filterCounts.ALL },
              { id: 'Laufend', label: 'Laufend', count: filterCounts.Laufend },
              { id: 'Abgeschlossen', label: 'Abgeschlossen', count: filterCounts.Abgeschlossen },
              { id: 'UNREAD', label: 'Ungelesen', count: filterCounts.UNREAD },
              { id: 'READ_ALL', label: 'Gelesen', count: filterCounts.READ_ALL },
              { id: 'Pausiert', label: 'Pausiert', count: filterCounts.Pausiert },
              { id: 'Geplant', label: 'Geplant', count: filterCounts.Geplant },
            ].filter(tab => tab.id === 'ALL' || tab.count > 0).map(tab => (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id)}
                className={`px-2.5 sm:px-3 py-1.5 rounded-lg font-medium transition-all whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
                  statusFilter === tab.id 
                    ? 'bg-brand-600 text-white shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <span>{tab.label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono font-bold leading-none ${
                  statusFilter === tab.id ? 'bg-brand-700/90 text-white' : 'bg-slate-800 text-slate-400'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Publisher, Sort, Reset & View Mode Controls */}
          <div className="w-full xl:w-auto flex flex-wrap items-center justify-between xl:justify-start gap-2 text-xs">
            {/* Publisher Filter */}
            <label className="flex-1 sm:flex-initial min-w-0 flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
              <Building2 className="w-3.5 h-3.5 text-brand-400 shrink-0" />
              <select
                id="filter-publisher-select"
                value={publisherFilter}
                onChange={e => setPublisherFilter(e.target.value)}
                className="filter-chip-select font-medium text-slate-200 group-hover:text-white truncate max-w-[100px] sm:max-w-none"
              >
                <option value="ALL">Alle Verlage</option>
                {availablePublishers.map(pub => (
                  <option key={pub} value={pub}>{pub}</option>
                ))}
              </select>
              <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
            </label>

            {/* Sort Control */}
            <label className="flex-1 sm:flex-initial min-w-0 flex items-center gap-1.5 bg-slate-900/90 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all shadow-sm group">
              <ArrowUpDown className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                className="filter-chip-select font-medium text-slate-200 group-hover:text-white truncate max-w-[130px] sm:max-w-none"
              >
                <option value="newest_first">✨ Zuletzt hinzugefügt</option>
                <option value="title_asc">🔤 Titel (A → Z)</option>
                <option value="title_desc">🔤 Titel (Z → A)</option>
                <option value="progress_desc">📈 Fortschritt (Höchster %)</option>
                <option value="progress_asc">📖 Ungelesen zuerst</option>
                <option value="volumes_desc">📚 Meiste Bände</option>
                <option value="value_desc">💰 Höchster Wert (€)</option>
                <option value="publisher_asc">🏢 Verlag (A → Z)</option>
                <option value="oldest_first">⏳ Zuerst hinzugefügt</option>
              </select>
              <ChevronDown className="w-3 h-3 text-slate-400 group-hover:text-slate-200 pointer-events-none shrink-0" />
            </label>

            {/* Reset Filter Button (visible when filter active) */}
            {(statusFilter !== 'ALL' || publisherFilter !== 'ALL' || search) && (
              <button
                onClick={() => {
                  setStatusFilter('ALL');
                  setPublisherFilter('ALL');
                  setSearch('');
                }}
                className="btn-secondary py-1.5 px-2.5 text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1 border-sky-500/30 shrink-0"
                title="Alle Filter und Suche zurücksetzen"
              >
                <X className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Zurücksetzen</span>
              </button>
            )}

            {/* View Mode Toggle: Grid vs List */}
            <div className="flex items-center bg-slate-900/90 border border-slate-800 p-0.5 rounded-xl shadow-sm shrink-0">
              <button
                id="btn-view-grid"
                type="button"
                onClick={() => setViewMode('grid')}
                className={`p-1.5 rounded-lg transition-all ${
                  viewMode === 'grid'
                    ? 'bg-brand-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="Plakative Rasteransicht"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                id="btn-view-list"
                type="button"
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded-lg transition-all ${
                  viewMode === 'list'
                    ? 'bg-brand-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="Kompakte Listenansicht"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="text-xs text-slate-400 ml-1 hidden sm:inline">
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
          <div className="glass-panel p-8 sm:p-12 rounded-3xl text-center max-w-lg mx-auto my-12 border border-slate-800 animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-brand-500/10 border border-brand-500/20 text-brand-400 flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white mb-2">
              {search || statusFilter !== 'ALL' || publisherFilter !== 'ALL'
                ? 'Keine Treffer gefunden'
                : 'Deine Sammlung ist noch leer'}
            </h3>
            <p className="text-sm text-slate-400 mb-6">
              {search || statusFilter !== 'ALL' || publisherFilter !== 'ALL'
                ? 'Für die aktuellen Such- und Filtereinstellungen wurden keine passenden Mangas gefunden.'
                : 'Füge deinen ersten Manga hinzu, um Bände und deinen Fortschritt zu verfolgen.'}
            </p>
            {search || statusFilter !== 'ALL' || publisherFilter !== 'ALL' ? (
              <button 
                onClick={() => {
                  setSearch('');
                  setStatusFilter('ALL');
                  setPublisherFilter('ALL');
                }} 
                className="btn-secondary text-sm inline-flex items-center gap-2"
              >
                <X className="w-4 h-4" /> Filter & Suche zurücksetzen
              </button>
            ) : (
              <button onClick={handleOpenModal} className="btn-primary text-sm inline-flex items-center gap-2">
                <Plus className="w-4 h-4" /> Ersten Manga anlegen
              </button>
            )}
          </div>
        ) : viewMode === 'list' ? (
          /* COMPACT LIST VIEW */
          <div className="glass-panel rounded-2xl border border-slate-800/80 overflow-hidden shadow-xl animate-fade-in">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                    <th className="py-3 px-4 w-16">Cover</th>
                    <th className="py-3 px-4">Titel & Autor</th>
                    <th className="py-3 px-4 hidden sm:table-cell">Verlag</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Bände / Fortschritt</th>
                    <th className="py-3 px-4 text-right hidden md:table-cell">Wert</th>
                    <th className="py-3 px-4 text-right w-24">Aktion</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filtered.map(manga => {
                    const total = manga.total_volumes || 0;
                    const owned = manga.owned_volumes || 0;
                    const pct = total > 0 ? Math.min(100, Math.round((owned / total) * 100)) : null;

                    return (
                      <tr key={manga.id} className="hover:bg-slate-850/60 transition-colors group">
                        <td className="py-2.5 px-4">
                          <Link to={`/manga/${manga.id}`} className="block w-10 h-14 rounded-lg overflow-hidden bg-slate-950 border border-slate-800 shrink-0">
                            {manga.cover_image && !failedImages[manga.id] ? (
                              <img 
                                src={manga.cover_image} 
                                alt="" 
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform" 
                                onError={() => setFailedImages(prev => ({ ...prev, [manga.id]: true }))} 
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-700">
                                <BookOpen className="w-4 h-4" />
                              </div>
                            )}
                          </Link>
                        </td>
                        <td className="py-2.5 px-4">
                          <Link to={`/manga/${manga.id}`} className="font-bold text-white hover:text-brand-400 transition-colors text-sm line-clamp-1">
                            {manga.title}
                          </Link>
                          <div className="text-slate-400 text-xs mt-0.5 line-clamp-1">
                            {manga.author || 'Kein Autor'}
                            {manga.alt_title && <span className="text-slate-500 ml-1.5">({manga.alt_title})</span>}
                          </div>
                        </td>
                        <td className="py-2.5 px-4 hidden sm:table-cell text-slate-300">
                          {manga.publisher ? (
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                              <span>{manga.publisher}</span>
                            </span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="py-2.5 px-4">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${getStatusBadge(manga.status)}`}>
                            {manga.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-white font-mono">
                              {owned} {total > 0 ? `/ ${total}` : 'Bde.'}
                            </span>
                            {manga.read_volume_count > 0 ? (
                              <span className={`text-[10px] font-mono ${
                                manga.read_volume_count >= (manga.owned_volumes || manga.volume_count) && (manga.owned_volumes > 0 || manga.volume_count > 0)
                                  ? 'text-emerald-400 font-bold' 
                                  : 'text-sky-300'
                              }`}>
                                ({manga.read_volume_count} gelesen • {Math.round(((manga.read_volume_count || 0) / (manga.owned_volumes || manga.volume_count || 1)) * 100)}%)
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-500 font-mono">(Ungelesen)</span>
                            )}
                          </div>
                          {pct !== null && (
                            <div className="w-24 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800 mt-1">
                              <div 
                                className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 rounded-full" 
                                style={{ width: `${pct}%` }} 
                              />
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right hidden md:table-cell font-mono font-bold text-emerald-400">
                          {manga.total_value > 0 
                            ? `${manga.total_value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` 
                            : '—'}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Link 
                              to={`/manga/${manga.id}`} 
                              className="btn-secondary py-1 px-2.5 text-xs text-brand-400 hover:text-white"
                            >
                              Details
                            </Link>
                            {canEdit && (
                              <button
                                onClick={(e) => handleDeleteManga(e, manga.id, manga.title)}
                                className="p-1 hover:bg-red-500/20 text-slate-500 hover:text-red-400 rounded-lg transition-colors"
                                title="Manga löschen"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* POSTER / GRID VIEW */
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 min-[1800px]:grid-cols-8 gap-4 sm:gap-5 lg:gap-6 animate-fade-in">
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
                      <div className="absolute top-2 left-2 right-2 flex justify-between items-start gap-1 pointer-events-none min-w-0">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider backdrop-blur-md border truncate shrink-0 max-w-[65%] ${getStatusBadge(manga.status)}`}>
                          {manga.status}
                        </span>

                        <span className="bg-slate-950/80 border border-slate-800 text-white text-[11px] font-bold px-1.5 py-0.5 rounded-lg backdrop-blur-md shrink-0">
                          {owned} {total > 0 ? `/ ${total}` : 'Bde.'}
                        </span>
                      </div>

                      {/* Reading Progress Badge */}
                      {manga.read_volume_count > 0 && (
                        <div className="absolute top-9 right-2 pointer-events-none">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md backdrop-blur-md flex items-center gap-1 border shadow-sm ${
                            manga.read_volume_count >= (manga.owned_volumes || manga.volume_count) && (manga.owned_volumes > 0 || manga.volume_count > 0)
                              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-300'
                              : 'bg-slate-950/85 border-sky-500/40 text-sky-300'
                          }`}>
                            <BookCheck className="w-2.5 h-2.5" />
                            <span>{manga.read_volume_count}{manga.read_volume_count >= (manga.owned_volumes || manga.volume_count) && (manga.owned_volumes > 0 || manga.volume_count > 0) ? ' ✓' : `/${manga.owned_volumes || manga.volume_count}`}</span>
                          </span>
                        </div>
                      )}

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
