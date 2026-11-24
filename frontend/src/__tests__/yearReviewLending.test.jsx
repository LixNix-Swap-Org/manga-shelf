// "Mein Manga-Jahr" in the reading statistics (U6), quick lending in the owner pill (U8).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import YearReviewCard, { yearDelta } from '../components/modals/stats/YearReviewCard';
import OwnerBadges, { lendChoices } from '../components/detail/OwnerBadges';
import { fakeResponse } from './fakeResponse';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const review = (overrides = {}) => ({
  user: { id: 1, username: 'max' },
  year: 2026,
  years: [2026, 2025],
  read: { volumes: 42, pages: 8400, previous_year: 30, started: 3 },
  best_month: { month: '2026-03', volumes: 9 },
  top_series: { manga_id: 7, title: 'Vinland Saga', cover_image: null, volumes: 11 },
  bought: { volumes: 20, total: 159.5, other_currency: 2 },
  ...overrides
});

describe('year review card', () => {
  it('yearDelta compares with the year before', () => {
    expect(yearDelta(42, 30, 2026)).toBe('+12 zu 2025');
    expect(yearDelta(3, 5, 2026)).toBe('−2 zu 2025');
    expect(yearDelta(4, 4, 2026)).toBe('wie 2025');
    expect(yearDelta(0, 0, 2026)).toBeNull();
  });

  it('shows the tiles, the top series and the best month, and reloads for another year', async () => {
    const urls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      urls.push(String(url));
      return fakeResponse(200, String(url).includes('year=2025') ? review({ year: 2025, read: { volumes: 30, pages: 6000, previous_year: 0, started: 5 }, best_month: null, top_series: null, bought: { volumes: 0, total: 0, other_currency: 0 } }) : review());
    }));
    render(<MemoryRouter><YearReviewCard userId={1} /></MemoryRouter>);
    const card = await screen.findByRole('region', { name: 'Mein Manga-Jahr 2026' });
    expect(urls[0]).toBe('/api/stats/year?user_id=1');
    expect(card.textContent).toMatch('42 Bände');
    expect(card.textContent).toMatch('+12 zu 2025');
    expect(card.textContent).toMatch('8.400');
    expect(card.textContent).toMatch('3 Reihen');
    expect(card.textContent).toMatch(/159,50\s*€/);
    expect(card.textContent).toMatch('Ohne 2 Bände in anderer Währung.');
    expect(within(card).getByRole('link').getAttribute('href')).toBe('/manga/7');
    expect(card.textContent).toMatch('Stärkster Monat');
    expect(card.textContent).toMatch('März');

    fireEvent.change(within(card).getByLabelText('Jahr'), { target: { value: '2025' } });
    const before = await screen.findByRole('region', { name: 'Mein Manga-Jahr 2025' });
    expect(urls.at(-1)).toBe('/api/stats/year?user_id=1&year=2025');
    expect(before.textContent).toMatch('30 Bände');
    expect(before.textContent).not.toMatch('Am meisten gelesen');
    expect(before.textContent).not.toMatch('€');
  });

  it('another reader starts at the current year again instead of keeping an old pick', async () => {
    const urls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      urls.push(String(url));
      if (String(url).includes('year=2025')) return fakeResponse(200, review({ year: 2025 }));
      return fakeResponse(200, String(url).includes('user_id=2') ? review({ user: { id: 2, username: 'lena' }, years: [2026] }) : review());
    }));
    const { rerender } = render(<MemoryRouter><YearReviewCard userId={1} /></MemoryRouter>);
    const card = await screen.findByRole('region', { name: 'Mein Manga-Jahr 2026' });
    fireEvent.change(within(card).getByLabelText('Jahr'), { target: { value: '2025' } });
    await screen.findByRole('region', { name: 'Mein Manga-Jahr 2025' });
    rerender(<MemoryRouter><YearReviewCard userId={2} /></MemoryRouter>);
    await screen.findByRole('region', { name: 'Mein Manga-Jahr 2026' });
    expect(urls.at(-1)).toBe('/api/stats/year?user_id=2');
    expect(urls).not.toContain('/api/stats/year?user_id=2&year=2025');
  });

  it('says so when the year cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(500, { error: 'kaputt' })));
    render(<MemoryRouter><YearReviewCard /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('stays away on an older server without the route', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(404, { error: 'Nicht gefunden' }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<MemoryRouter><YearReviewCard /></MemoryRouter>);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });
});

describe('quick lending in the owner pill', () => {
  const people = [
    { user_id: 1, username: 'max', role: 'admin' },
    { user_id: 2, username: 'lukas', role: 'editor' },
    { user_id: 3, username: 'tim', role: 'guest' }
  ];
  const vol = (copies) => ({
    id: 5,
    owners: [...new Map(copies.map((c) => [c.owner_user_id, { user_id: c.owner_user_id, username: c.owner }])).values()],
    copies
  });
  const mine = { id: 11, owner_user_id: 1, owner: 'max', lent_to: null };
  const lukas = { id: 12, owner_user_id: 2, owner: 'lukas', lent_to: null };

  it('lendChoices offers the own copies only', () => {
    expect(lendChoices(vol([lukas]), 1)).toBeNull();
    expect(lendChoices(vol([mine, lukas]), 1)).toEqual({ lent: [], free: mine });
    const lent = { ...mine, lent_to: 'Oma' };
    expect(lendChoices(vol([lent]), 1)).toEqual({ lent: [lent], free: null });
    expect(lendChoices(vol([mine]), null)).toBeNull();
  });

  it('an editor without owner rights lends their copy to a member or another person', () => {
    const onLend = vi.fn();
    const v = vol([mine, lukas]);
    render(<OwnerBadges vol={v} multiUser lend={{ userId: 1, people, onLend }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Besitzer und Verleihen' }));
    const menu = screen.getByRole('dialog', { name: 'Besitzer und Verleihen' });
    expect(within(menu).queryByRole('button', { name: /max/ })).toBeNull();
    fireEvent.click(within(menu).getByRole('button', { name: 'lukas' }));
    expect(onLend).toHaveBeenCalledWith(v, mine, { user_id: 2 });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Besitzer und Verleihen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Andere Person …' }));
    const submit = screen.getByRole('button', { name: 'Verleihen' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Oma Helga ' } });
    fireEvent.click(submit);
    expect(onLend).toHaveBeenLastCalledWith(v, mine, { name: 'Oma Helga' });
  });

  it('a lent copy can be taken back; without an own copy the pill stays plain', () => {
    const onLend = vi.fn();
    const lent = { ...mine, lent_to: 'Oma Helga' };
    const v = vol([lent]);
    const { unmount } = render(<OwnerBadges vol={{ ...v, owners: [...v.owners, { user_id: 2, username: 'lukas' }] }} multiUser lend={{ userId: 1, people, onLend }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Besitzer und Verleihen' }));
    expect(screen.queryByText('Verleihen an')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zurückbekommen von Oma Helga' }));
    expect(onLend).toHaveBeenCalledWith(expect.anything(), lent, null);
    unmount();

    render(<OwnerBadges vol={vol([lukas])} multiUser lend={{ userId: 1, people, onLend }} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('img', { name: 'Besitzer: lukas' })).toBeTruthy();
  });

  it('admins see the owners list and the lending part in one menu', () => {
    const onToggleOwner = vi.fn();
    render(<OwnerBadges vol={vol([mine])} multiUser people={people} onToggleOwner={onToggleOwner} lend={{ userId: 1, people, onLend: vi.fn() }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Besitzer' }));
    const menu = screen.getByRole('dialog', { name: 'Besitzer' });
    expect(within(menu).getByRole('button', { name: /max/, pressed: true })).toBeTruthy();
    expect(menu.querySelector('[data-lend-menu]').textContent).toMatch('Verleihen an');
  });
});
