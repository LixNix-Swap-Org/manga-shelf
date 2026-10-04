import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  PRIORITY_OPTIONS, PRIORITY_LABELS, isWishedSeries, wishLabel, normalizeWishPriority, filterWishedSeries,
  mergeWishedPublisherChips, priorityBadgeClass
} from '../utils/priority';
import { buildFormData, updateBody, changedFormFields } from '../hooks/useMangaData';
import { normalizePubName } from '../utils/volumeHelpers';
import { GERMAN_MONTHS, getStatusBadge, getFilterCounts } from '../utils/collectionHelpers';
import { groupMpItemsByDate } from '../utils/radarHelpers';
import MpTimeline from '../components/dashboard/radar/MpTimeline';
import MangaCollectionGrid from '../components/dashboard/MangaCollectionGrid';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';

describe('utils/priority', () => {
  it('one set of labels for volume and series priorities', () => {
    expect(PRIORITY_OPTIONS.map(o => o.label)).toEqual(['Keine', 'Niedrig', 'Mittel', 'Hoch']);
    expect(PRIORITY_LABELS[3]).toBe('★★★ hoch');
    expect(priorityBadgeClass(3)).toMatch(/rose/);
    expect(priorityBadgeClass('x')).toBe(priorityBadgeClass(0));
    expect([null, '', 'x', 4, 1.5].map(normalizeWishPriority)).toEqual([null, null, null, null, null]);
    expect(normalizeWishPriority('2')).toBe(2);
  });

  it('a wished series: the server flag wins, otherwise wish_priority set and nothing owned', () => {
    expect(isWishedSeries({ wished: 1, wish_priority: 2, owned_volumes: 0 })).toBe(true);
    expect(isWishedSeries({ wished: 0, wish_priority: 2, owned_volumes: 0 })).toBe(false);
    expect(isWishedSeries({ wish_priority: 0, owned_volumes: 0 })).toBe(true);
    expect(isWishedSeries({ wish_priority: 2, owned_volumes: 3 })).toBe(false);
    expect(isWishedSeries({ wish_priority: null })).toBe(false);
    expect(wishLabel({ wish_priority: 3, owned_volumes: 0 })).toBe('Wunschliste · hoch');
    expect(wishLabel({ wish_priority: 0, owned_volumes: 0 })).toBe('Wunschliste');
    expect(wishLabel({ wish_priority: 3, owned_volumes: 1 })).toBe('');
  });

  it('filters wished series by publisher chip and search, chips count them', () => {
    const series = [
      { id: 1, title: 'Akira', publisher: 'carlsen manga', wish_priority: 1 },
      { id: 2, title: 'Berserk', publisher: 'Panini Verlags GmbH', wish_priority: 3 }
    ];
    const matches = (s, q) => s.title.toLowerCase().includes(q.toLowerCase());
    expect(filterWishedSeries(series, { publisherFilter: 'Carlsen Manga', normalizePubName }).map(s => s.id)).toEqual([1]);
    expect(filterWishedSeries(series, { search: 'bers', matches }).map(s => s.id)).toEqual([2]);
    expect(filterWishedSeries(series, { prioritySort: true }).map(s => s.id)).toEqual([2, 1]);
    const chips = mergeWishedPublisherChips([{ publisher: 'Carlsen Manga', count: 2, total_price: 14 }], series, normalizePubName);
    expect(chips).toEqual([
      { publisher: 'Carlsen Manga', count: 2, total_price: 14, wished_count: 1 },
      { publisher: 'Panini Verlags GmbH', count: 0, total_price: 0, wished_count: 1 }
    ]);
  });
});

describe('useMangaData form: wishlist fields', () => {
  it('the form carries the toggle and the priority; the PUT sends wish_priority (null when unticked)', () => {
    const base = buildFormData({ title: 'A', wish_priority: 3 });
    expect([base.wish, base.wish_priority]).toEqual([true, '3']);
    const none = buildFormData({ title: 'A', wish_priority: null });
    expect([none.wish, none.wish_priority]).toEqual([false, '2']);

    expect(updateBody(changedFormFields(base, { ...base }), base)).toEqual({});
    const off = { ...base, wish: false };
    expect(updateBody(changedFormFields(base, off), off)).toEqual({ wish_priority: null });
    const lower = { ...base, wish_priority: '1' };
    expect(updateBody(changedFormFields(base, lower), lower)).toEqual({ wish_priority: 1 });
    const on = { ...none, wish: true, title: 'B' };
    expect(updateBody(changedFormFields(none, on), on)).toEqual({ title: 'B', wish_priority: 2 });
  });
});

describe('MpTimeline: wished series and covers', () => {
  const card = (over) => ({
    id: 1, title: 'Berserk', volume_number: '42', publisher: 'Panini', date: '2026-10-02', price: 12, is_digital: false,
    in_collection: true, user_manga_id: 4, match_kind: 'exact', user_volume_status: null, ...over
  });
  const timeline = (over = {}) => (
    <MemoryRouter>
      <MpTimeline
        loadingMp={false} mpError={null} onRetry={vi.fn()} mpYear={2026} mpMonth={10} canEdit onImport={vi.fn()}
        GERMAN_MONTHS={GERMAN_MONTHS} filtersActive={false} onResetFilters={vi.fn()}
        {...over}
        mpDateGroups={groupMpItemsByDate(over.mpData?.items || [])}
      />
    </MemoryRouter>
  );

  it('"Auf Wunschliste" instead of "Reihe im Regal" for a wished series', () => {
    render(timeline({ mpData: { items: [card({ user_manga_wished: true }), card({ id: 2, volume_number: '43' })] } }));
    expect(screen.getAllByText('Auf Wunschliste')).toHaveLength(1);
    expect(screen.getAllByText('Reihe im Regal')).toHaveLength(1);
  });

  it('a broken cover falls back to the placeholder of its own card only', () => {
    render(timeline({ mpData: { items: [card({ cover_image: '/uploads/a.jpg' }), card({ id: 2, volume_number: '43', cover_image: '/uploads/b.jpg' })] } }));
    fireEvent.error(document.querySelector('img[src="/uploads/a.jpg"]'));
    expect(document.querySelector('img[src="/uploads/a.jpg"]')).toBeNull();
    expect(document.querySelector('img[src="/uploads/b.jpg"]')).toBeTruthy();
  });

  it('the loading text is announced by one live region that stays mounted', () => {
    const { rerender } = render(timeline({ mpData: null, loadingMp: true }));
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('Lade Neuerscheinungen von Manga Passion...');
    rerender(timeline({ mpData: { items: [card({})] }, loadingMp: false }));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe('');
  });
});

describe('Shelf: wishlist chip and card badge', () => {
  const wished = { id: 1, title: 'Wunsch', status: 'Laufend', owned_volumes: 0, regular_owned: 0, wish_priority: 3, wished: 1 };
  const owned = { id: 2, title: 'Regal', status: 'Laufend', owned_volumes: 1, regular_owned: 1, wish_priority: 3, wished: 0 };

  it('the toolbar shows the "Wunschliste" chip with the number of wished series', () => {
    const setStatusFilter = vi.fn();
    render(
      <CollectionToolbar
        availablePublishers={[]} filterCounts={getFilterCounts([wished, owned])} filtered={[wished, owned]} publisherFilter="ALL"
        search="" setPublisherFilter={vi.fn()} setSearch={vi.fn()} setSortBy={vi.fn()} setStatusFilter={setStatusFilter}
        setViewMode={vi.fn()} sortBy="title_asc" statusFilter="ALL" viewMode="grid"
      />
    );
    const chip = within(screen.getByRole('group', { name: 'Status-Filter' })).getByRole('button', { name: /Wunschliste/ });
    expect(chip.textContent).toBe('Wunschliste1');
    fireEvent.click(chip);
    expect(setStatusFilter).toHaveBeenCalledWith('WISHLIST');
  });

  it('a wished series card carries the "Wunsch" badge, an owned one does not', () => {
    render(
      <MemoryRouter>
        <MangaCollectionGrid
          canEdit={false} error={null} filtered={[wished, owned]} getStatusBadge={getStatusBadge} handleDeleteManga={vi.fn()}
          handleOpenModal={vi.fn()} isOffline={false} loading={false} onRetry={vi.fn()} publisherFilter="ALL" search=""
          setPublisherFilter={vi.fn()} setSearch={vi.fn()} setStatusFilter={vi.fn()} sortBy="title_asc" statusFilter="ALL" viewMode="grid"
        />
      </MemoryRouter>
    );
    const badges = screen.getAllByTitle('Wunschliste · hoch');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('Wunsch: Wunschliste · hoch');
    expect(badges[0].closest('div').textContent).toContain('Wunsch');
    expect(screen.getByText('0 Bände')).toBeTruthy();
  });
});
