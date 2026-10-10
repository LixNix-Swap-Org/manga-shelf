// Covers the online section of the shelf search, its collection matching, the shared lookup prefill and the empty panel.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OnlineResults, { clearOnlineAnswers } from '../components/dashboard/OnlineResults';
import MangaCollectionGrid from '../components/dashboard/MangaCollectionGrid';
import { matchHit, retryAfterSeconds, visibleHits } from '../utils/onlineMatch';
import { hitToForm, lookupSourceLabels, releasedSoFar } from '../utils/lookupPrefill';
import { lookupSourceLabels as modalSourceLabels } from '../components/modals/AddMangaModal';
import { setDefaultLanguage } from '../utils/editions';
import { fakeResponse } from './fakeResponse';

const MP_HIT = {
  id: 'mp_7', source: 'manga_passion', manga_passion_id: 7, title: 'Frieren', alt_title: 'Sousou no Frieren', author: 'Kanehito Yamada',
  publisher: 'Egmont', status: 'Laufend', total_volumes: 12, cover_image: 'https://img.example/frieren.jpg'
};
const AL_HIT = {
  id: 'al_1', source: 'anilist', title: 'Frieren: Beyond Journey’s End', author: 'Kanehito Yamada', publisher: null, status: 'Abgeschlossen',
  total_volumes: 13, cover_image: '', work_key: 'anilist:1', also_on: ['mal']
};

const answer = (status, body, headers = {}) => {
  const res = fakeResponse(status, body);
  for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
  return res;
};

let calls = [];
const stubLookup = (...responses) => {
  calls = [];
  const queue = [...responses];
  vi.stubGlobal('fetch', vi.fn((url, init) => {
    calls.push(String(url));
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next(url, init) : Promise.resolve(next);
  }));
};

const renderResults = (props = {}) => render(
  <MemoryRouter>
    <OnlineResults query="frieren" mangas={[]} canEdit onAdd={vi.fn()} {...props} />
  </MemoryRouter>
);

beforeEach(() => {
  clearOnlineAnswers();
  setDefaultLanguage('de');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setDefaultLanguage('de');
});

describe('OnlineResults', () => {
  it('announces the search, then the count once, in a polite live region', async () => {
    stubLookup(answer(200, [MP_HIT, AL_HIT]));
    renderResults();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Online-Suche läuft…');
    expect(await screen.findByText('2 online gefunden')).toBe(status);
    expect(screen.getByRole('heading', { level: 2, name: 'Online-Treffer zu „frieren“' })).toBeTruthy();
    expect(calls).toEqual(['/api/lookup/manga?q=frieren']);
  });

  it('asks with the default edition language like Auto-fill does', async () => {
    setDefaultLanguage('en');
    stubLookup(answer(200, []));
    renderResults();
    expect(await screen.findByText('Online nichts gefunden zu „frieren“')).toBeTruthy();
    expect(calls).toEqual(['/api/lookup/manga?q=frieren&language=en']);
  });

  it('names the rate limit with its wait, unavailable sources and any other failure', async () => {
    stubLookup(answer(429, { error: 'Zu viele Suchanfragen' }, { 'Retry-After': '42' }));
    const first = renderResults();
    expect(await screen.findByText('Zu viele Online-Suchen – in 42 s wieder')).toBeTruthy();
    first.unmount();

    clearOnlineAnswers();
    stubLookup(answer(503, { error: 'x', code: 'SOURCES_UNAVAILABLE' }));
    const second = renderResults();
    expect(await screen.findByText('Online-Quellen gerade nicht erreichbar')).toBeTruthy();
    second.unmount();

    clearOnlineAnswers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const third = renderResults();
    expect(await screen.findByText('Fehler bei der Suche')).toBeTruthy();
    third.unmount();

    clearOnlineAnswers();
    stubLookup(answer(400, { error: 'Suchbegriff erforderlich' }));
    renderResults();
    expect(await screen.findByText('Suchbegriff erforderlich')).toBeTruthy();
  });

  it('shows the picker look: cover, title, alternative title, author, publisher, volumes, status and source badges', async () => {
    stubLookup(answer(200, [MP_HIT, AL_HIT]));
    renderResults();
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    const mp = within(items[0]);
    expect(mp.getByText('Manga Passion')).toBeTruthy();
    expect(mp.getByRole('heading', { level: 3, name: 'Frieren' })).toBeTruthy();
    for (const text of ['Sousou no Frieren', 'Kanehito Yamada', 'Egmont', '12 Bände', 'Laufend']) expect(mp.getByText(text)).toBeTruthy();
    expect(items[0].querySelector('img').getAttribute('src')).toBe(MP_HIT.cover_image);
    const al = within(items[1]);
    expect(al.getByText('AniList')).toBeTruthy();
    expect(al.getByText('MyAnimeList')).toBeTruthy();
    expect(items[1].querySelector('img')).toBeNull();
  });

  it('shows at most ten hits in the order of the answer', async () => {
    const hits = Array.from({ length: 14 }, (_, i) => ({ id: `al_${i}`, source: 'anilist', title: `Titel ${i}` }));
    stubLookup(answer(200, hits));
    renderResults();
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(10);
    expect(within(items[0]).getByRole('heading').textContent).toBe('Titel 0');
    expect(within(items[9]).getByRole('heading').textContent).toBe('Titel 9');
    expect(screen.getByText('10 online gefunden')).toBeTruthy();
  });

  it('marks hits that are in the collection, other editions and similar titles', async () => {
    const mangas = [
      { id: 3, title: 'Frieren - Nach dem Ende der Reise', manga_passion_id: 7, language: 'de' },
      { id: 4, title: 'Frieren (EN)', work_key: 'anilist:1', language: 'en' },
      { id: 5, title: 'Rosa Liebe', language: 'de' }
    ];
    const hits = [MP_HIT, AL_HIT, { id: 'al_9', source: 'anilist', title: 'Rosa', work_key: 'anilist:9' }];
    stubLookup(answer(200, hits));
    const onAdd = vi.fn();
    renderResults({ mangas, onAdd });
    const items = await screen.findAllByRole('listitem');
    const owned = within(items[0]).getByRole('link');
    expect(owned.textContent).toBe('In der Sammlung: Frieren - Nach dem Ende der Reise');
    expect(owned.getAttribute('href')).toBe('/manga/3');
    expect(within(items[0]).queryByRole('button')).toBeNull();
    expect(within(items[1]).getByText('Andere Ausgabe vorhanden (Englisch)')).toBeTruthy();
    expect(within(items[1]).getByRole('button', { name: `Anlegen: ${AL_HIT.title}` })).toBeTruthy();
    const similar = within(items[2]).getByRole('link', { name: 'Ähnlicher Titel: Rosa Liebe' });
    expect(similar.getAttribute('href')).toBe('/manga/5');
    expect(within(items[2]).getByRole('button', { name: 'Anlegen: Rosa' })).toBeTruthy();
  });

  it('guests see the hits without an add button', async () => {
    stubLookup(answer(200, [MP_HIT]));
    renderResults({ canEdit: false });
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('"Anlegen" hands the add dialog the hit mapped like Auto-fill, without a volume', async () => {
    stubLookup(answer(200, [MP_HIT, AL_HIT]));
    const onAdd = vi.fn();
    renderResults({ onAdd });
    fireEvent.click(await screen.findByRole('button', { name: 'Anlegen: Frieren' }));
    expect(onAdd).toHaveBeenCalledWith({
      form: {
        language: 'de', region: 'DE', currency: 'EUR', title: 'Frieren', alt_title: 'Sousou no Frieren', author: 'Kanehito Yamada',
        publisher: 'Egmont', status: 'Laufend', total_volumes: '', tags: '', cover_image: MP_HIT.cover_image, manga_passion_id: 7, work_key: null
      },
      volume: null
    });
    fireEvent.click(screen.getByRole('button', { name: `Anlegen: ${AL_HIT.title}` }));
    expect(onAdd.mock.calls[1][0].form).toMatchObject({ title: AL_HIT.title, total_volumes: '13', manga_passion_id: null, work_key: 'anilist:1' });
    expect(onAdd.mock.calls[1][0].form).not.toHaveProperty('publisher');
  });

  it('the same query is answered from memory within ten minutes; a failed one is asked again on the next submit', async () => {
    stubLookup(answer(200, [MP_HIT]));
    const { rerender } = renderResults({ seq: 1 });
    await screen.findByText('1 online gefunden');
    rerender(<MemoryRouter><OnlineResults query="frieren" seq={2} mangas={[]} canEdit onAdd={vi.fn()} /></MemoryRouter>);
    rerender(<MemoryRouter><OnlineResults query="Frieren" seq={3} mangas={[]} canEdit onAdd={vi.fn()} /></MemoryRouter>);
    await screen.findByText('1 online gefunden');
    expect(calls).toHaveLength(1);

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000 + 1);
    rerender(<MemoryRouter><OnlineResults query="frieren" seq={4} mangas={[]} canEdit onAdd={vi.fn()} /></MemoryRouter>);
    await waitFor(() => expect(calls).toHaveLength(2));
    clock.mockRestore();

    clearOnlineAnswers();
    stubLookup(answer(400, { error: 'Suchbegriff erforderlich' }), answer(200, [MP_HIT]));
    rerender(<MemoryRouter><OnlineResults query="rosa" seq={5} mangas={[]} canEdit onAdd={vi.fn()} /></MemoryRouter>);
    await screen.findByText('Suchbegriff erforderlich');
    rerender(<MemoryRouter><OnlineResults query="rosa" seq={6} mangas={[]} canEdit onAdd={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('1 online gefunden')).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('a new query aborts the running request and ignores its late answer', async () => {
    let releaseFirst;
    const signals = [];
    stubLookup(
      (url, init) => { signals.push(init.signal); return new Promise((resolve) => { releaseFirst = resolve; }); },
      (url, init) => { signals.push(init.signal); return Promise.resolve(answer(200, [AL_HIT])); }
    );
    const { rerender } = renderResults({ query: 'fri' });
    rerender(<MemoryRouter><OnlineResults query="frieren" mangas={[]} canEdit onAdd={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('1 online gefunden')).toBeTruthy();
    expect(signals[0].aborted).toBe(true);
    await act(async () => { releaseFirst(answer(200, [MP_HIT, AL_HIT, { id: 'x', title: 'X' }])); });
    expect(screen.getByText('1 online gefunden')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('embedded in the empty panel it has no heading of its own', async () => {
    stubLookup(answer(200, [MP_HIT]));
    renderResults({ embedded: true });
    await screen.findByText('1 online gefunden');
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('OnlineResults lookup memory', () => {
  const section = (props = {}) => (
    <MemoryRouter><OnlineResults query="frieren" seq={1} mangas={[]} canEdit onAdd={vi.fn()} {...props} /></MemoryRouter>
  );

  it('a remount or a new submit while the lookup runs joins it; a later mount shows the answer at once', async () => {
    let release;
    const signals = [];
    stubLookup((url, init) => { signals.push(init.signal); return new Promise((resolve) => { release = resolve; }); });
    const first = render(section());
    expect(screen.getByRole('status').textContent).toBe('Online-Suche läuft…');
    first.unmount();
    const second = render(section({ embedded: true }));
    second.rerender(section({ embedded: true, seq: 2 }));
    expect(calls).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    await act(async () => { release(answer(200, [MP_HIT])); });
    expect(await screen.findByText('1 online gefunden')).toBeTruthy();
    second.unmount();
    render(section({ seq: 2 }));
    expect(screen.getByRole('status').textContent).toBe('1 online gefunden');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('after a 429 nothing is asked before Retry-After, for any query; then only a new submit asks', async () => {
    stubLookup(answer(429, {}, { 'Retry-After': '30' }), answer(200, [MP_HIT]));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = render(section());
    expect(await screen.findByText('Zu viele Online-Suchen – in 30 s wieder')).toBeTruthy();
    first.unmount();
    clock.mockReturnValue(now + 10_000);
    const view = render(section({ embedded: true }));
    view.rerender(section({ embedded: true, seq: 2 }));
    expect(await screen.findByText('Zu viele Online-Suchen – in 20 s wieder')).toBeTruthy();
    view.rerender(section({ embedded: true, query: 'rosa', seq: 3 }));
    expect(await screen.findByText('Zu viele Online-Suchen – in 20 s wieder')).toBeTruthy();
    expect(calls).toHaveLength(1);
    clock.mockReturnValue(now + 31_000);
    view.rerender(section({ query: 'rosa', seq: 3 }));
    expect(calls).toHaveLength(1);
    view.rerender(section({ query: 'rosa', seq: 4 }));
    expect(await screen.findByText('1 online gefunden')).toBeTruthy();
    expect(calls).toEqual(['/api/lookup/manga?q=frieren', '/api/lookup/manga?q=rosa']);
    clock.mockRestore();
  });

  it('unavailable sources are kept for half a minute; a remount never asks again', async () => {
    stubLookup(answer(503, { code: 'SOURCES_UNAVAILABLE' }), answer(200, [MP_HIT]));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = render(section());
    expect(await screen.findByText('Online-Quellen gerade nicht erreichbar')).toBeTruthy();
    first.unmount();
    clock.mockReturnValue(now + 20_000);
    const view = render(section({ embedded: true }));
    view.rerender(section({ embedded: true, seq: 2 }));
    expect(screen.getByText('Online-Quellen gerade nicht erreichbar')).toBeTruthy();
    clock.mockReturnValue(now + 31_000);
    view.unmount();
    const later = render(section({ seq: 2 }));
    expect(calls).toHaveLength(1);
    later.rerender(section({ seq: 3 }));
    expect(await screen.findByText('1 online gefunden')).toBeTruthy();
    expect(calls).toHaveLength(2);
    clock.mockRestore();
  });

  it('takes focus once when asked: its heading below the shelf, its status line inside the empty panel', async () => {
    stubLookup(answer(200, [MP_HIT]));
    const focusRequest = { current: true };
    const below = render(section({ focusRequest }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Online-Treffer zu „frieren“' }));
    expect(focusRequest.current).toBe(false);
    below.unmount();
    const again = render(section({ focusRequest, embedded: true }));
    expect(document.activeElement).toBe(document.body);
    again.unmount();
    focusRequest.current = true;
    render(section({ focusRequest, embedded: true }));
    expect(document.activeElement).toBe(screen.getByRole('status'));
    await screen.findByText('1 online gefunden');
  });
});

describe('onlineMatch', () => {
  const mangas = [
    { id: 1, title: 'One Piece', manga_passion_id: 11, language: 'de' },
    { id: 2, title: 'Berserk', work_key: 'anilist:2', language: 'en' },
    { id: 3, title: 'Berserk Deluxe', work_key: 'anilist:2', language: 'de' },
    { id: 4, title: 'Vagabond', work_key: 'mal:4', language: 'ja' }
  ];

  it('Manga Passion id, work key in the default language, other edition, similar title, nothing', () => {
    expect(matchHit({ manga_passion_id: 11, title: 'Egal' }, mangas, { language: 'de' })).toEqual({ kind: 'owned', manga: mangas[0] });
    expect(matchHit({ manga_passion_id: '11', title: 'Egal' }, mangas, { language: 'de' })?.manga).toBe(mangas[0]);
    expect(matchHit({ work_key: 'anilist:2', title: 'X' }, mangas, { language: 'de' })).toEqual({ kind: 'owned', manga: mangas[2] });
    expect(matchHit({ work_key: 'anilist:2', title: 'X' }, mangas, { language: 'en' })).toEqual({ kind: 'owned', manga: mangas[1] });
    expect(matchHit({ work_key: 'mal:4', title: 'X' }, mangas, { language: 'de' })).toEqual({ kind: 'otherEdition', manga: mangas[3] });
    expect(matchHit({ title: 'One Pie' }, mangas, { language: 'de' })).toEqual({ kind: 'similar', manga: mangas[0] });
    expect(matchHit({ title: 'Piece One' }, mangas, { language: 'de' })).toEqual({ kind: 'similar', manga: mangas[0] });
    expect(matchHit({ title: 'Naruto' }, mangas, { language: 'de' })).toBeNull();
    expect(matchHit({ manga_passion_id: 99, title: 'Naruto' }, mangas, { language: 'de' })).toBeNull();
    expect(matchHit({ title: 'Berserk' }, [], { language: 'de' })).toBeNull();
  });

  it('a typo-only title hit (rank 3) and an author hit (rank 2) are not similar titles', () => {
    expect(matchHit({ title: 'Berzerk' }, mangas, { language: 'de' })).toBeNull();
    expect(matchHit({ title: 'Oda' }, [{ id: 9, title: 'Wanted', author: 'Eiichiro Oda' }], { language: 'de' })).toBeNull();
  });

  it('visibleHits and retryAfterSeconds', () => {
    expect(visibleHits(null)).toEqual([]);
    expect(visibleHits([null, { id: 1 }, 'x'])).toEqual([{ id: 1 }]);
    expect(retryAfterSeconds('42')).toBe(42);
    expect(retryAfterSeconds('0')).toBe(1);
    expect(retryAfterSeconds(null)).toBe(60);
    expect(retryAfterSeconds('Sat, 10 Oct 2026 12:00:30 GMT', 60, Date.parse('Sat, 10 Oct 2026 12:00:00 GMT'))).toBe(30);
  });
});

describe('lookupPrefill', () => {
  const previous = {
    title: 'Frier', alt_title: '', author: 'Alt', publisher: 'Carlsen', status: 'Pausiert', total_volumes: '5', description: 'alt',
    cover_image: '/uploads/alt.jpg', manga_passion_id: null, language: 'de', region: 'DE', currency: 'EUR', work_key: null,
    wish: false, wish_priority: '3'
  };

  it('maps a hit onto the current form exactly as the add dialog always did', () => {
    expect(hitToForm(MP_HIT, previous)).toEqual({
      ...previous, title: 'Frieren', alt_title: 'Sousou no Frieren', author: 'Kanehito Yamada', publisher: 'Egmont', status: 'Laufend',
      total_volumes: '5', tags: '', cover_image: MP_HIT.cover_image, manga_passion_id: 7, work_key: null
    });
    expect(hitToForm({ ...AL_HIT, publisher: 'Unbekannt', status: 'Unbekannt', cover_image: '' }, previous)).toEqual({
      ...previous, title: AL_HIT.title, author: 'Kanehito Yamada', total_volumes: '13', tags: '', work_key: 'anilist:1'
    });
    expect(hitToForm({ id: 'mal_5', source: 'mal', title: 'X' }, previous).work_key).toBe('mal:5');
    expect(hitToForm(MP_HIT, { ...previous, language: 'en' }).manga_passion_id).toBeNull();
  });

  it('without a form it only names what the hit brings, so the dialog keeps its defaults for the rest', () => {
    expect(hitToForm({ id: 'al_3', source: 'anilist', title: 'Y' }, { language: 'de' })).toEqual({
      language: 'de', title: 'Y', total_volumes: '', tags: '', manga_passion_id: null, work_key: 'anilist:3'
    });
  });

  it('takes the tags of the picked hit and never keeps those of an earlier pick', () => {
    const tags = 'Shounen, Action, Comedy';
    expect(hitToForm({ ...MP_HIT, tags }, previous).tags).toBe(tags);
    expect(hitToForm(AL_HIT, { ...previous, tags }).tags).toBe('');
  });

  it('names the released count only for a running series whose total stays open', () => {
    expect(releasedSoFar(MP_HIT)).toBe(12);
    expect(releasedSoFar({ ...MP_HIT, status: 'Releasing', total_volumes: '22' })).toBe(22);
    expect(releasedSoFar(AL_HIT)).toBeNull();
    expect(releasedSoFar({ ...MP_HIT, total_volumes: null })).toBeNull();
    expect(releasedSoFar({ ...MP_HIT, total_volumes: 0 })).toBeNull();
    expect(releasedSoFar(null)).toBeNull();
  });

  it('the dialog still exports the shared source badges', () => {
    expect(modalSourceLabels).toBe(lookupSourceLabels);
  });
});

describe('MangaCollectionGrid search extras', () => {
  const base = {
    canEdit: true, error: null, filtered: [], getStatusBadge: () => null, handleDeleteManga: vi.fn(), handleOpenModal: vi.fn(),
    isOffline: false, loading: false, onRetry: vi.fn(), publisherFilter: 'ALL', search: 'rosa', statusFilter: 'ALL', viewMode: 'grid',
    setSearch: vi.fn(), setStatusFilter: vi.fn(), setPublisherFilter: vi.fn()
  };
  const renderGrid = (props) => render(<MemoryRouter><MangaCollectionGrid {...base} {...props} /></MemoryRouter>);

  it('"Keine Treffer" offers the online search, a new series for editors and keeps the reset', () => {
    const extras = { query: 'rosa', renderSection: null, onSearchOnline: vi.fn(), onCreateSeries: vi.fn() };
    renderGrid({ searchExtras: extras });
    expect(screen.getByRole('heading', { name: 'Keine Treffer gefunden' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Online nach „rosa“ suchen' }));
    expect(extras.onSearchOnline).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Neue Reihe „rosa“ anlegen' }));
    expect(extras.onCreateSeries).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Filter & Suche zurücksetzen/ }));
    expect(base.setSearch).toHaveBeenCalledWith('');
  });

  it('with online results the panel reads "Nicht in deiner Sammlung" and shows them instead of its text', () => {
    const renderSection = vi.fn((embedded) => <div>Online-Abschnitt {String(embedded)}</div>);
    renderGrid({ searchExtras: { query: 'rosa', renderSection, onSearchOnline: null, onCreateSeries: vi.fn() } });
    expect(screen.getByRole('heading', { name: 'Nicht in deiner Sammlung' })).toBeTruthy();
    expect(screen.getByText('Online-Abschnitt true')).toBeTruthy();
    expect(screen.queryByText(/Für die aktuellen Such- und Filtereinstellungen/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Online nach/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Neue Reihe „rosa“ anlegen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Filter & Suche zurücksetzen/ })).toBeTruthy();
  });

  it('below the shelf: the row or the section; without extras the empty panel is unchanged', () => {
    const manga = { id: 1, title: 'Rosario', status: 'Laufend', owned_volumes: 1, regular_owned: 1 };
    const onSearchOnline = vi.fn();
    const { rerender } = renderGrid({ filtered: [manga], searchExtras: { query: 'rosa', renderSection: null, onSearchOnline, onCreateSeries: vi.fn() } });
    fireEvent.click(screen.getByRole('button', { name: 'Online nach „rosa“ suchen' }));
    expect(onSearchOnline).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Neue Reihe/ })).toBeNull();
    rerender(<MemoryRouter><MangaCollectionGrid {...base} filtered={[manga]} viewMode="list" searchExtras={{ query: 'rosa', renderSection: (e) => <p>Abschnitt {String(e)}</p>, onSearchOnline: null, onCreateSeries: null }} /></MemoryRouter>);
    expect(screen.getByText('Abschnitt false')).toBeTruthy();
    rerender(<MemoryRouter><MangaCollectionGrid {...base} /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Keine Treffer gefunden' })).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['Filter & Suche zurücksetzen']);
  });
});
