// The anime calendar writes its days in the format of the UI language, never a fixed German "19.10.".
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import AnimeCalendarTab from '../components/dashboard/animehub/AnimeCalendarTab';
import { fakeResponse } from './fakeResponse';
import { setLanguage, resetI18nForTests } from '../i18n/index.js';

const NOW = new Date(2026, 9, 21, 12);
const sec = (d) => Math.floor(d.getTime() / 1000);
const show = {
  id: 1, title: 'Frieren', format: 'TV', episodes: 12, my_progress: { status: 'Schaue', episodes_watched: 2 },
  next_airing: { episode: 3, at: sec(new Date(2026, 9, 23, 16)) }
};

const openCalendar = async () => {
  render(<AnimeCalendarTab list={[show]} now={NOW} onOpen={vi.fn()} />);
  await act(async () => {});
};
const weekDays = () => [...document.querySelectorAll('#anime-calendar ol > li .font-mono')].map((el) => el.textContent);

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, { airings: [], finished: [] })));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => resetI18nForTests());

describe('AnimeCalendarTab dates', () => {
  it('German: day and month with dots in the week, the month cells and the day list', async () => {
    await openCalendar();
    expect(weekDays()).toEqual(['19.10.', '20.10.', '21.10.', '22.10.', '23.10.', '24.10.', '25.10.']);
    fireEvent.click(screen.getByRole('button', { name: 'Monat' }));
    expect(screen.getByRole('gridcell', { name: '23.10. · 1 Folge' })).toBeTruthy();
    expect(document.querySelector('#anime-calendar-day h3').textContent).toMatch(/21\.10\.$/);
  });

  it('English: the same days in the English format, no German dots', async () => {
    await setLanguage('en', { persist: false, env: { languages: ['en'] } });
    await openCalendar();
    expect(weekDays()).toEqual(['19/10', '20/10', '21/10', '22/10', '23/10', '24/10', '25/10']);
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(screen.getByRole('gridcell', { name: '23/10 · 1 episode' })).toBeTruthy();
    expect(document.querySelector('#anime-calendar-day h3').textContent).toMatch(/21\/10$/);
    expect(document.getElementById('anime-calendar').textContent).not.toMatch(/\d{1,2}\.\d{1,2}\./);
  });
});

describe('AnimeCalendarTab view switch', () => {
  it('exactly the shown view is pressed, also in the year view', async () => {
    resetI18nForTests();
    await openCalendar();
    const pressed = () => ['Woche', 'Monat', 'Jahr'].filter((name) => screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true');
    expect(pressed()).toEqual(['Woche']);
    fireEvent.click(screen.getByRole('button', { name: 'Jahr' }));
    expect(pressed()).toEqual(['Jahr']);
    fireEvent.click(screen.getByRole('button', { name: 'Monat' }));
    expect(pressed()).toEqual(['Monat']);
  });
});
