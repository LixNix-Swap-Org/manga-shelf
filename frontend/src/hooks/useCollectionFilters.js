import { useState, useEffect, useMemo, useDeferredValue } from 'react';
import {
  getAvailablePublishers, getFilterCounts, filterAndSortMangas, getCollectionTotals, getStatusTabs,
  sanitizePublisherFilter, isStatusFilter, isSortOption
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
 * Search, status / publisher filter, sort and view mode of the series list plus the results. Filters, sort and view
 * are remembered in localStorage; the search only for this tab and user (sessionStorage), so it survives a visit to a
 * series. Pass loading while the list is (re)fetched: a remembered publisher that is not in the loaded list is reset to 'ALL'.
 * The list follows typing a moment later (deferredSearch), so the input stays responsive with large collections.
 */
export default function useCollectionFilters(mangas, { loading = false, userId = null } = {}) {
  const [search, setSearch] = useState(() => readStoredSearch(userId));
  const deferredSearch = useDeferredValue(search);
  const [statusFilter, setStatusFilter] = useState(() => readStored('localStorage', 'mangashelf_status_filter', 'ALL', isStatusFilter));
  const [publisherFilter, setPublisherFilter] = useState(() => readStored('localStorage', 'mangashelf_publisher_filter', 'ALL'));
  const [sortBy, setSortBy] = useState(() => readStored('localStorage', 'mangashelf_sort_by', 'title_asc', isSortOption));
  const [viewMode, setViewMode] = useState(() => readStored('localStorage', 'mangashelf_view_mode', 'grid', (v) => v === 'grid' || v === 'list'));

  useEffect(() => {
    writeStored('sessionStorage', SEARCH_KEY, JSON.stringify({ user: userKey(userId), search }));
  }, [search, userId]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_status_filter', statusFilter); }, [statusFilter]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_publisher_filter', publisherFilter); }, [publisherFilter]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_sort_by', sortBy); }, [sortBy]);
  useEffect(() => { writeStored('localStorage', 'mangashelf_view_mode', viewMode); }, [viewMode]);

  const availablePublishers = useMemo(() => getAvailablePublishers(mangas), [mangas]);

  // an empty list is not checked: before the first load it would wipe a valid remembered filter
  useEffect(() => {
    if (loading || mangas.length === 0) return;
    const next = sanitizePublisherFilter(publisherFilter, availablePublishers);
    if (next !== publisherFilter) setPublisherFilter(next);
  }, [loading, mangas.length, availablePublishers, publisherFilter]);

  const filterCounts = useMemo(() => getFilterCounts(mangas), [mangas]);
  const statusTabs = useMemo(() => getStatusTabs(filterCounts, statusFilter), [filterCounts, statusFilter]);
  const filtered = useMemo(
    () => filterAndSortMangas(mangas, { search: deferredSearch, statusFilter, publisherFilter, sortBy }),
    [mangas, deferredSearch, statusFilter, publisherFilter, sortBy]
  );
  const totalSeries = mangas.length;
  const { totalOwnedVolumes, totalCollectionValue, completedSeries } = useMemo(() => getCollectionTotals(mangas), [mangas]);

  return {
    search, setSearch, deferredSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy, viewMode, setViewMode,
    availablePublishers, filterCounts, statusTabs, filtered, totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries
  };
}
