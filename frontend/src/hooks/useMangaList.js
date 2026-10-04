import { useState, useLayoutEffect, useRef, useCallback } from 'react';
import { loadMangaList, syncOfflineCopy } from '../utils/offlineStore';
import { apiFetch, readJson, isAbortError, sessionEndAnnounced } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import {
  readCache, writeCache, touchCache, clearDataCache, revalidateHeaders, takePrefetch, cacheOwner, PREFETCH_MANGAS, LIST_KEY
} from '../utils/dataCache';
import useLatestRequest from './useLatestRequest';
import { t } from '../i18n/index.js';
import { serverText } from '../i18n/serverText.js';

export { SESSION_EXPIRED_EVENT } from '../utils/api';

/** Drops every in-memory copy (logout, session end); the offline copy is cleared separately. */
export function clearMangaListCache() {
  clearDataCache();
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);
export const TRASH_UNDO_MS = 10000;

/**
 * The series list and deleting a series; stale-while-revalidate (memory, else offline copy, then server).
 * `loading` only while nothing is shown, else `refreshing`; `error` is a German message, the list stays.
 */
export default function useMangaList({ user, canEdit, onRestored }) {
  const owner = cacheOwner(user);
  const [initial] = useState(() => readCache(owner, LIST_KEY));
  const [mangas, setMangas] = useState(() => initial?.data ?? []);
  const [loading, setLoading] = useState(() => !initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [dataAt, setDataAt] = useState(() => initial?.at ?? null);

  const beginRequest = useLatestRequest();
  const offlineRef = useRef(Boolean(user?.offline));
  const canEditRef = useRef(canEdit);
  const onRestoredRef = useRef(onRestored);
  const ownerRef = useRef(owner);
  const mangasRef = useRef(mangas);
  const fromOfflineCopyRef = useRef(false);
  const triedOfflineCopyRef = useRef(Boolean(initial));

  useLayoutEffect(() => {
    offlineRef.current = Boolean(user?.offline);
    canEditRef.current = canEdit;
    onRestoredRef.current = onRestored;
    ownerRef.current = owner;
  });

  const show = useCallback((list, { offlineCopy = false, at = null } = {}) => {
    mangasRef.current = list;
    fromOfflineCopyRef.current = offlineCopy;
    setMangas(list);
    setDataAt(at);
  }, []);

  const fetchMangas = useCallback(async () => {
    const { signal, isCurrent: isLatest } = beginRequest();
    const key = ownerRef.current;
    let answered = false;
    setRefreshing(true);

    const showOfflineCopy = async () => {
      const cached = await loadMangaList();
      if (!isLatest() || !cached?.length) return false;
      if (mangasRef.current.length === 0) show(cached, { offlineCopy: true });
      return true;
    };

    try {
      if (offlineRef.current) {
        const cached = await loadMangaList();
        if (!isLatest()) return;
        if (cached?.length) show(cached, { offlineCopy: true });
        setError(null);
        return;
      }

      if (mangasRef.current.length === 0 && !triedOfflineCopyRef.current) {
        triedOfflineCopyRef.current = true;
        loadMangaList().then((cached) => {
          if (answered || !isLatest() || !cached?.length || mangasRef.current.length > 0) return;
          show(cached, { offlineCopy: true });
          setLoading(false);
        });
      }

      const entry = readCache(key, LIST_KEY);
      const conditional = entry && entry.data === mangasRef.current;
      const prefetched = entry ? null : takePrefetch(PREFETCH_MANGAS);
      let res = prefetched ? await prefetched : null;
      if (!isLatest()) return;
      if (!res?.ok) res = await apiFetch('/api/mangas', { signal, headers: conditional ? revalidateHeaders(entry) : undefined });
      if (!isLatest()) return;

      if (res.status === 304 && conditional) {
        answered = true;
        setDataAt(touchCache(key, LIST_KEY)?.at ?? Date.now());
        setError(null);
        return;
      }
      if (res.status === 401) {
        // the list stays until App's session-expired handler (fired by the API client) signs out and unmounts the
        // shelf; an offline copy shown while waiting for this answer goes at once
        answered = true;
        clearMangaListCache();
        if (fromOfflineCopyRef.current) show([]);
        setError(t('Sitzung abgelaufen – bitte neu anmelden.'));
        return;
      }
      if (!res.ok) {
        const body = (await readJson(res)) || {};
        if (!isLatest()) return;
        const usedCopy = GATEWAY_STATUSES.has(res.status)
          && (fromOfflineCopyRef.current || (mangasRef.current.length === 0 && await showOfflineCopy()));
        if (!isLatest()) return;
        setError(usedCopy
          ? t('Server nicht erreichbar – angezeigt wird die gespeicherte Offline-Kopie.')
          : (serverText(body) || t('Sammlung konnte nicht geladen werden (Fehler {status}).', { status: res.status })));
        return;
      }
      const data = await readJson(res);
      if (!isLatest()) return;
      if (data === null) throw new Error(t('Antwort ist kein JSON'));
      answered = true;
      const list = Array.isArray(data) ? data : [];
      const stored = writeCache(key, LIST_KEY, list, res.headers?.get?.('ETag'));
      show(list, { at: stored.at });
      setError(null);
    } catch (e) {
      if (!isLatest() || isAbortError(e)) return;
      console.warn('Failed to fetch mangas, using offline copy:', e);
      const usedCopy = mangasRef.current.length === 0 && await showOfflineCopy();
      if (!isLatest()) return;
      setError(usedCopy || mangasRef.current.length > 0
        ? t('Server nicht erreichbar – angezeigt wird der zuletzt geladene Stand.')
        : t('Server nicht erreichbar – Sammlung konnte nicht geladen werden.'));
    } finally {
      if (isLatest()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [beginRequest, show]);

  const restoreSeries = useCallback(async (trashId) => {
    try {
      const res = await apiFetch(`/api/trash/${trashId}/restore`, { method: 'POST' });
      if (!res.ok) {
        await notifyResponseError(res, t('Wiederherstellen fehlgeschlagen'));
        return;
      }
    } catch (err) {
      notify.error(err);
      return;
    }
    await fetchMangas();
    syncOfflineCopy({ force: true });
    onRestoredRef.current?.();
  }, [fetchMangas]);

  /**
   * Returns true when the series was deleted, so the caller can refresh dependent views (badges). The series goes to
   * the trash; the toast offers "Rückgängig" (POST /api/trash/:id/restore).
   */
  const handleDeleteManga = useCallback(async (e, id, title) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    if (!canEditRef.current) return false;
    if (!confirm(t('Möchtest du "{title}" wirklich löschen? Die Reihe kommt mit allen Bänden in den Papierkorb (30 Tage wiederherstellbar).', { title }))) {
      return false;
    }

    let res;
    try {
      res = await apiFetch(`/api/mangas/${id}`, { method: 'DELETE' });
    } catch (err) {
      notify.error(err);
      return false;
    }
    if (res.ok) {
      const list = mangasRef.current.filter((m) => m.id !== id);
      // a remount before the refresh answers must not bring the series back
      writeCache(ownerRef.current, LIST_KEY, list);
      show(list, { at: Date.now() });
      fetchMangas();
      // the offline copy would otherwise bring the series back when the server is unreachable
      syncOfflineCopy({ force: true });
      const trashId = (await readJson(res))?.trash_id;
      if (trashId) {
        notify.success(t('„{title}“ in den Papierkorb gelegt', { title }), {
          duration: TRASH_UNDO_MS,
          action: { label: t('Rückgängig'), onClick: () => restoreSeries(trashId) }
        });
      }
      return true;
    }
    if (res.status === 401) {
      // a session end is already on its way to the login; any other 401 (proxy) needs a message
      if (!sessionEndAnnounced(res)) await notifyResponseError(res, t('Sitzung abgelaufen – bitte neu anmelden.'));
      return false;
    }
    await notifyResponseError(res, t('Fehler beim Löschen'));
    return false;
  }, [fetchMangas, restoreSeries, show]);

  return { mangas, loading, refreshing, error, dataAt, fetchMangas, handleDeleteManga };
}
