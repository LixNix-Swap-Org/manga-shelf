// Covers the helpers of the volume step in "Neuer Manga".
import { describe, it, expect } from 'vitest';
import { MAX_PICKED_VOLUMES, pickRange, pickerCount, volumeRuns } from '../utils/volumePicker';

describe('volume picker helpers', () => {
  it('pickerCount: a typed count wins, then released, then the total; capped and never negative', () => {
    expect(pickerCount({ typed: '', released: 12, total: '20' })).toBe(12);
    expect(pickerCount({ typed: '', released: null, total: '20' })).toBe(20);
    expect(pickerCount({ typed: '4', released: 12, total: '20' })).toBe(4);
    expect(pickerCount({ typed: '-3', released: 12, total: '' })).toBe(0);
    expect(pickerCount({ typed: '9999', released: null, total: '' })).toBe(MAX_PICKED_VOLUMES);
  });

  it('volumeRuns: runs of one status, the rest as "Fehlt" only on request, the scanned number left out', () => {
    expect(volumeRuns({ count: 6, owned: new Set(), missingRest: true })).toEqual([]);
    expect(volumeRuns({ count: 6, owned: new Set([2, 3, 6]), missingRest: false })).toEqual([
      { from: 2, to: 3, status: 'Vorhanden' }, { from: 6, to: 6, status: 'Vorhanden' }
    ]);
    expect(volumeRuns({ count: 5, owned: new Set([1, 2, 3]), missingRest: true, skip: '4' })).toEqual([
      { from: 1, to: 3, status: 'Vorhanden' }, { from: 5, to: 5, status: 'Fehlt' }
    ]);
    // a pick above a lowered count no longer counts
    expect(volumeRuns({ count: 2, owned: new Set([5]), missingRest: true })).toEqual([]);
  });

  it('pickRange adds the range in either order', () => {
    expect([...pickRange(new Set([9]), 4, 2)].sort((a, b) => a - b)).toEqual([2, 3, 4, 9]);
  });
});
