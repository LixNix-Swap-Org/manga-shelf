import { useState, useEffect, useRef } from 'react';
import {
  loadUser, getClearGeneration, readShoppingCache, readShoppingCacheTimestamp, writeShoppingCache, updateShoppingCache
} from '../utils/offlineStore';
import { discardLegacyQueue, withoutVolumes, localToday } from '../utils/shoppingQueue';
import {
  getOutbox, outboxScope, submitChange, isPurchaseEntry, applyChangeToCaches, OUTBOX_SYNCED_EVENT
} from '../utils/outbox';
import { useOutboxPending } from '../app/useOutbox';
import { PURCHASE_RECORDED_EVENT } from '../appShell';
import { apiFetch, readJson, sessionEndAnnounced } from '../utils/api';
import { notify } from '../utils/notify';
import { haptic } from '../utils/haptics';

async function errorText(res) {
  const body = await readJson(res);
  return typeof body?.error === 'string' ? body.error : '';
}

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const SESSION_EXPIRED = 'Sitzung abgelaufen – der Kauf ist vorgemerkt und wird nach der Anmeldung übertragen.';
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

const mangaIdIn = (data, volumeId) => [...(data?.items || []), ...(data?.others || [])]
  .find((item) => String(item?.id) === String(volumeId))?.manga_id ?? null;

const pendingPurchaseIds = (id) => new Set(getOutbox().list(outboxScope(id)).filter(isPurchaseEntry).map((e) => e.volumeId));

/**
 * Shopping list (missing volumes) with offline cache and quick buy. Purchases go through the outbox: made while the
 * server is unreachable they are kept per user and sent later. `user` is the logged-in user (with `offline: true` in
 * App's offline mode).
 */
export default function useShoppingList({ user, setNetworkOffline, fetchMangas }) {
  const userId = user?.id ?? null;
  const [shoppingData, setShoppingData] = useState(() => withoutVolumes(readShoppingCache(), pendingPurchaseIds(userId)));
  const [loadingShopping, setLoadingShopping] = useState(false);
  const [shoppingPublisherFilter, setShoppingPublisherFilter] = useState('ALL');
  const [shoppingSearch, setShoppingSearch] = useState('');
  const [buyingIds, setBuyingIds] = useState(() => new Set());
  const [shoppingError, setShoppingError] = useState(null);
  const [offlineLastUpdated, setOfflineLastUpdated] = useState(readShoppingCacheTimestamp);
  const [cacheWriteFailed, setCacheWriteFailed] = useState(false);
  const [cachedUserId, setCachedUserId] = useState(null);
  const pending = useOutboxPending(userId ?? cachedUserId);
  const pendingPurchases = pending.purchases;
  const [failedPurchases, setFailedPurchases] = useState([]);
  const shoppingDataRef = useRef(shoppingData);
  shoppingDataRef.current = shoppingData;
  // set when a request failed or a purchase was queued: the next successful list fetch then sends the queue
  const syncDueRef = useRef(false);

  const resolveUserId = async () => {
    if (userId !== null) return userId;
    const cached = await loadUser();
    return cached?.id ?? null;
  };

  /** Sends the outbox (purchases and other queued changes). Resolves to { synced, dropped, kept } or null. */
  const syncPendingPurchases = async () => {
    if (user?.offline || browserOffline()) return null;
    const id = await resolveUserId();
    if (id === null) return null;
    syncDueRef.current = false;
    const outbox = getOutbox();
    await outbox.migrateLegacy(outboxScope(id));
    const result = await outbox.flush(outboxScope(id), { force: true });
    const dropped = result.dropped.filter(isPurchaseEntry);
    if (dropped.length) {
      console.warn(`[PWA] ${dropped.length} vorgemerkte Käufe vom Server abgelehnt`);
      setFailedPurchases((prev) => [...prev, ...dropped]);
    }
    if (result.kept.length) syncDueRef.current = true;
    return { synced: result.synced, dropped: result.dropped, kept: result.kept };
  };

  // On mount and whenever App leaves its offline mode (that happens without a browser 'online' event)
  useEffect(() => {
    const dropped = discardLegacyQueue();
    if (dropped) console.warn(`[PWA] ${dropped} vorgemerkte Käufe ohne Benutzerzuordnung verworfen`);
    let active = true;
    resolveUserId().then((id) => {
      if (!active || id === null) return;
      if (userId === null) setCachedUserId(id);
      getOutbox().migrateLegacy(outboxScope(id));
    });
    if (!user?.offline) syncPendingPurchases();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur bei Benutzer- oder Offline-Wechsel
  }, [userId, user?.offline]);

  // bought volumes leave the list as soon as they are in the outbox (also those of a replay on another view)
  const pendingKey = [...pending.purchaseIds].sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!pending.purchaseIds.size) return;
    setShoppingData((prev) => withoutVolumes(prev, pending.purchaseIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pendingKey steht für die Menge
  }, [pendingKey]);

  // a replay of queued changes (App, reconnect): the list and the shelf show the server state again
  useEffect(() => {
    const onSynced = () => {
      fetchShoppingList();
      fetchMangas();
    };
    window.addEventListener(OUTBOX_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(OUTBOX_SYNCED_EVENT, onSynced);
  });

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
      await getOutbox().load();
      if (generation !== getClearGeneration()) return;
      const visible = withoutVolumes(data, pendingPurchaseIds(id));
      setShoppingError(null);
      setShoppingData(visible);
      setNetworkOffline(false);
      const savedAt = writeShoppingCache(visible, generation);
      setCacheWriteFailed(!savedAt);
      if (savedAt) setOfflineLastUpdated(savedAt);
      if (syncDueRef.current && getOutbox().count(outboxScope(id))) syncPendingPurchases();
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
   * A purchase that was sent or queued reaches the stored copies (in-memory detail, offline detail and with it the ISBN
   * index) and the listeners of PURCHASE_RECORDED_EVENT (offline overlay, open detail page). Call before markBought:
   * the series is looked up on the list.
   */
  const recordPurchaseLocally = (volumeId, change, ownerId, queued) => {
    const mangaId = mangaIdIn(shoppingDataRef.current, volumeId) ?? mangaIdIn(readShoppingCache(), volumeId);
    window.dispatchEvent(new CustomEvent(PURCHASE_RECORDED_EVENT, { detail: queued ? { volumeId, queued: true } : { volumeId } }));
    if (mangaId === null) return Promise.resolve(false);
    const me = user?.id !== undefined && user?.id !== null ? user : { id: ownerId };
    return applyChangeToCaches({ user: me, mangaId, change }).catch(() => false);
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
      const id = userId !== null ? userId : await resolveUserId();
      if (id === null) return done('failed', QUEUE_FAILED);
      const offline = Boolean(user?.offline) || browserOffline();
      const change = { kind: 'purchase', volumeId, value: true, purchase_date: localToday() };
      let result;
      try {
        result = await submitChange(change, { userId: id, offline });
      } catch (_) {
        return done('failed', QUEUE_FAILED);
      }
      const { status, res } = result;
      if (result.reason === 'storage') return done('failed', QUEUE_FAILED);
      if (status === 'queued' || status === 'auth') {
        syncDueRef.current = true;
        if (!offline && status === 'queued') setNetworkOffline(true);
        const recorded = recordPurchaseLocally(volumeId, change, id, true);
        markBought(volumeId);
        if (status === 'auth' && !sessionEndAnnounced(res) && !batch) notify.info(SESSION_EXPIRED);
        await recorded;
        return done('queued');
      }
      if (status === 'sent' && res?.ok) {
        const recorded = recordPurchaseLocally(volumeId, change, id, false);
        markBought(volumeId);
        await recorded;
        if (!batch) {
          fetchMangas();
          fetchShoppingList();
        }
        return done('ok', '', res.status);
      }
      // 404: the volume no longer exists; other 4xx: the server refused the purchase
      if (res?.status === 404) dropItem(volumeId);
      return done('failed', (res && await errorText(res)) || BUY_FAILED, res?.status ?? null);
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
