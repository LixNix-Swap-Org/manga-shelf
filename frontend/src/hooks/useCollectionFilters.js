import { useState, useEffect, useMemo } from 'react';
import { getAvailablePublishers, getFilterCounts, filterAndSortMangas, getCollectionTotals } from '../utils/collectionHelpers';

/** Search, status / publisher filter, sort and view mode of the series list (remembered in localStorage) plus the results. */
export default function useCollectionFilters(mangas) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(() => {
    try { return localStorage.getItem('mangashelf_status_filter') || 'ALL'; } catch (_) { return 'ALL'; }
  });
  const [publisherFilter, setPublisherFilter] = useState(() => {
    try { return localStorage.getItem('mangashelf_publisher_filter') || 'ALL'; } catch (_) { return 'ALL'; }
  });
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('mangashelf_sort_by') || 'title_asc'; } catch (_) { return 'title_asc'; }
  });
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem('mangashelf_view_mode') || 'grid'; } catch (_) { return 'grid'; }
  }); // 'grid' | 'list'

  useEffect(() => {
    try { localStorage.setItem('mangashelf_status_filter', statusFilter); } catch (_) {}
  }, [statusFilter]);

  useEffect(() => {
    try { localStorage.setItem('mangashelf_publisher_filter', publisherFilter); } catch (_) {}
  }, [publisherFilter]);

  useEffect(() => {
    try { localStorage.setItem('mangashelf_sort_by', sortBy); } catch (_) {}
  }, [sortBy]);

  useEffect(() => {
    try { localStorage.setItem('mangashelf_view_mode', viewMode); } catch (_) {}
  }, [viewMode]);

  const availablePublishers = useMemo(() => getAvailablePublishers(mangas), [mangas]);
  const filterCounts = useMemo(() => getFilterCounts(mangas), [mangas]);
  const filtered = useMemo(
    () => filterAndSortMangas(mangas, { search, statusFilter, publisherFilter, sortBy }),
    [mangas, search, statusFilter, publisherFilter, sortBy]
  );
  const totalSeries = mangas.length;
  const { totalOwnedVolumes, totalCollectionValue, completedSeries } = useMemo(() => getCollectionTotals(mangas), [mangas]);

  return {
    search, setSearch, statusFilter, setStatusFilter, publisherFilter, setPublisherFilter, sortBy, setSortBy, viewMode, setViewMode,
    availablePublishers, filterCounts, filtered, totalSeries, totalOwnedVolumes, totalCollectionValue, completedSeries
  };
}
