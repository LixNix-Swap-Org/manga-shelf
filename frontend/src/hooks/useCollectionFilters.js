import { useState, useEffect, useMemo, useDeferredValue, useRef } from 'react';
import {
  getAvailablePublishers, getFilterCounts, filterAndSortMangas, getCollectionTotals, getStatusTabs,
  sanitizePublisherFilter, isStatusFilter, isSortOption, isCollectFilter, isGroupOption, getCollectCounts, groupMangas,
  readFilterParams, writeFilterParams
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

const SEARCH_KEY = 'mangashelf_search';
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
 * Search, status / publisher / collect / author filter, sort, grouping and view mode of the series list plus the results.
 * Filters, sort, grouping and view are remembered in localStorage; the search only for this tab and user
 * (sessionStorage), so it survives a visit to a series. With `url` ({ search, replace(search) }) the filters are also
 * mirrored into the query string (status, publisher, collect, author, sort, group): a value in the URL wins over the
 * remembered one, and later changes replace the current history entry. Pass loading while the list is (re)fetched:
 * a remembered publisher that is not in the loaded list is reset to 'ALL'. The list follows typing a moment later
 * (deferredSearch), so the input stays responsive with large collections.
 */
export default function useCollectionFilters(mangas, { loading = false, userId = null, url = null } = {}) {
  const [fromUrl] = useState(() => (url ? readFilterParams(url.search) : {}));
  const [search, setSearch] = useState(() => readStoredSearch(userId));
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState(() => fromUrl.status ?? readStored('localStorage', 'mangashelf_status_filter', 'ALL', isStatusFilter));
  const [publisherFilter, setPublisherFilter] = useState(() => fromUrl.publisher ?? readStored('localStorage', 'mangashelf_publisher_filter', 'ALL'));
  const [collectFilter, setCollectFilter] = useState(() => fromUrl.collect ?? readStored('localStorage', 'mangashelf_collect_filter', 'ALL', isCollectFilter));
  const [authorFilter, setAuthorFilter] = useState(() => fromUrl.author ?? '');
  const [sortBy, setSortBy] = useState(() => fromUrl.sort ?? readStored('localStorage', 'mangashelf_sort_by', 'title_asc', isSortOption));
  const [groupBy, setGroupBy] = useState(() => fromUrl.group ?? readStored('localStorage', 'mangashelf_group_by', 'none', isGroupOption));
  const [viewMode, setViewMode] = useState(() => readStored('localStorage', 'mangashelf_view_mode', 'grid', (v) => v === 'grid' || v === 'list'));

  useEffect(() => {
    writeStored('sessionStorage', SEARCH_KEY, JSON.stringify({ user: userKey(userId), search }));
  }, [search, userId]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_status_filter', statusFilter); }, [statusFilter]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_publisher_filter', publisherFilter); }, [publisherFilter]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_collect_filter', collectFilter); }, [collectFilter]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_sort_by', sortBy); }, [sortBy]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_group_by', groupBy); }, [groupBy]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_view_mode', viewMode); }, [viewMode]);

  // the URL follows changes only: writing on mount would race the dashboard's own start-up navigations
  const urlRef = useRef(url);
  urlRef.current = url;
  const urlFilters = { status: statusFilter, publisher: publisherFilter, collect: collectFilter, author: authorFilter, sort: sortBy, group: groupBy };
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
    if (params.sort !== undefined) setSortBy(params.sort);
    if (params.group !== undefined) setGroupBy(params.group);
  }, [urlSearch]);

  const availablePublishers = useMemo(() => getAvailablePublishers(mangas), [mangas]);

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
    const list = filterAndSortMangas(mangas, { search: deferredSearch, statusFilter, publisherFilter, sortBy, collectFilter, authorFilter });
    const sections = groupMangas(list, groupBy);
    return { filtered: sections.length > 1 ? sections.flatMap(s => s.items) : list, groups: sections };
  }, [mangas, deferredSearch, statusFilter, publisherFilter, sortBy, collectFilter, authorFilter, groupBy]);
  const totalSeries = mangas.length;
  const { totalOwnedVolumes, totalCollectionValue, completedSeries } = useMemo(() => getCollectionTotals(mangas), [mangas]);

  return {
    search, setSearch, deferredSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy, viewMode, setViewMode,
    collectFilter, setCollectFilter, authorFilter, setAuthorFilter, groupBy, setGroupBy, collectCounts, groups,
    availablePublishers, filterCounts, statusTabs, filtered, totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries
  };
}
