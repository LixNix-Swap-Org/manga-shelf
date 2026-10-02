import { useState, useMemo } from 'react';
import { normalizePubName, getVolumeSortInfo, hasUserRead } from '../utils/volumeHelpers';

/** Filter, search, sort and view-mode state of the volume list plus the filtered/sorted result and the type counts. */
export default function useVolumeFilters({ volumes, manga, user, selectedReaderId }) {
  // Filters & Sorting for Volumes
  const [volumeFilter, setVolumeFilter] = useState('ALL'); // 'ALL' | 'Vorhanden' | 'Fehlt' | 'Gelesen' | 'Ungelesen'
  const [volumeTypeFilter, setVolumeTypeFilter] = useState('ALL'); // 'ALL' | 'volume' | 'special_edition' | 'schuber' | 'special'
  const [volumePublisherFilter, setVolumePublisherFilter] = useState('ALL');
  const [volumeConditionFilter, setVolumeConditionFilter] = useState('ALL');
  const [volumeSort, setVolumeSort] = useState('number_asc');
  const [volumeSearch, setVolumeSearch] = useState('');
  // View mode
  const [volumeViewMode, setVolumeViewMode] = useState(() => {
    return localStorage.getItem('mangashelf_volume_view_mode') || 'grid';
  });

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
    return Array.from(pubMap.values()).sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  }, [volumes, manga?.publisher]);

  // Available conditions
  const conditionsList = ['Neuwertig', 'Sehr gut', 'Gut', 'Akzeptabel', 'Mängelexemplar'];

  // Base volumes matching all filters EXCEPT the type filter (for computing accurate type badge counts)
  const baseVolumesForType = useMemo(() => {
    return volumes.filter(v => {
      const effUserId = selectedReaderId !== 'ALL' ? selectedReaderId : user?.id;
      const isReadByTarget = hasUserRead(v, effUserId, user?.id);

      if (volumeFilter === 'Vorhanden' && v.status !== 'Vorhanden') return false;
      if (volumeFilter === 'Fehlt' && v.status !== 'Fehlt') return false;
      if (volumeFilter === 'Vorbestellt' && v.status !== 'Vorbestellt') return false;
      if (volumeFilter === 'Erscheint bald' && v.status !== 'Erscheint bald') return false;
      if (volumeFilter === 'Gelesen' && !isReadByTarget) return false;
      if (volumeFilter === 'Ungelesen') {
        if (v.status !== 'Vorhanden' || isReadByTarget) return false;
      }
      
      if (volumePublisherFilter !== 'ALL') {
        const rawPub = (v.publisher && v.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '';
        const pub = normalizePubName(rawPub);
        if (pub.toLowerCase() !== volumePublisherFilter.toLowerCase()) return false;
      }

      if (volumeConditionFilter !== 'ALL') {
        if (volumeConditionFilter === 'Ohne') {
          if (v.condition) return false;
        } else if (v.condition !== volumeConditionFilter) {
          return false;
        }
      }

      if (volumeSearch.trim()) {
        const q = volumeSearch.toLowerCase();
        const numMatch = String(v.volume_number).toLowerCase().includes(q);
        const isbnMatch = v.isbn && String(v.isbn).toLowerCase().includes(q);
        const notesMatch = v.notes && String(v.notes).toLowerCase().includes(q);
        const pubMatch = ((v.publisher || manga?.publisher || '')).toLowerCase().includes(q);
        if (!numMatch && !isbnMatch && !notesMatch && !pubMatch) return false;
      }

      return true;
    });
  }, [volumes, selectedReaderId, user?.id, volumeFilter, volumePublisherFilter, volumeConditionFilter, volumeSearch, manga?.publisher]);

  const schuberCount = useMemo(() => baseVolumesForType.filter(v => v.type === 'schuber' || String(v.volume_number).toLowerCase().includes('schuber')).length, [baseVolumesForType]);

  const specialEditionCount = useMemo(() => baseVolumesForType.filter(v => v.type === 'special_edition' || (
    v.type !== 'schuber' && (
      String(v.volume_number).toLowerCase().includes('special edition') ||
      String(v.volume_number).toLowerCase().includes('limited edition') ||
      String(v.volume_number).toLowerCase().includes('spezial edition') ||
      (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition')))
    )
  )).length, [baseVolumesForType]);

  const specialCount = useMemo(() => baseVolumesForType.filter(v => {
    if (v.type === 'special_edition' || v.type === 'schuber') return false;
    const vLower = String(v.volume_number).toLowerCase();
    if (vLower.includes('special edition') || vLower.includes('limited edition') || vLower.includes('spezial edition') || vLower.includes('schuber')) return false;
    return v.type === 'special' || vLower.includes('special') || vLower.includes('extra') || vLower.includes('sonderband');
  }).length, [baseVolumesForType]);

  const regularVolumeCount = useMemo(() => baseVolumesForType.filter(v => {
    const isSchuber = v.type === 'schuber' || String(v.volume_number).toLowerCase().includes('schuber');
    const isSpecialEd = v.type === 'special_edition' || (
      String(v.volume_number).toLowerCase().includes('special edition') ||
      String(v.volume_number).toLowerCase().includes('limited edition') ||
      String(v.volume_number).toLowerCase().includes('spezial edition') ||
      (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition')))
    );
    const isSpecial = v.type === 'special' || String(v.volume_number).toLowerCase().includes('special') || String(v.volume_number).toLowerCase().includes('extra') || String(v.volume_number).toLowerCase().includes('sonderband');
    return !isSchuber && !isSpecialEd && !isSpecial;
  }).length, [baseVolumesForType]);

  // Filter & sort volumes
  const filteredVolumes = useMemo(() => {
    return baseVolumesForType
      .filter(v => {
        if (volumeTypeFilter !== 'ALL') {
          const t = v.type || (
            String(v.volume_number).toLowerCase().includes('schuber') ? 'schuber' :
            String(v.volume_number).toLowerCase().includes('special edition') || String(v.volume_number).toLowerCase().includes('limited edition') || String(v.volume_number).toLowerCase().includes('spezial edition') || (v.notes && (v.notes.toLowerCase().includes('special edition') || v.notes.toLowerCase().includes('limited edition'))) ? 'special_edition' :
            String(v.volume_number).toLowerCase().includes('special') || String(v.volume_number).toLowerCase().includes('extra') || String(v.volume_number).toLowerCase().includes('sonderband') ? 'special' :
            'volume'
          );
          if (t !== volumeTypeFilter) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const infoA = getVolumeSortInfo(a);
        const infoB = getVolumeSortInfo(b);
        const priceA = a.price !== null && a.price !== undefined ? a.price : -1;
        const priceB = b.price !== null && b.price !== undefined ? b.price : -1;
        const pubA = ((a.publisher && a.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '').toLowerCase();
        const pubB = ((b.publisher && b.publisher.trim()) || (manga?.publisher && manga.publisher.trim()) || '').toLowerCase();
        const yearA = a.release_year || 0;
        const yearB = b.release_year || 0;

        switch (volumeSort) {
          case 'number_desc':
            if (infoA.rank !== infoB.rank) return infoA.rank - infoB.rank;
            if (infoB.num !== infoA.num) return infoB.num - infoA.num;
            if (infoA.subRank !== infoB.subRank) return infoA.subRank - infoB.subRank;
            return infoB.raw.localeCompare(infoA.raw, undefined, { numeric: true });
          case 'publisher_asc':
            return pubA.localeCompare(pubB) || (infoA.rank - infoB.rank) || (infoA.num - infoB.num);
          case 'publisher_desc':
            return pubB.localeCompare(pubA) || (infoA.rank - infoB.rank) || (infoA.num - infoB.num);
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
            if (infoA.rank !== infoB.rank) return infoA.rank - infoB.rank;
            if (infoA.num !== infoB.num) return infoA.num - infoB.num;
            if (infoA.subRank !== infoB.subRank) return infoA.subRank - infoB.subRank;
            return infoA.raw.localeCompare(infoB.raw, undefined, { numeric: true });
        }
      });
  }, [baseVolumesForType, volumeTypeFilter, volumeSort, manga?.publisher]);

  const hasActiveFilters = volumeFilter !== 'ALL' || volumeTypeFilter !== 'ALL' || volumePublisherFilter !== 'ALL' || volumeConditionFilter !== 'ALL' || Boolean(volumeSearch.trim());

  const handleResetFilters = () => {
    setVolumeFilter('ALL');
    setVolumeTypeFilter('ALL');
    setVolumePublisherFilter('ALL');
    setVolumeConditionFilter('ALL');
    setVolumeSearch('');
  };

  const handleSetVolumeViewMode = (mode) => {
    setVolumeViewMode(mode);
    localStorage.setItem('mangashelf_volume_view_mode', mode);
  };

  return {
    volumeFilter, setVolumeFilter, volumeTypeFilter, setVolumeTypeFilter,
    volumePublisherFilter, setVolumePublisherFilter, volumeConditionFilter, setVolumeConditionFilter,
    volumeSort, setVolumeSort, volumeSearch, setVolumeSearch,
    volumeViewMode, handleSetVolumeViewMode,
    availablePublishers, conditionsList, baseVolumesForType,
    schuberCount, specialEditionCount, specialCount, regularVolumeCount,
    filteredVolumes, hasActiveFilters, handleResetFilters
  };
}
