import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';
import {
  filterAndSortMangas, getAvailableTags, parseTagFilter, formatTagFilter, readFilterParams, writeFilterParams
} from '../utils/collectionHelpers';

const series = [
  { id: 1, title: 'Frieren', tags: 'Adventure, Fantasy, Shounen', status: 'Laufend' },
  { id: 2, title: 'Vinland Saga', tags: 'Abenteuer, Historisch, Seinen', status: 'Laufend' },
  { id: 3, title: 'Yotsuba', tags: 'Slice of Life', status: 'Laufend' },
  { id: 4, title: 'Ohne Tags', tags: null, status: 'Laufend' }
];
const opts = { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc' };

describe('tag filter helpers', () => {
  it('counts tags in German and filters with AND', () => {
    expect(getAvailableTags(series).slice(0, 2)).toEqual([{ tag: 'Abenteuer', count: 2 }, { tag: 'Alltag', count: 1 }]);
    const titles = (tagFilter) => filterAndSortMangas(series, { ...opts, tagFilter }).map(m => m.title);
    expect(titles(['Abenteuer'])).toEqual(['Frieren', 'Vinland Saga']);
    expect(titles(['abenteuer', 'Fantasy'])).toEqual(['Frieren']);
    expect(titles('Alltag')).toEqual(['Yotsuba']);
    expect(titles([])).toHaveLength(4);
    expect(filterAndSortMangas(series, { ...opts, search: 'übernatürlich' })).toEqual([]);
    expect(filterAndSortMangas(series, { ...opts, search: 'Alltag' }).map(m => m.title)).toEqual(['Yotsuba']);
  });

  it('keeps the filter as "a,b" in the URL', () => {
    expect(parseTagFilter('Abenteuer, fantasy , piraten')).toEqual(['Abenteuer', 'Fantasy', 'piraten']);
    expect(formatTagFilter(['Adventure', 'Drama'])).toBe('Abenteuer,Drama');
    expect(readFilterParams('?tags=Abenteuer%2CFantasy&view=anime')).toEqual({ tags: 'Abenteuer,Fantasy' });
    expect(writeFilterParams('?view=anime', { tags: 'Abenteuer' })).toBe('?view=anime&tags=Abenteuer');
    expect(writeFilterParams('?tags=Abenteuer', { tags: '' })).toBe('');
  });
});

describe('CollectionToolbar genre filter', () => {
  const props = (over = {}) => ({
    availablePublishers: [], filterCounts: { ALL: 4 }, filtered: series, publisherFilter: 'ALL', search: '',
    setPublisherFilter: vi.fn(), setSearch: vi.fn(), setSortBy: vi.fn(), setStatusFilter: vi.fn(), setViewMode: vi.fn(),
    sortBy: 'title_asc', statusFilter: 'ALL', viewMode: 'grid',
    availableTags: getAvailableTags(series), tagFilter: [], setTagFilter: vi.fn(),
    ...over
  });

  it('adds a genre from the select and removes it through its chip; reset clears it', () => {
    const p = props();
    const { rerender } = render(<CollectionToolbar {...p} />);
    const select = screen.getByLabelText('Genre filtern');
    expect([...select.options].map(o => o.textContent)).toContain('Abenteuer (2)');
    fireEvent.change(select, { target: { value: 'Abenteuer' } });
    expect(p.setTagFilter).toHaveBeenLastCalledWith(['Abenteuer']);

    rerender(<CollectionToolbar {...p} tagFilter={['Abenteuer']} />);
    expect([...screen.getByLabelText('Genre filtern').options].map(o => o.value)).not.toContain('Abenteuer');
    fireEvent.change(screen.getByLabelText('Genre filtern'), { target: { value: 'Fantasy' } });
    expect(p.setTagFilter).toHaveBeenLastCalledWith(['Abenteuer', 'Fantasy']);
    fireEvent.click(screen.getByRole('button', { name: 'Genre-Filter „Abenteuer“ entfernen' }));
    expect(p.setTagFilter).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole('button', { name: 'Filter und Suche zurücksetzen' }));
    expect(p.setTagFilter).toHaveBeenLastCalledWith([]);
  });

  it('stays hidden without the handler or without tags', () => {
    const { rerender } = render(<CollectionToolbar {...props({ setTagFilter: undefined })} />);
    expect(screen.queryByLabelText('Genre filtern')).toBeNull();
    rerender(<CollectionToolbar {...props({ availableTags: [] })} />);
    expect(screen.queryByLabelText('Genre filtern')).toBeNull();
  });
});
