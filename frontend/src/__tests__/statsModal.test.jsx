import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StatsModal from '../components/modals/StatsModal';
import SpendingCard from '../components/modals/SpendingCard';
import OwnerStatsCard from '../components/modals/OwnerStatsCard';
import {
  fmtNumber, fmtEuro, fmtPct, countLabel, parseUtcTimestamp, publisherSegments, publisherColor
} from '../components/modals/statsFormat';
import { localISODate } from '../utils/radarHelpers';
import { fakeResponse } from './fakeResponse';

const MONTH_KEYS = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const emptyMonths = () => MONTH_KEYS.map(month => ({ month, volumes: 0, total: 0 }));

const statsBody = (over = {}) => ({
  summary: {
    total_series: 3, completed_series: 1, total_owned_volumes: 20, total_missing_volumes: 2,
    total_volumes_recorded: 25, total_owned_value: 1234.5, total_missing_value: 10, total_possible_value: 1500,
    avg_price_per_volume: 7.5, priced_owned_volumes: 18, collection_start_date: '2021-04-09',
    collection_days: 2000, collection_months: 66, collection_years: 5.48, avg_monthly_spending: 18.7,
    ...over.summary
  },
  publishers: over.publishers || [
    { publisher: 'Carlsen', series_count: 2, volume_count: 11, total_value: 80, percentage: 55 },
    { publisher: 'EMA', series_count: 1, volume_count: 9, total_value: 70, percentage: 45 }
  ],
  user_reading_stats: [{ user_id: 1, username: 'anna', role: 'admin', read_count: 5, unread_count: 15, total_owned: 20, read_pct: 23.1 }],
  owner_stats: [],
  top_series: over.top_series || [
    { id: 1, title: 'Teuer', cover_image: '/uploads/a.jpg', owned_volumes: 3, total_value: 80 },
    { id: 2, title: 'Viele', cover_image: null, owned_volumes: 10, total_value: 0 }
  ],
  spending: { by_year: [{ year: 2023, volumes: 3, total: 21 }], by_month: emptyMonths(), year_only: { volumes: 0, total: 0 }, without_date: { volumes: 0, total: 0 } }
});

const response = (body, { status = 200 } = {}) => fakeResponse(status, body);

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const ui = (props) => (
  <MemoryRouter>
    <StatsModal isOpen onClose={vi.fn()} user={{ id: 1, role: 'admin' }} {...props} />
  </MemoryRouter>
);

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

describe('statsFormat', () => {
  it('formats numbers, money, percentages and counts for de-DE', () => {
    expect(fmtNumber(5.48, 2)).toBe('5,48');
    expect(fmtNumber(1234)).toBe('1.234');
    expect(fmtEuro(1234.5)).toBe('1.234,50\u00a0€');
    expect(fmtEuro(null)).toBe('0,00\u00a0€');
    expect(fmtEuro('7.5')).toBe('7,50\u00a0€');
    expect(fmtPct(23.1)).toBe('23,1%');
    expect(countLabel(1, 'Band', 'Bände')).toBe('1 Band');
    expect(countLabel(2, 'Band', 'Bände')).toBe('2 Bände');
  });

  it('reads SQLite timestamps as UTC and leaves ISO strings alone', () => {
    expect(parseUtcTimestamp('2026-10-03 15:07:43').toISOString()).toBe('2026-10-03T15:07:43.000Z');
    expect(parseUtcTimestamp('2026-10-03T15:07:43Z').toISOString()).toBe('2026-10-03T15:07:43.000Z');
    expect(parseUtcTimestamp(null)).toBeNull();
    expect(parseUtcTimestamp('kaputt')).toBeNull();
  });

  it('adds a grey "Sonstige" segment after 8 publishers and the widths add up to 100', () => {
    const pubs = Array.from({ length: 10 }, (_, i) => ({ publisher: `P${i}`, volume_count: 10 - i, percentage: 0 }));
    const segments = publisherSegments(pubs);
    expect(segments).toHaveLength(9);
    expect(segments[8].label).toBe('Sonstige (2 Verlage)');
    expect(segments[8].color).toBe('bg-slate-500');
    expect(segments[8].volumes).toBe(3);
    expect(segments.reduce((s, seg) => s + seg.width, 0)).toBeCloseTo(100, 6);
    expect(publisherColor(8)).toBe('bg-slate-500');
    expect(publisherColor(0)).toBe('bg-sky-500');
  });
});

describe('StatsModal', () => {
  it('formats KPIs for German readers and uses the new summary fields', async () => {
    fetchMock.mockResolvedValue(response(statsBody()));
    render(ui());
    expect(await screen.findByText('1.234,50 €')).toBeTruthy();
    expect(screen.getByText('5,5 Jahre')).toBeTruthy();
    expect(screen.getByText('2.000 Tage aktiv')).toBeTruthy();
    expect(screen.getByText('Durchschnitt pro Monat über 66 Monate')).toBeTruthy();
    expect(screen.getByText(/20 Bände im Besitz \(Ø 7,50 €\/Band, 2 ohne Preis\)/)).toBeTruthy();
    expect(screen.getByText(/Gesamtwert aller 25 erfassten Bände/)).toBeTruthy();
    expect(screen.getByText(/\(23,1%\)/)).toBeTruthy();
    expect(screen.queryByText(/5\.48/)).toBeNull();
  });

  it('uses singular forms for one month, one year and one day', async () => {
    fetchMock.mockResolvedValue(response(statsBody({ summary: { collection_months: 1, collection_years: 1, collection_days: 1 } })));
    render(ui());
    expect(await screen.findByText('Durchschnitt pro Monat über 1 Monat')).toBeTruthy();
    expect(screen.getByText('1 Jahr')).toBeTruthy();
    expect(screen.getByText('1 Tag aktiv')).toBeTruthy();
  });

  it('names the dialog by its h2 title and never skips a heading level', async () => {
    fetchMock.mockResolvedValue(response(statsBody()));
    render(ui());
    await screen.findByText('1.234,50 €');
    const dialog = screen.getByRole('dialog', { name: 'Statistik- & Finanz-Dashboard' });
    expect(dialog.getAttribute('aria-label')).toBeNull();
    const checkLevels = () => {
      const levels = [...dialog.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => Number(h.tagName[1]));
      expect(levels[0]).toBe(2);
      levels.forEach((lvl, i) => { if (i > 0) expect(lvl).toBeLessThanOrEqual(levels[i - 1] + 1); });
    };
    checkLevels();
    fireEvent.click(screen.getByRole('button', { name: /Lese-Tracking/ }));
    checkLevels();
    fireEvent.click(screen.getByRole('button', { name: /Verlagsdiagramm/ }));
    checkLevels();
  });

  it('shows the error instead of the previous numbers when a reopen fails, and can retry', async () => {
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    const { rerender } = render(ui());
    await screen.findByText('1.234,50 €');

    rerender(ui({ isOpen: false }));
    fetchMock.mockResolvedValueOnce(response({ error: 'Wiederherstellung läuft, bitte gleich erneut versuchen.' }, { ok: false, status: 503 }));
    rerender(ui());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Wiederherstellung läuft');
    expect(screen.queryByText('1.234,50 €')).toBeNull();

    fetchMock.mockResolvedValueOnce(response(statsBody({ summary: { total_owned_value: 99 } })));
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText('99,00 €')).toBeTruthy();
  });

  it('reports a network error on the first open', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(ui());
    expect((await screen.findByRole('alert')).textContent).toMatch(/Netzwerkfehler/);
  });

  it('drops a stats response that arrives after the modal was closed and reopened', async () => {
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise);
    const { rerender } = render(ui());
    rerender(ui({ isOpen: false }));
    fetchMock.mockResolvedValueOnce(response(statsBody({ summary: { total_owned_value: 50 } })));
    rerender(ui());
    expect(await screen.findByText('50,00 €')).toBeTruthy();
    await act(async () => { slow.resolve(response(statsBody({ summary: { total_owned_value: 777 } }))); });
    expect(screen.queryByText('777,00 €')).toBeNull();
    expect(screen.getByText('50,00 €')).toBeTruthy();
  });

  it('closing the dialog aborts the running stats request', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const { rerender } = render(ui());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/stats');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    rerender(ui({ isOpen: false }));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('ignores reader details that arrive after a close and reopen', async () => {
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    const { rerender } = render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: /Lese-Tracking/ }));
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Alle gelesenen Bände anzeigen' }));
    expect(screen.getByRole('button', { name: 'Lädt...' })).toBeTruthy();

    rerender(ui({ isOpen: false }));
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    rerender(ui());
    await screen.findByText('1.234,50 €');
    await act(async () => {
      slow.resolve(response({ user: { id: 1, username: 'anna' }, stats: { totalVolumes: 1, totalPages: 0, readMangas: [] } }));
    });
    fireEvent.click(screen.getByRole('button', { name: /Lese-Tracking/ }));
    expect(screen.queryByText(/Gelesene Mangas von/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Alle gelesenen Bände anzeigen' })).toBeTruthy();
  });

  it('labels reader chips by type, keys them by id, sorts them and lazy-loads covers', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: /Lese-Tracking/ }));
    fetchMock.mockResolvedValueOnce(response({
      user: { id: 1, username: 'anna' },
      stats: {
        totalVolumes: 4, totalPages: 1234,
        readMangas: [{
          id: 7, title: 'One Piece', cover_image: '/uploads/op.jpg',
          volumes: [
            { id: 11, volume_number: '2', type: 'volume', notes: null, read_at: '2026-10-03T15:07:43Z' },
            { id: 10, volume_number: '1', type: 'special_edition', notes: 'Limited Edition', read_at: '2026-10-02T10:00:00Z' },
            { id: 12, volume_number: '5', type: 'schuber', notes: null, read_at: '2026-10-01T10:00:00Z' },
            { id: 9, volume_number: '1', type: 'volume', notes: null, read_at: '2026-09-01T10:00:00Z' }
          ]
        }]
      }
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Alle gelesenen Bände anzeigen' }));
    expect(await screen.findByText('Gelesene Mangas von anna')).toBeTruthy();
    expect(screen.getByText('4 Bände (1.234 Seiten) insgesamt gelesen')).toBeTruthy();

    const chips = [...screen.getByText('One Piece').parentElement.querySelectorAll('span[title^="Gelesen am"]')];
    expect(chips.map(c => c.textContent)).toEqual(['Band 1', 'Band 1 (Limited Edition)', 'Band 2', 'Schuber 5']);
    const expected = new Date('2026-10-03T15:07:43Z').toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
    expect(chips[2].getAttribute('title')).toBe(`Gelesen am: ${expected}`);
    expect(errorSpy.mock.calls.some(args => String(args[0]).includes('same key'))).toBe(false);

    const cover = screen.getByText('One Piece').closest('div.p-4').querySelector('img');
    expect(cover.getAttribute('loading')).toBe('lazy');
  });

  it('renders long reader histories in steps', async () => {
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: /Lese-Tracking/ }));
    const readMangas = Array.from({ length: 35 }, (_, i) => ({
      id: i + 1, title: `Reihe ${i + 1}`, cover_image: null,
      volumes: [{ id: 100 + i, volume_number: '1', type: 'volume', notes: null, read_at: '2026-10-03T15:07:43Z' }]
    }));
    fetchMock.mockResolvedValueOnce(response({ user: { id: 1, username: 'anna' }, stats: { totalVolumes: 35, totalPages: 0, readMangas } }));
    fireEvent.click(screen.getByRole('button', { name: 'Alle gelesenen Bände anzeigen' }));
    await screen.findByText('Reihe 30');
    expect(screen.queryByText('Reihe 31')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Reihen anzeigen (5 übrig)' }));
    expect(screen.getByText('Reihe 35')).toBeTruthy();
  });

  it('shows reader-detail errors inline', async () => {
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: /Lese-Tracking/ }));
    fetchMock.mockResolvedValueOnce(response({ error: 'Sitzung abgelaufen' }, { ok: false, status: 401 }));
    fireEvent.click(screen.getByRole('button', { name: 'Alle gelesenen Bände anzeigen' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Sitzung abgelaufen');
  });

  it('labels the top series by value, matching the server order', async () => {
    fetchMock.mockResolvedValue(response(statsBody()));
    render(ui());
    await screen.findByText('1.234,50 €');
    expect(screen.getByRole('heading', { name: 'Wertvollste Reihen' })).toBeTruthy();
    expect(screen.queryByText(/meisten Bänden/)).toBeNull();
    const first = screen.getByText('Teuer').closest('a');
    // rank once as a phone ranking label and once over the cover from sm on
    expect(within(first).getAllByText('#1')).toHaveLength(2);
    expect(within(first).getByText('Platz 1:')).toBeTruthy();
    expect(within(first).getByText('80,00 €')).toBeTruthy();
    expect(within(first).getByText('3 Bände')).toBeTruthy();
    expect(first.querySelector('img').getAttribute('loading')).toBe('lazy');
  });

  it('top series show the owned value and what completing them still costs', async () => {
    fetchMock.mockResolvedValue(response(statsBody({
      top_series: [
        { id: 1, title: 'Teuer', cover_image: null, owned_volumes: 3, owned_value: 80, total_value: 80, missing_value: 14, avg_price: 26.67, unpriced: 0 },
        { id: 2, title: 'Komplett', cover_image: null, owned_volumes: 2, owned_value: 20, total_value: 20, missing_value: 0, avg_price: 10, unpriced: 0 }
      ]
    })));
    render(ui());
    await screen.findByText('1.234,50 €');
    const card = document.getElementById('stats-top-series');
    expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    expect(within(screen.getByText('Teuer').closest('a')).getByText('noch 14,00 € bis komplett')).toBeTruthy();
    expect(within(screen.getByText('Komplett').closest('a')).queryByText(/bis komplett/)).toBeNull();
  });

  it('shows the wishlist KPI only when there are wished series', async () => {
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    const { rerender } = render(ui());
    await screen.findByText('1.234,50 €');
    expect(document.getElementById('stats-wishlist')).toBeNull();

    rerender(ui({ isOpen: false }));
    fetchMock.mockResolvedValueOnce(response(statsBody({ summary: { wished_series: 2, wished_known_cost: 21 } })));
    rerender(ui());
    await screen.findByText('1.234,50 €');
    const kpi = document.getElementById('stats-wishlist');
    expect(kpi.textContent).toMatch(/Wunschliste/);
    expect(kpi.textContent).toMatch(/2 Reihen · 21,00\s€ bekannt/);
  });

  it('keeps one live region mounted for the loading text and scrolls the tab bar instead of wrapping', async () => {
    const slow = deferred();
    fetchMock.mockReturnValueOnce(slow.promise);
    render(ui());
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Berechne Statistiken & Finanzdaten...');
    expect(screen.getByRole('group', { name: 'Bereiche' }).className).toMatch(/overflow-x-auto no-scrollbar/);
    await act(async () => { slow.resolve(response(statsBody())); });
    await screen.findByText('1.234,50 €');
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('');
  });

  it('publisher tab: volumes, series, value, average and missing per publisher; sorts by value or average', async () => {
    const publishers = [
      { publisher: 'Carlsen', series_count: 2, volume_count: 11, total_value: 80, percentage: 55, value_percentage: 40, priced_count: 10, avg_price: 8, missing_count: 2, missing_value: 14 },
      { publisher: 'EMA', series_count: 1, volume_count: 9, total_value: 120, percentage: 45, value_percentage: 60, priced_count: 9, avg_price: 13.33, missing_count: 0, missing_value: 0 },
      { publisher: 'Ohne Preis', series_count: 1, volume_count: 1, total_value: 0, percentage: 5, value_percentage: 0, priced_count: 0, avg_price: null, missing_count: 0, missing_value: 0 }
    ];
    fetchMock.mockResolvedValue(response(statsBody({ publishers })));
    render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: /Verlagsdiagramm/ }));
    const card = document.getElementById('stats-publishers');
    const names = () => [...card.querySelectorAll('span.font-bold.text-sm:not(.font-mono)')].map(n => n.textContent);
    expect(names()).toEqual(['Carlsen', 'EMA', 'Ohne Preis']);
    const carlsen = screen.getByText('Carlsen').closest('div.p-3');
    expect(within(carlsen).getByText('14,00 €')).toBeTruthy();
    expect(within(carlsen).getByText('fehlt (2)')).toBeTruthy();
    expect(within(carlsen).getByText('8,00 €')).toBeTruthy();
    expect(within(screen.getByText('Ohne Preis').closest('div.p-3')).getAllByText('–')).toHaveLength(2);

    fireEvent.click(within(card).getByRole('button', { name: 'Wert' }));
    expect(names()).toEqual(['EMA', 'Carlsen', 'Ohne Preis']);
    expect(within(card).getByRole('button', { name: 'Wert' }).getAttribute('aria-pressed')).toBe('true');
    const bar = card.querySelector('div[aria-hidden="true"].flex');
    expect(bar.children[0].style.width).toBe('60%');
    expect(bar.children[0].getAttribute('title')).toBe(`EMA: 60% (${fmtEuro(120)})`);
    expect(within(screen.getByText('EMA').closest('div.p-3')).getByText('Wertanteil:')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Durchschnittspreis' }));
    expect(names()).toEqual(['EMA', 'Carlsen', 'Ohne Preis']);
  });

  it('draws publisher bars at their real share, groups the rest as "Sonstige" and greys rows after 8', async () => {
    const publishers = [{ publisher: 'Carlsen', series_count: 5, volume_count: 55, total_value: 400, percentage: 55 }]
      .concat(Array.from({ length: 9 }, (_, i) => ({ publisher: `Verlag ${i + 2}`, series_count: 1, volume_count: 5, total_value: 30, percentage: 5 })));
    fetchMock.mockResolvedValue(response(statsBody({ publishers })));
    const { container } = render(ui());
    await screen.findByText('1.234,50 €');
    const quickRow = screen.getByText('Carlsen').closest('.space-y-1');
    expect(quickRow.querySelector('.bg-sky-500').style.width).toBe('55%');
    expect(within(quickRow).getByText(/\(55%\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Verlagsdiagramm/ }));
    expect(screen.queryByText(/Fahre mit der Maus/)).toBeNull();
    const bar = container.querySelector('div[aria-hidden="true"].flex');
    expect(bar.children).toHaveLength(9);
    expect(bar.children[8].className).toContain('bg-slate-500');
    expect(bar.children[8].getAttribute('title')).toContain('Sonstige (2 Verlage)');
    const ninthRow = screen.getByText('Verlag 9').closest('div.p-3');
    const dot = ninthRow.querySelector('span.rounded-full');
    expect(dot.className).toContain('bg-slate-500');
    expect(dot.className).not.toContain('bg-sky-500');
  });

  it('start date editor: labelled input, min/max, error inline and reset when closed', async () => {
    fetchMock.mockResolvedValue(response(statsBody()));
    render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: 'Datum ändern' }));
    const input = screen.getByLabelText(/Sammlungs-Startdatum festlegen/);
    expect(input.value).toBe('2021-04-09');
    expect(input.getAttribute('min')).toBe('1900-01-01');
    expect(input.getAttribute('max')).toBe(localISODate());

    fireEvent.change(input, { target: { value: '2022-02-02' } });
    fetchMock.mockResolvedValueOnce(response({ error: 'Das Datum darf nicht in der Zukunft liegen' }, { ok: false, status: 400 }));
    fireEvent.click(screen.getByRole('button', { name: 'Datum speichern' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Das Datum darf nicht in der Zukunft liegen');

    fireEvent.click(screen.getByRole('button', { name: 'Schließen', expanded: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Datum ändern' }));
    expect(screen.getByLabelText(/Sammlungs-Startdatum festlegen/).value).toBe('2021-04-09');
  });

  it('saving the start date reloads the stats', async () => {
    fetchMock.mockResolvedValueOnce(response(statsBody()));
    render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: 'Datum ändern' }));
    fireEvent.change(screen.getByLabelText(/Sammlungs-Startdatum festlegen/), { target: { value: '2022-02-02' } });
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    fetchMock.mockResolvedValueOnce(response(statsBody({ summary: { collection_start_date: '2022-02-02', collection_days: 1339 } })));
    fireEvent.click(screen.getByRole('button', { name: 'Datum speichern' }));
    expect(await screen.findByText('1.339 Tage aktiv')).toBeTruthy();
    const put = fetchMock.mock.calls.find(([url, opts]) => url === '/api/stats/settings' && opts?.method === 'PUT');
    expect(JSON.parse(put[1].body)).toEqual({ collection_start_date: '2022-02-02' });
  });
});

describe('SpendingCard', () => {
  it('explains an empty 12-month window and keeps the year list', () => {
    render(<SpendingCard spending={{ by_year: [{ year: 2023, volumes: 3, total: 21 }], by_month: emptyMonths(), year_only: { volumes: 0, total: 0 }, without_date: { volumes: 0, total: 0 } }} />);
    expect(screen.getByText('Keine Käufe in den letzten 12 Monaten.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('2023')).toBeTruthy();
    expect(screen.getByText('21,00 €')).toBeTruthy();
  });

  it('makes every month amount reachable by tap, keyboard and screen reader', () => {
    const months = emptyMonths();
    months[5] = { month: '2026-03', volumes: 2, total: 12.5 };
    months[7] = { month: '2026-05', volumes: 1, total: 0 };
    render(<SpendingCard spending={{ by_year: [{ year: 2026, volumes: 3, total: 12.5 }], by_month: months, year_only: { volumes: 3, total: 21 }, without_date: { volumes: 1, total: 7 } }} />);
    expect(screen.getByRole('group', { name: 'Ausgaben je Monat, Okt 2025 – Sep 2026' })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(12);
    const march = screen.getByRole('button', { name: /^Mär 2026: 12,50\s€, 2 Bände$/ });
    expect(screen.getByText('Mai 2026: 0,00 € · 1 Band')).toBeTruthy();
    fireEvent.click(march);
    expect(march.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Mär 2026: 12,50 € · 2 Bände')).toBeTruthy();
    const may = screen.getByRole('button', { name: /^Mai 2026: 0,00\s€, 1 Band$/ });
    expect(may.querySelector('span').style.minHeight).toBe('3px');
    expect(screen.getByText('3 Bände (21,00 €) haben nur ein Kaufjahr und fehlen im Monatsdiagramm.')).toBeTruthy();
    expect(screen.getByText('1 Band (7,00 €) hat kein verwertbares Kaufdatum und fehlt hier.')).toBeTruthy();
  });
});

describe('OwnerStatsCard', () => {
  it('opens the publisher list per owner and explains shared volumes', () => {
    render(<OwnerStatsCard
      ownerStats={[
        { user_id: 1, username: 'anna', volume_count: 2, series_count: 1, total_value: 15, shared_count: 1 },
        { user_id: 2, username: 'ben', volume_count: 1, series_count: 1, total_value: 7, shared_count: 1 }
      ]}
      ownerPublishers={[
        { user_id: 1, username: 'anna', publisher: 'Carlsen Manga', volume_count: 1, total_value: 8 },
        { user_id: 1, username: 'anna', publisher: 'TOKYOPOP', volume_count: 1, total_value: 7 },
        { user_id: 2, username: 'ben', publisher: 'TOKYOPOP', volume_count: 1, total_value: 7 }
      ]}
    />);
    expect(screen.getByText(/Geteilte Bände zählen bei jedem Besitzer voll/)).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Verlage von anna' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Carlsen Manga')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')).textContent).toMatch(/Carlsen Manga1 Band · 8,00\s€/);
    expect(screen.getAllByText('TOKYOPOP')).toHaveLength(1);
  });

  it('formats owner values in German', () => {
    render(<OwnerStatsCard ownerStats={[
      { user_id: 1, username: 'anna', volume_count: 1, series_count: 1, total_value: 1234.5, shared_count: 0 },
      { user_id: 2, username: 'ben', volume_count: 3, series_count: 2, total_value: 7.5, shared_count: 1 }
    ]} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Besitz pro Nutzer' })).toBeTruthy();
    expect(screen.getByText(/1 Band · 1 Reihe · 1\.234,50 €/)).toBeTruthy();
    expect(screen.getByText(/3 Bände · 2 Reihen · 7,50 €/)).toBeTruthy();
  });
});

describe('StatsModal closed', () => {
  it('renders nothing and does not fetch while closed', async () => {
    render(ui({ isOpen: false }));
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

const readingBody = () => {
  const months = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(2024, 10 + i, 15);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  return {
    user: { id: 1, username: 'anna' },
    months: 24,
    by_month: months.map((month, i) => ({ month, volumes: i === 23 ? 4 : 0, pages: i === 23 ? 800 : 0, series: i === 23 ? 2 : 0 })),
    backlog_by_month: months.map((month) => ({ month, owned: 20, read: 5, backlog: 15 })),
    this_year: { year: 2026, volumes: 4, pages: 800 },
    last_year: { year: 2025, volumes: 1, pages: 200 },
    streak: { longest: 3, longest_end: '2026-01', current: 1 },
    unknown_date: 2,
    continue_reading: [{ manga_id: 7, title: 'Frieren', cover_image: null, last_read_at: '2026-10-01 10:00:00', next_volume: { id: 70, volume_number: '5', cover_image: null }, unread_after: 3 }]
  };
};

describe('StatsModal: Leseverlauf and the collection tools', () => {
  const route = (handlers) => fetchMock.mockImplementation(async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api/, '/api');
    for (const [pattern, answer] of handlers) if (pattern.test(path)) return response(typeof answer === 'function' ? answer(path, init) : answer);
    return response({ error: 'unbekannt' }, { status: 404 });
  });

  it('the Leseverlauf tab loads the reader timeline with streaks, backlog and the Weiterlesen list', async () => {
    route([[/^\/api\/stats$/, statsBody()], [/^\/api\/stats\/reading/, readingBody()]]);
    render(ui());
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: /Leseverlauf/ }));
    const next = await screen.findByRole('link', { name: /Frieren/ });
    expect(next.getAttribute('href')).toBe('/manga/7');
    expect(next.textContent).toMatch(/Weiter mit Band 5/);
    expect(next.textContent).toMatch(/3 Bände ungelesen im Regal/);
    expect(screen.getByText('Rekord: 3 Monate')).toBeTruthy();
    expect(screen.getByText(/2 Bände ohne Lesedatum zählen als gelesen/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /4 Bände, 800 Seiten/ })).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/stats/reading?user_id=1'))).toBe(true);
  });

  it('opens the trash above the statistics; a restore reloads the figures and tells the caller', async () => {
    let statsCalls = 0;
    route([
      [/^\/api\/stats$/, () => { statsCalls++; return statsBody(); }],
      [/^\/api\/trash$/, { items: [{ id: 1, kind: 'manga', ref_id: 3, manga_id: 3, title: 'Weg', deleted_at: '2026-10-03 10:00:00', purge_at: '2026-11-02', volume_count: 1, restorable: true }], retention_days: 30 }],
      [/restore$/, { success: true }]
    ]);
    const onDataChanged = vi.fn();
    render(ui({ onDataChanged }));
    await screen.findByText('1.234,50 €');
    fireEvent.click(screen.getByRole('button', { name: 'Papierkorb' }));
    fireEvent.click(await screen.findByRole('button', { name: /„Weg“ .* wiederherstellen/ }));
    await waitFor(() => expect(onDataChanged).toHaveBeenCalledTimes(1));
    const trashDialog = screen.getByRole('dialog', { name: 'Papierkorb' });
    fireEvent.click(within(trashDialog).getAllByRole('button', { name: 'Schließen' })[0]);
    await waitFor(() => expect(statsCalls).toBe(2));
    expect(screen.queryByRole('dialog', { name: 'Papierkorb' })).toBeNull();
  });

  it('offers the publisher merge to admins only', async () => {
    route([[/^\/api\/stats$/, statsBody()]]);
    const { unmount } = render(ui());
    await screen.findByText('1.234,50 €');
    expect(screen.getByRole('button', { name: 'Verlage zusammenführen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sammlung aufräumen' })).toBeTruthy();
    unmount();
    render(ui({ user: { id: 2, role: 'editor' } }));
    await screen.findByText('1.234,50 €');
    expect(screen.queryByRole('button', { name: 'Verlage zusammenführen' })).toBeNull();
  });
});
