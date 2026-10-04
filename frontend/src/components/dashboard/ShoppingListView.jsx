import { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { getVolumeDisplayTitle } from '../../utils/volumeHelpers';
import {
  classifyShopScan, classifyShopScanOffline, classifyLocalHit, localSourceNote, lookupFailureKind, canStartLookup,
  mergeScanEntry, normalizeBuyOutcome, shouldStopBooking, applyBookingResults, markScanBooking, bookingSummary, isBookable,
  loadScanList, saveScanList, reconcileScanList, filterShoppingItems, recountPublishers, resolvePublisherFilter,
  formatShoppingStand, liveScanSupported
} from '../../utils/scanHelpers';
import { lookupLocalIsbn, formatAge } from '../../utils/offlineStore';
import { useForegroundRefresh } from '../../hooks/usePullToRefresh';
import { readApiError } from '../../hooks/useVolumeActions';
import { apiFetch, readJson, sessionEndAnnounced, TIMEOUTS } from '../../utils/api';
import { BEFORE_LOGOUT_EVENT } from '../../appShell';
import { notify } from '../../utils/notify';
import { formatCount, formatEuro, formatNumber } from '../../utils/format';
import { createSearch, naturalCollator } from '../../utils/search';
import { buildShareText, canShareText, groupByPublisher, itemText, shareText } from '../../utils/shareList';
import {
  PRIORITY_LABELS, priorityBadgeClass, filterWishedSeries, mergeWishedPublisherChips
} from '../../utils/priority';
import useProgressiveList from '../../hooks/useProgressiveList';
import BarcodeScannerButton from '../common/BarcodeScannerButton';
import CoverImage from '../common/CoverImage';
import {
  ShoppingCart, RefreshCw, Search, X, CircleCheck, CircleAlert, SearchX,
  BookOpen, BuildingComplex, Check, WifiOff, ScanBarcode, Heart, Share2, Copy, Printer
} from 'lucide-react';

const PAGE_STEP = 50;
// content-visibility skips layout and paint of off-screen cards
const ITEM_WRAPPER_CLASS = '[content-visibility:auto] [contain-intrinsic-block-size:auto_200px]';
const wishedSearch = createSearch((s) => ({ primary: [s.title], secondary: [s.publisher] }));
const byTitle = (a, b) => naturalCollator.compare(a.title || '', b.title || '');
const UNDO_MS = 5000;
const LOAD_SETTLE_MS = 400;
const SESSION_EXPIRED_TEXT = 'Sitzung abgelaufen – bitte neu anmelden.';
// MangaDetail's back link returns here instead of the shelf
const FROM_SHOPPING = { from: '/?view=shopping' };

const KIND_STYLE = {
  buy: ['🛒', 'text-emerald-300'], owned: ['✅', 'text-slate-400'], partner: ['👥', 'text-sky-300'],
  check: ['ℹ️', 'text-amber-300'], new: ['📖', 'text-sky-300'], unknown: ['❓', 'text-slate-400'],
  offline: ['📴', 'text-amber-300'], pending: ['⏳', 'text-slate-400']
};

const scanStore = () => {
  try { return window.localStorage; } catch (_) { return null; }
};

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const withoutId = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

const COVER_FALLBACK = (
  <div className="w-16 h-24 bg-slate-800 rounded-xl flex items-center justify-center text-slate-400 border border-slate-700/60">
    <BookOpen className="w-6 h-6" aria-hidden="true" />
  </div>
);

const PRINT_SHEET_ID = 'shopping-print-sheet';
const PRINT_CSS = `
#${PRINT_SHEET_ID} { display: none; }
@media print {
  @page { margin: 15mm; }
  html, body { background: #fff !important; }
  body > *:not(#${PRINT_SHEET_ID}) { display: none !important; }
  #${PRINT_SHEET_ID} { display: block !important; color: #000; font: 11pt/1.4 system-ui, sans-serif; }
  #${PRINT_SHEET_ID} h1 { font-size: 16pt; font-weight: 700; margin: 0 0 2pt; }
  #${PRINT_SHEET_ID} h2 { font-size: 12pt; font-weight: 700; margin: 12pt 0 4pt; padding-bottom: 2pt; border-bottom: 1px solid #888; break-after: avoid; }
  #${PRINT_SHEET_ID} ul { list-style: none; margin: 0; padding: 0; }
  #${PRINT_SHEET_ID} li { padding: 1.5pt 0; break-inside: avoid; }
}`;

/** Print-only copy of the visible list, grouped by publisher; the app around it is hidden while printing. */
function PrintSheet({ items, wished, normalizePubName, filtered, summary }) {
  return createPortal(
    <div id={PRINT_SHEET_ID}>
      <style>{PRINT_CSS}</style>
      <h1>Einkaufsliste</h1>
      <p>{summary}{filtered ? ' · gefiltert' : ''}</p>
      {groupByPublisher(items, normalizePubName).map((group) => (
        <section key={group.publisher}>
          <h2>{group.publisher}</h2>
          <ul>
            {group.items.map((item) => <li key={item.id}>☐ {itemText(item)}</li>)}
          </ul>
        </section>
      ))}
      {wished.length > 0 && (
        <section>
          <h2>Gewünschte Reihen</h2>
          <ul>
            {wished.map((s) => <li key={s.id}>♡ {s.title}{s.publisher ? ` (${s.publisher})` : ''}</li>)}
          </ul>
        </section>
      )}
    </div>,
    document.body
  );
}

function ListProgress({ shown, total, onMore, sentinelRef }) {
  return (
    <div ref={sentinelRef} className="mt-4 flex flex-col items-center gap-2 text-xs text-slate-400">
      <p>Zeige {formatNumber(shown)} von {formatNumber(total)}</p>
      <button type="button" onClick={onMore} className="btn-secondary text-xs py-1.5 px-3">
        Weitere anzeigen
      </button>
    </div>
  );
}

/** Wished series (spec A3): a card per series with cover, publisher, priority, what is already known to be missing. */
function WishedSeriesSection({ series, canRemove, removing, onRemove }) {
  return (
    <section id="shop-wished-series" aria-labelledby="shop-wished-heading" className="space-y-3">
      <h3 id="shop-wished-heading" className="text-sm font-bold text-slate-200 flex items-center gap-2">
        <Heart className="w-4 h-4 text-rose-400" aria-hidden="true" />
        Gewünschte Reihen <span className="text-xs font-normal text-slate-400">({series.length})</span>
      </h3>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
        {series.map((s) => (
          <li key={s.id} className="glass-card rounded-2xl p-3 border border-rose-500/25 flex gap-3 bg-slate-900/60">
            <CoverImage
              src={s.cover_image}
              className="w-16 h-24 object-cover rounded-xl shadow-md border border-slate-800 shrink-0"
              fallback={COVER_FALLBACK}
            />
            <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
              <div>
                <p className="text-xs font-bold text-white truncate" title={s.title}>{s.title}</p>
                <p className="text-[11px] text-slate-400 mt-1 truncate flex items-center gap-1">
                  <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" aria-hidden="true" />
                  <span className="truncate">{s.publisher}</span>
                </p>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-lg border ${priorityBadgeClass(s.wish_priority)}`} title="Wunsch-Priorität">
                    {s.wish_priority > 0 ? PRIORITY_LABELS[s.wish_priority] : 'Wunsch'}
                  </span>
                  <span className="text-[11px] text-slate-300">
                    {s.known_missing_count > 0
                      ? `${formatCount(s.known_missing_count, 'Band', 'Bände')} bekannt · ${formatEuro(s.known_missing_cost)}`
                      : 'Noch keine Bände bekannt'}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-2.5">
                <Link
                  to={`/manga/${s.id}`}
                  state={FROM_SHOPPING}
                  className="px-2.5 py-1.5 rounded-xl border border-brand-500/40 text-brand-300 hover:bg-brand-700 hover:text-white text-xs font-semibold"
                  aria-label={`Zur Reihe ${s.title}`}
                >
                  Zur Reihe
                </Link>
                {canRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(s)}
                    disabled={removing.has(s.id)}
                    aria-busy={removing.has(s.id) || undefined}
                    aria-label={`${s.title} von der Wunschliste nehmen`}
                    className="px-2.5 py-1.5 rounded-xl border border-slate-700 text-slate-300 hover:text-white hover:border-rose-500/50 text-xs font-semibold disabled:opacity-50"
                  >
                    Von der Wunschliste
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ShoppingListView({
  shoppingData,
  loadingShopping,
  shoppingError = null,
  fetchShoppingList,
  fetchMangas,
  isOfflineMode,
  offlineLastUpdated,
  syncPendingPurchases,
  pendingPurchases = 0,
  failedPurchases = [],
  cacheWriteFailed = false,
  shoppingSearch,
  setShoppingSearch,
  shoppingPublisherFilter,
  setShoppingPublisherFilter,
  normalizePubName,
  setActiveMainView,
  canEdit,
  handleQuickBuy,
  buyingId,
  buyingIds = null,
  user = null
}) {
  const userId = user?.id ?? null;
  const items = useMemo(() => shoppingData?.items || [], [shoppingData]);
  // ?scan=1 (app shortcut "Barcode scannen"): a big camera button, since a file input only opens on a tap
  const [searchParams, setSearchParams] = useSearchParams();
  const scanStart = searchParams.get('scan') === '1';
  const closeScanStart = () => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    next.delete('scan');
    return next;
  }, { replace: true });

  useForegroundRefresh(() => {
    if (!isOfflineMode && !browserOffline()) fetchShoppingList();
  });
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Scan list of this store visit (kept in localStorage for 12 h: survives opening a series, a reload and an app kill)
  const [scanned, setScanned] = useState(() => loadScanList(scanStore(), { userId }));
  const scannedRef = useRef(scanned);
  const updateScanned = useCallback((change) => {
    const next = change(scannedRef.current);
    if (next === scannedRef.current) return;
    scannedRef.current = next;
    setScanned(next);
  }, []);
  const [booking, setBooking] = useState(false);
  const [bookingNote, setBookingNote] = useState('');
  const [prioritySort, setPrioritySort] = useState(false);

  useEffect(() => { saveScanList(scanStore(), scanned, { userId }); }, [scanned, userId]);

  useEffect(() => {
    if (shoppingData && !loadingShopping) updateScanned((prev) => reconcileScanList(prev, shoppingData.items));
  }, [shoppingData, loadingShopping, updateScanned]);

  const lookupsRef = useRef(new Set());

  /**
   * Offline the local ISBN index answers. Online the server is authoritative: a hit of the offline copy is shown at
   * once as a provisional entry, and the server's answer replaces it (mergeScanEntry replaces offline entries).
   */
  const handleBarcodeScan = async (scannedCode, { network = false } = {}) => {
    const cleanIsbn = String(scannedCode || '').replace(/[^0-9X]/gi, '').toUpperCase();
    if (!cleanIsbn) return;
    const local = classifyShopScan(cleanIsbn, { found: false }, itemsRef.current);
    if (local.kind === 'buy') {
      updateScanned((prev) => mergeScanEntry(prev, local));
      return;
    }
    if (!canStartLookup(scannedRef.current, cleanIsbn) || lookupsRef.current.has(cleanIsbn)) return;
    const previous = scannedRef.current.find((e) => e.isbn === cleanIsbn) || null;
    updateScanned((prev) => mergeScanEntry(prev, { isbn: cleanIsbn, kind: 'pending', label: `${cleanIsbn} – wird geprüft…` }));

    const finish = (entry) => updateScanned((prev) => mergeScanEntry(prev, entry));
    const checkOffline = async () => finish(classifyShopScanOffline(cleanIsbn, await lookupLocalIsbn(cleanIsbn), itemsRef.current));
    const abandon = () => updateScanned((prev) => prev.flatMap((e) => (
      e.isbn === cleanIsbn && e.kind === 'pending' ? (previous ? [previous] : []) : [e]
    )));

    if (browserOffline()) return checkOffline();
    lookupsRef.current.add(cleanIsbn);
    try {
      if (!network) {
        const hit = await lookupLocalIsbn(cleanIsbn);
        if (hit) {
          const note = localSourceNote(hit.syncedAt ? formatAge(hit.syncedAt) : '');
          finish(classifyLocalHit(cleanIsbn, hit, itemsRef.current, { note, source: 'local' }));
        }
      }
      return await checkNetwork(cleanIsbn, { finish, checkOffline, abandon });
    } finally {
      lookupsRef.current.delete(cleanIsbn);
    }
  };

  const checkNetwork = async (cleanIsbn, { finish, checkOffline, abandon }) => {
    let res;
    try {
      res = await apiFetch(`/api/lookup/isbn?isbn=${encodeURIComponent(cleanIsbn)}`, { timeout: TIMEOUTS.lookup });
    } catch (_) {
      return checkOffline();
    }
    const data = await readJson(res);
    if (!res.ok) {
      const failure = lookupFailureKind(res.status);
      if (failure === 'offline') return checkOffline();
      abandon();
      if (failure === 'auth') {
        // an ended session was announced by the API client; a proxy's 401 would otherwise drop the scan silently
        if (!sessionEndAnnounced(res)) notify.error(data?.error || SESSION_EXPIRED_TEXT);
        return;
      }
      // e.g. a wrong check digit: a misread barcode, scan again
      notify.error(data?.error || `ISBN-Abfrage fehlgeschlagen (HTTP ${res.status})`);
      return;
    }
    if (!data) return checkOffline();
    finish(classifyShopScan(cleanIsbn, data, itemsRef.current));
  };

  // Quick buy with a short undo window: the PUT is sent when the window ends, the page is hidden or the view closes
  const [deferred, setDeferred] = useState([]);
  const deferredTimers = useRef(new Map());
  const deferredToasts = useRef(new Map());
  const [inFlight, setInFlight] = useState(() => new Set());
  const quickBuyRef = useRef(handleQuickBuy);
  quickBuyRef.current = handleQuickBuy;

  const dropDeferred = useCallback((id) => {
    if (!deferredTimers.current.has(id)) return false;
    clearTimeout(deferredTimers.current.get(id));
    deferredTimers.current.delete(id);
    // forget the toast before announcing the dismiss, so the eviction listener below ignores our own dismiss
    const toastId = deferredToasts.current.get(id);
    deferredToasts.current.delete(id);
    notify.dismiss(toastId);
    setDeferred((prev) => prev.filter((d) => d.id !== id));
    return true;
  }, []);

  // id -> running single quick buy, so a batch booking waits for it instead of buying twice
  const commitsRef = useRef(new Map());
  const commitBuy = useCallback((id) => {
    if (!dropDeferred(id)) return commitsRef.current.get(id) || null;
    setInFlight((prev) => new Set(prev).add(id));
    const run = (async () => {
      try {
        return await quickBuyRef.current(id);
      } finally {
        commitsRef.current.delete(id);
        setInFlight((prev) => withoutId(prev, id));
      }
    })();
    commitsRef.current.set(id, run);
    return run;
  }, [dropDeferred]);

  // the Toaster keeps only the newest undo toasts: an evicted one commits its buy at once (its undo is gone)
  useEffect(() => notify.subscribe((event) => {
    if (event.type !== 'dismiss') return;
    for (const [itemId, toastId] of deferredToasts.current) {
      if (toastId === event.id) {
        commitBuy(itemId);
        break;
      }
    }
  }), [commitBuy]);

  const startBuy = (item) => {
    if (deferredTimers.current.has(item.id) || inFlight.has(item.id)) return;
    deferredTimers.current.set(item.id, setTimeout(() => commitBuy(item.id), UNDO_MS));
    const toastId = notify.success(`„${item.manga_title} ${getVolumeDisplayTitle(item)}“ als gekauft markiert`, {
      duration: UNDO_MS,
      action: { label: 'Rückgängig', onClick: () => dropDeferred(item.id) }
    });
    deferredToasts.current.set(item.id, toastId);
    setDeferred((prev) => [...prev, { id: item.id }]);
  };

  useEffect(() => {
    const flush = () => { for (const id of [...deferredTimers.current.keys()]) commitBuy(id); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    const onBeforeLogout = (event) => {
      flush();
      for (const run of commitsRef.current.values()) event.detail?.waitUntil?.(run);
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener(BEFORE_LOGOUT_EVENT, onBeforeLogout);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener(BEFORE_LOGOUT_EVENT, onBeforeLogout);
      flush();
    };
  }, [commitBuy]);

  const buyable = scanned.filter(isBookable);
  const bookAll = async () => {
    if (booking) return;
    const batch = scannedRef.current.filter(isBookable);
    if (!batch.length) return;
    setBooking(true);
    setBookingNote('');
    const results = [];
    try {
      for (const entry of batch) {
        updateScanned((prev) => markScanBooking(prev, [entry.isbn]));
        // a 'Gekauft' tap still in its undo window is cancelled only now; entries after a stop keep theirs
        const single = dropDeferred(entry.itemId) ? null : commitsRef.current.get(entry.itemId);
        let outcome;
        try {
          outcome = single ? await single : await handleQuickBuy(entry.itemId, { batch: true });
        } catch (err) {
          outcome = { status: 'failed', error: err?.message || '' };
        }
        const result = { isbn: entry.isbn, ...normalizeBuyOutcome(outcome) };
        results.push(result);
        updateScanned((prev) => applyBookingResults(prev, [result]));
        if (shouldStopBooking(result)) break;
      }
    } finally {
      updateScanned((prev) => (prev.some((e) => e.booking)
        ? prev.map((e) => {
          if (!e.booking) return e;
          const { booking: _booking, ...rest } = e;
          return rest;
        })
        : prev));
      setBooking(false);
    }
    setBookingNote(bookingSummary(results, batch.length));
    // batch mode skips the per-item refresh; reload once
    if (results.some((r) => r.batch && r.status === 'ok')) {
      fetchShoppingList();
      if (fetchMangas) fetchMangas();
    }
  };

  const clearScanned = () => {
    updateScanned(() => []);
    setBookingNote('');
  };

  // 'Ich habe ihn auch' (volumes other users own)
  const [claiming, setClaiming] = useState(() => new Set());
  const [claimed, setClaimed] = useState(() => new Set());
  const [claimErrors, setClaimErrors] = useState({});
  useEffect(() => { setClaimed(new Set()); }, [shoppingData]);

  const handleClaim = async (item) => {
    if (claiming.has(item.id) || isOfflineMode) return;
    setClaiming((prev) => new Set(prev).add(item.id));
    setClaimErrors(({ [item.id]: _old, ...rest }) => rest);
    let message = '';
    try {
      const res = await apiFetch(`/api/volumes/${item.id}/owners`, { method: 'POST', body: { owned: true } });
      if (res.ok) {
        setClaimed((prev) => new Set(prev).add(item.id));
        fetchShoppingList();
        if (fetchMangas) fetchMangas();
      } else {
        message = res.status === 401 ? SESSION_EXPIRED_TEXT : await readApiError(res, 'Besitz konnte nicht gespeichert werden');
      }
    } catch (_) {
      message = 'Keine Verbindung – bitte später erneut versuchen.';
    } finally {
      setClaiming((prev) => withoutId(prev, item.id));
    }
    if (message) setClaimErrors((prev) => ({ ...prev, [item.id]: message }));
  };

  // Load state: 'Alles komplett' only after a successful load, an error card when nothing could be loaded
  const [loadSettled, setLoadSettled] = useState(false);
  const sawLoadingRef = useRef(false);
  useEffect(() => {
    if (loadingShopping) sawLoadingRef.current = true;
    else if (sawLoadingRef.current) setLoadSettled(true);
  }, [loadingShopping]);
  useEffect(() => {
    const timer = setTimeout(() => setLoadSettled(true), LOAD_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);
  const loadFailed = !shoppingData && !loadingShopping && (Boolean(shoppingError) || loadSettled);

  // Filters
  const wishedSeries = useMemo(() => shoppingData?.wished_series || [], [shoppingData]);
  const publisherChips = useMemo(
    () => mergeWishedPublisherChips(recountPublishers(shoppingData, normalizePubName), wishedSeries, normalizePubName),
    [shoppingData, normalizePubName, wishedSeries]
  );
  const activePublisher = shoppingData ? resolvePublisherFilter(shoppingPublisherFilter, publisherChips) : shoppingPublisherFilter;
  useEffect(() => {
    if (activePublisher !== shoppingPublisherFilter) setShoppingPublisherFilter('ALL');
  }, [activePublisher, shoppingPublisherFilter, setShoppingPublisherFilter]);

  // the list follows typing a moment later, so the input stays responsive with long lists
  const searchTerm = useDeferredValue(shoppingSearch);
  const filteredItems = useMemo(
    () => filterShoppingItems(items, { search: searchTerm, publisherFilter: activePublisher, normalizePubName, prioritySort }),
    [items, searchTerm, activePublisher, normalizePubName, prioritySort]
  );
  const hiddenIds = useMemo(() => new Set([...deferred.map((d) => d.id), ...inFlight]), [deferred, inFlight]);
  const visibleItems = useMemo(() => filteredItems.filter((item) => !hiddenIds.has(item.id)), [filteredItems, hiddenIds]);
  const resetKey = JSON.stringify([searchTerm, activePublisher, prioritySort]);
  const itemPages = useProgressiveList(visibleItems, { step: PAGE_STEP, resetKey });

  const [removingWish, setRemovingWish] = useState(() => new Set());
  const [removedWish, setRemovedWish] = useState(() => new Set());
  useEffect(() => { setRemovedWish(new Set()); }, [shoppingData]);
  const visibleWished = useMemo(() => {
    const filtered = filterWishedSeries(wishedSeries.filter((s) => !removedWish.has(s.id)), {
      search: searchTerm, publisherFilter: activePublisher, normalizePubName, matches: wishedSearch.matches
    });
    return [...filtered].sort(prioritySort ? (a, b) => (b.wish_priority || 0) - (a.wish_priority || 0) || byTitle(a, b) : byTitle);
  }, [wishedSeries, removedWish, searchTerm, activePublisher, normalizePubName, prioritySort]);

  const removeWish = async (series) => {
    if (removingWish.has(series.id) || isOfflineMode) return;
    setRemovingWish((prev) => new Set(prev).add(series.id));
    try {
      const res = await apiFetch(`/api/mangas/${series.id}`, { method: 'PUT', body: { wish_priority: null } });
      if (res.ok) {
        setRemovedWish((prev) => new Set(prev).add(series.id));
        notify.success(`„${series.title}“ ist nicht mehr auf der Wunschliste`);
        fetchShoppingList();
        if (fetchMangas) fetchMangas();
      } else if (res.status === 401) {
        if (!sessionEndAnnounced(res)) notify.error(SESSION_EXPIRED_TEXT);
      } else {
        notify.error(await readApiError(res, 'Wunschliste konnte nicht geändert werden'));
      }
    } catch (_) {
      notify.error('Keine Verbindung – bitte später erneut versuchen.');
    } finally {
      setRemovingWish((prev) => withoutId(prev, series.id));
    }
  };

  const wishedCount = wishedSeries.filter((s) => !removedWish.has(s.id)).length;

  // share, copy and print hand on what the list shows: search and publisher filter apply, hidden buys do not
  const filtersActive = Boolean(String(searchTerm || '').trim()) || activePublisher !== 'ALL';
  const canHandOn = visibleItems.length > 0 || visibleWished.length > 0;
  const handOn = async (share) => {
    const text = buildShareText({ items: visibleItems, wished: visibleWished, normalizePubName, filtered: filtersActive });
    try {
      const how = await shareText(text, { share });
      if (how === 'copied') notify.success('Einkaufsliste als Text kopiert');
      else if (how === 'downloaded') notify.info('Einkaufsliste als Textdatei gespeichert (einkaufsliste.txt)');
    } catch (_) {
      notify.error('Einkaufsliste konnte nicht weitergegeben werden');
    }
  };
  // 'button': rendered, then printed; 'browser': the browser's own print command, the sheet is only rendered
  const [printSheet, setPrintSheet] = useState(null);
  const printSheetRef = useRef(null);
  printSheetRef.current = printSheet;
  useEffect(() => {
    const before = () => {
      if (!printSheetRef.current) flushSync(() => setPrintSheet('browser'));
    };
    const after = () => setPrintSheet(null);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  useEffect(() => {
    if (printSheet !== 'button') return undefined;
    const timer = setTimeout(() => {
      try {
        window.print();
      } catch (_) {
        setPrintSheet(null);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [printSheet]);
  const printSummary = `${formatCount(visibleItems.length, 'Band', 'Bände')}${visibleItems.length ? ` · ca. ${formatEuro(visibleItems.reduce((sum, i) => sum + (Number(i.price) > 0 ? Number(i.price) : 0), 0))}` : ''}`;
  const noMatch = (items.length > 0 || wishedCount > 0) && filteredItems.length === 0 && visibleWished.length === 0;
  const resetFilters = () => {
    setShoppingSearch('');
    setShoppingPublisherFilter('ALL');
  };

  const visibleOthers = useMemo(() => (shoppingData?.others || []).filter((item) => !claimed.has(item.id)), [shoppingData, claimed]);
  const otherPages = useProgressiveList(visibleOthers, { step: PAGE_STEP, resetKey: 'others' });
  const failedCount = Array.isArray(failedPurchases) ? failedPurchases.length : Number(failedPurchases) || 0;
  const stand = formatShoppingStand(offlineLastUpdated);
  const connectionText = shoppingError === 'server'
    ? 'Server nicht erreichbar.'
    : (browserOffline() ? 'Keine Internetverbindung.' : 'Keine Verbindung zum Server.');

  const checkConnection = async () => {
    if (browserOffline()) {
      notify.info('Gerät ist noch immer offline. Sobald wieder Netz vorhanden ist, wird automatisch synchronisiert.');
      return;
    }
    // send queued purchases first, otherwise the list briefly shows them as missing again
    const result = syncPendingPurchases ? await syncPendingPurchases() : null;
    if (!result || !(result.synced?.length || result.dropped?.length)) fetchShoppingList();
  };

  // shown inside the live scanner, which stays open in the shop: every hit appears here at once
  const scanFeed = (
    <div id="shop-scan-feed" className="space-y-1 text-xs">
      {scanned.length > 0 && (
        <p className="text-slate-400">
          Gescannt: {scanned.length}{buyable.length > 0 ? ` · ${buyable.length} zum Abhaken` : ''}
        </p>
      )}
      <ul className="space-y-1" aria-label="Zuletzt gescannt">
        {scanned.slice(0, 3).map((e) => {
          const [icon, color] = KIND_STYLE[e.kind] || KIND_STYLE.unknown;
          return (
            <li key={e.isbn} className={`flex items-start gap-2 ${color}`} data-kind={e.kind}>
              <span aria-hidden="true">{icon}</span>
              <span className="min-w-0 truncate">{e.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
  const liveScan = liveScanSupported();

  return (
    <div className="space-y-6 animate-fade-in">
      {printSheet && (
        <PrintSheet items={visibleItems} wished={visibleWished} normalizePubName={normalizePubName} filtered={filtersActive} summary={printSummary} />
      )}
      {/* Offline Banner when offline or using cached shopping list */}
      {isOfflineMode && (
        <div className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-3.5 rounded-2xl text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-fade-in shadow-lg">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
              <WifiOff className="w-4 h-4 text-amber-400" aria-hidden="true" />
            </div>
            <div>
              <p className="font-bold text-amber-200 text-sm flex items-center gap-2">
                <span>Offline-Einkaufsmodus aktiv</span>
                <span aria-hidden="true" className="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
              </p>
              <p className="text-amber-300/90 text-xs mt-0.5">
                {connectionText}{' '}
                {shoppingData
                  ? `Die Liste wird aus dem lokalen Speicher dieses Geräts bereitgestellt${stand ? ` (Stand: ${stand})` : ''}.`
                  : 'Auf diesem Gerät ist keine Offline-Kopie der Einkaufsliste gespeichert.'}
                {' '}Im Laden getätigte Käufe werden vorgemerkt und automatisch synchronisiert.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={checkConnection}
            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded-xl text-amber-200 text-xs font-semibold transition-all shrink-0 flex items-center justify-center gap-1.5 self-stretch sm:self-auto cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Verbindung prüfen</span>
          </button>
        </div>
      )}

      {scanStart && (
        <div id="shop-scan-start" className="glass-panel p-4 sm:p-5 rounded-2xl border border-indigo-500/40 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <ScanBarcode className="w-6 h-6 text-indigo-300 shrink-0 mt-0.5" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-white">Band im Laden prüfen</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {liveScan
                  ? 'Halte die Kamera auf den Barcode der Rückseite. Der Scanner bleibt offen, jeder Band erscheint sofort unter „Gescannt“.'
                  : 'Fotografiere den Barcode auf der Rückseite. Das Ergebnis erscheint unter „Gescannt“.'}
              </p>
            </div>
            <button type="button" onClick={closeScanStart} className="ml-auto text-slate-400 hover:text-white p-1.5 -m-1 rounded shrink-0" aria-label="Scan-Hinweis schließen">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <BarcodeScannerButton
            onDetected={handleBarcodeScan}
            buttonText={liveScan ? 'Scanner starten' : 'Foto aufnehmen'}
            continuous
            scannerTitle="Laden-Scan"
            scannerChildren={scanFeed}
            className="flex items-center justify-center gap-2 w-full sm:w-auto px-6 py-3.5 rounded-2xl text-base font-bold bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white shadow-lg transition active:scale-95 disabled:opacity-50"
          />
        </div>
      )}

      {(pendingPurchases > 0 || failedCount > 0 || cacheWriteFailed || shoppingError === 'auth') && (
        <div id="shop-sync-notes" className="space-y-1 text-xs" role="status">
          {pendingPurchases > 0 && (
            <p className="text-amber-300">
              {pendingPurchases === 1 ? '1 Kauf vorgemerkt, wird' : `${pendingPurchases} Käufe vorgemerkt, werden`} automatisch übertragen.
            </p>
          )}
          {failedCount > 0 && (
            <p className="text-rose-300">
              {failedCount === 1 ? '1 vorgemerkter Kauf wurde' : `${failedCount} vorgemerkte Käufe wurden`} vom Server abgelehnt.
            </p>
          )}
          {cacheWriteFailed && (
            <p className="text-slate-400">Offline-Kopie der Einkaufsliste konnte nicht gespeichert werden (Speicher voll).</p>
          )}
          {shoppingError === 'auth' && <p className="text-rose-300">{SESSION_EXPIRED_TEXT}</p>}
        </div>
      )}

      {/* Scan-Liste des Ladenbesuchs */}
      {scanned.length > 0 && (
        <div className="glass-panel p-4 rounded-2xl border border-emerald-500/30 space-y-3" id="shop-scan-list">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-bold text-white">Gescannt ({scanned.length})</p>
            <div className="flex items-center gap-2">
              {canEdit && buyable.length > 0 && (
                <button
                  type="button"
                  onClick={bookAll}
                  disabled={booking}
                  className="btn-primary text-xs !bg-emerald-700 hover:!bg-emerald-800 disabled:opacity-50"
                >
                  {booking ? 'Wird gebucht...' : `${buyable.length} als gekauft abhaken`}
                </button>
              )}
              <button type="button" onClick={clearScanned} className="btn-secondary text-xs px-3 py-1.5" disabled={booking}>Leeren</button>
            </div>
          </div>
          {bookingNote && <p className="text-xs text-rose-300" role="status">{bookingNote}</p>}
          <ul className="space-y-1.5">
            {scanned.map((e) => {
              const [icon, color] = KIND_STYLE[e.kind] || KIND_STYLE.unknown;
              const marker = e.done ? (e.queued ? '🕓' : '✔️') : (e.failed ? '⚠️' : icon);
              const recheck = !e.done && !booking && !isOfflineMode && (e.kind === 'offline' || e.offline);
              return (
                <li key={e.isbn} className={`text-xs flex items-start gap-2 ${color}`} data-kind={e.kind}>
                  <span aria-hidden="true">{marker}</span>
                  <span className="min-w-0 flex-1">
                    <span className={e.done ? 'line-through opacity-60' : ''}>{e.label}</span>
                    {e.done && e.queued && <span className="ml-1 text-slate-400">(vorgemerkt)</span>}
                    {e.done && e.gone && <span className="ml-1 text-slate-400">(nicht mehr auf der Liste)</span>}
                    {e.booking && <span className="ml-1 text-slate-400">(wird gebucht…)</span>}
                    {!e.done && e.failed && <span className="ml-1 text-rose-300">– nicht gebucht: {e.error}</span>}
                  </span>
                  {recheck && (
                    <button
                      type="button"
                      onClick={() => handleBarcodeScan(e.isbn, { network: true })}
                      className="shrink-0 text-[11px] text-brand-300 hover:text-white underline"
                    >
                      Erneut prüfen
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

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
                  {formatCount(shoppingData.total_missing, 'Band', 'Bände')}
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
              {formatEuro(shoppingData?.total_cost ?? 0)}
            </p>
          </div>
          <div className="flex items-center gap-1.5" role="group" aria-label="Liste weitergeben">
            {canShareText() && (
              <button
                type="button"
                id="btn-shop-share"
                onClick={() => handOn(true)}
                disabled={!canHandOn}
                className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 disabled:opacity-40"
                title="Liste teilen (z. B. per Messenger)"
                aria-label="Liste teilen"
              >
                <Share2 className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              id="btn-shop-copy"
              onClick={() => handOn(false)}
              disabled={!canHandOn}
              className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 disabled:opacity-40"
              title="Liste als Text kopieren"
              aria-label="Liste als Text kopieren"
            >
              <Copy className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              id="btn-shop-print"
              onClick={() => setPrintSheet('button')}
              disabled={!canHandOn}
              className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 disabled:opacity-40"
              title="Liste drucken"
              aria-label="Liste drucken"
            >
              <Printer className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            onClick={fetchShoppingList}
            disabled={loadingShopping}
            className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5"
            title="Liste aktualisieren"
            aria-label="Liste aktualisieren"
          >
            <RefreshCw className={`w-4 h-4 ${loadingShopping ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Shopping Filters Bar */}
      <div className="glass-panel p-4 rounded-2xl border border-slate-800/80 flex flex-col sm:flex-row justify-between items-center gap-3">
        {/* Search */}
        <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full sm:w-72 focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400">
          <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
          <input
            type="text"
            placeholder="Titel oder Band filtern..."
            aria-label="Einkaufsliste filtern"
            className="w-full bg-transparent border-0 p-0 text-base sm:text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-0"
            value={shoppingSearch}
            onChange={e => setShoppingSearch(e.target.value)}
          />
          <div className="flex items-center gap-1 shrink-0">
            <BarcodeScannerButton compact continuous onDetected={handleBarcodeScan} buttonText="Laden-Scan" scannerChildren={scanFeed} />
            {shoppingSearch && (
              <button type="button" onClick={() => setShoppingSearch('')} className="text-slate-400 hover:text-white p-1.5 -m-1 rounded" aria-label="Suche leeren">
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <button
          type="button"
          id="btn-shop-priority-sort"
          onClick={() => setPrioritySort(v => !v)}
          aria-pressed={prioritySort}
          className={`text-xs px-3 py-1.5 rounded-xl border font-semibold shrink-0 transition-colors ${
            prioritySort ? 'bg-amber-500/20 text-amber-200 border-amber-500/50' : 'text-slate-400 border-slate-700 hover:text-slate-200'
          }`}
          title="Bände mit hoher Wunsch-Priorität zuerst zeigen"
        >
          ★ Wichtigste zuerst
        </button>

        {/* Publisher Filter Chips */}
        {publisherChips.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto p-1 -my-1 no-scrollbar">
            <button
              type="button"
              onClick={() => setShoppingPublisherFilter('ALL')}
              aria-pressed={activePublisher === 'ALL'}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
                activePublisher === 'ALL'
                  ? 'bg-brand-700 text-white shadow'
                  : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-700/50'
              }`}
            >
              Alle Verlage ({shoppingData.total_missing})
            </button>
            {publisherChips.map(p => {
              const active = activePublisher !== 'ALL' && activePublisher.toLowerCase() === String(p.publisher).toLowerCase();
              return (
                <button
                  type="button"
                  key={p.publisher}
                  onClick={() => setShoppingPublisherFilter(p.publisher)}
                  aria-pressed={active}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 ${
                    active
                      ? 'bg-brand-700 text-white shadow'
                      : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-700/50'
                  }`}
                >
                  <span>{p.publisher}</span>
                  <span className="text-[10px] bg-slate-900/80 px-1.5 py-0.5 rounded-full font-mono">
                    {p.count + (p.wished_count || 0)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Loading State */}
      {!shoppingData && !loadFailed && (
        <div role="status" className="flex justify-center items-center py-20 text-slate-400 gap-2">
          <RefreshCw className="w-5 h-5 animate-spin text-brand-400" aria-hidden="true" />
          <span>Einkaufsliste wird geladen...</span>
        </div>
      )}

      {/* Load error without any data (no cache) */}
      {loadFailed && (
        <div id="shop-load-error" className="glass-panel p-10 rounded-3xl border border-rose-500/30 text-center max-w-lg mx-auto" role="alert">
          <div className="w-14 h-14 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center mx-auto mb-4">
            <CircleAlert className="w-7 h-7 text-rose-400" aria-hidden="true" />
          </div>
          <h3 className="text-lg font-bold text-white">Einkaufsliste konnte nicht geladen werden</h3>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            {shoppingError === 'auth'
              ? SESSION_EXPIRED_TEXT
              : 'Der Server hat nicht geantwortet und auf diesem Gerät ist noch keine Offline-Kopie gespeichert.'}
          </p>
          <button type="button" onClick={fetchShoppingList} className="btn-primary text-xs px-4 py-2 mt-6">
            Erneut versuchen
          </button>
        </div>
      )}

      {/* Empty State */}
      {shoppingData && items.length === 0 && wishedCount === 0 && (
        <div className="glass-panel p-12 rounded-3xl border border-slate-800 text-center max-w-lg mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
            <CircleCheck className="w-8 h-8 text-emerald-400" />
          </div>
          <h3 className="text-lg font-bold text-white">Alles komplett im Regal!</h3>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Aktuell hast du keine Bände mit dem Status „Fehlt“. Sobald du bei einer Reihe Bände als fehlend markierst, erscheinen sie hier automatisch in deiner Einkaufsliste.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-6">
            <button
              type="button"
              onClick={() => setActiveMainView('shelf')}
              className="btn-primary text-xs px-4 py-2"
            >
              Zurück zur Sammlung
            </button>
          </div>
        </div>
      )}

      {/* No match for search / publisher filter */}
      {noMatch && (
        <div id="shop-no-match" className="glass-panel p-8 rounded-3xl border border-slate-800 text-center max-w-lg mx-auto">
          <SearchX className="w-8 h-8 text-slate-400 mx-auto mb-3" aria-hidden="true" />
          <h3 className="text-sm font-bold text-white">Keine Treffer für diese Filter</h3>
          <p className="text-xs text-slate-400 mt-1">
            {items.length === 0
              ? 'Keine gewünschte Reihe passt zu Suche oder Verlag.'
              : (items.length === 1
                ? 'Der fehlende Band passt nicht zu Suche oder Verlag.'
                : `Keiner der ${items.length} fehlenden Bände passt zu Suche oder Verlag.`)}
          </p>
          <button type="button" onClick={resetFilters} className="btn-secondary text-xs px-4 py-2 mt-4">
            Filter zurücksetzen
          </button>
        </div>
      )}

      {visibleWished.length > 0 && (
        <WishedSeriesSection
          series={visibleWished}
          canRemove={canEdit && !isOfflineMode}
          removing={removingWish}
          onRemove={removeWish}
        />
      )}

      {/* Shopping List Items Grid */}
      {visibleItems.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3.5 sm:gap-4">
          {itemPages.visible.map(item => {
            const busy = buyingId === item.id || Boolean(buyingIds?.has?.(item.id)) || inFlight.has(item.id);
            return (
              <div key={item.id} className={ITEM_WRAPPER_CLASS}>
              <div
                className="glass-card h-full rounded-2xl p-3 border border-slate-800/80 flex gap-3 relative group hover:border-emerald-500/50 transition-all bg-slate-900/60"
              >
                {/* Cover Thumbnail */}
                <Link to={`/manga/${item.manga_id}`} state={FROM_SHOPPING} tabIndex={-1} aria-hidden="true" className="shrink-0 relative group/cover">
                  <CoverImage
                    src={item.manga_cover}
                    className="w-16 h-24 object-cover rounded-xl shadow-md border border-slate-800 group-hover/cover:scale-105 transition-transform"
                    fallback={COVER_FALLBACK}
                  />
                  <span className="absolute top-1 left-1 bg-amber-500/90 text-slate-950 font-black text-[9px] px-1.5 py-0.5 rounded shadow uppercase">
                    Fehlt
                  </span>
                </Link>

                {/* Info & Buy Button */}
                <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                  <div>
                    <Link
                      to={`/manga/${item.manga_id}`}
                      state={FROM_SHOPPING}
                      className="text-xs font-bold text-white hover:text-brand-300 truncate block transition-colors"
                      title={item.manga_title}
                    >
                      {item.manga_title}
                    </Link>

                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                        {getVolumeDisplayTitle(item)}
                      </span>
                      {item.priority > 0 && (
                        <span className="bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[10px] font-bold px-1.5 py-0.5 rounded-lg" title="Wunsch-Priorität">
                          {PRIORITY_LABELS[item.priority]}
                        </span>
                      )}
                      {item.price > 0 && (
                        <span className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono px-2 py-0.5 rounded-lg font-bold">
                          {formatEuro(item.price)}
                        </span>
                      )}
                    </div>

                    {item.target_price > 0 && (
                      <p className="text-[11px] text-amber-300 mt-1">
                        Zielpreis: max. {formatEuro(item.target_price)}
                      </p>
                    )}
                    <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                      <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" />
                      <span className="truncate">{item.effective_publisher}</span>
                    </p>
                    {item.isbn && (
                      <p className="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                        ISBN: {item.isbn}
                      </p>
                    )}
                  </div>

                  {/* Quick Buy Button */}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => startBuy(item)}
                      disabled={busy}
                      aria-busy={busy || undefined}
                      aria-label={`Gekauft: ${item.manga_title} ${getVolumeDisplayTitle(item)}`}
                      className="mt-2.5 w-full bg-emerald-600/20 hover:bg-emerald-700 text-emerald-300 hover:text-white border border-emerald-500/40 hover:border-emerald-500 py-1.5 px-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all active:scale-95 shadow-sm"
                      title="Als gekauft markieren und ins Regal stellen"
                    >
                      {busy ? (
                        <RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <Check className="w-3.5 h-3.5 text-emerald-400 group-hover:text-white" aria-hidden="true" />
                      )}
                      <span>Gekauft</span>
                    </button>
                  )}
                </div>
              </div>
              </div>
            );
          })}
        </div>
      )}
      {itemPages.hasMore && (
        <ListProgress shown={itemPages.shown} total={itemPages.total} onMore={itemPages.showMore} sentinelRef={itemPages.sentinelRef} />
      )}

      {/* Bände, die andere Nutzer in Reihen besitzen, die ich auch sammle */}
      {visibleOthers.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-bold text-slate-200 mb-1">Bei anderen vorhanden</h3>
          <p className="text-xs text-slate-400 mb-3">Diese Bände besitzen andere Nutzer in Reihen, die du auch sammelst.</p>
          <ul className="divide-y divide-slate-800/80 rounded-2xl border border-slate-800 bg-slate-950/60">
            {otherPages.visible.map(item => {
              const busy = claiming.has(item.id);
              return (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs [content-visibility:auto] [contain-intrinsic-block-size:auto_48px]">
                  <div className="min-w-0">
                    <Link to={`/manga/${item.manga_id}`} state={FROM_SHOPPING} className="font-semibold text-slate-100 hover:text-brand-300 truncate block">
                      {item.manga_title} {getVolumeDisplayTitle({ volume_number: item.volume_number, type: item.type, notes: item.notes })}
                    </Link>
                    <span className="text-slate-400">Besitzt: {item.owned_by_others}</span>
                    {claimErrors[item.id] && <span className="block text-rose-300" role="alert">{claimErrors[item.id]}</span>}
                  </div>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => handleClaim(item)}
                      disabled={busy || isOfflineMode}
                      aria-busy={busy || undefined}
                      className="shrink-0 px-2.5 py-1 rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-700 hover:text-white font-semibold disabled:opacity-50 disabled:hover:bg-transparent flex items-center gap-1"
                      title={isOfflineMode ? 'Nur online möglich' : 'Ich besitze diesen Band auch'}
                    >
                      {busy && <RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />}
                      Ich habe ihn auch
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {otherPages.hasMore && (
            <ListProgress shown={otherPages.shown} total={otherPages.total} onMore={otherPages.showMore} sentinelRef={otherPages.sentinelRef} />
          )}
        </div>
      )}
    </div>
  );
}
