// Volume views (shelf, grid, list), spines, filter bar and detail keyboard shortcuts.
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ShelfSpine from '../components/detail/ShelfSpine';
import VolumeShelfView from '../components/detail/VolumeShelfView';
import VolumeGridView from '../components/detail/VolumeGridView';
import VolumeListView from '../components/detail/VolumeListView';
import OwnerBadges from '../components/detail/OwnerBadges';
import VolumeFilterBar from '../components/detail/VolumeFilterBar';
import useDetailKeyboard from '../hooks/useDetailKeyboard';
import { inferVolumeType } from '../utils/volumeHelpers';
import {
  getVolumeBadge, formatEuro, formatShortDate, getSpineAriaLabel, countShelfItems, gapLabel, releaseVerb,
  isCollectibleVolume, mpPillText
} from '../components/detail/volumeViewHelpers';

const manga = { id: 1, title: 'One Piece', publisher: 'Carlsen', reader_stats: [] };
const editor = { id: 1, role: 'editor' };
const vol = (over = {}) => ({ id: 1, volume_number: '5', type: 'volume', status: 'Vorhanden', read_users: [], ...over });

const spineProps = (over = {}) => ({
  currentMode: 'rows', isFitMultiRow: false, totalCount: 5, shelfScale: 'm', mpGapMap: new Map(),
  canEdit: true, setFillingGapNumber: vi.fn(), selectedReaderId: 1, user: editor, manga,
  focusedVolumeId: null, setFocusedVolumeId: vi.fn(), handleOpenEditVolume: vi.fn(), ...over
});

const viewProps = (over = {}) => ({
  canEdit: true, displayVolumeItems: [], handleDeleteVolume: vi.fn(), handleOpenEditVolume: vi.fn(),
  handleToggleVolume: vi.fn(), handleToggleVolumeRead: vi.fn(), manga, mpGapMap: new Map(),
  openVolumeGallery: vi.fn(), readers: [], selectedReaderId: 1, setFillingGapNumber: vi.fn(), user: editor, ...over
});

const nbsp = (s) => s.replace(/\u00a0|\u202f/g, ' ');

describe('volume view helpers', () => {
  const fixtures = [
    vol({ notes: 'Limited Edition vergriffen, normale Ausgabe', volume_number: '14' }),
    vol({ volume_number: 'Extra' }),
    vol({ volume_number: 'Schuber-Edition 3' }),
    vol({ type: 'special_edition', volume_number: '5', notes: 'Collectors Edition' }),
    vol({ type: 'special', volume_number: 'Special Edition Artbook' }),
    vol({ type: null, volume_number: 'Schuber 3' }),
    vol({ type: null, volume_number: 'Limited Edition 3' }),
    vol({ type: null, volume_number: '5', notes: 'Limited Edition' })
  ];

  it('the badge type always equals inferVolumeType, a stored type wins over keywords', () => {
    for (const v of fixtures) expect(getVolumeBadge(v).type).toBe(inferVolumeType(v));
    expect(getVolumeBadge(fixtures[0])).toMatchObject({ type: 'volume', text: 'Band 14' });
    expect(getVolumeBadge(fixtures[1]).type).toBe('volume');
    expect(getVolumeBadge(fixtures[3])).toMatchObject({ type: 'special_edition', label: 'Collectors Edition', text: 'Band 5' });
    expect(getVolumeBadge(fixtures[4]).type).toBe('special');
    expect(getVolumeBadge(fixtures[5])).toMatchObject({ type: 'schuber', text: '3' });
    expect(getVolumeBadge(fixtures[6]).type).toBe('special_edition');
  });

  it('formats prices and dates the German way', () => {
    expect(nbsp(formatEuro(7.5))).toBe('7,50 €');
    expect(nbsp(formatEuro('7.5'))).toBe('7,50 €');
    expect(nbsp(formatEuro(1234.5))).toBe('1.234,50 €');
    expect(nbsp(formatEuro(0))).toBe('0,00 €');
    expect(formatEuro(null)).toBe('');
    expect(formatEuro('')).toBe('');
    expect(formatEuro('abc')).toBe('');
    expect(formatShortDate('2026-11-12')).toBe('12.11.2026');
    expect(formatShortDate('2026-11')).toBe('11/2026');
    expect(formatShortDate('2026')).toBe('2026');
    expect(formatShortDate(null)).toBe('');
  });

  it('release wording follows is_released, otherwise the date', () => {
    const today = new Date(2026, 9, 3);
    expect(releaseVerb('2026-11-12', undefined, today)).toBe('erscheint');
    expect(releaseVerb('2025-01-01', undefined, today)).toBe('erschienen');
    expect(releaseVerb('2026-10', undefined, today)).toBe('erscheint');
    expect(releaseVerb('2030-01-01', true, today)).toBe('erschienen');
  });

  it('spine label carries status and read state', () => {
    expect(getSpineAriaLabel(vol({ status: 'Fehlt' }), false)).toBe('Band 5, fehlt');
    expect(getSpineAriaLabel(vol({ status: 'Vorbestellt' }), false)).toBe('Band 5, vorbestellt');
    expect(getSpineAriaLabel(vol({ status: 'Bestellt' }), false)).toBe('Band 5, bestellt');
    expect(getSpineAriaLabel(vol({ status: 'Erscheint bald' }), false)).toBe('Band 5, erscheint bald');
    expect(getSpineAriaLabel(vol(), true)).toBe('Band 5, gelesen');
    expect(getSpineAriaLabel(vol(), false)).toBe('Band 5');
  });

  it('counts shelf items and labels gaps', () => {
    const items = [...Array(20)].map((_, i) => ({ isGap: false, volume: vol({ id: i }) }))
      .concat([...Array(5)].map((_, i) => ({ isGap: true, gapNumber: 30 + i })));
    expect(countShelfItems(items)).toEqual({ volumes: 20, gaps: 5 });
    expect(gapLabel(true)).toBe('Offizielle Lücke in Reihe');
    expect(gapLabel(false)).toBe('Lücke (geschätzt)');
    expect(gapLabel(undefined)).toBe('Lücke in Reihe');
    expect(['Vorhanden', 'Fehlt', 'Vorbestellt', 'Bestellt', 'Erscheint bald'].map(status => isCollectibleVolume({ status })))
      .toEqual([true, true, false, false, false]);
    expect(mpPillText({ mpGapError: 'Netzwerkfehler' })).toBe('Nicht erreichbar');
    expect(mpPillText({ mpGapData: { matched: false } })).toBe('Keine Edition');
    expect(mpPillText({ mpGapData: { edition: { publisher: 'Carlsen' } }, mpGapError: 'x' })).toBe('Carlsen');
  });

  it('a Manga Passion outage is not reported as "no edition"', () => {
    const outage = { success: false, matched: false, unavailable: true, message: 'Manga Passion nicht erreichbar' };
    expect(mpPillText({ mpGapData: outage })).toBe('Nicht erreichbar');
  });
});

describe('VolumeFilterBar Manga Passion pill', () => {
  const barProps = (over = {}) => ({
    availablePublishers: [], baseVolumesForType: [], conditionsList: [], currentReaderReadCount: 0, currentReaderUnreadCount: 0,
    detectedGaps: [], handleResetFilters: vi.fn(), handleSetVolumeViewMode: vi.fn(), handleToggleShowGaps: vi.fn(),
    hasActiveFilters: false, missingCount: 0, mpGapData: null, mpGapLoading: false, ownedCount: 0, preorderedCount: 0,
    regularVolumeCount: 0, schuberCount: 0, setShowMpEditionModal: vi.fn(), setVolumeConditionFilter: vi.fn(),
    setVolumeFilter: vi.fn(), setVolumePublisherFilter: vi.fn(), setVolumeSearch: vi.fn(), setVolumeSort: vi.fn(),
    setVolumeTypeFilter: vi.fn(), showGaps: false, specialCount: 0, specialEditionCount: 0, upcomingCount: 0,
    volumeConditionFilter: 'ALL', volumeFilter: 'ALL', volumePublisherFilter: 'ALL', volumeSearch: '', volumeSort: 'number_asc',
    volumeTypeFilter: 'ALL', volumeViewMode: 'grid', volumes: [], ...over
  });

  it('is shown online and names an outage', () => {
    render(<VolumeFilterBar {...barProps({ mpGapData: { matched: false, unavailable: true, message: 'Zeitüberschreitung' } })} />);
    const pill = screen.getByTitle('Manga Passion: Zeitüberschreitung');
    expect(pill.textContent).toContain('Nicht erreichbar');
  });

  it('is hidden offline', () => {
    render(<VolumeFilterBar {...barProps({ isOffline: true })} />);
    expect(screen.queryByText('Manga Passion:')).toBeNull();
    expect(screen.queryByText('Abgleich')).toBeNull();
  });
});

describe('ShelfSpine', () => {
  it('editor spine is a named button with data-volume-id; Enter opens the editor', () => {
    const p = spineProps();
    render(<ShelfSpine {...p} item={{ isGap: false, volume: vol({ id: 7, status: 'Fehlt' }) }} />);
    const spine = screen.getByRole('button', { name: 'Band 5, fehlt' });
    expect(spine.getAttribute('data-volume-id')).toBe('7');
    fireEvent.keyDown(spine, { key: 'Enter' });
    expect(p.handleOpenEditVolume).toHaveBeenCalledTimes(1);
  });

  it('announces "gelesen" only for owned read volumes', () => {
    render(<ShelfSpine {...spineProps()} item={{ isGap: false, volume: vol({ read_users: [{ user_id: 1 }] }) }} />);
    expect(screen.getByRole('button', { name: 'Band 5, gelesen' })).toBeTruthy();
  });

  it('visitors get no inert button', () => {
    render(<ShelfSpine {...spineProps({ canEdit: false })} item={{ isGap: false, volume: vol() }} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: 'Band 5' }).getAttribute('tabindex')).toBe('-1');
  });

  it('a stored "volume" with Limited Edition in the notes is drawn as a regular volume', () => {
    const { container } = render(<ShelfSpine {...spineProps()} item={{ isGap: false, volume: vol({ notes: 'mit Limited Edition Poster' }) }} />);
    expect(container.querySelector('.manga-spine-special')).toBeNull();
    expect(screen.queryByText('LTD')).toBeNull();
  });

  it('a real special edition keeps its label', () => {
    const { container } = render(<ShelfSpine {...spineProps()} item={{ isGap: false, volume: vol({ type: 'special_edition', notes: 'Limited Edition' }) }} />);
    expect(container.querySelector('.manga-spine-special')).not.toBeNull();
    expect(screen.getByText('LTD')).toBeTruthy();
  });

  it('shows the own label for "Bestellt"', () => {
    render(<ShelfSpine {...spineProps()} item={{ isGap: false, volume: vol({ status: 'Bestellt' }) }} />);
    expect(screen.getByTitle('Bestellt').textContent).toBe('BESTELLT');
    expect(screen.queryByText('FEHLT')).toBeNull();
  });

  it('ghost spine is a keyboard-reachable button for editors with a lazy cover', () => {
    const p = spineProps({ mpGapMap: new Map([['3', { price: 7.5, cover_image: 'https://x/c.jpg' }]]) });
    const { container } = render(<ShelfSpine {...p} item={{ isGap: true, gapNumber: 3 }} />);
    const ghost = screen.getByRole('button', { name: /Lücke: Band 3 erfassen/ });
    expect(ghost.tagName).toBe('BUTTON');
    fireEvent.click(ghost);
    expect(p.setFillingGapNumber).toHaveBeenCalledWith(3);
    const img = container.querySelector('img');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(container.innerHTML).not.toContain('background-image');
  });

  it('ghost spine for visitors is a named, non-interactive image', () => {
    const p = spineProps({ canEdit: false });
    render(<ShelfSpine {...p} item={{ isGap: true, gapNumber: 4 }} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: 'Lücke: Band 4 fehlt' })).toBeTruthy();
  });
});

function KeyboardShelf({ volumes, canEdit, onToggle }) {
  const [focusedVolumeId, setFocusedVolumeId] = useState(null);
  useDetailKeyboard({
    lightboxData: null, setLightboxData: vi.fn(), activeVolume: null, setActiveVolume: vi.fn(),
    showBatchModal: false, setShowBatchModal: vi.fn(), showBatchReadModal: false, setShowBatchReadModal: vi.fn(),
    fillingGapNumber: null, setFillingGapNumber: vi.fn(), showMpEditionModal: false, setShowMpEditionModal: vi.fn(),
    editing: false, setEditing: vi.fn(), volumeViewMode: 'spine', filteredVolumes: volumes, focusedVolumeId,
    setFocusedVolumeId, canEdit, handleToggleVolumeRead: onToggle, handleOpenEditVolume: vi.fn()
  });
  return (
    <div>
      {volumes.map(v => (
        <ShelfSpine key={v.id} {...spineProps({ canEdit, focusedVolumeId, setFocusedVolumeId })} item={{ isGap: false, volume: v }} />
      ))}
    </div>
  );
}

describe('shelf keyboard', () => {
  const volumes = [vol({ id: 1, volume_number: '1' }), vol({ id: 2, volume_number: '2' })];

  it('Space on a focused spine toggles that volume exactly once and does not scroll', () => {
    const onToggle = vi.fn();
    render(<KeyboardShelf volumes={volumes} canEdit onToggle={onToggle} />);
    const spine = screen.getByRole('button', { name: 'Band 2' });
    spine.focus();
    const notPrevented = fireEvent.keyDown(spine, { key: ' ' });
    expect(notPrevented).toBe(false);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0][0].id).toBe(2);
  });

  it('J moves DOM focus to the next spine and scrolls it into view; Space then toggles that one', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      const onToggle = vi.fn();
      render(<KeyboardShelf volumes={volumes} canEdit onToggle={onToggle} />);
      fireEvent.click(screen.getByRole('button', { name: 'Band 1' }));
      fireEvent.keyDown(document.activeElement, { key: 'j' });
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Band 2' }));
      expect(scroll).toHaveBeenCalled();
      fireEvent.keyDown(document.activeElement, { key: ' ' });
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(onToggle.mock.calls[0][0].id).toBe(2);
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });

  it('visitors toggle nothing', () => {
    const onToggle = vi.fn();
    render(<KeyboardShelf volumes={volumes} canEdit={false} onToggle={onToggle} />);
    fireEvent.keyDown(screen.getByRole('img', { name: 'Band 1' }), { key: ' ' });
    expect(onToggle).not.toHaveBeenCalled();
  });
});

describe('VolumeShelfView', () => {
  const shelf = (over = {}) => ({
    canEdit: true, handleSetShelfMode: vi.fn(), handleSetShelfScale: vi.fn(), isFitMultiRow: false,
    renderShelfSpine: () => null, scrollShelf: vi.fn(), shelfMode: 'rows', shelfRows: [], shelfScale: 'm',
    shelfScrollRef: { current: null }, spineShelfItems: [], ...over
  });
  const items = (real, gaps) => [...Array(real)].map((_, i) => ({ isGap: false, volume: vol({ id: i }) }))
    .concat([...Array(gaps)].map((_, i) => ({ isGap: true, gapNumber: 100 + i })));

  it('counts real volumes and gaps separately', () => {
    const { rerender } = render(<VolumeShelfView {...shelf({ spineShelfItems: items(20, 5) })} />);
    expect(screen.getByText('(20 Bände + 5 Lücken)')).toBeTruthy();
    rerender(<VolumeShelfView {...shelf({ spineShelfItems: items(1, 1) })} />);
    expect(screen.getByText('(1 Band + 1 Lücke)')).toBeTruthy();
    rerender(<VolumeShelfView {...shelf({ spineShelfItems: items(3, 0) })} />);
    expect(screen.getByText('(3 Bände)')).toBeTruthy();
  });

  it('shows the Space / E hint only to editors', () => {
    const { rerender } = render(<VolumeShelfView {...shelf({ canEdit: false })} />);
    expect(screen.queryByText('Gelesen')).toBeNull();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.getByText('J')).toBeTruthy();
    rerender(<VolumeShelfView {...shelf()} />);
    expect(screen.getByText('Gelesen')).toBeTruthy();
  });

  it('layout and size toggles expose their state', () => {
    render(<VolumeShelfView {...shelf({ shelfMode: 'rows', shelfScale: 's' })} />);
    expect(screen.getByRole('button', { name: /Regalbretter/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Auto-Fit/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /Scrollen/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Kompakt' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Groß' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('VolumeGridView', () => {
  const readers = [{ user_id: 1, display_name: 'Alex' }, { user_id: 2, username: 'mia' }];

  it('uses the stored type for the badge (no Limited badge for a regular volume)', () => {
    render(<VolumeGridView {...viewProps({ displayVolumeItems: [{ isGap: false, volume: vol({ volume_number: '14', notes: 'Limited Edition vergriffen' }) }] })} />);
    expect(screen.getByText('Band 14')).toBeTruthy();
    expect(screen.queryByText('Limited')).toBeNull();
  });

  it('shows German date and price on cards', () => {
    render(<VolumeGridView {...viewProps({ displayVolumeItems: [{ isGap: false, volume: vol({ price: '7.5', release_date: '2026-11-12' }) }] })} />);
    expect(screen.getByText('12.11.2026')).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && nbsp(el.textContent) === '7,50 €')).toBeTruthy();
  });

  it('reader badges carry name and pressed state; non-admins cannot toggle others', () => {
    const p = viewProps({ readers, canToggleOthers: false, displayVolumeItems: [{ isGap: false, volume: vol({ read_users: [{ user_id: 1 }] }) }] });
    render(<VolumeGridView {...p} />);
    const group = screen.getByRole('group', { name: 'Lesestatus der Leser – Band 5' });
    const alex = within(group).getByRole('button', { name: 'Gelesen: Alex – Band 5' });
    expect(alex.getAttribute('aria-pressed')).toBe('true');
    expect(within(group).queryByRole('button', { name: /mia/ })).toBeNull();
    expect(within(group).getByRole('img', { name: 'mia: ungelesen' })).toBeTruthy();
    fireEvent.click(alex);
    expect(p.handleToggleVolumeRead).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 1, expect.anything());
  });

  it('admins toggle every reader', () => {
    render(<VolumeGridView {...viewProps({ readers, canToggleOthers: true, displayVolumeItems: [{ isGap: false, volume: vol() }] })} />);
    expect(screen.getByRole('button', { name: 'Gelesen: mia – Band 5' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('the main read button is disabled when a non-admin views another reader', () => {
    render(<VolumeGridView {...viewProps({ selectedReaderId: 2, canToggleOthers: false, displayVolumeItems: [{ isGap: false, volume: vol() }] })} />);
    expect(screen.getByRole('button', { name: /Ungelesen/ }).disabled).toBe(true);
  });

  it('delete hands over the volume object', () => {
    const p = viewProps({ displayVolumeItems: [{ isGap: false, volume: vol({ id: 9 }) }] });
    render(<VolumeGridView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Band 5 löschen' }));
    expect(p.handleDeleteVolume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 9 }));
  });

  it('canToggle without canEdit (offline editor): status and own read toggles work, editing stays hidden', () => {
    const p = viewProps({ canEdit: false, canToggle: true, canToggleOthers: false, displayVolumeItems: [{ isGap: false, volume: vol({ id: 4 }) }] });
    render(<VolumeGridView {...p} />);
    const status = screen.getByRole('button', { name: /^Status: Vorhanden/ });
    expect(status.disabled).toBe(false);
    fireEvent.click(status);
    expect(p.handleToggleVolume).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
    fireEvent.click(screen.getByRole('button', { name: /Ungelesen/ }));
    expect(p.handleToggleVolumeRead).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /löschen$/ })).toBeNull();
  });

  it('gives "Bestellt" its own label', () => {
    render(<VolumeGridView {...viewProps({ displayVolumeItems: [{ isGap: false, volume: vol({ status: 'Bestellt' }) }] })} />);
    expect(screen.getByText('Bestellt')).toBeTruthy();
  });

  it('gap card for visitors is not clickable', () => {
    const p = viewProps({ canEdit: false, displayVolumeItems: [{ isGap: true, gapNumber: 3 }] });
    const { container } = render(<VolumeGridView {...p} />);
    const card = container.querySelector('.border-dashed');
    expect(card.className).not.toContain('cursor-pointer');
    fireEvent.click(card);
    expect(p.setFillingGapNumber).not.toHaveBeenCalled();
  });
});

describe('VolumeListView', () => {
  const gapMap = new Map([['12', { price: 7.5, release_date: '2026-11-12', cover_image: 'https://x/c.jpg', is_released: false }]]);

  it('gap row: date in the title cell, "-" under Zustand, lazy cover, German price', () => {
    const { container } = render(<VolumeListView {...viewProps({ mpGapMap: gapMap, displayVolumeItems: [{ isGap: true, gapNumber: 12 }] })} />);
    const cells = container.querySelectorAll('tbody tr td');
    expect(cells).toHaveLength(9);
    expect(cells[1].textContent).toContain('erscheint 12.11.2026');
    expect(cells[7].querySelector('[aria-hidden="true"]').textContent).toBe('-');
    expect(cells[7].querySelector('.sr-only').textContent).toBe('keine Angabe');
    expect(nbsp(cells[6].textContent)).toBe('7,50 €');
    expect(container.querySelector('img').getAttribute('loading')).toBe('lazy');
  });

  it('gap caption depends on whether the gaps are official', () => {
    const item = [{ isGap: true, gapNumber: 3 }];
    const { rerender } = render(<VolumeListView {...viewProps({ displayVolumeItems: item, gapsOfficial: false })} />);
    expect(screen.getByText('Lücke (geschätzt)')).toBeTruthy();
    rerender(<VolumeListView {...viewProps({ displayVolumeItems: item, gapsOfficial: true })} />);
    expect(screen.getByText('Offizielle Lücke in Reihe')).toBeTruthy();
  });

  it('canToggle without canEdit: the status and read buttons work, edit and delete are not offered', () => {
    const p = viewProps({ canEdit: false, canToggle: true, canToggleOthers: false, displayVolumeItems: [{ isGap: false, volume: vol({ id: 4 }) }] });
    render(<VolumeListView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Im Besitz/ }));
    expect(p.handleToggleVolume).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
    fireEvent.click(screen.getByRole('button', { name: /Ungelesen/ }));
    expect(p.handleToggleVolumeRead).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /löschen/ })).toBeNull();
  });

  it('gap row looks and acts inert for visitors', () => {
    const p = viewProps({ canEdit: false, displayVolumeItems: [{ isGap: true, gapNumber: 3 }] });
    const { container } = render(<VolumeListView {...p} />);
    const row = container.querySelector('tbody tr');
    expect(row.className).not.toContain('cursor-pointer');
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.click(row);
    expect(p.setFillingGapNumber).not.toHaveBeenCalled();
  });

  it('type column follows inferVolumeType, price is German, delete gets the volume', () => {
    const p = viewProps({ displayVolumeItems: [
      { isGap: false, volume: vol({ id: 4, volume_number: '5', notes: 'mit Limited Edition Poster', price: 7.5 }) },
      { isGap: false, volume: vol({ id: 5, type: undefined, volume_number: 'Schuber 3' }) }
    ] });
    const { container } = render(<VolumeListView {...p} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].querySelectorAll('td')[2].textContent).toBe('Einzelband');
    expect(nbsp(rows[0].querySelectorAll('td')[6].textContent)).toBe('7,50 €');
    expect(rows[1].querySelectorAll('td')[2].textContent).toBe('Schuber');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Band 5 löschen' }));
    expect(p.handleDeleteVolume).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 4 }));
  });

  it('read toggle for another reader is disabled for non-admins', () => {
    render(<VolumeListView {...viewProps({ selectedReaderId: 2, canToggleOthers: false, displayVolumeItems: [{ isGap: false, volume: vol() }] })} />);
    expect(screen.getByRole('button', { name: /Ungelesen/ }).disabled).toBe(true);
  });
});

describe('OwnerBadges', () => {
  it('names all owners in one label', () => {
    render(<OwnerBadges multiUser vol={{ owners: [{ user_id: 1, username: 'alex' }, { user_id: 2, username: 'mia' }] }} />);
    expect(screen.getByRole('img', { name: 'Besitzer: alex, mia' })).toBeTruthy();
  });
});

describe('selection mode of the volume views', () => {
  const items = [vol({ id: 1 }), vol({ id: 2, volume_number: '6', status: 'Fehlt' })].map((volume) => ({ isGap: false, volume }));
  const selectionProps = (selected = [], over = {}) => ({
    selectionMode: true, isSelected: (id) => selected.includes(id), onSelectVolume: vi.fn(), ...over
  });

  it('grid: a card click selects instead of opening the editor; checkboxes are named and edit buttons hidden', () => {
    const p = viewProps({ displayVolumeItems: items, ...selectionProps([2]) });
    const { container } = render(<VolumeGridView {...p} />);
    fireEvent.click(container.querySelector('[data-volume-id="1"]'), { shiftKey: true });
    expect(p.onSelectVolume).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.objectContaining({ shiftKey: true }));
    expect(p.handleOpenEditVolume).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Band 6 auswählen' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Band 5 auswählen' }));
    expect(p.onSelectVolume).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: /löschen$/ })).toBeNull();
  });

  it('grid without selection mode keeps the editor click and has no checkboxes', () => {
    const p = viewProps({ displayVolumeItems: items });
    const { container } = render(<VolumeGridView {...p} />);
    fireEvent.click(container.querySelector('[data-volume-id="1"]'));
    expect(p.handleOpenEditVolume).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('list: a checkbox column; a row click selects, the status button still toggles', () => {
    const p = viewProps({ displayVolumeItems: items, ...selectionProps([1]) });
    const { container } = render(<VolumeListView {...p} />);
    expect(screen.getByRole('checkbox', { name: 'Band 5 auswählen' }).checked).toBe(true);
    fireEvent.click(container.querySelector('tr[data-volume-id="2"] td:nth-child(3)'));
    expect(p.onSelectVolume).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), expect.anything());
    fireEvent.click(within(container.querySelector('tr[data-volume-id="2"]')).getByText('✕ Fehlt'));
    expect(p.handleToggleVolume).toHaveBeenCalledTimes(1);
    expect(p.onSelectVolume).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Band 5 löschen' })).toBeNull();
  });

  it('spine: a checkbox in selection mode; Enter and Space select, the editor stays closed', () => {
    const onSelect = vi.fn();
    const p = spineProps({ selectionMode: true, selected: true, onSelect });
    render(<ShelfSpine {...p} item={{ isGap: false, volume: vol({ id: 7 }) }} />);
    const spine = screen.getByRole('checkbox', { name: /^Band 5/ });
    expect(spine.getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(spine, { key: ' ' });
    fireEvent.click(spine);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(p.handleOpenEditVolume).not.toHaveBeenCalled();
  });

  it('the filter bar offers "Auswählen" only with canSelect and shows its state', () => {
    const base = {
      availablePublishers: [], baseVolumesForType: [], conditionsList: [], detectedGaps: [], handleResetFilters: vi.fn(),
      handleSetVolumeViewMode: vi.fn(), handleToggleShowGaps: vi.fn(), setShowMpEditionModal: vi.fn(), setVolumeConditionFilter: vi.fn(),
      setVolumeFilter: vi.fn(), setVolumePublisherFilter: vi.fn(), setVolumeSearch: vi.fn(), setVolumeSort: vi.fn(), setVolumeTypeFilter: vi.fn(),
      volumeConditionFilter: 'ALL', volumeFilter: 'ALL', volumePublisherFilter: 'ALL', volumeSearch: '', volumeSort: 'number_asc',
      volumeTypeFilter: 'ALL', volumeViewMode: 'grid', volumes: [], isOffline: true
    };
    const { rerender } = render(<VolumeFilterBar {...base} />);
    expect(screen.queryByRole('button', { name: 'Auswählen' })).toBeNull();
    const onToggle = vi.fn();
    rerender(<VolumeFilterBar {...base} canSelect selectionMode onToggleSelectionMode={onToggle} />);
    const button = screen.getByRole('button', { name: 'Auswählen' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
