// Regal-/Personen-Chip: shelf and person of the collection in one chip, with the saved filters inside.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ShelfPersonChip from '../components/dashboard/ShelfPersonChip';
import { seriesOwners, getAvailablePersons, filterAndSortMangas } from '../utils/collectionHelpers';

beforeEach(() => { localStorage.clear(); });

const mangas = [
  { id: 1, title: 'A', owners: '1\tanna\n2\tben', shelf_id: 1 },
  { id: 2, title: 'B', owners: '2\tben', shelf_id: 1 },
  { id: 3, title: 'C', owners: null, shelf_id: 2 }
];

describe('person helpers', () => {
  it('reads the owners of a row and lists everybody with their series count, me first', () => {
    expect(seriesOwners(mangas[0])).toEqual([{ id: 1, name: 'anna' }, { id: 2, name: 'ben' }]);
    expect(seriesOwners(mangas[2])).toEqual([]);
    expect(getAvailablePersons(mangas)).toEqual([{ id: 1, name: 'anna', count: 1 }, { id: 2, name: 'ben', count: 2 }]);
    expect(getAvailablePersons(mangas, { id: 2, name: 'ben' }).map((p) => p.id)).toEqual([2, 1]);
  });

  it('the person filter keeps the series in which that person owns a volume', () => {
    const titles = (personFilter) => filterAndSortMangas(mangas, { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc', personFilter }).map((m) => m.title);
    expect(titles('ALL')).toEqual(['A', 'B', 'C']);
    expect(titles('1')).toEqual(['A']);
    expect(titles('2')).toEqual(['A', 'B']);
  });
});

describe('ShelfPersonChip', () => {
  const shelves = [{ id: 1, name: 'Familie', count: 2 }, { id: 2, name: 'Anna allein', count: 1 }];
  const persons = [{ id: 1, name: 'anna', count: 1 }, { id: 2, name: 'ben', count: 2 }];

  it('names shelf and person, "Ich" for the signed-in user, and opens to change both', () => {
    const setShelf = vi.fn();
    const setPerson = vi.fn();
    render(<ShelfPersonChip shelves={shelves} shelfFilter="1" setShelfFilter={setShelf} persons={persons} personFilter="1" setPersonFilter={setPerson} userId={1} />);
    const chip = screen.getByRole('button', { name: 'Regal und Person: Familie · Ich' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByLabelText('Person filtern'), { target: { value: '2' } });
    expect(setPerson).toHaveBeenCalledWith('2');
    fireEvent.change(screen.getByLabelText('Regal filtern'), { target: { value: 'ALL' } });
    expect(setShelf).toHaveBeenCalledWith('ALL');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip);
  });

  it('one shelf and nobody else: "Meine Sammlung", the saved filters stay reachable', () => {
    render(<ShelfPersonChip shelves={[shelves[0]]} setShelfFilter={vi.fn()} persons={[persons[0]]} setPersonFilter={vi.fn()} userId={1}
      saved={{ userId: 1, current: { publisher: 'Carlsen' }, apply: vi.fn(), filtersActive: true }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regal und Person: Meine Sammlung' }));
    expect(screen.queryByLabelText('Regal filtern')).toBeNull();
    expect(screen.queryByLabelText('Person filtern')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Aktuelle Auswahl merken/ }));
    expect(screen.getByRole('button', { name: 'Carlsen' })).toBeTruthy();
  });
});
