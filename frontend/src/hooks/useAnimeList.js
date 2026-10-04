import { useState, useCallback, useRef, useEffect } from 'react';
import api, { isAbortError, TIMEOUTS } from '../utils/api';
import { notify } from '../utils/notify';
import { getClearGeneration } from '../utils/offlineStore';
import {
  readAnimeCache, writeAnimeCache, withProgress, predictProgress
} from '../utils/animeHelpers';
import useLatestRequest from './useLatestRequest';

/**
 * The anime tab: shared list with my progress (GET /api/anime), the sources state and the actions. Offline (or when
 * the server is unreachable) the last list comes from localStorage and nothing can be changed.
 */
export default function useAnimeList({ user }) {
  const userId = user?.id ?? null;
  const offline = Boolean(user?.offline);
  const [list, setList] = useState(() => readAnimeCache(userId)?.list || []);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cacheAt, setCacheAt] = useState(() => readAnimeCache(userId)?.timestamp || null);
  const [fromCache, setFromCache] = useState(false);
  const [sources, setSources] = useState(null);
  const beginList = useLatestRequest();
  const beginSources = useLatestRequest();
  const listRef = useRef(list);
  listRef.current = list;

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
      const data = await api.get('/api/anime', { signal, fallback: 'Anime-Liste konnte nicht geladen werden' });
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
      setError(err.message || 'Anime-Liste konnte nicht geladen werden');
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
    const data = await api.get(`/api/anime/search?q=${encodeURIComponent(q)}`, { signal, timeout: TIMEOUTS.lookup, fallback: 'Suche fehlgeschlagen' });
    fetchSources();
    return data;
  }, [fetchSources]);

  /** Anime adaptations of a series: { results, source, cached }. */
  const adaptations = useCallback((mangaId, { signal } = {}) => api.get(`/api/mangas/${mangaId}/adaptations`, { signal, timeout: TIMEOUTS.lookup, fallback: 'Adaptionen konnten nicht geladen werden' }), []);

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
    const detail = await api.post('/api/anime', body, { timeout: TIMEOUTS.lookup, fallback: 'Anime konnte nicht hinzugefügt werden' });
    replaceEntry(detail);
    return detail;
  }, [replaceEntry]);

  const update = useCallback(async (id, body) => {
    const detail = await api.put(`/api/anime/${id}`, body, { fallback: 'Änderung konnte nicht gespeichert werden' });
    replaceEntry(detail);
    return detail;
  }, [replaceEntry]);

  const fetchDetail = useCallback((id, { signal } = {}) => api.get(`/api/anime/${id}`, { signal, fallback: 'Anime konnte nicht geladen werden' }), []);

  /** Optimistic: the list shows the predicted state at once and goes back when the server refuses. */
  const updateProgress = useCallback(async (id, change) => {
    const before = listRef.current.find((a) => a.id === id);
    if (!before) return null;
    const predicted = predictProgress(before.my_progress, change, before.episodes);
    setList((cur) => cur.map((a) => (a.id === id ? withProgress(a, predicted, user) : a)));
    try {
      const saved = await api.put(`/api/anime/${id}/progress`, change, { fallback: 'Fortschritt konnte nicht gespeichert werden' });
      store(listRef.current.map((a) => (a.id === id ? withProgress(a, saved, user) : a)));
      return saved;
    } catch (err) {
      setList((cur) => cur.map((a) => (a.id === id ? before : a)));
      notify.error(err, { fallback: 'Fortschritt konnte nicht gespeichert werden' });
      return null;
    }
  }, [store, user]);

  const removeFromMyList = useCallback(async (id) => {
    const before = listRef.current.find((a) => a.id === id);
    if (!before) return false;
    setList((cur) => cur.map((a) => (a.id === id ? withProgress(a, null, user) : a)));
    try {
      await api.del(`/api/anime/${id}/progress`, { fallback: 'Konnte nicht von deiner Liste entfernt werden' });
      store(listRef.current);
      return true;
    } catch (err) {
      setList((cur) => cur.map((a) => (a.id === id ? before : a)));
      notify.error(err);
      return false;
    }
  }, [store, user]);

  const remove = useCallback(async (id) => {
    await api.del(`/api/anime/${id}`, { fallback: 'Anime konnte nicht gelöscht werden' });
    store(listRef.current.filter((a) => a.id !== id));
    return true;
  }, [store]);

  /** Manual refresh; the server allows one per 60 s and entry (429 with retry_after). */
  const refresh = useCallback(async (id) => {
    const detail = await api.post(`/api/anime/${id}/refresh`, undefined, { timeout: TIMEOUTS.lookup, fallback: 'Aktualisierung fehlgeschlagen' });
    replaceEntry(detail);
    fetchSources();
    return detail;
  }, [replaceEntry, fetchSources]);

  return {
    list, loaded, loading, error, cacheAt, fromCache, sources,
    fetchAnime, fetchSources, search, adaptations, add, update, fetchDetail, updateProgress, removeFromMyList, remove, refresh
  };
}
