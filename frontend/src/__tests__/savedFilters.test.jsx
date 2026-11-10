// "Gemerkte Filter": save the current filter combination, apply it with one click, delete it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SavedFilters, { filterLabel, filterSnapshot, readSavedFilters, sameFilters, SAVED_FILTER_LIMIT } from '../components/dashboard/SavedFilters';

const base = { status: 'ALL', publisher: 'ALL', collect: 'ALL', author: '', tags: [], lang: 'ALL', shelf: 'ALL', sort: 'title_asc', group: 'none' };

beforeEach(() => { localStorage.clear(); });

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
  it('stays hidden without saved sets and without active filters', () => {
    const { container } = render(<SavedFilters userId={1} current={base} apply={vi.fn()} filtersActive={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('saves the current choice once, applies it and deletes it; kept per account', () => {
    const apply = vi.fn();
    const current = { ...base, publisher: 'Carlsen', collect: 'gaps' };
    const { rerender } = render(<SavedFilters userId={1} current={current} apply={apply} filtersActive />);
    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Auswahl merken/ }));
    expect(readSavedFilters(1).map((f) => f.label)).toEqual(['Carlsen · Mit Lücken']);
    expect(readSavedFilters(2)).toEqual([]);
    // already saved: no second save button, the chip shows as active
    expect(screen.queryByRole('button', { name: /Aktuelle Auswahl merken/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Carlsen · Mit Lücken' }).getAttribute('aria-pressed')).toBe('true');

    rerender(<SavedFilters userId={1} current={base} apply={apply} filtersActive={false} />);
    const chip = screen.getByRole('button', { name: 'Carlsen · Mit Lücken' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ publisher: 'Carlsen', collect: 'gaps', status: 'ALL' }));

    fireEvent.click(screen.getByRole('button', { name: 'Gemerkten Filter „Carlsen · Mit Lücken“ löschen' }));
    expect(readSavedFilters(1)).toEqual([]);
  });

  it(`keeps the newest ${SAVED_FILTER_LIMIT}`, () => {
    const { rerender } = render(<SavedFilters userId={1} current={{ ...base, publisher: 'P0' }} apply={vi.fn()} filtersActive />);
    for (let i = 0; i <= SAVED_FILTER_LIMIT; i++) {
      rerender(<SavedFilters userId={1} current={{ ...base, publisher: `P${i}` }} apply={vi.fn()} filtersActive />);
      fireEvent.click(screen.getByRole('button', { name: /Aktuelle Auswahl merken/ }));
    }
    const labels = readSavedFilters(1).map((f) => f.label);
    expect(labels).toHaveLength(SAVED_FILTER_LIMIT);
    expect(labels[0]).toBe('P1');
  });
});
