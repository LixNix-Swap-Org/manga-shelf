import { describe, it, expect } from 'vitest';
import { isPastRelease, mpCardActions } from '../utils/radarHelpers.js';

describe('calendar actions for released volumes', () => {
  it('knows past, current and unknown dates', () => {
    expect(isPastRelease('2026-10-01', '2026-10-12')).toBe(true);
    expect(isPastRelease('2026-10-12', '2026-10-12')).toBe(false);
    expect(isPastRelease('2026-09', '2026-10-12')).toBe(true);
    expect(isPastRelease('2026-10', '2026-10-12')).toBe(false);
    expect(isPastRelease(null)).toBe(false);
  });

  it('offers no pre-order for a volume that is already out', () => {
    expect(mpCardActions('Fehlt', '2000-01-01')).toEqual({ preorder: false, cart: false });
    expect(mpCardActions(null, '2000-01-01')).toEqual({ preorder: false, cart: true });
    expect(mpCardActions(null, '2999-01-01')).toEqual({ preorder: true, cart: true });
    expect(mpCardActions(null)).toEqual({ preorder: true, cart: true });
  });
});
