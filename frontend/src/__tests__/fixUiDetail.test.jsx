// Series page layout, touch targets, contrast and keyboard behaviour on small screens.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook, within, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../components/common/BarcodeScannerButton', () => ({
  default: ({ id, children }) => <button type="button" id={id}>{children}</button>
}));

import MangaHeroCard, { isLongDescription } from '../components/detail/MangaHeroCard';
import AddVolumeBar from '../components/detail/AddVolumeBar';
import DetailBottomBar, { revealAboveKeyboard, isTypingTarget } from '../components/detail/DetailBottomBar';
import ReaderBar from '../components/detail/ReaderBar';
import VolumeGridView, { readerInitials } from '../components/detail/VolumeGridView';
import VolumeListView from '../components/detail/VolumeListView';
import VolumeShelfView from '../components/detail/VolumeShelfView';
import ShelfSpine from '../components/detail/ShelfSpine';
import VolumeFilterBar from '../components/detail/VolumeFilterBar';
import BatchAddModal from '../components/detail/BatchAddModal';
import BatchReadModal from '../components/detail/BatchReadModal';
import DetailFields from '../components/detail/volumeEdit/DetailFields';
import AutofillPanel from '../components/detail/volumeEdit/AutofillPanel';
import StatusPriceFields from '../components/detail/volumeEdit/StatusPriceFields';
import useDetailKeyboard, { dialogFormState } from '../hooks/useDetailKeyboard';
import { ownerColor } from '../components/detail/OwnerBadges';
import { NARROW_QUERY } from '../components/common/BottomNav';

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const classesOf = (el) => String(el.getAttribute('class') || '').split(/\s+/);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('MangaHeroCard layout (tablets, landscape phones, long German titles)', () => {
  const props = (over = {}) => ({
    canEdit: true, completionPct: 0, editing: false, formData: { title: 'T', status: 'Laufend', cover_image: '' },
    handleCoverUpload: vi.fn(), handleDeleteManga: vi.fn(), handleEditLookup: vi.fn(), handleUpdate: vi.fn(e => e.preventDefault()),
    manga: { id: 7, title: 'Rechtsschutzversicherungsgesellschaften', author: 'A', cover_image: null, collecting: 'aktiv' },
    ownedCount: 0, saving: false, setEditLookupResults: vi.fn(), setEditing: vi.fn(), startEditing: vi.fn(), cancelEditing: vi.fn(),
    setFormData: vi.fn(), totalOwnedValue: 0, totalTarget: 0, uploadingCover: false,
    ...over
  });

  it('the info column can shrink, title row and actions wrap, the h1 breaks German compounds', () => {
    render(<MemoryRouter><MangaHeroCard {...props()} /></MemoryRouter>);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.getAttribute('lang')).toBe('de');
    expect(classesOf(h1)).toEqual(expect.arrayContaining(['break-words', 'hyphens-auto', '[overflow-wrap:anywhere]']));
    const row = document.getElementById('detail-hero-title-row');
    expect(classesOf(row)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    expect(classesOf(h1.parentElement)).toEqual(expect.arrayContaining(['min-w-0', 'basis-full']));
    const actions = document.getElementById('detail-hero-actions');
    expect(classesOf(actions)).toContain('flex-wrap');
    expect(within(actions).getByRole('button', { name: 'Reihe löschen' })).toBeTruthy();
    expect(within(actions).getByRole('link', { name: /Anime-Adaption/ })).toBeTruthy();
    expect(classesOf(row.closest('.flex-1'))).toContain('min-w-0');
  });

  it('a Japanese title keeps lang="ja"', () => {
    render(<MangaHeroCard {...props({ manga: { id: 7, title: '進撃の巨人' } })} />);
    expect(screen.getByRole('heading', { level: 1 }).getAttribute('lang')).toBe('ja');
  });

  it('a long description is clamped below md behind "Mehr anzeigen"; a short one is not', () => {
    const long = 'Ein sehr langer Klappentext. '.repeat(20);
    expect(isLongDescription(long)).toBe(true);
    expect(isLongDescription('Kurz.')).toBe(false);
    expect(isLongDescription('1\n2\n3\n4\n5\n6')).toBe(true);
    const { rerender } = render(<MangaHeroCard {...props({ manga: { id: 7, title: 'T', description: long } })} />);
    const more = screen.getByRole('button', { name: 'Mehr anzeigen' });
    const text = document.getElementById(more.getAttribute('aria-controls'));
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(classesOf(more)).toEqual(expect.arrayContaining(['md:hidden', 'hit-44']));
    expect(classesOf(text)).toEqual(expect.arrayContaining(['line-clamp-5', 'md:line-clamp-none', 'break-words']));
    fireEvent.click(more);
    expect(screen.getByRole('button', { name: 'Weniger anzeigen' }).getAttribute('aria-expanded')).toBe('true');
    expect(classesOf(text)).not.toContain('line-clamp-5');
    rerender(<MangaHeroCard {...props({ manga: { id: 8, title: 'T', description: 'Kurz.' } })} />);
    expect(screen.queryByRole('button', { name: /anzeigen$/ })).toBeNull();
  });

  it('the collecting chip shows a chevron, sizes to the chosen label and keeps its name', () => {
    render(<MangaHeroCard {...props({ manga: { id: 7, title: 'T', collecting: 'pausiert' } })} />);
    const select = screen.getByLabelText('Sammelstatus');
    expect(select.tagName).toBe('SELECT');
    const chip = select.parentElement;
    expect(chip.querySelector('svg.lucide-chevron-down')).toBeTruthy();
    expect(within(chip).getByTestId('collecting-label').textContent).toBe('Pausiert');
    expect(within(chip).getByTestId('collecting-label').getAttribute('aria-hidden')).toBe('true');
    expect(classesOf(select)).toEqual(expect.arrayContaining(['absolute', 'inset-0', 'opacity-0', 'filter-chip-select']));
  });

  it('the total volumes field opens a number pad', () => {
    render(<MangaHeroCard {...props({ editing: true, formData: { title: 'T', status: 'Laufend', cover_image: '', total_volumes: '3' } })} />);
    expect(screen.getByLabelText('Geplante Gesamtbände').getAttribute('inputmode')).toBe('numeric');
  });
});

describe('AddVolumeBar on phones', () => {
  const props = (over = {}) => ({
    canEdit: true, handleAddSingleVolume: vi.fn(e => e.preventDefault()), handleUploadNewSingleCover: vi.fn(), newVolumeCover: '',
    newVolumeNum: '', newVolumePrice: '', newVolumeReleaseDate: '', newVolumeStatus: 'Vorhanden', newVolumeType: 'volume',
    setNewVolumeCover: vi.fn(), setNewVolumeNum: vi.fn(), setNewVolumePrice: vi.fn(), setNewVolumeReleaseDate: vi.fn(),
    setNewVolumeStatus: vi.fn(), setNewVolumeType: vi.fn(), uploadingNewCover: false, ...over
  });

  it('fields sit in a two-column grid without fixed phone widths, with visible labels', () => {
    render(<AddVolumeBar {...props()} />);
    const grid = document.getElementById('add-volume-fields');
    expect(classesOf(grid)).toEqual(expect.arrayContaining(['grid', 'grid-cols-2', 'sm:flex', 'sm:flex-wrap']));
    for (const cell of grid.children) {
      expect(classesOf(cell).filter((c) => /^w-(28|36)$/.test(c))).toEqual([]);
    }
    for (const name of ['Typ', 'Nummer', 'Preis in Euro', 'Status', 'Erscheinungsdatum (für Release-Radar)']) {
      const field = screen.getByLabelText(name);
      const label = document.querySelector(`label[for="${field.id}"]`);
      expect(classesOf(label), name).not.toContain('sr-only');
      expect(classesOf(field)).toContain('w-full');
    }
    expect(classesOf(grid)).toContain('grid-flow-row-dense');
    expect(classesOf(screen.getByLabelText('Preis in Euro').parentElement)).toContain('col-span-2');
    expect(classesOf(screen.getByLabelText('Erscheinungsdatum (für Release-Radar)').parentElement)).toContain('col-span-2');
    expect(screen.getByLabelText('Nummer').getAttribute('placeholder')).toBe('Band-Nr.');
    expect(classesOf(screen.getByRole('button', { name: /Hinzufügen/ }))).toContain('col-span-2');
  });

  it('the number field opens the number pad, a special\'s free-text name the full keyboard', () => {
    const { rerender } = render(<AddVolumeBar {...props()} />);
    expect(screen.getByLabelText('Nummer').getAttribute('inputmode')).toBe('decimal');
    rerender(<AddVolumeBar {...props({ newVolumeType: 'schuber' })} />);
    expect(screen.getByLabelText('Nummer').getAttribute('inputmode')).toBe('decimal');
    rerender(<AddVolumeBar {...props({ newVolumeType: 'special' })} />);
    expect(screen.getByLabelText('Bezeichnung').getAttribute('inputmode')).toBe('text');
  });

  it('select options and the photo button carry no emoji', () => {
    const { rerender } = render(<AddVolumeBar {...props()} />);
    for (const option of document.querySelectorAll('option')) expect(option.textContent).not.toMatch(EMOJI);
    expect(Array.from(screen.getByLabelText('Status').options).map((o) => o.textContent)).toEqual(['Im Besitz', 'Vorbestellt', 'Erscheint bald', 'Fehlt noch']);
    rerender(<AddVolumeBar {...props({ newVolumeCover: '/uploads/a.jpg' })} />);
    const photo = screen.getByRole('button', { name: 'Anderes Foto auswählen' });
    expect(photo.textContent).toBe('Foto');
    expect(photo.querySelector('svg.lucide-check')).toBeTruthy();
  });
});

describe('DetailBottomBar and the on-screen keyboard', () => {
  let viewport;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn((query) => ({
      matches: query === NARROW_QUERY, media: query, addEventListener() {}, removeEventListener() {}
    })));
    const listeners = new Set();
    viewport = {
      height: window.innerHeight, offsetTop: 0, scale: 1,
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
      fire: () => [...listeners].forEach((fn) => fn()),
      listeners
    };
    vi.stubGlobal('visualViewport', viewport);
  });

  const renderBar = () => render(
    <MemoryRouter>
      <input aria-label="Nummer" />
      <input type="checkbox" aria-label="Auswahl" />
      <DetailBottomBar mangaId={5} volumes={[]} canEdit onAddVolume={vi.fn()} />
    </MemoryRouter>
  );

  it('hides while a text field outside the bar has focus and comes back on blur', () => {
    renderBar();
    const bar = document.getElementById('detail-bottom-bar');
    expect(classesOf(bar)).not.toContain('hidden');
    const field = screen.getByLabelText('Nummer');
    act(() => field.focus());
    expect(classesOf(document.getElementById('detail-bottom-bar'))).toContain('hidden');
    expect(document.getElementById('detail-bottom-bar').getAttribute('data-keyboard')).toBe('open');
    act(() => field.blur());
    expect(classesOf(document.getElementById('detail-bottom-bar'))).not.toContain('hidden');
    act(() => screen.getByLabelText('Auswahl').focus());
    expect(classesOf(document.getElementById('detail-bottom-bar'))).not.toContain('hidden');
  });

  it('hides while the visual viewport is squeezed by the keyboard', () => {
    renderBar();
    act(() => {
      viewport.height = window.innerHeight - 300;
      viewport.fire();
    });
    expect(classesOf(document.getElementById('detail-bottom-bar'))).toContain('hidden');
    act(() => {
      viewport.height = window.innerHeight;
      viewport.fire();
    });
    expect(classesOf(document.getElementById('detail-bottom-bar'))).not.toContain('hidden');
  });

  it('revealAboveKeyboard scrolls the focused field into the visible part once the keyboard is up', () => {
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    field.getBoundingClientRect = () => ({ top: 600, bottom: 640, height: 40 });
    revealAboveKeyboard(field);
    expect(viewport.listeners.size).toBe(1);
    viewport.height = 400;
    viewport.fire();
    expect(scrollBy).toHaveBeenCalledWith({ top: 600 - 180 });
    expect(viewport.listeners.size).toBe(0);
  });

  it('revealAboveKeyboard leaves a visible field alone and stops waiting on its own', () => {
    vi.useFakeTimers();
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    field.getBoundingClientRect = () => ({ top: 100, bottom: 140, height: 40 });
    revealAboveKeyboard(field);
    viewport.height = 400;
    viewport.fire();
    expect(scrollBy).not.toHaveBeenCalled();
    revealAboveKeyboard(field, { timeout: 500 });
    vi.advanceTimersByTime(600);
    expect(viewport.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it('revealAboveKeyboard also lifts the form\'s submit button 16 px above the keyboard while the field stays in view', () => {
    const scrollBy = vi.fn();
    vi.stubGlobal('scrollBy', scrollBy);
    const form = document.createElement('form');
    const field = document.createElement('input');
    const submit = Object.assign(document.createElement('button'), { type: 'submit' });
    form.append(field, submit);
    document.body.appendChild(form);
    field.focus();
    field.getBoundingClientRect = () => ({ top: 339, bottom: 385, height: 46 });
    submit.getBoundingClientRect = () => ({ top: 593, bottom: 636, height: 43 });
    revealAboveKeyboard(field);
    viewport.height = 494;
    viewport.fire();
    expect(scrollBy).toHaveBeenCalledWith({ top: 636 - (494 - 16) });

    scrollBy.mockClear();
    field.getBoundingClientRect = () => ({ top: 100, bottom: 146, height: 46 });
    submit.getBoundingClientRect = () => ({ top: 900, bottom: 943, height: 43 });
    revealAboveKeyboard(field);
    viewport.fire();
    expect(scrollBy).toHaveBeenCalledWith({ top: 100 - 16 });

    scrollBy.mockClear();
    field.getBoundingClientRect = () => ({ top: 700, bottom: 746, height: 46 });
    submit.getBoundingClientRect = () => ({ top: 760, bottom: 803, height: 43 });
    revealAboveKeyboard(field);
    viewport.fire();
    expect(scrollBy).toHaveBeenCalledWith({ top: 700 - 224 });
  });

  it('isTypingTarget: text fields and selects open the keyboard, checkboxes and buttons do not', () => {
    const make = (tag, type) => Object.assign(document.createElement(tag), type ? { type } : {});
    expect(isTypingTarget(make('input'))).toBe(true);
    expect(isTypingTarget(make('input', 'date'))).toBe(true);
    expect(isTypingTarget(make('textarea'))).toBe(true);
    expect(isTypingTarget(make('select'))).toBe(true);
    expect(isTypingTarget(make('input', 'checkbox'))).toBe(false);
    expect(isTypingTarget(make('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('ReaderBar date and stats', () => {
  const props = (over = {}) => ({
    readers: [{ user_id: 1, username: 'admin', read_count: 1, total_owned: 2 }], selectedReaderId: 1, setSelectedReaderId: vi.fn(),
    user: { id: 1 }, ownedCount: 2, currentReaderReadCount: 1, currentReaderUnreadCount: 1, canToggle: true, setReadDate: vi.fn(), ...over
  });

  it('an empty "Gelesen am" field shows its meaning next to it; a picked date does not', () => {
    const { rerender } = render(<ReaderBar {...props()} />);
    const field = screen.getByLabelText('Gelesen am');
    const hint = document.getElementById(field.getAttribute('aria-describedby'));
    expect(hint.textContent).toBe('leer = jetzt');
    expect(classesOf(field)).toContain('min-w-[9rem]');
    expect(classesOf(document.querySelector(`label[for="${field.id}"]`))).toContain('whitespace-nowrap');
    rerender(<ReaderBar {...props({ readDate: '2026-09-01' })} />);
    expect(screen.queryByText('leer = jetzt')).toBeNull();
    expect(screen.getByLabelText('Gelesen am').getAttribute('aria-describedby')).toBeNull();
  });

  it('stats never break inside a value', () => {
    render(<ReaderBar {...props()} />);
    expect(classesOf(screen.getByText(/Gelesen:/))).toContain('whitespace-nowrap');
    expect(classesOf(screen.getByText(/SuB:/))).toContain('whitespace-nowrap');
  });
});

const manga = { id: 1, title: 'One Piece', publisher: 'Carlsen', reader_stats: [] };
const editor = { id: 1, role: 'editor' };
const vol = (over = {}) => ({ id: 1, volume_number: '5', type: 'volume', status: 'Vorhanden', read_users: [], ...over });
const viewProps = (over = {}) => ({
  canEdit: true, displayVolumeItems: [], handleDeleteVolume: vi.fn(), handleOpenEditVolume: vi.fn(),
  handleToggleVolume: vi.fn(), handleToggleVolumeRead: vi.fn(), manga, mpGapMap: new Map(),
  openVolumeGallery: vi.fn(), readers: [], selectedReaderId: 1, setFillingGapNumber: vi.fn(), user: editor, ...over
});
const spineProps = (over = {}) => ({
  currentMode: 'rows', isFitMultiRow: false, totalCount: 5, shelfScale: 'm', mpGapMap: new Map(),
  canEdit: true, setFillingGapNumber: vi.fn(), selectedReaderId: 1, user: editor, manga,
  focusedVolumeId: null, setFocusedVolumeId: vi.fn(), handleOpenEditVolume: vi.fn(), ...over
});

describe('missing volumes keep full-strength text (contrast)', () => {
  it('list: a missing row is not dimmed, only its cover', () => {
    const { container } = render(<VolumeListView {...viewProps({ displayVolumeItems: [
      { isGap: false, volume: vol({ id: 2, status: 'Fehlt', cover_image: '/uploads/c.jpg' }) },
      { isGap: false, volume: vol({ id: 3, status: 'Fehlt' }) }
    ] })} />);
    const row = container.querySelector('tr[data-volume-id="2"]');
    expect(row.getAttribute('data-missing')).toBe('true');
    expect(classesOf(row).some((c) => c.startsWith('opacity-'))).toBe(false);
    expect(classesOf(row.querySelector('img'))).toContain('opacity-60');
    const placeholder = container.querySelector('tr[data-volume-id="3"] td div[aria-hidden="true"]');
    expect(placeholder.textContent).not.toMatch(EMOJI);
    expect(placeholder.querySelector('svg')).toBeTruthy();
  });

  it('shelf: a missing spine dims a background layer, not itself', () => {
    render(<ShelfSpine {...spineProps()} item={{ isGap: false, volume: vol({ id: 7, status: 'Fehlt' }) }} />);
    const spine = screen.getByRole('button', { name: 'Band 5, fehlt' });
    expect(classesOf(spine).filter((c) => /^(opacity-|saturate-)/.test(c))).toEqual([]);
    expect(within(spine).getByTestId('spine-dim')).toBeTruthy();
    expect(screen.getByText('FEHLT').closest('.relative')).toBeTruthy();
  });

  it('owned spines have no dim layer', () => {
    render(<ShelfSpine {...spineProps()} item={{ isGap: false, volume: vol({ id: 8 }) }} />);
    expect(screen.queryByTestId('spine-dim')).toBeNull();
  });

  it('grid: the gap placeholder text is readable amber', () => {
    render(<VolumeGridView {...viewProps({ displayVolumeItems: [{ isGap: true, gapNumber: 4 }] })} />);
    const label = screen.getByTestId('gap-ghost-label');
    expect(classesOf(label)).toContain('text-amber-300');
    expect(classesOf(label).some((c) => /\/\d+$/.test(c))).toBe(false);
  });
});

describe('touch hit areas on the series page', () => {
  it('grid: read chip, "Band N erfassen" and the selection checkbox', () => {
    const { rerender } = render(<VolumeGridView {...viewProps({ displayVolumeItems: [{ isGap: false, volume: vol() }, { isGap: true, gapNumber: 6 }] })} />);
    expect(classesOf(screen.getByRole('button', { name: 'Ungelesen – Band 5' }))).toContain('hit-44');
    expect(classesOf(screen.getByRole('button', { name: 'Band 6 erfassen' }))).toContain('hit-44');
    const onSelectVolume = vi.fn();
    rerender(<VolumeGridView {...viewProps({ displayVolumeItems: [{ isGap: false, volume: vol() }], selectionMode: true, onSelectVolume })} />);
    const box = screen.getByRole('checkbox', { name: 'Band 5 auswählen' });
    expect(classesOf(box)).toEqual(expect.arrayContaining(['w-6', 'h-6']));
    expect(box.parentElement.tagName).toBe('LABEL');
    expect(classesOf(box.parentElement)).toContain('hit-44');
    fireEvent.click(box.parentElement);
    expect(onSelectVolume).toHaveBeenCalledTimes(1);
  });

  it('list: the selection checkbox is 24 px inside a 44 px label; a label click selects once', () => {
    const onSelectVolume = vi.fn();
    render(<VolumeListView {...viewProps({ displayVolumeItems: [{ isGap: false, volume: vol() }], selectionMode: true, isSelected: () => false, onSelectVolume })} />);
    const box = screen.getByRole('checkbox', { name: 'Band 5 auswählen' });
    expect(classesOf(box)).toEqual(expect.arrayContaining(['w-6', 'h-6']));
    expect(classesOf(box.parentElement)).toContain('hit-44');
    fireEvent.click(box.parentElement);
    expect(onSelectVolume).toHaveBeenCalledTimes(1);
  });

  it('shelf size buttons', () => {
    render(<VolumeShelfView canEdit handleSetShelfMode={vi.fn()} handleSetShelfScale={vi.fn()} isFitMultiRow={false}
      renderShelfSpine={() => null} scrollShelf={vi.fn()} shelfMode="rows" shelfRows={[]} shelfScale="m"
      shelfScrollRef={{ current: null }} spineShelfItems={[]} />);
    for (const name of ['Kompakt', 'Standard', 'Groß']) {
      expect(classesOf(screen.getByRole('button', { name }))).toEqual(expect.arrayContaining(['hit-44', '[@media(pointer:coarse)]:min-w-11']));
    }
  });

  it('volume editor: text-link buttons are 44 px tall on touch, the message close button has a hit area', () => {
    render(<DetailFields editVolForm={{ release_date: '2026' }} setEditVolForm={vi.fn()} autofillingVolume={false}
      handleAutofillVolumeData={vi.fn()} manga={{ publisher: 'Carlsen' }} />);
    for (const name of [/Vom Manga \(Carlsen\) übernehmen/, /Auto-Ausfüllen/, /entfernen/]) {
      expect(classesOf(screen.getByRole('button', { name }))).toContain('[@media(pointer:coarse)]:min-h-[44px]');
    }
    expect(screen.getByLabelText(/Erscheinungsjahr/).getAttribute('inputmode')).toBe('numeric');
    expect(screen.getByLabelText(/Seitenzahl/).getAttribute('inputmode')).toBe('numeric');
    cleanup();
    render(<StatusPriceFields editVolForm={{ status: 'Fehlt' }} setEditVolForm={vi.fn()} />);
    expect(screen.getByLabelText(/Kaufpreis/).getAttribute('inputmode')).toBe('decimal');
    expect(screen.getByLabelText(/Zielpreis/).getAttribute('inputmode')).toBe('decimal');
    cleanup();
    render(<AutofillPanel editVolForm={{ type: 'volume' }} autofillingVolume={false} autofillMessage={{ type: 'success', text: 'OK' }}
      setAutofillMessage={vi.fn()} handleAutofillVolumeData={vi.fn()} />);
    expect(classesOf(screen.getByRole('button', { name: 'Meldung schließen' }))).toContain('hit-44');
  });
});

describe('reader avatars', () => {
  it('two-letter initials tell admin and anna apart', () => {
    expect(readerInitials('admin')).toBe('Ad');
    expect(readerInitials('anna')).toBe('An');
    expect(readerInitials('Max Mustermann')).toBe('MM');
    expect(readerInitials('b')).toBe('B');
    expect(readerInitials('')).toBe('?');
  });

  it('each reader gets an own colour and the full name in the label', () => {
    const readers = [{ user_id: 1, username: 'admin' }, { user_id: 2, username: 'anna' }, { user_id: 3, username: 'ben' }];
    render(<VolumeGridView {...viewProps({ readers, canToggleOthers: true, displayVolumeItems: [{ isGap: false, volume: vol({ read_users: [{ user_id: 2 }] }) }] })} />);
    const group = screen.getByRole('group', { name: 'Lesestatus der Leser – Band 5' });
    const admin = within(group).getByRole('button', { name: 'Gelesen: admin – Band 5' });
    const anna = within(group).getByRole('button', { name: 'Gelesen: anna – Band 5' });
    expect(within(admin).getByTestId('reader-initials').textContent).toBe('Ad');
    expect(within(anna).getByTestId('reader-initials').textContent).toBe('An');
    expect(admin.getAttribute('title')).toMatch(/^admin:/);
    expect(ownerColor(1)).not.toBe(ownerColor(2));
    expect(admin.style.borderColor).not.toBe(anna.style.borderColor);
    expect(anna.style.backgroundColor).not.toBe('');
    expect(admin.style.backgroundColor).toBe('');
  });
});

describe('batch dialogs: header and overlay', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['BatchAddModal', () => <BatchAddModal isOpen onClose={vi.fn()} mangaId="1" manga={{}} />, 'Bände hinzufügen'],
    ['BatchReadModal', () => <BatchReadModal isOpen onClose={vi.fn()} mangaId="1" manga={{ reader_stats: [] }} user={{ id: 1, role: 'editor' }} readers={[]} />, 'Lesestatus setzen']
  ])('%s: the close button sits beside the title column, the overlay scrolls', (_, element, label) => {
    vi.stubGlobal('fetch', vi.fn());
    render(element());
    const dialog = screen.getByRole('dialog', { name: label });
    expect(classesOf(dialog)).toContain('dialog-overlay');
    expect(classesOf(dialog.firstElementChild)).toContain('dialog-box');
    const heading = within(dialog).getByRole('heading', { level: 2 });
    const close = within(dialog).getByRole('button', { name: 'Schließen' });
    expect(heading.contains(close)).toBe(false);
    expect(classesOf(heading)).toContain('min-w-0');
    expect(classesOf(heading.parentElement)).toEqual(expect.arrayContaining(['grid', 'grid-cols-[minmax(0,1fr)_auto]']));
    expect(close.parentElement).toBe(heading.parentElement);
    expect(classesOf(close)).toEqual(expect.arrayContaining(['shrink-0', 'hit-44']));
  });

  it('BatchAddModal: the price placeholder fits a half-width field', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<BatchAddModal isOpen onClose={vi.fn()} mangaId="1" manga={{}} />);
    const price = screen.getByLabelText(/Preis pro Band/);
    expect(price.getAttribute('placeholder')).toBe('z. B. 7,99');
    expect(classesOf(price)).toContain('placeholder:font-sans');
  });

  it('"Bis einschließlich Band-Nummer" opens a number pad', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<BatchReadModal isOpen onClose={vi.fn()} mangaId="1" manga={{ reader_stats: [] }} user={{ id: 1, role: 'editor' }} readers={[]} />);
    expect(screen.getByLabelText('Bis einschließlich Band-Nummer').getAttribute('inputmode')).toBe('decimal');
  });
});

describe('no emoji next to Lucide icons', () => {
  it('AutofillPanel button', () => {
    render(<AutofillPanel editVolForm={{ type: 'volume' }} autofillingVolume={false} autofillMessage={null}
      setAutofillMessage={vi.fn()} handleAutofillVolumeData={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Daten jetzt automatisch ausfüllen' });
    expect(button.textContent).not.toMatch(EMOJI);
  });

  it('VolumeFilterBar chips', () => {
    const volumes = [vol({ id: 1 }), vol({ id: 2, status: 'Fehlt' }), vol({ id: 3, status: 'Vorbestellt' }),
      vol({ id: 4, type: 'schuber', volume_number: '1' }), vol({ id: 5, type: 'special_edition' }), vol({ id: 6, type: 'special', volume_number: 'Artbook' })];
    render(<VolumeFilterBar availablePublishers={[]} baseVolumesForType={volumes} conditionsList={[]} detectedGaps={[]}
      handleResetFilters={vi.fn()} handleSetVolumeViewMode={vi.fn()} handleToggleShowGaps={vi.fn()} setShowMpEditionModal={vi.fn()}
      setVolumeConditionFilter={vi.fn()} setVolumeFilter={vi.fn()} setVolumePublisherFilter={vi.fn()} setVolumeSearch={vi.fn()}
      setVolumeSort={vi.fn()} setVolumeTypeFilter={vi.fn()} volumeConditionFilter="ALL" volumeFilter="ALL" volumePublisherFilter="ALL"
      volumeSearch="" volumeSort="number_asc" volumeTypeFilter="ALL" volumeViewMode="grid" volumes={volumes} isOffline />);
    for (const button of screen.getAllByRole('button')) expect(button.textContent, button.textContent).not.toMatch(EMOJI);
    expect(screen.getByRole('button', { name: /^Im Besitz \(/ }).querySelector('svg')).toBeTruthy();
  });
});

describe('Escape in the volume editor', () => {
  function useHarness(props) {
    useDetailKeyboard({
      lightboxData: null, setLightboxData: vi.fn(), activeVolume: null, setActiveVolume: vi.fn(),
      showBatchModal: false, setShowBatchModal: vi.fn(), showBatchReadModal: false, setShowBatchReadModal: vi.fn(),
      fillingGapNumber: null, setFillingGapNumber: vi.fn(), showMpEditionModal: false, setShowMpEditionModal: vi.fn(),
      editing: false, setEditing: vi.fn(), filteredVolumes: [], canEdit: true, handleToggleVolumeRead: vi.fn(),
      handleOpenEditVolume: vi.fn(), focusedVolumeId: null, setFocusedVolumeId: vi.fn(), ...props
    });
  }
  const esc = (target) => fireEvent.keyDown(target, { key: 'Escape', bubbles: true, cancelable: true });

  function mountDialog() {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.tabIndex = -1;
    dialog.innerHTML = '<input id="nr" value="3"><select id="type"><option value="volume">Einzelband</option><option value="schuber">Schuber</option></select>'
      + '<button type="button" aria-pressed="true">Im Besitz</button><button type="button" aria-pressed="false">Fehlt</button>';
    document.body.appendChild(dialog);
    return dialog;
  }

  it('an untouched editor closes on Escape from a field or select', () => {
    const setActiveVolume = vi.fn();
    renderHook(() => useHarness({ activeVolume: { id: 1 }, setActiveVolume }));
    const dialog = mountDialog();
    dialog.focus();
    const field = dialog.querySelector('#nr');
    field.focus();
    esc(field);
    expect(setActiveVolume).toHaveBeenCalledWith(null);
    setActiveVolume.mockClear();
    esc(dialog.querySelector('#type'));
    expect(setActiveVolume).toHaveBeenCalledWith(null);
  });

  it('a changed field, select or status toggle keeps the editor open for Escape from a field', () => {
    const setActiveVolume = vi.fn();
    renderHook(() => useHarness({ activeVolume: { id: 1 }, setActiveVolume }));
    const dialog = mountDialog();
    dialog.focus();
    const field = dialog.querySelector('#nr');
    field.value = '4';
    esc(field);
    expect(setActiveVolume).not.toHaveBeenCalled();
    field.value = '3';
    const pressed = dialog.querySelectorAll('[aria-pressed]');
    pressed[0].setAttribute('aria-pressed', 'false');
    pressed[1].setAttribute('aria-pressed', 'true');
    esc(field);
    expect(setActiveVolume).not.toHaveBeenCalled();
    esc(document.body);
    expect(setActiveVolume).toHaveBeenCalledWith(null);
  });

  it('dialogFormState ignores file pickers and reads checkboxes', () => {
    const root = document.createElement('div');
    root.innerHTML = '<input type="file"><input type="checkbox" checked><input value="x">';
    expect(dialogFormState(root)).toBe(JSON.stringify([['true', 'x'], []]));
    expect(dialogFormState(null)).toBe(null);
  });

  it('a clean series form closes on Escape from its fields without asking; a dirty one keeps them', () => {
    const cancelEditing = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    const input = document.createElement('input');
    document.body.appendChild(input);
    const { rerender } = renderHook((p) => useHarness(p), { initialProps: { editing: true, isEditDirty: false, cancelEditing } });
    esc(input);
    expect(cancelEditing).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
    rerender({ editing: true, isEditDirty: true, cancelEditing });
    esc(input);
    expect(cancelEditing).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});
