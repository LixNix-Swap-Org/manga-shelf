import { useState, useEffect, useCallback, useMemo, useDeferredValue, useRef, useSyncExternalStore } from 'react';
import api, { apiFetch, getApiBase, readJson } from '../utils/api';
import { invalidateShelves, readShelfFilter, writeShelfFilter } from '../utils/shelfScope';
import { useShelves } from './useShelfViewer';
import { readCache, writeCache, touchCache, revalidateHeaders, volumeSearchMap, VOLUME_SEARCH_KEY } from '../utils/dataCache';
import { loadOfflineVolumeSearch } from '../utils/offlineStore';
import { publisherNamesVersion, setPublisherNames, subscribePublisherNames } from '../utils/volumeHelpers';
import {
  getAvailablePublishers, getFilterCounts, filterAndSortMangas, getCollectionTotals, getStatusTabs,
  sanitizePublisherFilter, isStatusFilter, isSortOption, isCollectFilter, isGroupOption, getCollectCounts, groupMangas,
  readFilterParams, writeFilterParams, getAvailableTags, parseTagFilter, formatTagFilter, withVolumeSearch, isLanguageFilter, getOtherCurrencyTotals, getAvailableShelves
} from '../utils/collectionHelpers';
import { availableLanguages as collectLanguages } from '../utils/editions';

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
  let res;
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
const LANGUAGE_FILTER_KEY = 'mangashelf_language_filter';
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
export default function useCollectionFilters(mangas, { loading = false, userId = null, url = null, shelvesEnabled = true, loadShelfRoles = false } = {}) {
  const [fromUrl] = useState(() => (url ? readFilterParams(url.search) : {}));
  const [search, setSearch] = useState(() => readStoredSearch(userId));
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState(() => fromUrl.status ?? readStored('localStorage', 'mangashelf_status_filter', 'ALL', isStatusFilter));
  const [publisherFilter, setPublisherFilter] = useState(() => fromUrl.publisher ?? readStored('localStorage', 'mangashelf_publisher_filter', 'ALL'));
  const [collectFilter, setCollectFilter] = useState(() => fromUrl.collect ?? readStored('localStorage', 'mangashelf_collect_filter', 'ALL', isCollectFilter));
  const [authorFilter, setAuthorFilter] = useState(() => fromUrl.author ?? '');
  const [tagFilter, setTagFilter] = useState(() => parseTagFilter(fromUrl.tags ?? readStored('localStorage', TAG_FILTER_KEY, '')));
  const tagKey = formatTagFilter(tagFilter);
  const [languageFilter, setLanguageFilter] = useState(() => fromUrl.lang ?? readStored('localStorage', LANGUAGE_FILTER_KEY, 'ALL', isLanguageFilter));
  // the shelf is remembered per server and account; another account on this device starts with every shelf
  const shelfOwner = userKey(userId);
  const [shelfPick, setShelfPick] = useState(() => ({ owner: shelfOwner, value: readShelfFilter(userId) }));
  if (shelfPick.owner !== shelfOwner) setShelfPick({ owner: shelfOwner, value: readShelfFilter(userId) });
  const shelfFilter = shelfPick.owner === shelfOwner ? shelfPick.value : 'ALL';
  const setShelfFilter = useCallback((value) => setShelfPick((prev) => ({ ...prev, value: String(value) })), []);
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
  useEffect(() => { writeStored('localStorage', LANGUAGE_FILTER_KEY, languageFilter); }, [languageFilter]);
  const shelfWrittenRef = useRef(shelfPick);
  useEffect(() => {
    if (shelfWrittenRef.current === shelfPick) return;
    shelfWrittenRef.current = shelfPick;
    if (shelfPick.owner === shelfOwner) writeShelfFilter(userId, shelfPick.value);
  }, [shelfPick, shelfOwner, userId]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_sort_by', sortBy); }, [sortBy]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_group_by', groupBy); }, [groupBy]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_view_mode', viewMode); }, [viewMode]);

  // the URL follows changes only: writing on mount would race the dashboard's own start-up navigations
  const urlRef = useRef(url);
  urlRef.current = url;
  const urlFilters = { status: statusFilter, publisher: publisherFilter, collect: collectFilter, author: authorFilter, tags: tagKey, lang: languageFilter, sort: sortBy, group: groupBy };
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
    if (params.lang !== undefined) setLanguageFilter(params.lang);
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
  const availableLanguages = useMemo(() => collectLanguages(mangas), [mangas]);
  // shelves: the chip shows only when the rows come from more than one; names and roles come from the shared shelf list
  // (GET /api/shelves), which reloads after a shelf change and once more when the rows name a shelf it does not know
  const shelfCounts = useMemo(() => getAvailableShelves(mangas), [mangas]);
  const shelves = useShelves(userId, shelvesEnabled && (loadShelfRoles || shelfCounts.length > 1 || shelfFilter !== 'ALL'));
  const unknownShelves = Array.isArray(shelves) ? shelfCounts.filter((s) => !shelves.some((known) => known.id === s.id)).map((s) => s.id).join(',') : '';
  const askedForRef = useRef('');
  useEffect(() => {
    if (!unknownShelves || askedForRef.current === unknownShelves) return;
    askedForRef.current = unknownShelves;
    invalidateShelves();
  }, [unknownShelves]);
  const availableShelves = useMemo(() => shelfCounts.map((s) => ({
    ...s, name: (Array.isArray(shelves) && shelves.find((known) => known.id === s.id)?.name) || `#${s.id}`
  })), [shelfCounts, shelves]);

  // an empty list is not checked: before the first load it would wipe a valid remembered filter
  useEffect(() => {
    if (loading || mangas.length === 0) return;
    const next = sanitizePublisherFilter(publisherFilter, availablePublishers);
    if (next !== publisherFilter) setPublisherFilter(next);
  }, [loading, mangas.length, availablePublishers, publisherFilter]);
  // a remembered language no series has any more would hide the whole shelf
  useEffect(() => {
    if (loading || mangas.length === 0 || languageFilter === 'ALL') return;
    if (!availableLanguages.some((l) => l.code === languageFilter)) setLanguageFilter('ALL');
  }, [loading, mangas.length, availableLanguages, languageFilter]);

  // a remembered shelf the user no longer sees would hide the whole shelf
  useEffect(() => {
    if (loading || mangas.length === 0 || shelfFilter === 'ALL') return;
    if (!shelfCounts.some((s) => String(s.id) === shelfFilter)) setShelfFilter('ALL');
  }, [loading, mangas.length, shelfCounts, shelfFilter, setShelfFilter]);

  const filterCounts = useMemo(() => getFilterCounts(mangas), [mangas]);
  const collectCounts = useMemo(() => getCollectCounts(mangas), [mangas]);
  const statusTabs = useMemo(() => getStatusTabs(filterCounts, statusFilter), [filterCounts, statusFilter]);
  const { filtered, groups } = useMemo(() => {
    const list = filterAndSortMangas(searchable, { search: deferredSearch, statusFilter, publisherFilter, sortBy, collectFilter, authorFilter, tagFilter: tagKey, languageFilter, shelfFilter });
    const sections = groupMangas(list, groupBy);
    return { filtered: sections.length > 1 ? sections.flatMap(s => s.items) : list, groups: sections };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- publisherNames as above
  }, [searchable, deferredSearch, statusFilter, publisherFilter, sortBy, collectFilter, authorFilter, tagKey, languageFilter, shelfFilter, groupBy, publisherNames]);
  const totalSeries = mangas.length;
  const { totalOwnedVolumes, totalCollectionValue, completedSeries } = useMemo(() => getCollectionTotals(mangas), [mangas]);
  const otherCurrencyTotals = useMemo(() => getOtherCurrencyTotals(mangas), [mangas]);

  return {
    search, setSearch, deferredSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy, viewMode, setViewMode,
    collectFilter, setCollectFilter, authorFilter, setAuthorFilter, tagFilter, setTagFilter, availableTags, groupBy, setGroupBy,
    languageFilter, setLanguageFilter, availableLanguages, shelfFilter, setShelfFilter, availableShelves, shelves, otherCurrencyTotals,
    collectCounts, groups, availablePublishers, filterCounts, statusTabs, filtered, totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries
  };
}
