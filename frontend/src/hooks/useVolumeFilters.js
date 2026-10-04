import { useState, useMemo } from 'react';
import {
  normalizePubName, compareVolumesByNumber, getVolumeSortInfo, hasUserRead, inferVolumeType,
  getVolumeDisplayTitle, getEditionLabel, matchesConditionFilter, filtersAllowGaps, VOLUME_CONDITIONS
} from '../utils/volumeHelpers';
import { createSearch, prepareQuery, compareNatural } from '../utils/search';
import { isCollectibleVolume } from '../components/detail/volumeViewHelpers';

/** Volume search over what the cards show (display title, edition label), number, ISBN, notes and publisher. */
export const createVolumeSearch = (mangaPublisher) => createSearch(v => {
  const rawPub = (v.publisher && String(v.publisher).trim()) || (mangaPublisher && String(mangaPublisher).trim()) || '';
  return {
    primary: [getVolumeDisplayTitle(v), v.volume_number],
    // every volume would otherwise carry the fallback label "Special Edition"
    secondary: [v.isbn, v.notes, rawPub, normalizePubName(rawPub), inferVolumeType(v) === 'special_edition' ? getEditionLabel(v).label : null]
  };
});

const VIEW_MODE_KEY = 'mangashelf_volume_view_mode';
const readViewMode = () => {
  try { return localStorage.getItem(VIEW_MODE_KEY) || 'grid'; } catch (_) { return 'grid'; }
};

/** Filter, search, sort and view-mode state of the volume list plus the filtered/sorted result and the type counts. */
export default function useVolumeFilters({ volumes, manga, user, selectedReaderId }) {
  // Filters & Sorting for Volumes
  const [volumeFilter, setVolumeFilter] = useState('ALL'); // 'ALL' | 'Vorhanden' | 'Fehlt' | 'Gelesen' | 'Ungelesen'
  const [volumeTypeFilter, setVolumeTypeFilter] = useState('ALL'); // 'ALL' | 'volume' | 'special_edition' | 'schuber' | 'special'
  const [volumePublisherFilter, setVolumePublisherFilter] = useState('ALL');
  const [volumeConditionFilter, setVolumeConditionFilter] = useState('ALL');
  const [volumeSort, setVolumeSort] = useState('number_asc');
  const [volumeSearch, setVolumeSearch] = useState('');
  const [volumeOwnerFilter, setVolumeOwnerFilter] = useState('ALL'); // 'ALL' | Benutzer-ID: nur Bände dieser Person
  const [volumeOwnerMissing, setVolumeOwnerMissing] = useState(false); // mit Person: stattdessen Bände, die ihr (noch) fehlen
  // View mode
  const [volumeViewMode, setVolumeViewMode] = useState(readViewMode);

  const availablePublishers = useMemo(() => {
    const pubMap = new Map();
    volumes.forEach(v => {
      const raw = (v.publisher && v.publisher.trim()) || (manga?.publisher && manga.publisher.trim());
      if (!raw) return;
      const canonical = normalizePubName(raw);
      const key = canonical.toLowerCase();
      if (!pubMap.has(key)) {
        pubMap.set(key, canonical);
      }
    });
    return Array.from(pubMap.values()).sort(compareNatural);
  }, [volumes, manga?.publisher]);

  const volumeSearchIndex = useMemo(() => createVolumeSearch(manga?.publisher), [manga?.publisher]);

  // the usual conditions plus any other value found on the volumes (e.g. from a CSV import), so it can be filtered
  const conditionsList = useMemo(() => {
    const extra = new Set();
    volumes.forEach(v => {
      const c = v.condition === null || v.condition === undefined ? '' : String(v.condition).trim();
      if (c && !VOLUME_CONDITIONS.includes(c)) extra.add(c);
    });
    return [...VOLUME_CONDITIONS, ...[...extra].sort((a, b) => a.localeCompare(b, 'de'))];
  }, [volumes]);

  // Base volumes matching all filters EXCEPT the type filter (for computing accurate type badge counts)
  const baseVolumesForType = useMemo(() => {
    const query = prepareQuery(volumeSearch);
    return volumes.filter(v => {
      const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
      const isReadByTarget = hasUserRead(v, effUserId, user?.id);

      if (volumeFilter === 'Vorhanden' && v.status !== 'Vorhanden') return false;
      if (volumeFilter === 'Fehlt' && v.status !== 'Fehlt') return false;
      if (volumeFilter === 'Vorbestellt' && v.status !== 'Vorbestellt') return false;
      if (volumeFilter === 'Erscheint bald' && v.status !== 'Erscheint bald') return false;
      // owned only, like reader_stats.read_count shown on the chip
      if (volumeFilter === 'Gelesen' && (v.status !== 'Vorhanden' || !isReadByTarget)) return false;
      if (volumeFilter === 'Ungelesen') {
        if (v.status !== 'Vorhanden' || isReadByTarget) return false;
      }
      
      if (volumeOwnerFilter !== 'ALL') {
        const ownedByPerson = (v.owners || []).some(o => String(o.user_id) === String(volumeOwnerFilter));
        if (volumeOwnerMissing ? ownedByPerson : !ownedByPerson) return false;
        // missing = total - owned, as in OwnerFilterBar: preorders and announced volumes are not missing yet
        if (volumeOwnerMissing && !isCollectibleVolume(v)) return false;
      }

      if (volumePublisherFilter !== 'ALL') {
        const rawPub = (v.publisher && v.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '';
        const pub = normalizePubName(rawPub);
        if (pub.toLowerCase() !== volumePublisherFilter.toLowerCase()) return false;
      }

      if (!matchesConditionFilter(v, volumeConditionFilter)) return false;
      if (query && !volumeSearchIndex.matches(v, query)) return false;

      return true;
    });
  }, [volumes, selectedReaderId, user?.id, volumeFilter, volumeOwnerFilter, volumeOwnerMissing, volumePublisherFilter, volumeConditionFilter, volumeSearch, volumeSearchIndex, manga?.publisher]);

  // One rule for chips, counts and filter: the entry's type (inferVolumeType falls back to the name only without a stored type)
  const typeCounts = useMemo(() => {
    const counts = {};
    for (const v of baseVolumesForType) {
      const type = inferVolumeType(v);
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }, [baseVolumesForType]);
  const schuberCount = typeCounts.schuber || 0;
  const specialEditionCount = typeCounts.special_edition || 0;
  const specialCount = typeCounts.special || 0;
  const regularVolumeCount = typeCounts.volume || 0;

  // Filter & sort volumes
  const filteredVolumes = useMemo(() => {
    return baseVolumesForType
      .filter(v => {
        if (volumeTypeFilter !== 'ALL' && inferVolumeType(v) !== volumeTypeFilter) return false;
        return true;
      })
      .sort((a, b) => {
        const infoA = getVolumeSortInfo(a);
        const infoB = getVolumeSortInfo(b);
        const priceA = a.price !== null && a.price !== undefined ? a.price : -1;
        const priceB = b.price !== null && b.price !== undefined ? b.price : -1;
        const pubA = (a.publisher && a.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '';
        const pubB = (b.publisher && b.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '';
        const yearA = a.release_year || 0;
        const yearB = b.release_year || 0;

        switch (volumeSort) {
          case 'number_desc':
            return compareVolumesByNumber(a, b, true);
          case 'publisher_asc':
            return compareNatural(pubA, pubB) || (infoA.rank - infoB.rank) || (infoA.num - infoB.num);
          case 'publisher_desc':
            return compareNatural(pubB, pubA) || (infoA.rank - infoB.rank) || (infoA.num - infoB.num);
          case 'price_desc':
            return priceB - priceA;
          case 'price_asc':
            return (priceA === -1 ? 999999 : priceA) - (priceB === -1 ? 999999 : priceB);
          case 'year_desc':
            return yearB - yearA;
          case 'year_asc':
            return (yearA || 9999) - (yearB || 9999);
          case 'condition':
            return (a.condition || 'ZZZ').localeCompare(b.condition || 'ZZZ');
          case 'number_asc':
          default:
            return compareVolumesByNumber(a, b);
        }
      });
  }, [baseVolumesForType, volumeTypeFilter, volumeSort, manga?.publisher]);

  const gapsAllowedByFilters = filtersAllowGaps({
    volumeTypeFilter, volumeFilter, volumeSearch, volumePublisherFilter, volumeConditionFilter, volumeOwnerFilter, volumeOwnerMissing
  });

  const hasActiveFilters = volumeFilter !== 'ALL' || volumeTypeFilter !== 'ALL' || volumePublisherFilter !== 'ALL' || volumeConditionFilter !== 'ALL' || volumeOwnerFilter !== 'ALL' || Boolean(volumeSearch.trim());

  const handleResetFilters = () => {
    setVolumeFilter('ALL');
    setVolumeTypeFilter('ALL');
    setVolumePublisherFilter('ALL');
    setVolumeConditionFilter('ALL');
    setVolumeSearch('');
    setVolumeOwnerFilter('ALL');
    setVolumeOwnerMissing(false);
  };

  const handleSetVolumeViewMode = (mode) => {
    setVolumeViewMode(mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch (_) { /* storage blocked: only this visit */ }
  };

  return {
    volumeFilter, setVolumeFilter, volumeTypeFilter, setVolumeTypeFilter,
    volumePublisherFilter, setVolumePublisherFilter, volumeConditionFilter, setVolumeConditionFilter,
    volumeSort, setVolumeSort, volumeSearch, setVolumeSearch,
    volumeOwnerFilter, setVolumeOwnerFilter, volumeOwnerMissing, setVolumeOwnerMissing,
    volumeViewMode, handleSetVolumeViewMode,
    availablePublishers, conditionsList, baseVolumesForType,
    schuberCount, specialEditionCount, specialCount, regularVolumeCount,
    filteredVolumes, hasActiveFilters, gapsAllowedByFilters, handleResetFilters
  };
}
