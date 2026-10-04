import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  normalizeBase, getActiveBase, setActiveBase, getToken, setToken, BASE_KEY, TOKEN_KEY
} from '../app/connection';

describe('app connection store', () => {
  beforeEach(() => localStorage.clear());

  it('normalizes a server address to origin plus path without trailing slash', () => {
    expect(normalizeBase('https://shelf.example.org/')).toBe('https://shelf.example.org');
    expect(normalizeBase('  http://192.168.1.20:3000/manga//  ')).toBe('http://192.168.1.20:3000/manga');
    expect(normalizeBase('https://shelf.example.org/manga?x=1#y')).toBe('https://shelf.example.org/manga');
    expect(normalizeBase('ftp://shelf.example.org')).toBe('');
    expect(normalizeBase('kein server')).toBe('');
    expect(normalizeBase(null)).toBe('');
  });

  it('stores, reads and clears the active server', () => {
    expect(getActiveBase()).toBe('');
    expect(setActiveBase('https://shelf.example.org/')).toBe('https://shelf.example.org');
    expect(localStorage.getItem(BASE_KEY)).toBe('https://shelf.example.org');
    expect(getActiveBase()).toBe('https://shelf.example.org');
    setActiveBase('');
    expect(getActiveBase()).toBe('');
    expect(localStorage.getItem(BASE_KEY)).toBeNull();
  });

  it('rejects an invalid address and keeps the previous one', () => {
    setActiveBase('https://a.example');
    expect(() => setActiveBase('javascript:alert(1)')).toThrow(/Ungültige Serveradresse/);
    expect(getActiveBase()).toBe('https://a.example');
  });

  it('stores the token with the origin of the active server and removes it', () => {
    setActiveBase('https://shelf.example.org/manga');
    setToken('abc.def.ghi');
    expect(getToken()).toBe('abc.def.ghi');
    expect(JSON.parse(localStorage.getItem(TOKEN_KEY))).toEqual({ origin: 'https://shelf.example.org', token: 'abc.def.ghi' });
    setToken(null);
    expect(getToken()).toBe('');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('switching to another origin drops the token; another path on the same origin keeps it', () => {
    setActiveBase('https://home.example');
    setToken('home-token');
    setActiveBase('https://home.example/manga');
    expect(getToken()).toBe('home-token');
    setActiveBase('http://192.168.1.10:3000');
    expect(getToken()).toBe('');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    setActiveBase('https://home.example');
    expect(getToken()).toBe('');
  });

  it('never returns a token bound to another origin or stored in the old plain format', () => {
    localStorage.setItem(BASE_KEY, 'https://b.example');
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ origin: 'https://a.example', token: 'for-a' }));
    expect(getToken()).toBe('');
    localStorage.setItem(TOKEN_KEY, 'legacy.jwt.value');
    expect(getToken()).toBe('');
  });

  it('works without usable storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getToken()).toBe('');
    expect(() => setToken('x')).not.toThrow();
    expect(getActiveBase()).toBe('');
    spy.mockRestore();
  });
});
