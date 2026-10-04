import { useState, useEffect, useMemo, useDeferredValue, useRef, useSyncExternalStore } from 'react';
import api, { apiFetch, getApiBase, readJson } from '../utils/api';
import { readCache, writeCache, touchCache, revalidateHeaders, volumeSearchMap, VOLUME_SEARCH_KEY } from '../utils/dataCache';
import { loadOfflineVolumeSearch } from '../utils/offlineStore';
import { publisherNamesVersion, setPublisherNames, subscribePublisherNames } from '../utils/volumeHelpers';
import {
  getAvailablePublishers, getFilterCounts, filterAndSortMangas, getCollectionTotals, getStatusTabs,
  sanitizePublisherFilter, isStatusFilter, isSortOption, isCollectFilter, isGroupOption, getCollectCounts, groupMangas,
  readFilterParams, writeFilterParams, getAvailableTags, parseTagFilter, formatTagFilter, withVolumeSearch
} from '../utils/collectionHelpers';

const readStored = (storage, key, fallback, isValid = () => true) => {
  try {
    const value = window[storage].getItem(key);
    return value && isValid(value) ? value : fallback;
  } catch (_) { return fallback; }
};

const writeStored = (storage, key, value) => {
  try { window[storage].setItem(key, value); } catch (_) {}
};

const PUBLISHER_NAMES_TTL_MS = 10 * 60 * 1000;
let publisherLoad = null;

/**
 * Loads the server's publisher names (GET /api/publishers) into normalizePubName, at most every 10 minutes per
 * server and user (`scope`); `force` reloads (after a merge). Without an answer the built-in names stay in use.
 */
export function loadPublisherNames({ scope = publisherLoad?.scope ?? '', force = false, now = Date.now() } = {}) {
  if (!force && publisherLoad?.scope === scope && now - publisherLoad.at < PUBLISHER_NAMES_TTL_MS) return publisherLoad.promise;
  if (publisherLoad && publisherLoad.scope !== scope) setPublisherNames(null);
  const record = { scope, at: now };
  record.promise = api.get('/api/publishers')
    .then((data) => {
      if (publisherLoad === record) setPublisherNames(data);
      return true;
    })
    .catch(() => {
      if (publisherLoad === record) publisherLoad = { ...record, at: 0 };
      return false;
    });
  publisherLoad = record;
  return record.promise;
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);
const volumeSearchLoads = new Map();

async function fetchVolumeSearch(owner) {
  const entry = readCache(owner, VOLUME_SEARCH_KEY);
  let res = null;
  try {
    res = await apiFetch('/api/mangas/volume-search', { headers: revalidateHeaders(entry) });
  } catch (_) {
    res = null;
  }
  if (res?.status === 304 && entry) return touchCache(owner, VOLUME_SEARCH_KEY)?.data ?? entry.data;
  if (res?.ok) {
    const rows = await readJson(res).catch(() => null);
    if (Array.isArray(rows)) return writeCache(owner, VOLUME_SEARCH_KEY, volumeSearchMap(rows), res.headers?.get?.('ETag')).data;
  }
  if (entry) return entry.data;
  // no answer: the offline copy carries the same text; any other refusal keeps what the list rows have
  if (res && !GATEWAY_STATUSES.has(res.status)) return null;
  const offline = volumeSearchMap(await loadOfflineVolumeSearch());
  return offline.size ? offline : null;
}

/**
 * The shelf's volume search index as a Map id -> text, or null. Revalidated with the ETag of the in-memory copy;
 * without a server answer the copy, else the offline copy. One request per owner at a time.
 */
export function loadVolumeSearch(owner) {
  const key = String(owner ?? '');
  let pending = volumeSearchLoads.get(key);
  if (!pending) {
    pending = fetchVolumeSearch(owner).catch(() => null).finally(() => volumeSearchLoads.delete(key));
    volumeSearchLoads.set(key, pending);
  }
  return pending;
}

const SEARCH_KEY = 'mangashelf_search';
const TAG_FILTER_KEY = 'mangashelf_tag_filter';
const userKey = (userId) => (userId === null || userId === undefined ? '' : String(userId));

/** The tab's remembered search, only when it was typed by the same user (another login in this tab starts empty). */
export function readStoredSearch(userId) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(SEARCH_KEY));
    return saved && typeof saved.search === 'string' && saved.user === userKey(userId) ? saved.search : '';
  } catch (_) {
    return '';
  }
}

/**
 * Series list state: search, filters, sort, grouping, view mode and the filtered results. Filters persist in
 * localStorage, the search per tab and user; with `url` they mirror into the query string (a URL value wins).
 */
export default function useCollectionFilters(mangas, { loading = false, userId = null, url = null } = {}) {
  const [fromUrl] = useState(() => (url ? readFilterParams(url.search) : {}));
  const [search, setSearch] = useState(() => readStoredSearch(userId));
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState(() => fromUrl.status ?? readStored('localStorage', 'mangashelf_status_filter', 'ALL', isStatusFilter));
  const [publisherFilter, setPublisherFilter] = useState(() => fromUrl.publisher ?? readStored('localStorage', 'mangashelf_publisher_filter', 'ALL'));
  const [collectFilter, setCollectFilter] = useState(() => fromUrl.collect ?? readStored('localStorage', 'mangashelf_collect_filter', 'ALL', isCollectFilter));
  const [authorFilter, setAuthorFilter] = useState(() => fromUrl.author ?? '');
  const [tagFilter, setTagFilter] = useState(() => parseTagFilter(fromUrl.tags ?? readStored('localStorage', TAG_FILTER_KEY, '')));
  const tagKey = formatTagFilter(tagFilter);
  const [sortBy, setSortBy] = useState(() => fromUrl.sort ?? readStored('localStorage', 'mangashelf_sort_by', 'title_asc', isSortOption));
  const [groupBy, setGroupBy] = useState(() => fromUrl.group ?? readStored('localStorage', 'mangashelf_group_by', 'none', isGroupOption));
  const [viewMode, setViewMode] = useState(() => readStored('localStorage', 'mangashelf_view_mode', 'grid', (v) => v === 'grid' || v === 'list'));

  useEffect(() => {
    writeStored('sessionStorage', SEARCH_KEY, JSON.stringify({ user: userKey(userId), search }));
  }, [search, userId]);

  // the volume search index loads with the first search (not with the list) and follows each new list
  const searching = search.trim() !== '';
  const [volumeIndex, setVolumeIndex] = useState(() => ({ owner: userKey(userId), map: readCache(userId, VOLUME_SEARCH_KEY)?.data ?? null }));
  useEffect(() => {
    if (!searching) return undefined;
    let active = true;
    const owner = userKey(userId);
    loadVolumeSearch(userId).then((map) => {
      if (active && map) setVolumeIndex((prev) => (prev.owner === owner && prev.map === map ? prev : { owner, map }));
    });
    return () => { active = false; };
  }, [searching, mangas, userId]);
  const indexMap = volumeIndex.owner === userKey(userId) ? volumeIndex.map : null;
  const searchable = useMemo(() => withVolumeSearch(mangas, indexMap), [mangas, indexMap]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_status_filter', statusFilter); }, [statusFilter]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_publisher_filter', publisherFilter); }, [publisherFilter]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_collect_filter', collectFilter); }, [collectFilter]);
  useEffect(() => { writeStored('localStorage', TAG_FILTER_KEY, tagKey); }, [tagKey]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_sort_by', sortBy); }, [sortBy]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_group_by', groupBy); }, [groupBy]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_view_mode', viewMode); }, [viewMode]);

  // the URL follows changes only: writing on mount would race the dashboard's own start-up navigations
  const urlRef = useRef(url);
  urlRef.current = url;
  const urlFilters = { status: statusFilter, publisher: publisherFilter, collect: collectFilter, author: authorFilter, tags: tagKey, sort: sortBy, group: groupBy };
  const filtersKey = JSON.stringify(urlFilters);
  const writtenKeyRef = useRef(filtersKey);
  useEffect(() => {
    if (filtersKey === writtenKeyRef.current) return;
    writtenKeyRef.current = filtersKey;
    const current = urlRef.current;
    if (!current) return;
    const next = writeFilterParams(current.search, JSON.parse(filtersKey));
    if (next !== (current.search || '')) current.replace(next);
  }, [filtersKey]);

  // a link to the open dashboard (?author=…) sets the filters it names
  const urlSearch = url ? url.search || '' : null;
  const seenSearchRef = useRef(urlSearch);
  useEffect(() => {
    if (urlSearch === null || urlSearch === seenSearchRef.current) return;
    seenSearchRef.current = urlSearch;
    const params = readFilterParams(urlSearch);
    if (params.status !== undefined) setStatusFilter(params.status);
    if (params.publisher !== undefined) setPublisherFilter(params.publisher);
    if (params.collect !== undefined) setCollectFilter(params.collect);
    if (params.author !== undefined) setAuthorFilter(params.author);
    if (params.tags !== undefined) setTagFilter(parseTagFilter(params.tags));
    if (params.sort !== undefined) setSortBy(params.sort);
    if (params.group !== undefined) setGroupBy(params.group);
  }, [urlSearch]);

  const publisherNames = useSyncExternalStore(subscribePublisherNames, publisherNamesVersion);
  useEffect(() => {
    if (userId !== null && userId !== undefined) loadPublisherNames({ scope: `${getApiBase()}|${userId}` });
  }, [userId]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- publisherNames: the server's names changed normalizePubName
  const availablePublishers = useMemo(() => getAvailablePublishers(mangas), [mangas, publisherNames]);
  const availableTags = useMemo(() => getAvailableTags(mangas), [mangas]);

  // an empty list is not checked: before the first load it would wipe a valid remembered filter
  useEffect(() => {
    if (loading || mangas.length === 0) return;
    const next = sanitizePublisherFilter(publisherFilter, availablePublishers);
    if (next !== publisherFilter) setPublisherFilter(next);
  }, [loading, mangas.length, availablePublishers, publisherFilter]);

  const filterCounts = useMemo(() => getFilterCounts(mangas), [mangas]);
  const collectCounts = useMemo(() => getCollectCounts(mangas), [mangas]);
  const statusTabs = useMemo(() => getStatusTabs(filterCounts, statusFilter), [filterCounts, statusFilter]);
  const { filtered, groups } = useMemo(() => {
    const list = filterAndSortMangas(searchable, { search: deferredSearch, statusFilter, publisherFilter, sortBy, collectFilter, authorFilter, tagFilter: tagKey });
    const sections = groupMangas(list, groupBy);
    return { filtered: sections.length > 1 ? sections.flatMap(s => s.items) : list, groups: sections };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- publisherNames as above
  }, [searchable, deferredSearch, statusFilter, publisherFilter, sortBy, collectFilter, authorFilter, tagKey, groupBy, publisherNames]);
  const totalSeries = mangas.length;
  const { totalOwnedVolumes, totalCollectionValue, completedSeries } = useMemo(() => getCollectionTotals(mangas), [mangas]);

  return {
    search, setSearch, deferredSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy, viewMode, setViewMode,
    collectFilter, setCollectFilter, authorFilter, setAuthorFilter, tagFilter, setTagFilter, availableTags, groupBy, setGroupBy,
    collectCounts, groups, availablePublishers, filterCounts, statusTabs, filtered, totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries
  };
}
