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

  it("'Band N' finds volume N only, also with realistic ISBNs; ISBNs need 4+ digits", () => {
    const isbn = (n) => `978-3-551-7${String(5420 + n).padStart(4, '0')}-${n % 10}`;
    const vols = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, volume_number: String(i + 1), status: 'Vorhanden', isbn: isbn(i + 1) }));
    const search = createVolumeSearch('Carlsen Manga');
    const numbers = (q) => search.filter(vols, q).map((v) => v.volume_number);
    expect(numbers('Band 2')).toEqual(['2']);
    expect(numbers('Band 3')).toEqual(['3']);
    expect(numbers('band 7')).toEqual(['7']);
    expect(numbers('12')).toEqual(['12']);
    expect(search.matches({ volume_number: '12', isbn: '978-3-551-75421-3' }, 'Band 2')).toBe(false);
    expect(numbers('75432')).toEqual(['12']);
    expect(numbers('978-3-551-75432-2')).toEqual(['12']);
  });

  it('decimal volume numbers: Band 1.5 is not Band 15', () => {
    const vols = ['1.5', '15', '150'].map((n, i) => ({ id: i + 1, volume_number: n, status: 'Vorhanden' }));
    const search = createVolumeSearch('');
    expect(search.filter(vols, 'Band 1.5').map((v) => v.volume_number)).toEqual(['1.5']);
    expect(search.filter(vols, '15').map((v) => v.volume_number)).toEqual(['15']);
  });

  it('with a search, number and title hits come before note hits; the sort orders each group', () => {
    const list = [
      { id: 1, volume_number: '1', status: 'Vorhanden', notes: 'Fortsetzung von Band 2' },
      { id: 2, volume_number: '2', status: 'Vorhanden' },
      { id: 3, volume_number: '3', status: 'Vorhanden', notes: 'Bnad mit Poster' },
      { id: 4, volume_number: '4', status: 'Vorhanden', notes: 'wie Band 2' }
    ];
    const { result } = renderHook(() => useVolumeFilters({ volumes: list, manga: {}, user: { id: 1 }, selectedReaderId: 'ALL' }));
    act(() => result.current.setVolumeSearch('band 2'));
    expect(ids(result)).toEqual([2, 1, 4]);
    act(() => result.current.setVolumeSort('number_desc'));
    expect(ids(result)).toEqual([2, 4, 1]);
    act(() => result.current.setVolumeSearch('poster'));
    expect(ids(result)).toEqual([3]);
    act(() => result.current.setVolumeSearch(''));
    expect(ids(result)).toEqual([4, 3, 2, 1]);
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
