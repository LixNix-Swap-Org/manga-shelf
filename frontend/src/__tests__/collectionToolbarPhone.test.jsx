// The collection bar on phones: the selects wait behind "Filter", whose badge counts the changed ones; nothing is removed.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';

const props = (extra = {}) => ({
  availablePublishers: ['Carlsen'],
  filterCounts: { ALL: 3 },
  filtered: [],
  publisherFilter: 'ALL',
  search: '',
  setPublisherFilter: vi.fn(),
  setSearch: vi.fn(),
  setSortBy: vi.fn(),
  setStatusFilter: vi.fn(),
  setViewMode: vi.fn(),
  sortBy: 'title_asc',
  statusFilter: 'ALL',
  viewMode: 'grid',
  setCollectFilter: vi.fn(),
  setGroupBy: vi.fn(),
  setTagFilter: vi.fn(),
  availableTags: [{ tag: 'Action', count: 2 }],
  ...extra
});

describe('CollectionToolbar on phones', () => {
  it('keeps every select in the page and opens them behind "Filter"', () => {
    render(<CollectionToolbar {...props()} />);
    const button = screen.getByRole('button', { name: 'Filter' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panels = button.getAttribute('aria-controls').split(' ').map((id) => document.getElementById(id));
    expect(panels).toHaveLength(2);
    for (const panel of panels) expect(panel.className).toMatch(/(^| )hidden( |$)/);
    // still in the document (and laid out from sm on through sm:contents)
    for (const name of ['Verlag filtern', 'Sammelstand filtern', 'Genre filtern', 'Sortierung', 'Gruppieren']) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    expect(panels[0].className).toContain('sm:contents');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    for (const panel of panels) expect(panel.className).toMatch(/(^| )flex( |$)/);
  });

  it('counts the selects set apart from the default in its badge', () => {
    render(<CollectionToolbar {...props({ publisherFilter: 'Carlsen', sortBy: 'title_desc', groupBy: 'publisher' })} />);
    expect(screen.getByRole('button', { name: 'Filter (3 geändert)' })).toBeTruthy();
  });

  it('keeps an active genre chip and the reset in view', () => {
    render(<CollectionToolbar {...props({ tagFilter: ['Action'] })} />);
    expect(screen.getByRole('button', { name: 'Genre-Filter „Action“ entfernen' }).closest('[id]')?.id || '').not.toMatch(/-a$|-b$/);
    expect(screen.getByRole('button', { name: 'Filter und Suche zurücksetzen' })).toBeTruthy();
  });
});
