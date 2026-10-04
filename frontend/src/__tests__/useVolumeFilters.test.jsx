// useVolumeFilters: status, condition and type filters and sorting of the volume list.
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useVolumeFilters from '../hooks/useVolumeFilters';
import { CONDITION_NONE } from '../utils/volumeHelpers';

const volumes = [
  { id: 1, volume_number: '1', status: 'Vorhanden', condition: 'Gut' },
  { id: 2, volume_number: '5', status: 'Vorhanden', condition: null },
  { id: 3, volume_number: '5', type: 'special_edition', status: 'Vorhanden', condition: '', notes: 'Collectors Edition' },
  { id: 4, volume_number: '3', status: 'Fehlt', condition: 'Wie neu (Import)' },
  { id: 5, volume_number: 'Schuber 1', type: 'schuber', status: 'Vorhanden', condition: 'Gut' }
];
const ids = (r) => r.current.filteredVolumes.map(v => v.id);
const render = () => renderHook(() => useVolumeFilters({ volumes, manga: { publisher: 'Carlsen Manga' }, user: { id: 1 }, selectedReaderId: 'ALL' }));

describe('useVolumeFilters', () => {
  beforeEach(() => localStorage.clear());

  it('the none condition keeps volumes without a condition; imported conditions are selectable', () => {
    const { result } = render();
    expect(result.current.conditionsList).toContain('Wie neu (Import)');
    act(() => result.current.setVolumeConditionFilter(CONDITION_NONE));
    expect(ids(result)).toEqual([2, 3]);
    act(() => result.current.setVolumeConditionFilter('Wie neu (Import)'));
    expect(ids(result)).toEqual([4]);
  });

  it('search matches the displayed title and ignores surrounding spaces', () => {
    const { result } = render();
    act(() => result.current.setVolumeSearch('Band 5 '));
    expect(ids(result)).toEqual([2, 3]);
    act(() => result.current.setVolumeSearch('collectors'));
    expect(ids(result)).toEqual([3]);
    act(() => result.current.setVolumeSearch('schuber 1'));
    expect(ids(result)).toEqual([5]);
  });

  it('number sorts keep schuber last in both directions; ghost permission follows the filters', () => {
    const { result } = render();
    expect(ids(result)).toEqual([1, 4, 2, 3, 5]);
    act(() => result.current.setVolumeSort('number_desc'));
    expect(ids(result)).toEqual([2, 3, 4, 1, 5]);
    expect(result.current.gapsAllowedByFilters).toBe(true);
    act(() => result.current.setVolumeConditionFilter('Gut'));
    expect(result.current.gapsAllowedByFilters).toBe(false);
  });
});
