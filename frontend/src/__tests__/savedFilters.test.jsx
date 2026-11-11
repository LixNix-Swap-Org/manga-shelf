// "Gemerkte Filter": save the current filter combination, apply it with one click, delete it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// a stand-in for /api/saved-filters with the server's rules (dedupe, newest SAVED_FILTER_LIMIT, own entries only)
const api = vi.hoisted(() => ({ rows: [], next: 1, down: false, calls: [] }));
vi.mock('../utils/api', () => {
  const list = () => ({ items: api.rows.map((r) => ({ ...r })), limit: 8 });
  const guard = () => { if (api.down) throw new Error('offline'); };
  return {
    get: vi.fn(async (path) => { guard(); api.calls.push(['GET', path]); return list(); }),
    post: vi.fn(async (path, body) => {
      guard();
      api.calls.push(['POST', path, body]);
      const key = JSON.stringify(body.filters);
      if (!api.rows.some((r) => JSON.stringify(r.filters) === key)) api.rows = [...api.rows, { id: api.next++, label: body.label, filters: body.filters }].slice(-8);
      return list();
    }),
    del: vi.fn(async (path) => {
      guard();
      api.calls.push(['DELETE', path]);
      api.rows = api.rows.filter((r) => `/api/saved-filters/${r.id}` !== path);
      return list();
    })
  };
});

import SavedFilters, { filterLabel, filterSnapshot, readSavedFilters, sameFilters, SAVED_FILTER_LIMIT } from '../components/dashboard/SavedFilters';

const base = { status: 'ALL', publisher: 'ALL', collect: 'ALL', author: '', tags: [], lang: 'ALL', shelf: 'ALL', sort: 'title_asc', group: 'none' };

beforeEach(() => { localStorage.clear(); api.rows = []; api.next = 1; api.down = false; api.calls = []; });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('saved filter helpers', () => {
  it('names a filter set by its parts and compares tags regardless of order', () => {
    const f = filterSnapshot({ ...base, shelf: 4, status: 'Laufend', publisher: 'Carlsen', collect: 'gaps', tags: ['Fantasy', 'action'], lang: 'de' });
    expect(f.tags).toEqual(['action', 'Fantasy']);
    expect(filterLabel(f, { shelves: [{ id: 4, name: 'Familie' }] })).toBe('Familie · Laufend · Carlsen · Mit Lücken · action, Fantasy · DE');
    expect(filterLabel(filterSnapshot(base))).toBe('Alle Reihen');
    expect(sameFilters(f, filterSnapshot({ ...base, shelf: '4', status: 'Laufend', publisher: 'Carlsen', collect: 'gaps', tags: ['action', 'Fantasy'], lang: 'de' }))).toBe(true);
  });
});

describe('SavedFilters', () => {
  it('stays hidden without saved sets and without active filters', async () => {
    const { container } = render(<SavedFilters userId={1} current={base} apply={vi.fn()} filtersActive={false} />);
    await settle();
    expect(container.innerHTML).toBe('');
  });

  it('saves the current choice on the server once, applies it and deletes it', async () => {
    const apply = vi.fn();
    const current = { ...base, publisher: 'Carlsen', collect: 'gaps' };
    const { rerender } = render(<SavedFilters userId={1} current={current} apply={apply} filtersActive />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Auswahl merken/ }));
    await settle();
    expect(api.rows.map((r) => r.label)).toEqual(['Carlsen · Mit Lücken']);
    expect(readSavedFilters(1)).toEqual([]);
    // already saved: no second save button, the chip shows as active
    expect(screen.queryByRole('button', { name: /Aktuelle Auswahl merken/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Carlsen · Mit Lücken' }).getAttribute('aria-pressed')).toBe('true');

    rerender(<SavedFilters userId={1} current={base} apply={apply} filtersActive={false} />);
    const chip = screen.getByRole('button', { name: 'Carlsen · Mit Lücken' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ publisher: 'Carlsen', collect: 'gaps', status: 'ALL' }));

    fireEvent.click(screen.getByRole('button', { name: 'Gemerkten Filter „Carlsen · Mit Lücken“ löschen' }));
    await settle();
    expect(api.calls.at(-1)).toEqual(['DELETE', '/api/saved-filters/1']);
    expect(api.rows).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Carlsen · Mit Lücken' })).toBeNull();
  });

  it('hands the sets kept in this browser to the server once and clears them there', async () => {
    const kept = [
      { id: 'a', label: 'Carlsen', filters: filterSnapshot({ ...base, publisher: 'Carlsen' }) },
      { id: 'b', label: 'Laufend', filters: filterSnapshot({ ...base, status: 'Laufend' }) }
    ];
    localStorage.setItem('mangashelf_saved_filters:1', JSON.stringify(kept));
    render(<SavedFilters userId={1} current={base} apply={vi.fn()} filtersActive={false} />);
    await waitFor(() => expect(api.rows.map((r) => r.label)).toEqual(['Carlsen', 'Laufend']));
    expect(localStorage.getItem('mangashelf_saved_filters:1')).toBeNull();
    expect(screen.getByRole('button', { name: 'Carlsen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Laufend' })).toBeTruthy();
  });

  it('server out of reach: the set stays in this browser and goes to the server on the next load', async () => {
    api.down = true;
    const current = { ...base, publisher: 'Carlsen' };
    const { unmount } = render(<SavedFilters userId={1} current={current} apply={vi.fn()} filtersActive />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Auswahl merken/ }));
    await settle();
    expect(screen.getByRole('button', { name: 'Carlsen' })).toBeTruthy();
    expect(readSavedFilters(1).map((f) => f.label)).toEqual(['Carlsen']);
    unmount();

    api.down = false;
    render(<SavedFilters userId={1} current={base} apply={vi.fn()} filtersActive={false} />);
    await waitFor(() => expect(api.rows.map((r) => r.label)).toEqual(['Carlsen']));
    expect(readSavedFilters(1)).toEqual([]);
  });

  it(`keeps the newest ${SAVED_FILTER_LIMIT}`, async () => {
    const { rerender } = render(<SavedFilters userId={1} current={{ ...base, publisher: 'P0' }} apply={vi.fn()} filtersActive />);
    await settle();
    for (let i = 0; i <= SAVED_FILTER_LIMIT; i++) {
      rerender(<SavedFilters userId={1} current={{ ...base, publisher: `P${i}` }} apply={vi.fn()} filtersActive />);
      fireEvent.click(screen.getByRole('button', { name: /Aktuelle Auswahl merken/ }));
      await settle();
    }
    const labels = api.rows.map((f) => f.label);
    expect(labels).toHaveLength(SAVED_FILTER_LIMIT);
    expect(labels[0]).toBe('P1');
    expect(screen.queryByRole('button', { name: 'P0' })).toBeNull();
  });
});
