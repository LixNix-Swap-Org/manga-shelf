import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useCollectionFilters from '../hooks/useCollectionFilters';

const mangas = [
  { id: 1, title: 'Berserk', publisher: 'Panini', status: 'Laufend', owned_volumes: 10, total_value: 80 },
  { id: 2, title: 'Akira', publisher: 'Carlsen Manga', status: 'Abgeschlossen', owned_volumes: 6, total_value: 60.5 },
  { id: 3, title: 'Dragon Ball', publisher: 'carlsen manga', status: 'Pausiert', owned_volumes: 4, total_value: 40 }
];
const titles = (r) => r.current.filtered.map(m => m.title);

describe('useCollectionFilters', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('defaults: all series by title, totals, deduplicated publishers', () => {
    const { result } = renderHook(() => useCollectionFilters(mangas));
    expect(result.current.statusFilter).toBe('ALL');
    expect(result.current.viewMode).toBe('grid');
    expect(titles(result)).toEqual(['Akira', 'Berserk', 'Dragon Ball']);
    expect(result.current.totalOwnedVolumes).toBe(20);
    expect(result.current.completedSeries).toBe(0);
    expect(result.current.availablePublishers).toHaveLength(2);
  });

  it('"Komplett" counts series with a known total whose regular volumes are all owned (spec A2)', () => {
    const list = [
      { id: 1, title: 'A', status: 'Abgeschlossen', total_volumes: 3, owned_volumes: 3, regular_owned: 3, max_regular_number: 3 },
      { id: 2, title: 'B', status: 'Laufend', total_volumes: 3, owned_volumes: 5, regular_owned: 4, max_regular_number: 5 },
      { id: 3, title: 'C', status: 'Laufend', total_volumes: null, owned_volumes: 1, regular_owned: 1, max_regular_number: 1 },
      { id: 4, title: 'D', status: 'Laufend', total_volumes: 0, owned_volumes: 4, regular_owned: 4, max_regular_number: 4 },
      { id: 5, title: 'E', status: 'Abgeschlossen', total_volumes: 10, owned_volumes: 10, regular_owned: 9, extras_owned: 1 }
    ];
    const { result } = renderHook(() => useCollectionFilters(list));
    expect(result.current.completedSeries).toBe(2);
  });

  it('filters and sort apply and are remembered in localStorage', () => {
    const { result } = renderHook(() => useCollectionFilters(mangas));
    act(() => result.current.setStatusFilter('Abgeschlossen'));
    expect(titles(result)).toEqual(['Akira']);
    expect(localStorage.getItem('mangashelf_status_filter')).toBe('Abgeschlossen');

    act(() => {
      result.current.setStatusFilter('ALL');
      result.current.setSortBy('volumes_desc');
      result.current.setSearch('carlsen');
    });
    expect(titles(result)).toEqual(['Akira', 'Dragon Ball']);
    expect(localStorage.getItem('mangashelf_sort_by')).toBe('volumes_desc');
  });

  it('restores the remembered choices on the next mount', () => {
    localStorage.setItem('mangashelf_status_filter', 'Laufend');
    localStorage.setItem('mangashelf_view_mode', 'list');
    const { result } = renderHook(() => useCollectionFilters(mangas));
    expect(result.current.viewMode).toBe('list');
    expect(titles(result)).toEqual(['Berserk']);
  });

  it('a remembered publisher that is gone is reset once the list has loaded, not while loading', () => {
    localStorage.setItem('mangashelf_publisher_filter', 'Tokyopop');
    const { result, rerender } = renderHook(({ list, loading }) => useCollectionFilters(list, { loading }), {
      initialProps: { list: [], loading: true }
    });
    expect(result.current.publisherFilter).toBe('Tokyopop');
    rerender({ list: mangas, loading: true });
    expect(result.current.publisherFilter).toBe('Tokyopop');
    rerender({ list: mangas, loading: false });
    expect(result.current.publisherFilter).toBe('ALL');
    expect(titles(result)).toEqual(['Akira', 'Berserk', 'Dragon Ball']);
    expect(localStorage.getItem('mangashelf_publisher_filter')).toBe('ALL');
  });

  it('a remembered publisher in another spelling becomes the matching option', () => {
    localStorage.setItem('mangashelf_publisher_filter', 'CARLSEN MANGA!');
    const { result } = renderHook(() => useCollectionFilters(mangas));
    expect(result.current.availablePublishers).toContain(result.current.publisherFilter);
    expect(result.current.publisherFilter).toBe('Carlsen Manga');
    expect(titles(result)).toEqual(['Akira', 'Dragon Ball']);
  });

  it('unknown remembered status, sort or view values fall back to the defaults', () => {
    localStorage.setItem('mangashelf_status_filter', 'Unbekannt');
    localStorage.setItem('mangashelf_sort_by', 'bogus');
    localStorage.setItem('mangashelf_view_mode', 'tiles');
    const { result } = renderHook(() => useCollectionFilters(mangas));
    expect(result.current.statusFilter).toBe('ALL');
    expect(result.current.sortBy).toBe('title_asc');
    expect(result.current.viewMode).toBe('grid');
  });

  it('the active status chip stays listed when its count drops to 0', () => {
    const { result, rerender } = renderHook(({ list }) => useCollectionFilters(list), { initialProps: { list: mangas } });
    act(() => result.current.setStatusFilter('Pausiert'));
    rerender({ list: mangas.filter(m => m.status !== 'Pausiert') });
    expect(result.current.statusTabs.map(t => t.id)).toContain('Pausiert');
    expect(result.current.statusTabs.find(t => t.id === 'Pausiert').count).toBe(0);
  });

  it('keeps the search for this tab across a remount', () => {
    const first = renderHook(() => useCollectionFilters(mangas));
    act(() => first.result.current.setSearch('akira'));
    first.unmount();
    const { result } = renderHook(() => useCollectionFilters(mangas));
    expect(result.current.search).toBe('akira');
    expect(localStorage.getItem('mangashelf_search')).toBeNull();
  });

  it('the remembered search belongs to the user who typed it', () => {
    const first = renderHook(() => useCollectionFilters(mangas, { userId: 1 }));
    act(() => first.result.current.setSearch('berserk'));
    first.unmount();

    const other = renderHook(() => useCollectionFilters(mangas, { userId: 2 }));
    expect(other.result.current.search).toBe('');
    expect(titles(other.result)).toEqual(['Akira', 'Berserk', 'Dragon Ball']);
    other.unmount();

    sessionStorage.setItem('mangashelf_search', JSON.stringify({ user: '1', search: 'akira' }));
    const same = renderHook(() => useCollectionFilters(mangas, { userId: 1 }));
    expect(same.result.current.search).toBe('akira');
    expect(titles(same.result)).toEqual(['Akira']);
  });

  it('an old plain-text search entry is not restored', () => {
    sessionStorage.setItem('mangashelf_search', 'Berserk');
    const { result } = renderHook(() => useCollectionFilters(mangas, { userId: 1 }));
    expect(result.current.search).toBe('');
  });

  it('the search tolerates accents, punctuation and one typo and ranks title hits first', () => {
    const list = [
      ...mangas,
      { id: 4, title: 'Pokémon', author: 'Hidenori Kusaka', publisher: 'Egmont', status: 'Laufend', tags: 'Abenteuer' },
      { id: 5, title: 'Monster', author: 'Naoki Urasawa', publisher: 'Carlsen Manga', status: 'Abgeschlossen', tags: 'Thriller, Akira-Fans' }
    ];
    const { result } = renderHook(() => useCollectionFilters(list));
    act(() => result.current.setSearch('pokemon'));
    expect(titles(result)).toEqual(['Pokémon']);
    act(() => result.current.setSearch('berserc'));
    expect(titles(result)).toEqual(['Berserk']);
    act(() => result.current.setSearch('abenteuer'));
    expect(titles(result)).toEqual(['Pokémon']);
    act(() => result.current.setSearch('akira'));
    expect(titles(result)).toEqual(['Akira', 'Monster']);
  });

  it('the filtered list follows the search', () => {
    const { result } = renderHook(() => useCollectionFilters(mangas));
    act(() => result.current.setSearch('dragon'));
    expect(result.current.deferredSearch).toBe('dragon');
    expect(titles(result)).toEqual(['Dragon Ball']);
  });
});

describe('useCollectionFilters: collect, author, grouping and the URL', () => {
  const shelf = [
    { id: 1, title: 'Naruto', author: 'Masashi Kishimoto', publisher: 'Carlsen Manga', status: 'Laufend', total_volumes: 72, regular_owned: 10, missing_count: 0 },
    { id: 2, title: 'Death Note', author: 'Tsugumi Ohba, Takeshi Obata', publisher: 'Tokyopop', status: 'Abgeschlossen', total_volumes: 12, regular_owned: 12, preorder_count: 0 },
    { id: 3, title: 'Bakuman', author: 'Tsugumi Ohba & Takeshi Obata', publisher: 'Tokyopop', status: 'Abgeschlossen', total_volumes: 20, regular_owned: 3, missing_count: 4, collecting: 'abgebrochen' },
    { id: 4, title: 'Boruto', author: 'Ukyo Kodachi', publisher: 'Carlsen Manga', status: 'Laufend', regular_owned: 2, preorder_count: 1, collecting: 'pausiert' }
  ];

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('collect filter: gaps, pre-orders, complete (spec A2), paused and dropped series, with counts', () => {
    const { result } = renderHook(() => useCollectionFilters(shelf));
    expect(result.current.collectCounts).toMatchObject({ ALL: 4, gaps: 1, preorder: 1, complete: 1, pausiert: 1, abgebrochen: 1 });
    act(() => result.current.setCollectFilter('gaps'));
    expect(titles(result)).toEqual(['Naruto']);
    act(() => result.current.setCollectFilter('preorder'));
    expect(titles(result)).toEqual(['Boruto']);
    act(() => result.current.setCollectFilter('complete'));
    expect(titles(result)).toEqual(['Death Note']);
    act(() => result.current.setCollectFilter('abgebrochen'));
    expect(titles(result)).toEqual(['Bakuman']);
    expect(localStorage.getItem('mangashelf_collect_filter')).toBe('abgebrochen');
  });

  it('author filter matches one name of a shared author field, case and spacing independent', () => {
    const { result } = renderHook(() => useCollectionFilters(shelf));
    act(() => result.current.setAuthorFilter('tsugumi  ohba'));
    expect(titles(result)).toEqual(['Bakuman', 'Death Note']);
    act(() => result.current.setAuthorFilter('Takeshi'));
    expect(titles(result)).toEqual([]);
  });

  it('grouping orders the list by section and keeps the sort inside each section', () => {
    const { result } = renderHook(() => useCollectionFilters(shelf));
    act(() => result.current.setGroupBy('status'));
    expect(result.current.groups.map(g => [g.label, g.items.length])).toEqual([['Laufend', 2], ['Abgeschlossen', 2]]);
    expect(titles(result)).toEqual(['Boruto', 'Naruto', 'Bakuman', 'Death Note']);
    act(() => result.current.setGroupBy('none'));
    expect(result.current.groups).toHaveLength(1);
    expect(titles(result)).toEqual(['Bakuman', 'Boruto', 'Death Note', 'Naruto']);
  });

  it('URL values win over localStorage on mount; nothing is written until a filter changes, then only non-defaults', () => {
    localStorage.setItem('mangashelf_status_filter', 'Laufend');
    localStorage.setItem('mangashelf_sort_by', 'title_desc');
    const replace = vi.fn();
    const { result } = renderHook(() => useCollectionFilters(shelf, { url: { search: '?view=radar&author=Ukyo%20Kodachi&status=ALL&group=bogus', replace } }));
    expect(result.current.statusFilter).toBe('ALL');
    expect(result.current.authorFilter).toBe('Ukyo Kodachi');
    expect(result.current.sortBy).toBe('title_desc');
    expect(result.current.groupBy).toBe('none');
    expect(replace).not.toHaveBeenCalled();
    act(() => result.current.setCollectFilter('preorder'));
    expect(replace).toHaveBeenLastCalledWith('?view=radar&author=Ukyo+Kodachi&collect=preorder&sort=title_desc');
  });

  it('a later URL (a link to the open dashboard) sets the filters it names', () => {
    const replace = vi.fn();
    const { result, rerender } = renderHook(({ search }) => useCollectionFilters(shelf, { url: { search, replace } }), { initialProps: { search: '' } });
    expect(result.current.authorFilter).toBe('');
    rerender({ search: '?author=Masashi%20Kishimoto' });
    expect(result.current.authorFilter).toBe('Masashi Kishimoto');
    expect(titles(result)).toEqual(['Naruto']);
  });
});
