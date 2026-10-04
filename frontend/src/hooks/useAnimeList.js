import { useState, useCallback, useRef, useEffect } from 'react';
import api, { isAbortError, TIMEOUTS } from '../utils/api';
import { notify } from '../utils/notify';
import { getClearGeneration } from '../utils/offlineStore';
import {
  readAnimeCache, writeAnimeCache, withProgress, predictProgress, predictWatched, listSyncDue, markListSync
} from '../utils/animeHelpers';
import { ANIME_SYNC_EVENT } from '../utils/shareIntake';
import { WATCH_SYNC_EVENT } from '../app/watch/watchState';
import useLatestRequest from './useLatestRequest';
import { t } from '../i18n/index.js';

/**
 * The anime tab: shared list with my progress (GET /api/anime), the sources state and the actions. Offline (or when
 * the server is unreachable) the last list comes from localStorage and nothing can be changed.
 */
export default function useAnimeList({ user }) {
  const userId = user?.id ?? null;
  const offline = Boolean(user?.offline);
  const canWrite = !offline && (user?.role === 'admin' || user?.role === 'editor');
  const [list, setList] = useState(() => readAnimeCache(userId)?.list || []);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cacheAt, setCacheAt] = useState(() => readAnimeCache(userId)?.timestamp || null);
  const [fromCache, setFromCache] = useState(false);
  const [sources, setSources] = useState(null);
  const [listSync, setListSync] = useState(null);
  const beginList = useLatestRequest();
  const beginSources = useLatestRequest();
  const listRef = useRef(list);
  listRef.current = list;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  useEffect(() => {
    const cached = readAnimeCache(userId);
    setList(cached?.list || []);
    setCacheAt(cached?.timestamp || null);
    setLoaded(false);
  }, [userId]);

  const store = useCallback((next) => {
    setList(next);
    const stamp = writeAnimeCache(next, userId);
    if (stamp) setCacheAt(stamp);
  }, [userId]);

  const fetchAnime = useCallback(async () => {
    const cached = readAnimeCache(userId);
    if (offline) {
      setList(cached?.list || []);
      setCacheAt(cached?.timestamp || null);
      setFromCache(true);
      setLoaded(true);
      return;
    }
    const { signal, isCurrent } = beginList();
    const generation = getClearGeneration();
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/api/anime', { signal, fallback: t('Anime-Liste konnte nicht geladen werden') });
      if (!isCurrent()) return;
      const next = Array.isArray(data) ? data : [];
      setList(next);
      setFromCache(false);
      const stamp = writeAnimeCache(next, userId, generation);
      if (stamp) setCacheAt(stamp);
    } catch (err) {
      if (!isCurrent() || isAbortError(err)) return;
      if (cached?.list) {
        setList(cached.list);
        setFromCache(true);
      }
      setError(err.message || t('Anime-Liste konnte nicht geladen werden'));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [beginList, offline, userId]);

  const fetchSources = useCallback(async () => {
    if (offline) return;
    const { signal, isCurrent } = beginSources();
    try {
      const data = await api.get('/api/anime/sources', { signal });
      if (isCurrent()) setSources(data);
    } catch (_) { /* the hint line is optional */ }
  }, [beginSources, offline]);

  /** { results, sources_used, partial, cached, credential_used } or throws ApiError (429 with retry_after). */
  const search = useCallback(async (q, { signal } = {}) => {
    const data = await api.get(`/api/anime/search?q=${encodeURIComponent(q)}`, { signal, timeout: TIMEOUTS.lookup, fallback: t('Suche fehlgeschlagen') });
    fetchSources();
    return data;
  }, [fetchSources]);

  /** Anime adaptations of a series: { results, source, cached }. */
  const adaptations = useCallback((mangaId, { signal } = {}) => api.get(`/api/mangas/${mangaId}/adaptations`, { signal, timeout: TIMEOUTS.lookup, fallback: t('Adaptionen konnten nicht geladen werden') }), []);

  const replaceEntry = useCallback((detail) => {
    const current = listRef.current;
    const existing = current.find((a) => a.id === detail.id);
    const entry = { ...(existing || {}), ...detail, progress_users: (detail.progress || existing?.progress_users || []).map((p) => ({ user_id: p.user_id, username: p.username, status: p.status, episodes_watched: p.episodes_watched })) };
    delete entry.description;
    delete entry.relations;
    delete entry.progress;
    store(existing ? current.map((a) => (a.id === detail.id ? entry : a)) : [...current, entry]);
  }, [store]);

  /** POST /api/anime from a search hit ({ anilist_id, mal_id }) or manual ({ title, episodes }); resolves with the detail. */
  const add = useCallback(async (body) => {
    const detail = await api.post('/api/anime', body, { timeout: TIMEOUTS.lookup, fallback: t('Anime konnte nicht hinzugefügt werden') });
    replaceEntry(detail);
    return detail;
  }, [replaceEntry]);

  const update = useCallback(async (id, body) => {
    const detail = await api.put(`/api/anime/${id}`, body, { fallback: t('Änderung konnte nicht gespeichert werden') });
    replaceEntry(detail);
    return detail;
  }, [replaceEntry]);

  const fetchDetail = useCallback((id, { signal } = {}) => api.get(`/api/anime/${id}`, { signal, fallback: t('Anime konnte nicht geladen werden') }), []);

  // `watch` (the "Weiter" target) is computed by the server from the progress: after a change it is read again
  const refreshWatch = useCallback(async (id) => {
    try {
      const detail = await api.get(`/api/anime/${id}`);
      if (detail && 'watch' in detail) store(listRef.current.map((a) => (a.id === id ? { ...a, watch: detail.watch } : a)));
    } catch (_) { /* the link keeps its old target until the next list load */ }
  }, [store]);

  /** Optimistic: the list shows the predicted state at once and goes back when the server refuses. */
  const updateProgress = useCallback(async (id, change) => {
    const before = listRef.current.find((a) => a.id === id);
    if (!before) return null;
    const predicted = predictProgress(before.my_progress, change, before.episodes);
    setList((cur) => cur.map((a) => (a.id === id ? withProgress(a, predicted, user) : a)));
    try {
      const saved = await api.put(`/api/anime/${id}/progress`, change, { fallback: t('Fortschritt konnte nicht gespeichert werden') });
      store(listRef.current.map((a) => (a.id === id ? withProgress(a, saved, user) : a)));
      if (before.watch) refreshWatch(id);
      return saved;
    } catch (err) {
      setList((cur) => cur.map((a) => (a.id === id ? before : a)));
      notify.error(err, { fallback: t('Fortschritt konnte nicht gespeichert werden') });
      return null;
    }
  }, [refreshWatch, store, user]);

  /**
   * "Ja, gesehen" of a shared link: POST /anime/:id/watched (never lowers the counter, remembers the page for "Weiter",
   * `remember` links the streaming series to the entry, `complete` allows an episode above the total). Resolves with
   * the answer ({ progress, previous, … }), null after an error toast; EPISODE_ABOVE_TOTAL is thrown to the dialog.
   */
  const markWatched = useCallback(async (id, { episode, url, remember, complete = false } = {}) => {
    const before = listRef.current.find((a) => a.id === id);
    // above the total without `complete` the server refuses: no optimistic "Gesehen"
    if (before && (complete || !(before.episodes > 0 && episode > before.episodes))) {
      const predicted = predictWatched(before.my_progress, { episode, url }, before.episodes);
      setList((cur) => cur.map((a) => (a.id === id ? withProgress(a, predicted, user) : a)));
    }
    const body = { episode };
    if (url) body.url = url;
    if (remember) body.remember = remember;
    if (complete) body.complete = true;
    try {
      const saved = await api.post(`/api/anime/${id}/watched`, body, { fallback: t('Fortschritt konnte nicht gespeichert werden') });
      const progress = saved?.progress ?? null;
      if (listRef.current.some((a) => a.id === id)) {
        store(listRef.current.map((a) => (a.id === id ? withProgress(a, progress, user) : a)));
        refreshWatch(id);
      } else fetchAnime();
      return saved || { progress };
    } catch (err) {
      if (before) setList((cur) => cur.map((a) => (a.id === id ? before : a)));
      if (err?.code === 'EPISODE_ABOVE_TOTAL') throw err;
      notify.error(err, { fallback: t('Fortschritt konnte nicht gespeichert werden') });
      return null;
    }
  }, [fetchAnime, refreshWatch, store, user]);

  /**
   * AniList list sync when the tab loads (POST /anime/sync/run, at most every 15 min here, the server throttles too);
   * reloads the list when the pull changed something. Errors only end up in `listSync.last_error`.
   */
  const syncList = useCallback(async ({ force = false } = {}) => {
    if (!canWrite || userId === null) return null;
    if (!force && !listSyncDue(userId)) return null;
    markListSync(userId);
    try {
      const data = await api.post('/api/anime/sync/run', force ? {} : { auto: true }, { timeout: TIMEOUTS.lookup });
      const result = data?.anilist || null;
      setListSync(result);
      if (result?.changed) await fetchAnime();
      return result;
    } catch (_) {
      return null;
    }
  }, [canWrite, fetchAnime, userId]);

  // "Jetzt abgleichen" in the account dialog
  useEffect(() => {
    const onSynced = (event) => {
      const result = event?.detail || null;
      if (!result) return;
      // the account dialog switched the sync off: no hint about its last error any more
      setListSync(result.enabled === false ? null : result);
      if (result.changed && loadedRef.current) fetchAnime();
    };
    window.addEventListener(ANIME_SYNC_EVENT, onSynced);
    return () => window.removeEventListener(ANIME_SYNC_EVENT, onSynced);
  }, [fetchAnime]);

  // the apps' Crunchyroll history sync or its match dialog changed progress: the shown list reloads
  useEffect(() => {
    const onWatchSync = (event) => {
      if (event?.detail?.changed && loadedRef.current) fetchAnime();
    };
    window.addEventListener(WATCH_SYNC_EVENT, onWatchSync);
    return () => window.removeEventListener(WATCH_SYNC_EVENT, onWatchSync);
  }, [fetchAnime]);

  const removeFromMyList = useCallback(async (id) => {
    const before = listRef.current.find((a) => a.id === id);
    if (!before) return false;
    setList((cur) => cur.map((a) => (a.id === id ? withProgress(a, null, user) : a)));
    try {
      await api.del(`/api/anime/${id}/progress`, { fallback: t('Konnte nicht von deiner Liste entfernt werden') });
      store(listRef.current);
      if (before.watch) refreshWatch(id);
      return true;
    } catch (err) {
      setList((cur) => cur.map((a) => (a.id === id ? before : a)));
      notify.error(err);
      return false;
    }
  }, [refreshWatch, store, user]);

  /**
   * "Rückgängig" of a share: back to the server's progress from before the write (`previous`, null = no progress).
   * Works without the entry in the list (not loaded yet or from an old cache).
   */
  const undoWatched = useCallback(async (id, previous) => {
    const change = previous ? { status: previous.status, episodes_watched: previous.episodes_watched || 0 } : null;
    if (listRef.current.some((a) => a.id === id)) return change ? Boolean(await updateProgress(id, change)) : removeFromMyList(id);
    try {
      if (change) await api.put(`/api/anime/${id}/progress`, change, { fallback: t('Fortschritt konnte nicht gespeichert werden') });
      else await api.del(`/api/anime/${id}/progress`, { fallback: t('Konnte nicht von deiner Liste entfernt werden') });
      fetchAnime();
      return true;
    } catch (err) {
      notify.error(err);
      return false;
    }
  }, [fetchAnime, updateProgress, removeFromMyList]);

  const remove = useCallback(async (id) => {
    await api.del(`/api/anime/${id}`, { fallback: t('Anime konnte nicht gelöscht werden') });
    store(listRef.current.filter((a) => a.id !== id));
    return true;
  }, [store]);

  /** Manual refresh; the server allows one per 60 s and entry (429 with retry_after). */
  const refresh = useCallback(async (id) => {
    const detail = await api.post(`/api/anime/${id}/refresh`, undefined, { timeout: TIMEOUTS.lookup, fallback: t('Aktualisierung fehlgeschlagen') });
    replaceEntry(detail);
    fetchSources();
    return detail;
  }, [replaceEntry, fetchSources]);

  return {
    list, loaded, loading, error, cacheAt, fromCache, sources, listSync,
    fetchAnime, fetchSources, syncList, search, adaptations, add, update, fetchDetail, updateProgress, markWatched, undoWatched, removeFromMyList, remove, refresh
  };
}
