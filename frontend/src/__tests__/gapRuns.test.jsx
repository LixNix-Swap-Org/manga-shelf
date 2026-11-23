// Runs of missing volumes on the series page (U1–U4): one row for three or more gaps in a row, its actions, the
// batch dialog with the run's range, the shopping import limited to the run and the compact phone filter bar.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, renderHook, act } from '@testing-library/react';
import { groupGapRuns, GAP_RUN_MIN } from '../utils/volumeHelpers';
import GapRunRow, { gapRunSummary } from '../components/detail/GapRunRow';
import VolumeGridView from '../components/detail/VolumeGridView';
import VolumeListView from '../components/detail/VolumeListView';
import BatchAddModal from '../components/detail/BatchAddModal';
import VolumeFilterBar from '../components/detail/VolumeFilterBar';
import useMpGaps from '../hooks/useMpGaps';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const vol = (n) => ({ isGap: false, volume: { id: n, volume_number: String(n), status: 'Vorhanden' } });
const gap = (n, meta) => ({ isGap: true, gapNumber: n, gapMeta: meta });

describe('groupGapRuns', () => {
  it('folds three or more gaps in a row and keeps shorter runs and volumes as they are', () => {
    const items = [vol(1), gap(2), gap(3), vol(4), gap(5), gap(6), gap(7), gap(8), vol(9)];
    const out = groupGapRuns(items);
    expect(GAP_RUN_MIN).toBe(3);
    expect(out.map((i) => (i.isGapRun ? `run ${i.key}` : i.isGap ? `gap ${i.gapNumber}` : `vol ${i.volume.id}`)))
      .toEqual(['vol 1', 'gap 2', 'gap 3', 'vol 4', 'run 5-8', 'vol 9']);
    expect(out[4].gaps.map((g) => g.gapNumber)).toEqual([5, 6, 7, 8]);
    expect(out[4].expanded).toBe(false);
  });

  it('an expanded run keeps its single gaps right after the row', () => {
    const out = groupGapRuns([gap(1), gap(2), gap(3)], { expanded: new Set(['1-3']) });
    expect(out.map((i) => (i.isGapRun ? 'run' : i.gapNumber))).toEqual(['run', 1, 2, 3]);
    expect(out[0].expanded).toBe(true);
  });

  it('only joins consecutive numbers, also in descending order', () => {
    const asc = groupGapRuns([gap(2), gap(3), gap(5), gap(6), gap(7)]);
    expect(asc.map((i) => (i.isGapRun ? i.key : i.gapNumber))).toEqual([2, 3, '5-7']);
    const desc = groupGapRuns([gap(9), gap(8), gap(7), vol(6)]);
    expect(desc[0]).toMatchObject({ isGapRun: true, key: '9-7', from: 9, to: 7 });
  });

  it('copes with an empty or missing list', () => {
    expect(groupGapRuns([])).toEqual([]);
    expect(groupGapRuns(undefined)).toEqual([]);
  });
});

const run = (numbers, extra = {}) => ({
  isGapRun: true, key: `${numbers[0]}-${numbers[numbers.length - 1]}`, from: numbers[0], to: numbers[numbers.length - 1],
  gaps: numbers.map((n) => gap(n, { price: 7.95, publisher: 'Carlsen Manga' })), expanded: false, ...extra
});

describe('GapRunRow', () => {
  it('sums the prices and names the range', () => {
    expect(gapRunSummary(run([9, 10, 11]), new Map(), {})).toEqual({ low: 9, high: 11, count: 3, total: 23.85, publisher: 'Carlsen Manga' });
    expect(gapRunSummary({ gaps: [gap(3), gap(2), gap(1)] }, new Map(), { publisher: 'Egmont' }))
      .toEqual({ low: 1, high: 3, count: 3, total: null, publisher: 'Egmont' });
    render(<GapRunRow run={run([9, 10, 11])} mpGapMap={new Map()} manga={{}} canEdit />);
    expect(screen.getByText('Band 9 bis 11 fehlen')).toBeTruthy();
    expect(screen.getByText('(3 Bände)')).toBeTruthy();
    expect(screen.getByText(/zusammen 23,85/)).toBeTruthy();
  });

  it('toggles, adds the range and sends only the gaps Manga Passion reports to the shopping list', () => {
    const onToggle = vi.fn();
    const onAddRange = vi.fn();
    const onToShopping = vi.fn();
    render(<GapRunRow run={run([9, 10, 11, 12])} mpGapMap={new Map()} manga={{}} canEdit shoppingGapNumbers={new Set([9, 10, 11])}
      onToggle={onToggle} onAddRange={onAddRange} onToShopping={onToShopping} />);
    const toggle = screen.getByRole('button', { name: 'Band 9 bis 12 einzeln zeigen' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith('9-12');
    fireEvent.click(screen.getByRole('button', { name: /Mehrere erfassen/ }));
    expect(onAddRange).toHaveBeenCalledWith({ from: 9, to: 12 });
    fireEvent.click(screen.getByRole('button', { name: /In die Einkaufsliste/ }));
    expect(onToShopping).toHaveBeenCalledWith([9, 10, 11]);
  });

  it('shows only "Aufklappen" to viewers, offline, or when no gap of the run can go to the shopping list', () => {
    const { rerender } = render(<GapRunRow run={run([1, 2, 3])} mpGapMap={new Map()} manga={{}} canEdit={false} shoppingGapNumbers={new Set([1, 2, 3])} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Aufklappen']);
    rerender(<GapRunRow run={run([1, 2, 3])} mpGapMap={new Map()} manga={{}} canEdit isOffline shoppingGapNumbers={new Set([1, 2, 3])} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    rerender(<GapRunRow run={run([1, 2, 3], { expanded: true })} mpGapMap={new Map()} manga={{}} canEdit shoppingGapNumbers={new Set()} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Zuklappen', 'Mehrere erfassen']);
    expect(screen.getByRole('button', { name: 'Band 1 bis 3 zuklappen' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('the shopping button waits while an import runs or the edition is unconfirmed', () => {
    render(<GapRunRow run={run([1, 2, 3])} mpGapMap={new Map()} manga={{}} canEdit shoppingGapNumbers={new Set([1, 2, 3])}
      fillDisabled fillTitle="Erst die Manga-Passion-Edition bestätigen" />);
    const button = screen.getByRole('button', { name: /In die Einkaufsliste/ });
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/bestätigen/);
  });
});

describe('card and list views', () => {
  const common = { manga: { publisher: 'Carlsen Manga' }, mpGapMap: new Map(), user: { id: 1, role: 'admin' }, readers: [], selectedReaderId: 'ALL',
    handleDeleteVolume: vi.fn(), handleOpenEditVolume: vi.fn(), handleToggleVolume: vi.fn(), handleToggleVolumeRead: vi.fn(), openVolumeGallery: vi.fn() };

  it('the card view draws the run across the whole row, and a single gap card has one "Erfassen" button', () => {
    const setFillingGapNumber = vi.fn();
    const { container } = render(<VolumeGridView {...common} canEdit setFillingGapNumber={setFillingGapNumber}
      displayVolumeItems={[gap(1), run([3, 4, 5])]} gapRunProps={{ shoppingGapNumbers: new Set([3, 4, 5]) }} />);
    expect(container.querySelector('[data-gap-run="3-5"]').className).toContain('col-span-full');
    expect(screen.queryByText('+ Zu Sammlung')).toBeNull();
    expect(screen.queryByText('Klicken zum Erfassen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Band 1 erfassen' }));
    expect(setFillingGapNumber).toHaveBeenCalledWith(1);
  });

  it('a viewer still sees that a single gap is missing', () => {
    render(<VolumeGridView {...common} canEdit={false} setFillingGapNumber={vi.fn()} displayVolumeItems={[gap(1)]} />);
    expect(screen.getByText('Fehlend')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Band 1 erfassen' })).toBeNull();
  });

  it('the list view gives the run one table row over every column', () => {
    const { container, rerender } = render(<VolumeListView {...common} canEdit setFillingGapNumber={vi.fn()} displayVolumeItems={[run([3, 4, 5])]} />);
    expect(container.querySelector('tr[data-gap-run="3-5"] td').getAttribute('colspan')).toBe('9');
    rerender(<VolumeListView {...common} canEdit setFillingGapNumber={vi.fn()} selectionMode displayVolumeItems={[run([3, 4, 5])]} />);
    expect(container.querySelector('tr[data-gap-run="3-5"] td').getAttribute('colspan')).toBe('10');
  });
});

describe('BatchAddModal with a run', () => {
  it('starts with the range of the run instead of after the highest volume', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<BatchAddModal isOpen onClose={vi.fn()} mangaId="1" manga={{ total_volumes: 29 }} volumes={[{ volume_number: '8', type: 'volume' }]}
      range={{ from: 9, to: 14 }} />);
    expect(screen.getByLabelText('Von Band').value).toBe('9');
    expect(screen.getByLabelText('Bis Band').value).toBe('14');
  });
});

describe('useMpGaps: shopping import of one run', () => {
  let toasts;
  beforeEach(() => {
    toasts = recordToasts();
    localStorage.clear();
    vi.stubGlobal('confirm', vi.fn(() => true));
  });
  afterEach(() => toasts.stop());

  it('sends only the numbers of the run', async () => {
    const data = { matched: true, link_confirmed: true, edition: { id: 9, title: 'Bestätigt' }, gaps: [
      { volume_number: '2', type: 'volume' }, { volume_number: '5', type: 'volume' }, { volume_number: '6', type: 'volume' },
      { volume_number: '7', type: 'volume' }, { volume_number: '6', type: 'special_edition', title: 'Collectors Edition' }
    ] };
    const fetchMock = vi.fn(async (url) => (String(url).includes('batch-import') ? fakeResponse(200, { success: true }) : fakeResponse(200, data)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useMpGaps({ id: '1', canEdit: true, volumes: [{ volume_number: '1' }], manga: { total_volumes: 7 },
      fetchManga: vi.fn(async () => {}), setShowMpEditionModal: vi.fn() }));
    await act(async () => { await result.current.fetchMpGaps(); });
    await act(async () => { await result.current.handleBatchFillGaps('Fehlt', { numbers: [5, 6, 7] }); });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes('batch-import'));
    expect(JSON.parse(call[1].body)).toMatchObject({ volume_numbers: ['5', '6', '7'], target_status: 'Fehlt', edition_id: 9 });
  });
});

describe('VolumeFilterBar on phones', () => {
  const props = {
    availablePublishers: ['Carlsen'], baseVolumesForType: [], conditionsList: [], currentReaderReadCount: 1, currentReaderUnreadCount: 1,
    detectedGaps: [], handleResetFilters: vi.fn(), handleSetVolumeViewMode: vi.fn(), handleToggleShowGaps: vi.fn(), hasActiveFilters: false,
    missingCount: 0, mpGapData: null, mpGapLoading: false, mpEnabled: false, ownedCount: 2, preorderedCount: 0, regularVolumeCount: 2,
    schuberCount: 0, setShowMpEditionModal: vi.fn(), setVolumeConditionFilter: vi.fn(), setVolumeFilter: vi.fn(), setVolumePublisherFilter: vi.fn(),
    setVolumeSearch: vi.fn(), setVolumeSort: vi.fn(), setVolumeTypeFilter: vi.fn(), showGaps: true, specialCount: 0, specialEditionCount: 0,
    upcomingCount: 0, volumeConditionFilter: 'ALL', volumeFilter: 'ALL', volumePublisherFilter: 'ALL', volumeSearch: '', volumeSort: 'number_asc',
    volumeTypeFilter: 'ALL', volumeViewMode: 'grid', volumes: []
  };

  it('keeps publisher, condition, sort and search behind "Filter" until it is opened', () => {
    render(<VolumeFilterBar {...props} />);
    const button = screen.getByRole('button', { name: 'Filter' });
    expect(button.className).toContain('sm:hidden');
    const panel = screen.getByLabelText('Verlag filtern').closest('[id]');
    expect(panel.className).toMatch(/(^| )hidden( |$)/);
    expect(panel.className).toContain('sm:flex');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.className).not.toMatch(/(^| )hidden( |$)/);
  });

  it('counts the filters set behind the button', () => {
    render(<VolumeFilterBar {...props} volumePublisherFilter="Carlsen" volumeSort="price_desc" />);
    expect(screen.getByRole('button', { name: 'Filter (2 geändert)' })).toBeTruthy();
  });

  it('shows the type row on phones while a type filter is set', () => {
    render(<VolumeFilterBar {...props} specialCount={2} volumeTypeFilter="special" />);
    expect(screen.getByRole('group', { name: 'Typ-Filter' }).className).not.toMatch(/(^| )hidden( |$)/);
  });

  it('view buttons keep only their icon on phones', () => {
    render(<VolumeFilterBar {...props} />);
    expect(screen.getByText('Karten').className).toContain('hidden sm:inline');
  });
});
