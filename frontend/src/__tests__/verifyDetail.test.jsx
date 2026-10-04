// Detail page layout: shelf row splitting and measuring, undo toasts and BulkActionBar on phones.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, renderHook, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import useShelfLayout, { splitShelfRows, fitsOneFitRow } from '../hooks/useShelfLayout';
import VolumeShelfView from '../components/detail/VolumeShelfView';
import Toaster from '../components/common/Toaster';
import BulkActionBar from '../components/detail/BulkActionBar';
import MangaHeroCard from '../components/detail/MangaHeroCard';
import GapFillModal from '../components/detail/GapFillModal';
import VolumeGridView from '../components/detail/VolumeGridView';
import VolumePhotoManager from '../components/detail/VolumePhotoManager';
import { notify } from '../utils/notify';
import { buildMpGapMap } from '../utils/volumeHelpers';

const classesOf = (el) => String(el.getAttribute('class') || '').split(/\s+/);

class FakeResizeObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    FakeResizeObserver.instances.push(this);
  }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  fire(width, height = 0) { this.callback([...this.targets].map((target) => ({ target, contentRect: { width, height } })), this); }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
  localStorage.clear();
  document.documentElement.style.removeProperty('scroll-padding-bottom');
  document.body.innerHTML = '';
});

const vol = (id, volume_number, extra = {}) => ({ isGap: false, volume: { id, volume_number: String(volume_number), status: 'Vorhanden', ...extra } });
const gap = (n) => ({ isGap: true, gapNumber: n });
// 14 volumes, gaps up to 24, a Schuber and a Special Edition: 26 shelf entries
const auditSeries = () => [
  ...Array.from({ length: 14 }, (_, i) => vol(i + 1, i + 1)),
  ...Array.from({ length: 10 }, (_, i) => gap(15 + i)),
  vol(100, 'Schuber 1', { type: 'schuber' }),
  vol(101, '1', { type: 'special_edition', edition_name: 'Fanbook' })
];
const ROW_MIN_M = { volume: 22, special_edition: 26, schuber: 40, gap: 20 };
const minWidthOf = (item) => {
  if (item.isGap) return ROW_MIN_M.gap;
  if (item.volume.type === 'schuber') return ROW_MIN_M.schuber;
  if (item.volume.type === 'special_edition') return ROW_MIN_M.special_edition;
  return ROW_MIN_M.volume;
};
const rowNeed = (row, gapPx) => row.reduce((sum, item) => sum + minWidthOf(item), 0) + (row.length - 1) * gapPx;

describe('shelf rows follow the measured shelf width', () => {
  it('without a width the scale preset decides (two rows of 13 for 26 entries at M)', () => {
    const rows = splitShelfRows(auditSeries(), { scale: 'm' });
    expect(rows.map((r) => r.length)).toEqual([13, 13]);
  });

  it('on a 360 px phone (232 px shelf) no row is wider than the shelf and nothing is lost', () => {
    const items = auditSeries();
    const rows = splitShelfRows(items, { scale: 'm', width: 232, gap: 4 });
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) expect(rowNeed(row, 4)).toBeLessThanOrEqual(232);
    expect(rows.flat()).toEqual(items);
  });

  it('the preset stays the upper bound on wide shelves', () => {
    const rows = splitShelfRows(auditSeries(), { scale: 'm', width: 1200, gap: 6 });
    expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(16);
    expect(splitShelfRows([], { scale: 'm', width: 232 })).toEqual([[]]);
  });

  it('Auto-Fit keeps one row only while the spines fit', () => {
    expect(fitsOneFitRow(auditSeries(), 0, 4)).toBe(true);
    expect(fitsOneFitRow(auditSeries(), 1100, 6)).toBe(true);
    expect(fitsOneFitRow(auditSeries(), 232, 4)).toBe(false);
  });

  it('useShelfLayout measures the shelf with a ResizeObserver and re-splits the rows', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    localStorage.setItem('mangashelf_shelf_mode', 'rows');
    const items = auditSeries();
    const { result } = renderHook(() => useShelfLayout(items));
    expect(result.current.shelfRows).toHaveLength(2);
    const node = document.createElement('div');
    act(() => result.current.shelfMeasureRef(node));
    const observer = FakeResizeObserver.instances.at(-1);
    expect(observer.targets.has(node)).toBe(true);
    act(() => observer.fire(232.6));
    expect(result.current.shelfRows.length).toBeGreaterThan(2);
    for (const row of result.current.shelfRows) expect(rowNeed(row, 4)).toBeLessThanOrEqual(232);
    act(() => result.current.handleSetShelfMode('fit'));
    expect(result.current.isFitMultiRow).toBe(true);
    act(() => observer.fire(1100));
    expect(result.current.isFitMultiRow).toBe(false);
    expect(result.current.shelfRows).toEqual([items]);
    act(() => result.current.shelfMeasureRef(null));
    expect(observer.targets.size).toBe(0);
  });

  it('VolumeShelfView hands the row wrapper to the measuring ref in every row mode', () => {
    const shelfMeasureRef = vi.fn();
    const base = {
      canEdit: true, handleSetShelfMode: vi.fn(), handleSetShelfScale: vi.fn(), isFitMultiRow: false, renderShelfSpine: () => null,
      scrollShelf: vi.fn(), shelfRows: [[]], shelfScale: 'm', shelfScrollRef: { current: null }, shelfMeasureRef, spineShelfItems: []
    };
    for (const [shelfMode, isFitMultiRow] of [['rows', false], ['fit', false], ['fit', true]]) {
      shelfMeasureRef.mockClear();
      const { unmount } = render(<VolumeShelfView {...base} shelfMode={shelfMode} isFitMultiRow={isFitMultiRow} />);
      const node = shelfMeasureRef.mock.calls.find(([el]) => el)?.[0];
      expect(node, shelfMode).toBeTruthy();
      expect(classesOf(node)).toContain('px-1');
      expect(node.querySelector('.shelf-plank')).toBeTruthy();
      unmount();
    }
  });

  it('shelf layout buttons and the scroll arrows get 44 px touch targets', () => {
    render(<VolumeShelfView canEdit handleSetShelfMode={vi.fn()} handleSetShelfScale={vi.fn()} isFitMultiRow={false}
      renderShelfSpine={() => null} scrollShelf={vi.fn()} shelfMode="scroll" shelfRows={[]} shelfScale="m"
      shelfScrollRef={{ current: null }} spineShelfItems={[]} />);
    for (const name of [/Auto-Fit/, /Regalbretter/, /Scrollen/, 'Nach links scrollen', 'Nach rechts scrollen']) {
      expect(classesOf(screen.getByRole('button', { name })), String(name)).toContain('hit-44');
    }
    expect(classesOf(screen.getByRole('button', { name: 'Nach links scrollen' }))).toContain('[@media(pointer:coarse)]:p-2.5');
  });
});

describe('undo toasts next to the selection bar on phones', () => {
  const mountBar = () => {
    const bar = document.createElement('div');
    bar.id = 'bulk-action-bar';
    const top = window.innerHeight - 140;
    bar.getBoundingClientRect = () => ({ height: 120, top, bottom: top + 120, left: 0, right: 0, width: 0 });
    document.body.appendChild(bar);
    return bar;
  };
  const media = (matching) => (query) => ({ matches: matching.includes(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const hidden = (text) => classesOf(screen.getByText(text).closest('[data-toast]')).includes('hidden');
  const threeUndos = () => act(() => {
    for (let i = 1; i <= 3; i++) notify.success(`Gelesen ${i}`, { action: { label: 'Rückgängig', onClick: vi.fn() } });
  });

  it('below sm only the newest toast shows while the bar is on screen; the others stay mounted', async () => {
    vi.stubGlobal('matchMedia', media(['(max-width: 639px), (max-height: 500px)']));
    mountBar();
    render(<Toaster />);
    threeUndos();
    await waitFor(() => expect(hidden('Gelesen 2')).toBe(true));
    expect(hidden('Gelesen 1')).toBe(true);
    expect(hidden('Gelesen 3')).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Rückgängig' })).toHaveLength(3);
  });

  it('wide screens keep every toast next to the bar', async () => {
    vi.stubGlobal('matchMedia', media([]));
    mountBar();
    render(<Toaster />);
    threeUndos();
    const stack = screen.getByText('Gelesen 1').closest('.fixed');
    await waitFor(() => expect(stack.style.bottom).not.toBe(''));
    for (let i = 1; i <= 3; i++) expect(hidden(`Gelesen ${i}`)).toBe(false);
  });

  it('phones without the selection bar keep every toast', () => {
    vi.stubGlobal('matchMedia', media(['(max-width: 639px), (max-height: 500px)']));
    render(<Toaster />);
    threeUndos();
    for (let i = 1; i <= 3; i++) expect(hidden(`Gelesen ${i}`)).toBe(false);
  });
});

describe('BulkActionBar on phones', () => {
  const props = (over = {}) => ({
    count: 2, visibleCount: 26, allVisibleSelected: false, onSelectAllVisible: vi.fn(), onClear: vi.fn(), onClose: vi.fn(),
    onApply: vi.fn(async () => true), userId: 1, ...over
  });

  it('reserves its height as scroll padding while mounted and follows its size', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    let height = 118.4;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
      return this.id === 'bulk-action-bar' ? { height, top: 0, bottom: height, left: 0, right: 0, width: 0 } : original.call(this);
    });
    const { unmount } = render(<BulkActionBar {...props()} />);
    const root = document.documentElement;
    const padding = () => root.style.getPropertyValue('scroll-padding-bottom').replace(/[()\s]/g, '');
    expect(padding()).toBe('calc119px+0.75rem+5.5rem+envsafe-area-inset-bottom');
    height = 240;
    act(() => FakeResizeObserver.instances.at(-1).fire(300, 240));
    expect(padding()).toBe('calc240px+0.75rem+5.5rem+envsafe-area-inset-bottom');
    unmount();
    expect(root.style.getPropertyValue('scroll-padding-bottom')).toBe('');
    vi.restoreAllMocks();
  });

  it('puts the actions in one scrolling row below sm and on short screens, and shortens the header buttons below sm', () => {
    render(<BulkActionBar {...props()} />);
    const actions = document.querySelector('[data-bulk-actions]');
    expect(classesOf(actions)).toEqual(expect.arrayContaining(['max-sm:flex-nowrap', 'max-sm:overflow-x-auto', 'short:flex-nowrap', 'short:overflow-x-auto']));
    for (const button of actions.querySelectorAll('button')) expect(classesOf(button)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    const count = screen.getByText('2 Bände ausgewählt');
    expect(classesOf(count)).toContain('min-w-0');
    expect(classesOf(count.parentElement)).toContain('max-sm:flex-nowrap');
    const all = screen.getByRole('button', { name: 'Alle sichtbaren (26)' });
    expect(classesOf(all.parentElement)).toEqual(expect.arrayContaining(['max-sm:shrink-0', 'max-sm:flex-nowrap']));
    expect(classesOf(all.querySelector('.max-sm\\:hidden'))).toContain('max-sm:hidden');
    expect(all.querySelector('.max-sm\\:hidden').textContent).toBe('sichtbaren');
    const done = screen.getByRole('button', { name: 'Auswahl beenden' });
    expect(done.querySelector('span.max-sm\\:hidden').textContent).toBe('Fertig');
    expect(done.getAttribute('title')).toBe('Auswahl beenden');
  });
});

describe('series edit header and gap dialog on narrow phones', () => {
  it('the edit header wraps and keeps "Speichern" inside the card', () => {
    render(<MemoryRouter><MangaHeroCard canEdit completionPct={0} editing formData={{ title: 'T', status: 'Laufend', cover_image: '' }}
      handleCoverUpload={vi.fn()} handleDeleteManga={vi.fn()} handleEditLookup={vi.fn()} handleUpdate={vi.fn((e) => e.preventDefault())}
      manga={{ id: 7, title: 'T' }} ownedCount={0} saving={false} setEditLookupResults={vi.fn()} setEditing={vi.fn()}
      startEditing={vi.fn()} cancelEditing={vi.fn()} setFormData={vi.fn()} totalOwnedValue={0} totalTarget={0} uploadingCover={false} /></MemoryRouter>);
    const heading = screen.getByRole('heading', { name: 'Manga bearbeiten' });
    const row = heading.parentElement;
    expect(classesOf(row)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'gap-2']));
    expect(classesOf(heading)).toContain('min-w-0');
    const save = screen.getByRole('button', { name: /Speichern/ });
    expect(classesOf(save.parentElement)).toContain('ml-auto');
  });

  it('a long title breaks inside the gap dialog and the close button keeps its place', () => {
    const title = 'Donaudampfschifffahrtsgesellschaftskapitänsmütze';
    render(<GapFillModal isOpen gapNumber={4} onClose={vi.fn()} manga={{ title }} mangaId="1" mpGapMap={buildMpGapMap([])} canEdit />);
    const subtitle = screen.getByText(title);
    expect(classesOf(subtitle)).toEqual(expect.arrayContaining(['break-words', '[overflow-wrap:anywhere]']));
    expect(classesOf(subtitle.parentElement)).toContain('min-w-0');
    expect(classesOf(subtitle.parentElement.parentElement)).toContain('min-w-0');
    const close = screen.getByRole('button', { name: 'Schließen' });
    expect(classesOf(close)).toEqual(expect.arrayContaining(['hit-44', 'shrink-0']));
    expect(classesOf(close.parentElement)).toContain('gap-2');
  });
});

describe('touch targets of the volume cards and photo order buttons', () => {
  const gridProps = (over = {}) => ({
    canEdit: true, handleDeleteVolume: vi.fn(), handleOpenEditVolume: vi.fn(), handleToggleVolume: vi.fn(), handleToggleVolumeRead: vi.fn(),
    manga: { id: 1, title: 'T' }, mpGapMap: buildMpGapMap([]), openVolumeGallery: vi.fn(), readers: [], selectedReaderId: 'ALL',
    setFillingGapNumber: vi.fn(), user: { id: 1, role: 'admin' }, canToggleOthers: true, gapsOfficial: false, ...over
  });

  it('card icon buttons reach 44 px on touch without overlapping areas, and the gap card link too', () => {
    render(<VolumeGridView {...gridProps({ displayVolumeItems: [vol(5, 5, { images: ['/a.jpg', '/b.jpg'] }), gap(6)] })} />);
    const icons = ['Foto für Band 5 hochladen', 'Band 5 bearbeiten', 'Band 5 löschen'].map((name) => screen.getByRole('button', { name }));
    for (const button of icons) expect(classesOf(button)).toEqual(expect.arrayContaining(['hit-44', '[@media(pointer:coarse)]:p-2.5']));
    expect(classesOf(icons[0].parentElement)).toContain('[@media(pointer:coarse)]:gap-2.5');
    expect(classesOf(screen.getByRole('button', { name: 'Band 6 zu Sammlung hinzufügen' }))).toContain('hit-44');
    expect(classesOf(screen.getByRole('button', { name: '2 Fotos von Band 5 öffnen' }))).toContain('hit-44');
  });

  it('photo move buttons use chevron icons and keep their names', () => {
    render(<VolumePhotoManager editVolForm={{ images: ['/a.jpg', '/b.jpg', '/c.jpg'], cover_image: '/a.jpg', volume_number: '3', type: 'volume' }}
      handleAddImageUrl={vi.fn()} handleMoveVolumeImage={vi.fn()} handleRemoveVolumeImage={vi.fn()} handleSetVolumeCover={vi.fn()}
      handleUploadVolumeImages={vi.fn()} manualImageUrl="" setManualImageUrl={vi.fn()} setShowUrlInput={vi.fn()} showUrlInput={false}
      onPreviewImage={vi.fn()} uploadingVolImage={false} />);
    const left = screen.getByRole('button', { name: 'Foto 2 nach links verschieben' });
    const right = screen.getByRole('button', { name: 'Foto 2 nach rechts verschieben' });
    expect(left.querySelector('svg.lucide-chevron-left').getAttribute('aria-hidden')).toBe('true');
    expect(right.querySelector('svg.lucide-chevron-right').getAttribute('aria-hidden')).toBe('true');
    expect(left.textContent).not.toMatch(/[◀▶]/);
    expect(right.textContent).not.toMatch(/[◀▶]/);
  });
});
