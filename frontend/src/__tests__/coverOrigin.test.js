// Covers the stored origin of Manga Passion covers that the header preconnects to.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { COVER_ORIGIN_KEY, getCoverOrigin, originOf, setCoverOrigin } from '../utils/coverOrigin';

beforeEach(() => {
  try { localStorage.clear(); } catch (_) {}
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('coverOrigin', () => {
  it('stores the origin of an absolute http(s) cover URL and reads it back', () => {
    expect(getCoverOrigin()).toBeNull();
    setCoverOrigin('https://cdn.example:8443/covers/a.jpg?x=1');
    expect(localStorage.getItem(COVER_ORIGIN_KEY)).toBe('https://cdn.example:8443');
    expect(getCoverOrigin()).toBe('https://cdn.example:8443');
  });

  it('ignores relative paths, other schemes and empty values', () => {
    setCoverOrigin('https://cdn.example/a.jpg');
    for (const value of ['/uploads/a.jpg', 'data:image/png;base64,AAAA', 'javascript:alert(1)', '', null, undefined]) setCoverOrigin(value);
    expect(getCoverOrigin()).toBe('https://cdn.example');
    expect(originOf('ftp://cdn.example/a.jpg')).toBeNull();
    expect(originOf('http://cdn.example/a.jpg')).toBe('http://cdn.example');
  });

  it('a stored value that is no plain origin reads as none', () => {
    localStorage.setItem(COVER_ORIGIN_KEY, 'https://cdn.example/path');
    expect(getCoverOrigin()).toBeNull();
    localStorage.setItem(COVER_ORIGIN_KEY, 'nonsense');
    expect(getCoverOrigin()).toBeNull();
  });

  it('blocked storage neither throws nor stores', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setCoverOrigin('https://cdn.example/a.jpg')).not.toThrow();
    expect(getCoverOrigin()).toBeNull();
  });
});
