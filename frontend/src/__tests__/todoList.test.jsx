// "Zu erledigen" on the shelf: GET /api/todo as a short list with links to the series.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TodoList, { compactVolumes, todoText } from '../components/dashboard/TodoList';
import { fakeResponse } from './fakeResponse';

afterEach(() => { vi.unstubAllGlobals(); });

const items = [
  { kind: 'elsewhere', manga_id: 1, title: 'One Piece', count: 1, volumes: ['57'], shelf_name: 'Familie' },
  { kind: 'overdue', manga_id: 2, title: 'Frieren', count: 2, volumes: ['13', '14'] },
  { kind: 'gap', manga_id: 3, title: 'Blue Lock', count: 3, volumes: ['24', '25', '26'] },
  { kind: 'gap', manga_id: 4, title: 'Dandadan', count: 1, volumes: ['3'] }
];

describe('todoText', () => {
  it('names the volumes for each kind', () => {
    expect(todoText(items[0])).toBe('One Piece: Band 57 steht schon im Regal „Familie“');
    expect(todoText(items[1])).toBe('Frieren: Bände 13, 14 sollten erschienen sein');
    expect(todoText(items[2])).toBe('Blue Lock: 3 Bände fehlen (24–26)');
    expect(todoText(items[3])).toBe('Dandadan: Band 3 fehlt');
  });
});

describe('compactVolumes', () => {
  it('turns three or more consecutive numbers into a range and keeps the rest', () => {
    expect(compactVolumes(['21', '22', '23', '24', '113'])).toBe('21–24, 113');
    expect(compactVolumes(['6', '7'])).toBe('6, 7');
    expect(compactVolumes(['1', '2', '3', '12.5', '13', '14', '15'])).toBe('1–3, 12.5, 13–15');
    expect(compactVolumes([])).toBe('');
  });
});

describe('TodoList', () => {
  it('shows the first three with links, the rest on demand, and reports the count', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, { total: 4, items }));
    vi.stubGlobal('fetch', fetchMock);
    const onCount = vi.fn();
    render(<MemoryRouter><TodoList shelfId="5" onCount={onCount} /></MemoryRouter>);
    const region = await screen.findByRole('region', { name: 'Zu erledigen (4)' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/todo?shelf_id=5');
    expect(onCount).toHaveBeenCalledWith(4);
    expect(within(region).getAllByRole('listitem')).toHaveLength(3);
    expect(within(region).getByRole('link', { name: '„One Piece“ öffnen' }).getAttribute('href')).toBe('/manga/1');
    fireEvent.click(within(region).getByRole('button', { name: 'Alle 4 zeigen' }));
    expect(within(region).getAllByRole('listitem')).toHaveLength(4);
  });

  it('stays hidden offline, when nothing is open and on an error', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, { total: 0, items: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const off = render(<MemoryRouter><TodoList enabled={false} /></MemoryRouter>);
    expect(fetchMock).not.toHaveBeenCalled();
    off.unmount();
    render(<MemoryRouter><TodoList /></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region')).toBeNull();
  });
});
