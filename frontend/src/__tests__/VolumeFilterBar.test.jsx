import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VolumeFilterBar from '../components/detail/VolumeFilterBar';

const props = (over = {}) => ({
  availablePublishers: ['Carlsen', 'Egmont'],
  baseVolumesForType: new Array(6).fill({}),
  conditionsList: ['Neu', 'Gut'],
  currentReaderReadCount: 2,
  currentReaderUnreadCount: 1,
  detectedGaps: [],
  handleResetFilters: vi.fn(),
  handleSetVolumeViewMode: vi.fn(),
  handleToggleShowGaps: vi.fn(),
  hasActiveFilters: false,
  missingCount: 1,
  mpGapData: null,
  mpGapLoading: false,
  ownedCount: 3,
  preorderedCount: 0,
  regularVolumeCount: 5,
  schuberCount: 0,
  setShowMpEditionModal: vi.fn(),
  setVolumeConditionFilter: vi.fn(),
  setVolumeFilter: vi.fn(),
  setVolumePublisherFilter: vi.fn(),
  setVolumeSearch: vi.fn(),
  setVolumeSort: vi.fn(),
  setVolumeTypeFilter: vi.fn(),
  showGaps: false,
  specialCount: 0,
  specialEditionCount: 0,
  upcomingCount: 0,
  volumeConditionFilter: 'ALL',
  volumeFilter: 'ALL',
  volumePublisherFilter: 'ALL',
  volumeSearch: '',
  volumeSort: 'number_asc',
  volumeTypeFilter: 'ALL',
  volumeViewMode: 'grid',
  volumes: new Array(6).fill({}),
  ...over
});

describe('VolumeFilterBar', () => {
  it('status chips carry their counts, empty optional chips stay hidden', () => {
    render(<VolumeFilterBar {...props()} />);
    expect(screen.getByRole('button', { name: 'Alle (6)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '✓ Im Besitz (3)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '✕ Fehlt noch (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Ungelesen \/ SuB \(1\)/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Vorbestellt/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Erscheint bald/ })).toBeNull();
    expect(screen.queryByText('Typ:')).toBeNull();
    expect(screen.queryByRole('button', { name: /Filter zurücksetzen/ })).toBeNull();
  });

  it('visible gaps are added to the missing chip and the toggle shows their number', () => {
    render(<VolumeFilterBar {...props({ detectedGaps: ['4', '5'], showGaps: true, preorderedCount: 2 })} />);
    expect(screen.getByRole('button', { name: '✕ Fehlt noch (1 + 2 Lücken)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Lücken: 2 fehlend\s*AN/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '📦 Vorbestellt (2)' })).toBeTruthy();
  });

  it('chips call their setters', () => {
    const p = props({ schuberCount: 1, specialEditionCount: 2, hasActiveFilters: true });
    render(<VolumeFilterBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '✓ Im Besitz (3)' }));
    expect(p.setVolumeFilter).toHaveBeenCalledWith('Vorhanden');

    expect(screen.getByRole('button', { name: 'Nur Bände (5)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '✨ Special Editions (2)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '📦 Nur Schuber (1)' }));
    expect(p.setVolumeTypeFilter).toHaveBeenCalledWith('schuber');

    fireEvent.click(screen.getByRole('button', { name: /Filter zurücksetzen/ }));
    expect(p.handleResetFilters).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText('Suchen...'), { target: { value: 'Band 3' } });
    expect(p.setVolumeSearch).toHaveBeenCalledWith('Band 3');
  });

  it('keeps the type row and the active chip visible while its count is 0', () => {
    const p = props({ volumeTypeFilter: 'schuber', hasActiveFilters: true });
    render(<VolumeFilterBar {...p} />);
    expect(screen.getByText('Typ:')).toBeTruthy();
    const active = screen.getByRole('button', { name: '📦 Nur Schuber (0)' });
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /Special Editions/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Alle (6)', pressed: false }));
    expect(p.setVolumeFilter).not.toHaveBeenCalled();
  });

  it('type "Alle" resets the type filter', () => {
    const p = props({ volumeTypeFilter: 'special', specialCount: 0 });
    render(<VolumeFilterBar {...p} />);
    const typeRow = screen.getByText('Typ:').parentElement;
    fireEvent.click(Array.from(typeRow.querySelectorAll('button')).find(b => b.textContent.startsWith('Alle')));
    expect(p.setVolumeTypeFilter).toHaveBeenCalledWith('ALL');
  });

  it('offers "Ohne Zustand" in the condition filter', () => {
    const p = props();
    render(<VolumeFilterBar {...p} />);
    const option = screen.getByRole('option', { name: 'Ohne Zustand' });
    fireEvent.change(option.parentElement, { target: { value: option.value } });
    expect(p.setVolumeConditionFilter).toHaveBeenCalledWith('__NONE__');
  });

  it('adds gaps to the missing chip only when the filters let ghosts show', () => {
    render(<VolumeFilterBar {...props({ detectedGaps: ['4'], showGaps: true, gapsAllowedByFilters: false })} />);
    expect(screen.getByRole('button', { name: '✕ Fehlt noch (1)' })).toBeTruthy();
  });

  it('pill says why there is no edition', () => {
    const { rerender } = render(<VolumeFilterBar {...props({ mpGapError: 'Manga Passion nicht erreichbar' })} />);
    expect(screen.getByText('Nicht erreichbar')).toBeTruthy();
    rerender(<VolumeFilterBar {...props({ mpGapData: { matched: false } })} />);
    expect(screen.getByText('Keine Edition')).toBeTruthy();
  });

  it('clear-search button is labelled and clears', () => {
    const p = props({ volumeSearch: 'x' });
    render(<VolumeFilterBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Suche löschen' }));
    expect(p.setVolumeSearch).toHaveBeenCalledWith('');
  });
});
