import { useState, useEffect, useRef } from 'react';
import {
  loadUser, getClearGeneration, readShoppingCache, readShoppingCacheTimestamp, writeShoppingCache, updateShoppingCache
} from '../utils/offlineStore';
import {
  enqueuePurchase, flushPurchaseQueue, pendingVolumeIds, pendingCount, discardLegacyQueue, withoutVolumes,
  classifyQuickBuy, sendPurchase, localToday
} from '../utils/shoppingQueue';
import { PURCHASE_RECORDED_EVENT } from '../appShell';
import { apiFetch, readJson } from '../utils/api';
import { notify } from '../utils/notify';
import { haptic } from '../utils/haptics';

async function errorText(res) {
  const body = await readJson(res);
  return typeof body?.error === 'string' ? body.error : '';
}

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const SESSION_EXPIRED = 'Sitzung abgelaufen – bitte neu anmelden.';
const BUY_FAILED = 'Fehler beim Aktualisieren des Bands';
const QUEUE_FAILED = 'Der Kauf konnte nicht vorgemerkt werden (Speicher voll oder nicht verfügbar). Bitte erneut versuchen, sobald eine Verbindung besteht.';

/** Why the list could not be loaded: 'offline' (no answer), 'auth' (401), 'server' (5xx/429) or 'error' (other 4xx). */
export function shoppingErrorKind(status) {
  if (status === null || status === undefined) return 'offline';
  if (status === 401) return 'auth';
  if (status === 429 || status >= 500) return 'server';
  return 'error';
}

const addId = (set, id) => (set.has(id) ? set : new Set(set).add(id));
const removeId = (set, id) => {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
};

/**
 * Shopping list (missing volumes) with offline cache, quick buy and the per-user queue of purchases made while the
 * server was unreachable. `user` is the logged-in user (with `offline: true` in App's offline mode).
 */
export default function useShoppingList({ user, setNetworkOffline, fetchMangas }) {
  const userId = user?.id ?? null;
  const [shoppingData, setShoppingData] = useState(() => withoutVolumes(readShoppingCache(), pendingVolumeIds(userId)));
  const [loadingShopping, setLoadingShopping] = useState(false);
  const [shoppingPublisherFilter, setShoppingPublisherFilter] = useState('ALL');
  const [shoppingSearch, setShoppingSearch] = useState('');
  const [buyingIds, setBuyingIds] = useState(() => new Set());
  const [shoppingError, setShoppingError] = useState(null);
  const [offlineLastUpdated, setOfflineLastUpdated] = useState(readShoppingCacheTimestamp);
  const [cacheWriteFailed, setCacheWriteFailed] = useState(false);
  const [pendingPurchases, setPendingPurchases] = useState(() => pendingCount(userId));
  const [failedPurchases, setFailedPurchases] = useState([]);
  // set when a request failed or a purchase was queued: the next successful list fetch then sends the queue
  const syncDueRef = useRef(false);

  const resolveUserId = async () => {
    if (userId !== null) return userId;
    const cached = await loadUser();
    return cached?.id ?? null;
  };

  const refreshPending = (id) => setPendingPurchases(pendingCount(id));

  const syncPendingPurchases = async () => {
    if (user?.offline || browserOffline()) return null;
    const id = await resolveUserId();
    if (id === null) return null;
    syncDueRef.current = false;
    const result = await flushPurchaseQueue({ userId: id });
    refreshPending(id);
    if (result.dropped.length) {
      console.warn(`[PWA] ${result.dropped.length} vorgemerkte Käufe vom Server abgelehnt`);
      setFailedPurchases((prev) => [...prev, ...result.dropped]);
    }
    if (result.kept.length) syncDueRef.current = true;
    if (result.synced.length || result.dropped.length) {
      fetchShoppingList();
      fetchMangas();
    }
    return result;
  };

  // On mount and whenever App leaves its offline mode (that happens without a browser 'online' event)
  useEffect(() => {
    const dropped = discardLegacyQueue();
    if (dropped) console.warn(`[PWA] ${dropped} vorgemerkte Käufe ohne Benutzerzuordnung verworfen`);
    let active = true;
    resolveUserId().then((id) => { if (active && id !== null) refreshPending(id); });
    if (!user?.offline) syncPendingPurchases();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur bei Benutzer- oder Offline-Wechsel
  }, [userId, user?.offline]);

  const fallBackToCache = (unreachable) => {
    const cached = readShoppingCache();
    if (cached) setShoppingData((prev) => prev ?? cached);
    if (unreachable) {
      syncDueRef.current = true;
      setNetworkOffline(true);
    }
  };

  const fetchShoppingList = async () => {
    const generation = getClearGeneration();
    setLoadingShopping(true);
    try {
      const id = await resolveUserId();
      const res = await apiFetch('/api/shopping-list?include_others=1');
      if (!res.ok) {
        if (generation === getClearGeneration()) {
          setShoppingError(shoppingErrorKind(res.status));
          fallBackToCache(res.status >= 500);
        }
        return;
      }
      const data = await readJson(res);
      if (data === null) throw new Error('Antwort ist kein JSON');
      if (generation !== getClearGeneration()) return; // logged out meanwhile: keep nothing of it
      const visible = withoutVolumes(data, pendingVolumeIds(id));
      setShoppingError(null);
      setShoppingData(visible);
      setNetworkOffline(false);
      const savedAt = writeShoppingCache(visible, generation);
      setCacheWriteFailed(!savedAt);
      if (savedAt) setOfflineLastUpdated(savedAt);
      if (syncDueRef.current && pendingCount(id)) syncPendingPurchases();
    } catch (e) {
      console.warn('Network issue fetching shopping list, using offline cache:', e);
      if (generation === getClearGeneration()) {
        setShoppingError(shoppingErrorKind(null));
        fallBackToCache(true);
      }
    } finally {
      setLoadingShopping(false);
    }
  };

  const dropItem = (volumeId) => {
    const ids = new Set([volumeId]);
    setShoppingData((prev) => withoutVolumes(prev, ids));
    updateShoppingCache((cached) => withoutVolumes(cached, ids));
  };

  const markBought = (volumeId) => {
    dropItem(volumeId);
    haptic('success');
  };

  /**
   * Records the purchase as the user's own ownership. Resolves to 'ok', 'queued' (sent later) or 'failed' (nothing
   * changed, the user was told why). With { batch: true } (a booking run over several scans) nothing is alerted or
   * refetched per item and the result is { status, error, httpStatus }; a volume that no longer exists (404) leaves the list.
   */
  const handleQuickBuy = async (volumeId, { batch = false } = {}) => {
    const done = (status, error = '', httpStatus = null) => {
      if (!batch) {
        if (status === 'failed' && error) notify.error(error);
        return status;
      }
      return { status, error, httpStatus };
    };
    setBuyingIds((prev) => addId(prev, volumeId));
    try {
      // no await when the user is known: a flush on unmount must send the purchase before the next page loads
      const id = userId !== null ? userId : await resolveUserId();
      const queue = () => {
        if (!enqueuePurchase(id, volumeId)) return done('failed', QUEUE_FAILED);
        syncDueRef.current = true;
        refreshPending(id);
        markBought(volumeId);
        return done('queued');
      };

      if (user?.offline || browserOffline()) return queue();

      let res;
      try {
        res = await sendPurchase(volumeId, localToday());
      } catch (_) {
        setNetworkOffline(true);
        return queue();
      }
      const outcome = classifyQuickBuy(res);
      if (outcome === 'ok') {
        markBought(volumeId);
        window.dispatchEvent(new CustomEvent(PURCHASE_RECORDED_EVENT, { detail: { volumeId } }));
        if (!batch) {
          fetchMangas();
          fetchShoppingList();
        }
        return done('ok', '', res.status);
      }
      if (outcome === 'queue') {
        setNetworkOffline(true);
        return queue();
      }
      if (res.status === 404) dropItem(volumeId);
      const message = outcome === 'auth' ? SESSION_EXPIRED : ((await errorText(res)) || BUY_FAILED);
      return done('failed', message, res.status);
    } finally {
      setBuyingIds((prev) => removeId(prev, volumeId));
    }
  };

  return {
    shoppingData, loadingShopping, shoppingPublisherFilter, setShoppingPublisherFilter,
    shoppingSearch, setShoppingSearch, buyingIds, shoppingError, offlineLastUpdated, cacheWriteFailed,
    pendingPurchases, failedPurchases, fetchShoppingList, handleQuickBuy, syncPendingPurchases
  };
}
