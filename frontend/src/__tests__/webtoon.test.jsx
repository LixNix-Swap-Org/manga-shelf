// Webtoons: the format choice, the lookup suggestion, chapter progress on cards and on the detail page, filter and sorting.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fakeResponse } from './fakeResponse';
import { recordToasts } from './toastLog';
import { hitToForm } from '../utils/lookupPrefill';
import { isMpEdition } from '../utils/editions';
import { getChapterProgress, isWebtoon } from '../utils/volumeHelpers';
import { filterAndSortMangas, getCollectCounts, hasCollectionGaps } from '../utils/collectionHelpers';
import MangaCard, { seriesSummary } from '../components/dashboard/MangaCard';
import ChapterProgress, { withChapter } from '../components/detail/ChapterProgress';
import FormatFields from '../components/common/FormatFields';
import { mergeEditLookup, editLookupHint, buildFormData } from '../hooks/useMangaData';

const WEBTOON = {
  id: 9, title: 'Solo Leveling', status: 'Abgeschlossen', format: 'webtoon', total_chapters: 200, chapters_read: 150,
  owned_volumes: 0, regular_owned: 0, total_volumes: null, language: 'de', currency: 'EUR'
};

describe('webtoon helpers', () => {
  it('add dialog: a manhwa hit suggests the webtoon format and its chapter count, a Manga Passion hit sets print again', () => {
    const hit = { id: 'al_1', source: 'anilist', title: 'Solo Leveling', series_format: 'webtoon', total_chapters: 201, manga_passion_id: null };
    expect(hitToForm({ ...hit, total_volumes: 15 }, { language: 'de', format: 'print', total_chapters: '', total_volumes: '' })).toMatchObject({ format: 'webtoon', total_chapters: '201', total_volumes: '' });
    const mp = { id: 'mp_7', source: 'manga_passion', title: 'Solo Leveling', manga_passion_id: 7 };
    expect(hitToForm(mp, { language: 'de', format: 'webtoon', total_chapters: '201' })).toMatchObject({ format: 'print', manga_passion_id: 7 });
    expect(hitToForm(mp, { language: 'de', format: 'print' })).toMatchObject({ format: 'print', manga_passion_id: 7 });
    expect(hitToForm({ id: 'al_2', source: 'anilist', title: 'X' }, { language: 'de' })).not.toHaveProperty('format');
    expect(hitToForm({ id: 'al_2', source: 'anilist', title: 'X' }, { language: 'de', format: 'webtoon' })).toMatchObject({ format: 'webtoon', manga_passion_id: null });
    expect(buildFormData(WEBTOON)).toMatchObject({ format: 'webtoon', total_chapters: 200 });
  });

  it('edit lookup: a hit never changes the format of the series; a webtoon hit on a print series only says so', () => {
    const hit = { id: 'al_1', source: 'anilist', title: 'Solo Leveling', series_format: 'webtoon', total_chapters: 201, total_volumes: 15, manga_passion_id: null };
    const mp = { id: 'mp_7', source: 'manga_passion', title: 'Solo Leveling', manga_passion_id: 7 };
    const print = buildFormData({ title: 'Solo Leveling', language: 'de', format: 'print', total_volumes: 14, manga_passion_id: 4711 });
    expect(mergeEditLookup(print, hit, null)).toMatchObject({ format: 'print', total_chapters: '', total_volumes: 14, manga_passion_id: 4711 });
    expect(editLookupHint(print, hit)).toBe('Treffer ist ein Webtoon – Form bleibt Druck');
    expect(editLookupHint(print, mp)).toBe('');
    const webtoon = buildFormData(WEBTOON);
    expect(mergeEditLookup(webtoon, hit, null)).toMatchObject({ format: 'webtoon', total_chapters: '201' });
    expect(mergeEditLookup(webtoon, mp, null)).toMatchObject({ format: 'webtoon', manga_passion_id: null });
    expect(editLookupHint(webtoon, hit)).toBe('');
  });

  it('Manga Passion knows no webtoons; chapter progress like the volume progress', () => {
    expect([isMpEdition({ language: 'de' }), isMpEdition({ language: 'de', format: 'webtoon' })]).toEqual([true, false]);
    expect(isWebtoon(WEBTOON)).toBe(true);
    expect(getChapterProgress(WEBTOON)).toEqual({ read: 150, total: 200, pct: 75 });
    expect(getChapterProgress({ chapters_read: 199, total_chapters: 200 }).pct).toBe(99);
    expect(getChapterProgress({ chapters_read: 1, total_chapters: 5000 }).pct).toBe(1);
    expect(getChapterProgress({ chapters_read: 210, total_chapters: 200 }).pct).toBe(100);
    expect(getChapterProgress({ chapters_read: 12 })).toEqual({ read: 12, total: 0, pct: null });
  });

  it('the "Webtoons" filter, no volume gaps from a total, sorting by chapter progress', () => {
    const print = { id: 1, title: 'Print', total_volumes: 10, regular_owned: 2, owned_volumes: 2 };
    const fresh = { ...WEBTOON, id: 2, title: 'Frisch', chapters_read: 0, total_volumes: 14 };
    const rows = [print, WEBTOON, fresh];
    expect(getCollectCounts(rows).webtoon).toBe(2);
    expect(hasCollectionGaps(fresh)).toBe(false);
    expect(hasCollectionGaps({ ...fresh, missing_count: 1 })).toBe(true);
    const opts = { searchQuery: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'completion_desc' };
    expect(filterAndSortMangas(rows, { ...opts, collectFilter: 'webtoon' }).map((m) => m.id)).toEqual([9, 2]);
    expect(filterAndSortMangas(rows, { ...opts, collectFilter: 'ALL' }).map((m) => m.id)).toEqual([9, 1, 2]);
  });
});

describe('MangaCard of a webtoon', () => {
  it('shows the pill, the chapter count, the chapter bar and a summary in chapters', () => {
    const { container } = render(<MemoryRouter><MangaCard manga={WEBTOON} getStatusBadge={() => ''} /></MemoryRouter>);
    expect(screen.getByText('Webtoon')).toBeTruthy();
    expect(screen.getByText('150 / 200 Kap.')).toBeTruthy();
    expect(screen.getByText('75% gelesen')).toBeTruthy();
    expect(container.querySelector('[style="width: 75%;"]')).toBeTruthy();
    expect(seriesSummary(WEBTOON, { owned: 0, total: 0, extras: 0 }, { read: 0 })).toBe('Abgeschlossen, Webtoon, 150 von 200 Kapiteln gelesen');
    expect(seriesSummary({ ...WEBTOON, total_chapters: null, chapters_read: 1 }, { owned: 2, total: 0, extras: 0 }, { read: 0 }))
      .toBe('Abgeschlossen, Webtoon, 1 Kapitel gelesen, 2 Bände');
  });
});

describe('FormatFields', () => {
  it('asks for the chapter count only for a webtoon', () => {
    const onChange = vi.fn();
    const { rerender } = render(<FormatFields value={{ format: 'print' }} onChange={onChange} idPrefix="f" />);
    expect(screen.queryByLabelText('Kapitel gesamt')).toBeNull();
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'webtoon' } });
    expect(onChange).toHaveBeenCalledWith({ format: 'webtoon' });
    rerender(<FormatFields value={{ format: 'webtoon', total_chapters: '' }} onChange={onChange} idPrefix="f" />);
    fireEvent.change(screen.getByLabelText('Kapitel gesamt'), { target: { value: '200' } });
    expect(onChange).toHaveBeenLastCalledWith({ total_chapters: '200' });
  });
});

describe('ChapterProgress', () => {
  let toasts;
  let fetchMock;
  const user = { id: 1, username: 'anna' };
  const manga = { ...WEBTOON, chapter_progress: [{ user_id: 1, username: 'anna', chapters_read: 150 }, { user_id: 2, username: 'ben', chapters_read: 30 }] };

  beforeEach(() => {
    toasts = recordToasts();
    fetchMock = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      const next = body.add ? 150 + body.add : body.chapters_read;
      return fakeResponse(200, { success: true, manga_id: 9, chapters_read: next, previous: 150, total_chapters: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    toasts.stop();
    vi.unstubAllGlobals();
  });

  it('shows the own chapter and the other readers; +1 saves and offers an undo', async () => {
    const onSaved = vi.fn();
    render(<ChapterProgress manga={manga} user={user} canChange isOffline={false} onSaved={onSaved} />);
    expect(screen.getByRole('progressbar', { name: 'Lesefortschritt' }).getAttribute('aria-valuetext')).toBe('150 von 200 Kapiteln gelesen');
    expect(within(screen.getByRole('list')).getByText('ben: Kapitel 30')).toBeTruthy();
    expect(screen.queryByText('anna: Kapitel 150')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+1 – ein Kapitel mehr gelesen' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ chapters_read: 151 })));
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method, JSON.parse(init.body)]).toEqual(['/api/mangas/9/chapters', 'PUT', { add: 1 }]);
    expect(toasts.last().message).toBe('Solo Leveling: bis Kapitel 151 gelesen');
    toasts.last().action.onClick();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ chapters_read: 150 });
  });

  it('"Gelesen bis Kapitel" sets a value; a refused one shows the server text', async () => {
    const onSaved = vi.fn();
    render(<ChapterProgress manga={manga} user={user} canChange isOffline={false} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText('Gelesen bis Kapitel'), { target: { value: '170' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ chapters_read: 170 })));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chapters_read: 170 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Speichern' }).disabled).toBe(false));

    // the field's max keeps a value above the total from being sent; the server refuses one that a lowered total makes too high
    fireEvent.change(screen.getByLabelText('Gelesen bis Kapitel'), { target: { value: '201' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementationOnce(async () => fakeResponse(400, { error: 'Kapitel 180 gibt es bei dieser Reihe nicht (sie hat 160 Kapitel).', code: 'CHAPTER_ABOVE_TOTAL', total_chapters: 160 }));
    fireEvent.change(screen.getByLabelText('Gelesen bis Kapitel'), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(toasts.messages('error')).toEqual(['Kapitel 180 gibt es bei dieser Reihe nicht (sie hat 160 Kapitel).']));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('offline or without the right it only shows; +1 stops at the end', () => {
    const { rerender } = render(<ChapterProgress manga={manga} user={user} canChange={false} isOffline onSaved={() => {}} />);
    expect(screen.queryByRole('button', { name: /ein Kapitel mehr/ })).toBeNull();
    expect(screen.getByText('Offline lässt sich der Kapitelstand nicht ändern.')).toBeTruthy();
    rerender(<ChapterProgress manga={{ ...manga, chapters_read: 200 }} user={user} canChange isOffline={false} onSaved={() => {}} />);
    expect(screen.getByRole('button', { name: '+1 – ein Kapitel mehr gelesen' }).disabled).toBe(true);
  });

  it('withChapter puts the own chapter into the detail', () => {
    expect(withChapter(manga, { chapters_read: 0 }, user)).toMatchObject({ chapters_read: 0, chapter_progress: [{ user_id: 2, chapters_read: 30 }] });
    expect(withChapter(manga, { chapters_read: 160 }, user).chapter_progress.map((p) => [p.username, p.chapters_read])).toEqual([['anna', 160], ['ben', 30]]);
    expect(withChapter(manga, { manga_id: 9, chapters_read: 160 }, user).chapters_read).toBe(160);
  });

  it('an undo tapped after opening another series stores the first one and leaves the shown one alone', async () => {
    const onSaved = vi.fn();
    const { rerender } = render(<ChapterProgress manga={manga} user={user} canChange isOffline={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: '+1 – ein Kapitel mehr gelesen' }));
    await waitFor(() => expect(toasts.last()?.action).toBeTruthy());
    const other = { ...manga, id: 12, title: 'Tower of God', chapters_read: 40, chapter_progress: [{ user_id: 1, username: 'anna', chapters_read: 40 }] };
    rerender(<ChapterProgress manga={other} user={user} canChange isOffline={false} onSaved={onSaved} />);
    toasts.last().action.onClick();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/mangas/9/chapters');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(withChapter(other, onSaved.mock.calls[1][0], user)).toBe(other);
  });

  it('chapter numbers are formatted like every other number', () => {
    const long = { ...manga, total_chapters: 2000, chapters_read: 1500, chapter_progress: [{ user_id: 2, username: 'ben', chapters_read: 1200 }] };
    render(<ChapterProgress manga={long} user={user} canChange={false} isOffline={false} onSaved={() => {}} />);
    expect(screen.getByRole('progressbar', { name: 'Lesefortschritt' }).getAttribute('aria-valuetext')).toBe('1.500 von 2.000 Kapiteln gelesen');
    expect(screen.getByText('ben: Kapitel 1.200')).toBeTruthy();
  });
});
