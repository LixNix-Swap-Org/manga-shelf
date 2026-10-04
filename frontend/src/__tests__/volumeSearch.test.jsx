import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useVolumeFilters, { createVolumeSearch } from '../hooks/useVolumeFilters';

const volumes = [
  { id: 1, volume_number: '1', status: 'Vorhanden', isbn: '978-3-551-75421-3', notes: 'Erstauflage, signiert' },
  { id: 2, volume_number: '10', status: 'Vorhanden', publisher: 'Kazé' },
  { id: 3, volume_number: '2', type: 'special_edition', status: 'Vorhanden', notes: 'Collector’s Edition' },
  { id: 4, volume_number: 'Schuber 1', type: 'schuber', status: 'Fehlt' }
];
const ids = (r) => r.current.filteredVolumes.map(v => v.id);

describe('volume search (shared search.js)', () => {
  it('folds accents, apostrophes and typos and keeps ISBN digits together', () => {
    const { result } = renderHook(() => useVolumeFilters({ volumes, manga: { publisher: 'Carlsen Manga' }, user: { id: 1 }, selectedReaderId: 'ALL' }));
    const search = (q) => {
      act(() => result.current.setVolumeSearch(q));
      return ids(result);
    };
    expect(search('kaze')).toEqual([2]);
    expect(search('collectors')).toEqual([3]);
    expect(search('erstaulage')).toEqual([1]);
    expect(search('9783551')).toEqual([1]);
    expect(search('978-3-551-75')).toEqual([1]);
    expect(search('band 10')).toEqual([2]);
    expect(search('schuber')).toEqual([4]);
    expect(search('carlsen')).toEqual([1, 3, 4]);
    expect(search('')).toHaveLength(4);
  });

  it('the series publisher is part of the index of volumes without their own', () => {
    const carlsen = createVolumeSearch('Carlsen Manga');
    const egmont = createVolumeSearch('Egmont');
    const vol = { id: 9, volume_number: '1' };
    expect(carlsen.matches(vol, 'carlsen')).toBe(true);
    expect(egmont.matches(vol, 'carlsen')).toBe(false);
  });

  it('publisher sort is natural', () => {
    const list = [
      { id: 1, volume_number: '1', publisher: 'Verlag 10', status: 'Vorhanden' },
      { id: 2, volume_number: '1', publisher: 'verlag 2', status: 'Vorhanden' }
    ];
    const { result } = renderHook(() => useVolumeFilters({ volumes: list, manga: {}, user: { id: 1 }, selectedReaderId: 'ALL' }));
    act(() => result.current.setVolumeSort('publisher_asc'));
    expect(ids(result)).toEqual([2, 1]);
    expect(result.current.availablePublishers).toEqual(['verlag 2', 'Verlag 10']);
  });
});
