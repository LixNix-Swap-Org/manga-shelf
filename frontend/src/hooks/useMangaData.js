import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadMangaDetail, updateCachedManga, syncOfflineCopy } from '../utils/offlineStore';
import { prefillTotalVolumes } from '../utils/scanHelpers';
import { readApiError, UPLOAD_CANCELLED, notifyTrashed } from './useVolumeActions';
import { apiFetch, errorFromResponse, isAbortError, readJson, TIMEOUTS } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import {
  readCache, writeCache, touchCache, dropCache, revalidateHeaders, cacheOwner, detailKey, LIST_KEY
} from '../utils/dataCache';
import useLatestRequest from './useLatestRequest';
import { prepareImageForUpload } from '../utils/imageResize';
import { DEFAULT_WISH_PRIORITY, normalizeWishPriority } from '../utils/priority';
import { t } from '../i18n/index.js';
import { editionCurrency, editionLanguage, editionRegion, isMpEdition } from '../utils/editions';

// i18n
export const MANGA_STATUSES = ['Laufend', 'Abgeschlossen', 'Pausiert', 'Abgebrochen', 'Geplant'];

/** A catalogue status the form can show; 'Unbekannt', empty or anything else keeps the previous value. */
export function normalizeLookupStatus(status, previous) {
  return MANGA_STATUSES.includes(status) ? status : previous;
}

export function buildFormData(data) {
  return {
    title: data.title || '',
    alt_title: data.alt_title || '',
    author: data.author || '',
    publisher: data.publisher || '',
    // edition language/region/currency as ISO codes (an old name such as 'Deutsch' reads as 'de')
    language: editionLanguage(data),
    region: editionRegion(data) || '',
    currency: editionCurrency(data),
    // stored value (mangas.status), shown through its label
    status: data.status || 'Laufend', // i18n-ignore
    tags: data.tags || '',
    total_volumes: data.total_volumes || '',
    description: data.description || '',
    cover_image: data.cover_image || '',
    manga_passion_id: data.manga_passion_id || null,
    wish: normalizeWishPriority(data.wish_priority) !== null,
    wish_priority: String(normalizeWishPriority(data.wish_priority) ?? DEFAULT_WISH_PRIORITY)
  };
}

/** Metadata search; the server searches Manga Passion only for German editions ('de' is its default, so it is not sent). */
export const lookupMangaUrl = (title, language) =>
  `/api/lookup/manga?q=${encodeURIComponent(title)}${language && language !== 'de' ? `&language=${encodeURIComponent(language)}` : ''}`;

/** PUT body of the edit form: the wishlist toggle and its priority become wish_priority (null = not wished). */
export function updateBody(changed, form) {
  const { wish, wish_priority: _priority, ...body } = changed;
  if (wish !== undefined || _priority !== undefined) {
    body.wish_priority = form.wish ? Number(form.wish_priority) : null;
  }
  if (body.region !== undefined) body.region = body.region || null;
  return body;
}

/** Form values after applying a metadata lookup hit; a running series keeps its total (the catalogue only counts released volumes). */
export function mergeEditLookup(prev, item, coverUrl) {
  return {
    ...prev,
    title: item.title || prev.title,
    alt_title: item.alt_title || prev.alt_title,
    author: item.author || prev.author,
    publisher: (item.publisher && item.publisher !== 'Unbekannt') ? item.publisher : prev.publisher,
    status: normalizeLookupStatus(item.status, prev.status),
    total_volumes: prefillTotalVolumes(item, prev.total_volumes),
    tags: String(prev.tags ?? '').trim() ? prev.tags : (item.tags || prev.tags),
    description: item.description || prev.description,
    cover_image: coverUrl || prev.cover_image,
    manga_passion_id: item.manga_passion_id || prev.manga_passion_id
  };
}

export function isFormDirty(base, current) {
  if (!base || !current) return false;
  const keys = new Set([...Object.keys(base), ...Object.keys(current)]);
  for (const key of keys) {
    if (String(base[key] ?? '') !== String(current[key] ?? '')) return true;
  }
  return false;
}

/** The fields the user changed since the form was opened; a refresh meanwhile (edition sync) must not be sent back. */
export function changedFormFields(base, current) {
  const changed = {};
  for (const [key, value] of Object.entries(current || {})) {
    if (String(base?.[key] ?? '') !== String(value ?? '')) changed[key] = value;
  }
  return changed;
}

export const seriesDeleteConfirmText = (title) =>
  t('Möchtest du "{title}" wirklich löschen? Die Reihe kommt mit allen Bänden in den Papierkorb (30 Tage wiederherstellbar).', { title });

/** "Genres nachladen": only for a German series linked to Manga Passion that has no tags yet (MP knows only German editions). */
export const canFillTags = (manga) => isMpEdition(manga) && Boolean(manga?.manga_passion_id) && !String(manga?.tags ?? '').trim();

// i18n
const REFRESH_FAILED = 'Aktualisierung fehlgeschlagen: Der Server ist gerade nicht erreichbar. Angezeigt wird der letzte Stand.';
// i18n
const SHOWING_OFFLINE_COPY = 'Server nicht erreichbar: Angezeigt wird die Offline-Kopie.';
// i18n
const SESSION_EXPIRED = 'Sitzung abgelaufen. Bitte melde dich neu an.';

/**
 * Loads one manga (server, else the offline copy) and owns its edit form, cover upload and Manga-Passion metadata lookup.
 * loadError (nothing to show): 'server' | 'offline-missing' | 'unauthorized'. refreshError: a failed reload while data is shown.
 */
export default function useMangaData({ id, user, canEdit, onUnauthorized }) {
  const navigate = useNavigate();

  const owner = cacheOwner(user);
  // the in-memory copy (a series seen before) renders at once and is revalidated by fetchManga
  const [initial] = useState(() => readCache(owner, detailKey(id)));
  const [manga, setManga] = useState(() => initial?.data ?? null);
  const [loading, setLoading] = useState(() => !initial);
  const loadedIdRef = useRef(initial ? id : null); // the series shown right now: reloads after an action keep the page (no spinner, scroll stays)
  const mangaRef = useRef(initial?.data ?? null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const beginRequest = useLatestRequest();
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [refreshError, setRefreshError] = useState(null);
  const [editing, setEditingState] = useState(false);
  const editingRef = useRef(false); // read by async refreshes, whose closures hold an old `editing`
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState(() => (initial ? buildFormData(initial.data) : {}));
  const formBaseRef = useRef(null); // the values the form was opened with
  if (formBaseRef.current === null && initial) formBaseRef.current = buildFormData(initial.data);
  const [uploadingCover, setUploadingCover] = useState(false);
  // the upload itself can still be cancelled; once its answer is in, the cover is stored and the button goes away
  const [coverCancellable, setCoverCancellable] = useState(false);
  const [failedCover, setFailedCover] = useState(false);

  const [editLookingUp, setEditLookingUp] = useState(false);
  const [editLookupResults, setEditLookupResults] = useState(null);
  const [editLookupError, setEditLookupError] = useState('');
  const editSessionRef = useRef(0); // a lookup or upload that finishes after cancel must not write into the next form

  const seedForm = (data) => {
    const base = buildFormData(data || {});
    formBaseRef.current = base;
    setFormData(base);
  };

  const resetLookup = () => {
    setEditLookupResults(null);
    setEditLookupError('');
    setEditLookingUp(false);
  };

  const startEditing = () => {
    if (!canEdit) return;
    editSessionRef.current++;
    seedForm(mangaRef.current);
    resetLookup();
    editingRef.current = true;
    setEditingState(true);
  };

  const cancelEditing = () => {
    editSessionRef.current++;
    editingRef.current = false;
    setEditingState(false);
    seedForm(mangaRef.current);
    resetLookup();
  };

  const setEditing = (value) => (value ? startEditing() : cancelEditing());

  const isEditDirty = editing && isFormDirty(formBaseRef.current, formData);

  const handleUnauthorized = () => {
    if (onUnauthorized) onUnauthorized();
    else notify.error(t(SESSION_EXPIRED));
  };

  const handleEditLookup = async () => {
    const title = String(formData.title || '').trim();
    if (!title) {
      setEditLookupError(t('Bitte gib zuerst einen Titel ein.'));
      return;
    }
    const session = editSessionRef.current;
    setEditLookingUp(true);
    setEditLookupError('');
    setEditLookupResults(null);
    try {
      const res = await apiFetch(lookupMangaUrl(title, formData.language), { timeout: TIMEOUTS.lookup });
      if (session !== editSessionRef.current) return;
      if (res.ok) {
        const data = await readJson(res);
        if (data === null) throw new Error(t('Antwort ist kein JSON'));
        if (session !== editSessionRef.current) return;
        if (data && data.length > 0) {
          if (data.length === 1) {
            await applyEditLookupResult(data[0]);
          } else {
            setEditLookupResults(data);
          }
        } else {
          setEditLookupError(t('Keine Treffer gefunden.'));
        }
      } else if (res.status === 401) {
        handleUnauthorized();
      } else {
        setEditLookupError(await readApiError(res, t('Fehler bei der Suche')));
      }
    } catch (e) {
      if (session === editSessionRef.current) {
        setEditLookupError(e?.code === 'TIMEOUT' ? t('Die Suche hat zu lange gedauert.') : t('Netzwerkfehler'));
      }
    } finally {
      if (session === editSessionRef.current) setEditLookingUp(false);
    }
  };

  const applyEditLookupResult = async (item) => {
    const session = editSessionRef.current;
    let localCoverUrl = item.cover_image;
    if (item.cover_image && item.cover_image.startsWith('http')) {
      try {
        const upRes = await apiFetch('/api/upload-remote', {
          method: 'POST',
          body: { url: item.cover_image },
          timeout: TIMEOUTS.remote
        });
        if (upRes.ok) {
          const upData = await readJson(upRes);
          if (upData?.url) localCoverUrl = upData.url;
        }
      } catch (e) {
        console.warn('Could not cache remote cover locally, using remote URL:', e);
      }
    }
    if (session !== editSessionRef.current) return;

    setFormData(prev => mergeEditLookup(prev, item, localCoverUrl));
    setEditLookupResults(null);
    setEditLookupError('');
  };

  const applyMangaData = (data) => {
    const idChanged = loadedIdRef.current !== id;
    if (mangaRef.current?.cover_image !== data.cover_image) setFailedCover(false);
    loadedIdRef.current = id;
    mangaRef.current = data;
    setManga(data);
    setNotFound(false);
    setLoadError(null);
    if (idChanged && editingRef.current) {
      editSessionRef.current++;
      editingRef.current = false;
      setEditingState(false);
      resetLookup();
    }
    // a refresh while the form is open (volume toggle, cover upload) must not wipe what the user typed
    if (!editingRef.current) seedForm(data);
  };

  const fetchManga = async () => {
    const { signal, isCurrent: isLatest } = beginRequest();
    const key = detailKey(id);
    let showing = loadedIdRef.current === id && mangaRef.current !== null;
    if (!showing) {
      const copy = readCache(ownerRef.current, key);
      if (copy) {
        applyMangaData(copy.data);
        setLoading(false);
        showing = true;
      } else {
        setLoading(true);
        setNotFound(false);
        setLoadError(null);
      }
    }
    try {
      if (!user?.offline) {
        const entry = readCache(ownerRef.current, key);
        const conditional = Boolean(entry) && entry.data === mangaRef.current;
        let res = null;
        try {
          res = await apiFetch(`/api/mangas/${id}`, { signal, headers: conditional ? revalidateHeaders(entry) : undefined });
        } catch (e) {
          if (!isLatest()) return;
          console.warn('Manga fetch failed:', e);
        }
        if (!isLatest()) return;
        if (res && res.status === 304 && conditional) {
          touchCache(ownerRef.current, key);
          setRefreshError(null);
          return;
        }
        if (res && res.ok) {
          const data = await readJson(res);
          if (!isLatest()) return;
          if (data) {
            writeCache(ownerRef.current, key, data, res.headers?.get?.('ETag'));
            applyMangaData(data);
            setRefreshError(null);
            updateCachedManga(data);
            return;
          }
        } else if (res && res.status === 404) {
          dropCache(ownerRef.current, key);
          setNotFound(true);
          return;
        } else if (res && res.status === 401) {
          if (onUnauthorized) onUnauthorized();
          if (showing) setRefreshError(t(SESSION_EXPIRED));
          else setLoadError('unauthorized');
          return;
        }
        // 5xx (restore running, proxy while the server restarts), a non-JSON answer or no connection
        if (showing) {
          setRefreshError(t(REFRESH_FAILED));
          return;
        }
      }
      const cached = await loadMangaDetail(id);
      if (!isLatest()) return;
      if (cached) {
        applyMangaData(cached);
        if (!user?.offline) setRefreshError(t(SHOWING_OFFLINE_COPY));
      } else {
        setLoadError(user?.offline ? 'offline-missing' : 'server');
      }
    } finally {
      if (isLatest()) setLoading(false);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    const body = updateBody(changedFormFields(formBaseRef.current, formData), formData);
    const closeForm = () => {
      editSessionRef.current++;
      editingRef.current = false;
      setEditingState(false);
      resetLookup();
    };
    if (Object.keys(body).length === 0) {
      closeForm();
      seedForm(mangaRef.current);
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/mangas/${id}`, { method: 'PUT', body });
      if (res.ok) {
        closeForm();
        await fetchManga();
      } else if (res.status === 401) {
        handleUnauthorized();
      } else {
        await notifyResponseError(res, t('Fehler beim Speichern'));
      }
    } catch (err) {
      notify.error(err);
    } finally {
      setSaving(false);
    }
  };

  // the shelf's in-memory list would otherwise show the deleted series until its refresh answers
  const forgetSeries = () => {
    dropCache(ownerRef.current, detailKey(id));
    const list = readCache(ownerRef.current, LIST_KEY);
    if (list) writeCache(ownerRef.current, LIST_KEY, list.data.filter((m) => String(m.id) !== String(id)));
  };

  const handleDeleteManga = async () => {
    if (!canEdit || !manga) return;
    if (!confirm(seriesDeleteConfirmText(manga.title))) return;
    const { title } = manga;
    const seriesId = id;
    try {
      const res = await apiFetch(`/api/mangas/${id}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        if (res.status === 404) notify.info((await errorFromResponse(res, t('Die Reihe wurde bereits gelöscht'))).message);
        const trashId = res.ok ? (await readJson(res))?.trash_id : null;
        forgetSeries();
        // the offline copy would otherwise list the deleted series until the next throttled sync
        syncOfflineCopy({ force: true });
        navigate('/');
        // the page is gone by then: a restored series opens again
        notifyTrashed(`„${title}“`, trashId, (ok) => {
          if (!ok) return;
          syncOfflineCopy({ force: true });
          navigate(`/manga/${seriesId}`);
        });
      } else if (res.status === 401) {
        handleUnauthorized();
      } else {
        await notifyResponseError(res, t('Fehler beim Löschen'));
      }
    } catch (err) {
      notify.error(err);
    }
  };

  const coverAbortRef = useRef(null);
  useEffect(() => () => {
    const running = coverAbortRef.current;
    coverAbortRef.current = null;
    running?.abort();
  }, []);

  /** Cancels a running cover upload ("Upload abbrechen"); returned only while the upload request runs. */
  const cancelCoverUpload = () => coverAbortRef.current?.abort();

  /** While the form is open the new cover only goes into the form ('Speichern' stores it, 'Abbrechen' drops it). */
  const handleCoverUpload = async (e) => {
    if (!canEdit) return;
    const file = e.target.files[0];
    if (!file) return;
    const deferred = editingRef.current;
    const session = editSessionRef.current;
    coverAbortRef.current?.abort();
    const controller = new AbortController();
    coverAbortRef.current = controller;

    setUploadingCover(true);
    setCoverCancellable(true);
    try {
      const fd = new FormData();
      fd.append('image', await prepareImageForUpload(file));
      if (controller.signal.aborted) throw new DOMException(UPLOAD_CANCELLED, 'AbortError');
      const res = await apiFetch('/api/upload', { method: 'POST', body: fd, signal: controller.signal });
      if (!res.ok) {
        if (res.status === 401) handleUnauthorized();
        else await notifyResponseError(res, t('Fehler beim Hochladen des Covers'));
        return;
      }
      const data = await readJson(res);
      if (controller.signal.aborted) throw new DOMException(UPLOAD_CANCELLED, 'AbortError');
      if (coverAbortRef.current === controller) setCoverCancellable(false);
      if (!data?.url) throw new Error(t('Antwort ohne Bild-URL'));
      if (deferred) {
        if (session === editSessionRef.current && editingRef.current) {
          setFormData(prev => ({ ...prev, cover_image: data.url }));
        }
        return;
      }
      const saveRes = await apiFetch(`/api/mangas/${id}`, { method: 'PUT', body: { cover_image: data.url }, signal: controller.signal });
      if (!saveRes.ok) {
        if (saveRes.status === 401) handleUnauthorized();
        else await notifyResponseError(saveRes, t('Das Cover konnte nicht gespeichert werden'));
        return;
      }
      await fetchManga();
    } catch (err) {
      if (!isAbortError(err) && !controller.signal.aborted) notify.error(err, { fallback: t('Fehler beim Hochladen des Covers') });
      else if (coverAbortRef.current === controller) notify.info(t(UPLOAD_CANCELLED));
    } finally {
      if (coverAbortRef.current === controller) {
        coverAbortRef.current = null;
        setUploadingCover(false);
        setCoverCancellable(false);
      }
    }
  };

  const [fillingTags, setFillingTags] = useState(false);
  const fillingTagsRef = useRef(false);
  /** "Genres nachladen": POST sync-edition { tags_only } fills empty tags from the linked edition (cache first). */
  const handleFillTags = async () => {
    if (!canEdit || fillingTagsRef.current || !canFillTags(mangaRef.current)) return;
    fillingTagsRef.current = true;
    setFillingTags(true);
    try {
      const res = await apiFetch(`/api/mangas/${id}/sync-edition`, { method: 'POST', body: { tags_only: true }, timeout: TIMEOUTS.lookup });
      if (res.ok) {
        const data = (await readJson(res)) ?? {};
        if (data.updated) notify.success(t('Genres übernommen: {tags}', { tags: data.tags }));
        else if (!data.tags) notify.info(t('Manga Passion nennt für diese Ausgabe keine Genres.'));
        await fetchManga();
      } else if (res.status === 401) {
        handleUnauthorized();
      } else {
        await notifyResponseError(res, t('Genres konnten nicht geladen werden'));
      }
    } catch (err) {
      notify.error(err, { fallback: t('Genres konnten nicht geladen werden') });
    } finally {
      fillingTagsRef.current = false;
      setFillingTags(false);
    }
  };

  return {
    manga, loading, notFound, loadError, refreshError, clearRefreshError: () => setRefreshError(null),
    editing, setEditing, startEditing, cancelEditing, isEditDirty, saving, formData, setFormData,
    uploadingCover, failedCover, setFailedCover,
    editLookingUp, editLookupResults, setEditLookupResults, editLookupError,
    applyEditLookupResult, handleEditLookup,
    patchManga: (fn) => setManga((prev) => (prev ? fn(prev) : prev)),
    fetchManga, handleUpdate, handleDeleteManga, handleCoverUpload,
    canFillTags: Boolean(canEdit) && !user?.offline && canFillTags(manga), fillingTags, handleFillTags,
    cancelCoverUpload: coverCancellable ? cancelCoverUpload : undefined
  };
}
