// Review fixes of the editions wave (I18N-D) in the frontend: offline language switch, money in the edition currency,
// shared/printed shopping list totals, Manga Passion gating, edition switcher links and shelf filters.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// a catalog that was never cached: its chunk cannot load offline
vi.mock('../i18n/locales/fr.json', () => { throw new Error('Failed to fetch dynamically imported module'); });

import { getLanguage, LOCALE_KEY, resetI18nForTests } from '../i18n/index.js';
import { PENDING_KEY, chooseLanguage, setLanguageTarget } from '../i18n/preference.js';
import LanguageSelect from '../components/common/LanguageSelect';
import { resetServiceWorkerWatcher, warmLanguageCache, warmLanguages, watchServiceWorkerUpdates } from '../hooks/usePwaInstall';
import { currencySymbol } from '../utils/format';
import StatusPriceFields from '../components/detail/volumeEdit/StatusPriceFields';
import VolumeEditModal from '../components/detail/VolumeEditModal';
import AddVolumeBar from '../components/detail/AddVolumeBar';
import BatchAddModal from '../components/detail/BatchAddModal';
import BulkActionBar from '../components/detail/BulkActionBar';
import useVolumeGallery from '../hooks/useVolumeGallery';
import { buildShareText, itemText, summaryText } from '../utils/shareList';
import { canFillTags } from '../hooks/useMangaData';
import { isMpVolume } from '../utils/editions';
import AddMangaModal from '../components/modals/AddMangaModal';
import useMpGaps from '../hooks/useMpGaps';
import { writeCache, clearDataCache, LIST_KEY } from '../utils/dataCache';
import EditionSwitcher from '../components/detail/EditionSwitcher';
import CollectionStats from '../components/dashboard/CollectionStats';
import MangaCollectionGrid from '../components/dashboard/MangaCollectionGrid';
import { fakeResponse } from './fakeResponse';

const json = (status, body) => fakeResponse(status, body);
const plain = (text) => String(text).replace(/\u00a0/g, ' ');

function mockFetch(routes) {
  const fn = vi.fn(async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${String(url).split('?')[0]}`;
    if (!routes[key]) throw new Error(`unexpected request ${key}`);
    return routes[key](url, init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const callsTo = (fn, key) => fn.mock.calls.filter(([url, init = {}]) => `${init.method || 'GET'} ${String(url).split('?')[0]}` === key);
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLanguageTarget(null);
  clearDataCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetI18nForTests();
  document.documentElement.lang = 'de';
});

describe('offline switch to a language whose catalog never loaded', () => {
  it('chooseLanguage changes nothing and queues nothing; a loadable language still goes out', async () => {
    const fetchFn = mockFetch({ 'PUT /api/auth/profile': () => json(200, { user: {} }) });
    setLanguageTarget({ id: 1, username: 'anna' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await chooseLanguage('fr')).toBe('de');
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(localStorage.getItem(LOCALE_KEY)).toBeNull();
    expect(callsTo(fetchFn, 'PUT /api/auth/profile')).toHaveLength(0);

    expect(await chooseLanguage('en')).toBe('en');
    await waitFor(() => expect(callsTo(fetchFn, 'PUT /api/auth/profile').map(bodyOf)).toEqual([{ locale: 'en' }]));
  });

  it('"follow the device" to an uncached device language is refused the same way', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['fr-FR'], language: 'fr-FR' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLanguageTarget({ id: 1, username: 'anna', offline: true });
    expect(await chooseLanguage('')).toBe('de');
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('LanguageSelect says so and keeps showing the active choice', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<LanguageSelect />);
    const select = screen.getByLabelText('Sprache');
    await act(async () => { fireEvent.change(select, { target: { value: 'fr' } }); });
    expect((await screen.findByRole('alert')).textContent).toBe('Sprache offline nicht verfügbar');
    expect(select.value).toBe('');
    expect(getLanguage()).toBe('de');
  });

  it('offline a failed chunk import is not turned into a page reload (the language switch reports it instead)', async () => {
    resetServiceWorkerWatcher();
    sessionStorage.clear();
    const reg = { active: null, waiting: null, installing: null, addEventListener: vi.fn(), update: vi.fn() };
    const container = { controller: null, addEventListener: vi.fn(), getRegistration: async () => reg };
    const win = { navigator: { onLine: false }, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
    const reload = vi.fn();
    await watchServiceWorkerUpdates({ container, win, doc: document, reload });
    const event = { preventDefault: vi.fn() };
    win.listeners['vite:preloadError'](event);
    expect(reload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    win.navigator.onLine = true;
    win.listeners['vite:preloadError'](event);
    expect(reload).toHaveBeenCalledTimes(1);
    resetServiceWorkerWatcher();
  });

  it('the worker warms the active and the device language once each', () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['ja-JP'], language: 'ja-JP' });
    expect(warmLanguages()).toEqual(['de', 'ja']);
    const reg = { active: { postMessage: vi.fn() } };
    warmLanguageCache(reg);
    expect(reg.active.postMessage.mock.calls.map(([m]) => m)).toEqual([
      { type: 'WARM_LANGUAGE', language: 'de' }, { type: 'WARM_LANGUAGE', language: 'ja' }
    ]);
    vi.stubGlobal('navigator', { ...navigator, languages: ['de-DE'], language: 'de-DE' });
    expect(warmLanguages()).toEqual(['de']);
  });
});

describe('money typed and shown in the edition currency', () => {
  it('currencySymbol follows the locale; an invalid code is the euro', () => {
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('USD', 'en-GB')).toBe('US$');
    expect(currencySymbol('nope')).toBe('€');
  });

  it('volume editor: price labels and suffix in the series currency; euro unchanged', () => {
    const form = { status: 'Fehlt', price: '', target_price: '' };
    const { rerender, container } = render(<StatusPriceFields editVolForm={form} setEditVolForm={vi.fn()} currency="USD" />);
    expect(screen.getByLabelText('Kaufpreis ($)')).toBeTruthy();
    expect(screen.getByLabelText('Zielpreis ($)')).toBeTruthy();
    expect(container.querySelector('span[aria-hidden="true"].absolute').textContent).toBe('$');
    rerender(<StatusPriceFields editVolForm={form} setEditVolForm={vi.fn()} />);
    expect(screen.getByLabelText('Kaufpreis (€)')).toBeTruthy();
    expect(screen.getByLabelText('Zielpreis (€)')).toBeTruthy();
  });

  it('add bar, batch dialog and bulk price use the series currency', async () => {
    render(
      <AddVolumeBar
        canEdit handleAddSingleVolume={vi.fn()} handleUploadNewSingleCover={vi.fn()} newVolumeCover="" newVolumeNum="" newVolumePrice=""
        newVolumeReleaseDate="" newVolumeStatus="Vorhanden" newVolumeType="volume" setNewVolumeCover={vi.fn()} setNewVolumeNum={vi.fn()}
        setNewVolumePrice={vi.fn()} setNewVolumeReleaseDate={vi.fn()} setNewVolumeStatus={vi.fn()} setNewVolumeType={vi.fn()}
        uploadingNewCover={false} currency="USD"
      />
    );
    expect(screen.getByLabelText('Preis in US-Dollar').getAttribute('placeholder')).toBe('Preis ($, z. B. 7,99)');

    render(<BatchAddModal isOpen onClose={vi.fn()} mangaId="1" manga={{ currency: 'JPY' }} />);
    expect(screen.getByLabelText('Preis pro Band (¥, optional)')).toBeTruthy();

    const onApply = vi.fn(async () => true);
    render(<BulkActionBar count={2} visibleCount={2} allVisibleSelected onSelectAllVisible={vi.fn()} onClear={vi.fn()} onClose={vi.fn()} onApply={onApply} userId={1} currency="USD" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preis…' }));
    fireEvent.change(screen.getByLabelText('Preis in $'), { target: { value: '9,99' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' })); });
    expect(onApply).toHaveBeenLastCalledWith({ set: { price: '9,99' } }, 'mit Preis 9,99 $ gespeichert');
  });

  it('the photo gallery subtitle shows the price in the series currency', () => {
    const { result } = renderHook(() => useVolumeGallery({ manga: { title: 'Frieren', currency: 'USD' } }));
    act(() => result.current.openVolumeGallery({ id: 1, volume_number: '2', cover_image: '/c.jpg', price: 7 }));
    expect(plain(result.current.lightboxData.subtitle)).toBe('Frieren • 7,00 $');
  });
});

describe('shared and printed shopping list', () => {
  const item = (over) => ({ manga_title: 'Berserk', volume_number: '1', type: 'volume', price: 7.5, ...over });

  it('adds only euro prices and lists the other currencies apart; items keep their currency', () => {
    const items = [
      item({}),
      item({ manga_title: 'Spirit Kingdom', volume_number: '2', price: 10, target_price: 9, currency: 'USD' }),
      item({ manga_title: 'Returner Ghost', volume_number: '6', price: 1200, currency: 'JPY' })
    ];
    expect(plain(itemText(items[1]))).toBe('Spirit Kingdom Band 2 – 10,00 $ · max. 9,00 $');
    expect(plain(itemText(items[2]))).toBe('Returner Ghost Band 6 – 1.200 ¥');
    expect(plain(summaryText(items))).toBe('3 Bände · ca. 7,50 € + 1.200 ¥ · 10,00 $');
    const text = plain(buildShareText({ items }));
    expect(text.split('\n')[1]).toBe('3 Bände · ca. 7,50 € + 1.200 ¥ · 10,00 $');
    expect(text).toContain('☐ Spirit Kingdom Band 2 – 10,00 $');
  });

  it('euro-only lists read as before; without euro prices the other currencies stand alone', () => {
    expect(plain(summaryText([item({}), item({ price: 7 })]))).toBe('2 Bände · ca. 14,50 €');
    expect(plain(summaryText([item({ price: null })]))).toBe('1 Band');
    expect(plain(summaryText([item({ price: null })], { always: true }))).toBe('1 Band · ca. 0,00 €');
    expect(plain(summaryText([item({ price: 10, currency: 'USD' })]))).toBe('1 Band · ca. 10,00 $');
    expect(summaryText([], { always: true })).toBe('0 Bände');
  });
});

describe('Manga Passion only for German editions', () => {
  it('"Genres nachladen" is not offered for a non-German series with a Manga Passion id', () => {
    expect(canFillTags({ manga_passion_id: 5, tags: '', language: 'de' })).toBe(true);
    expect(canFillTags({ manga_passion_id: 5, tags: '', language: 'en' })).toBe(false);
  });

  it('add dialog: another language drops a picked Manga Passion id and names only AniList / MyAnimeList', async () => {
    const fetchFn = mockFetch({
      'GET /api/lookup/manga': () => json(200, [
        { id: 'mp_1', source: 'manga_passion', title: 'Frieren', manga_passion_id: 12 },
        { id: 'al_2', source: 'anilist', title: 'Frieren: Beyond Journey', work_key: 'anilist:2' }
      ]),
      'POST /api/mangas': () => json(200, { success: true, id: 7 })
    });
    const pickMpHit = async () => {
      const view = render(<AddMangaModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
      const button = screen.getByRole('button', { name: /Auto-Fill/ });
      expect(button.getAttribute('title')).toBe('Sucht in Manga Passion (deutsche Ausgaben), AniList und MyAnimeList');
      fireEvent.change(screen.getByPlaceholderText(/One Piece/), { target: { value: 'Frieren' } });
      fireEvent.click(button);
      expect(await screen.findByText('Treffer auswählen (Manga Passion zuerst):')).toBeTruthy();
      fireEvent.click(screen.getAllByRole('button', { name: /Manga Passion.*Frieren|Frieren.*Manga Passion/ })[0]);
      await waitFor(() => expect(screen.queryByText('Treffer auswählen (Manga Passion zuerst):')).toBeNull());
      return { view, button };
    };
    // German keeps the picked id
    const first = await pickMpHit();
    fireEvent.click(document.querySelector('button[type="submit"]'));
    await waitFor(() => expect(callsTo(fetchFn, 'POST /api/mangas')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[0])).toMatchObject({ language: 'de', manga_passion_id: 12 });
    first.view.unmount();

    const { button: autofill } = await pickMpHit();
    fireEvent.change(screen.getByLabelText('Sprache der Ausgabe'), { target: { value: 'en' } });
    expect(autofill.getAttribute('title')).toBe('Sucht in AniList und MyAnimeList (Manga Passion kennt nur deutsche Ausgaben)');
    fireEvent.click(autofill);
    expect(await screen.findByText('Treffer auswählen (AniList / MyAnimeList):')).toBeTruthy();
    fireEvent.click(document.querySelector('button[type="submit"]'));
    await waitFor(() => expect(callsTo(fetchFn, 'POST /api/mangas')).toHaveLength(2));
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[1])).toMatchObject({ language: 'en', manga_passion_id: null });
  });

  it('a volume of its own other language gets no Manga Passion lookup in the editor, even in a German series', () => {
    expect(isMpVolume({ language: null }, { language: 'de' })).toBe(true);
    expect(isMpVolume({ language: 'en' }, { language: 'de' })).toBe(false);
    expect(isMpVolume({ language: 'de' }, { language: 'en' })).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})));
    const vol = (over) => ({ id: 7, manga_id: 1, type: 'volume', volume_number: '3', status: 'Vorhanden', owners: [], images: [], isbn: '', release_date: '', ...over });
    const view = (v) => render(<VolumeEditModal isOpen activeVolume={v} manga={{ id: 1, language: 'de' }} mangaId={1} canEdit user={{ id: 1, role: 'editor' }} onClose={vi.fn()} onSuccess={vi.fn()} />);
    const german = view(vol({ language: null }));
    expect(screen.queryByText('Metadaten automatisch ausfüllen')).toBeTruthy();
    german.unmount();
    view(vol({ language: 'en' }));
    expect(screen.queryByText('Metadaten automatisch ausfüllen')).toBeNull();
  });

  const props = (over) => ({ id: '6', canEdit: true, volumes: [], manga: null, fetchManga: vi.fn(), setShowMpEditionModal: vi.fn(), user: { id: 1 }, ...over });

  it('never asks /gaps before the language is known: the cached list row decides, else the detail', async () => {
    const fetchFn = vi.fn(async () => json(200, { matched: true, gaps: [] }));
    vi.stubGlobal('fetch', fetchFn);

    writeCache(1, LIST_KEY, [{ id: 6, language: 'en' }]);
    const en = renderHook(() => useMpGaps(props()));
    await act(async () => { await en.result.current.fetchMpGaps(); });
    expect(fetchFn).not.toHaveBeenCalled();
    en.unmount();

    writeCache(1, LIST_KEY, [{ id: 6, language: 'de' }]);
    const de = renderHook(() => useMpGaps(props()));
    await act(async () => { await de.result.current.fetchMpGaps(); });
    expect(String(fetchFn.mock.calls[0][0])).toContain('/api/mangas/6/gaps');
    de.unmount();
  });

  it('without a cached row the check waits for the detail and runs only for a German series', async () => {
    const fetchFn = vi.fn(async () => json(200, { matched: true, gaps: [] }));
    vi.stubGlobal('fetch', fetchFn);
    const hook = renderHook((p) => useMpGaps(p), { initialProps: props() });
    await act(async () => { await hook.result.current.fetchMpGaps(); });
    expect(fetchFn).not.toHaveBeenCalled();
    hook.rerender(props({ manga: { id: 6, language: 'ja' } }));
    await act(async () => {});
    expect(fetchFn).not.toHaveBeenCalled();

    const other = renderHook((p) => useMpGaps(p), { initialProps: props({ id: '7' }) });
    await act(async () => { await other.result.current.fetchMpGaps(); });
    other.rerender(props({ id: '7', manga: { id: 7, language: 'de' } }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(String(fetchFn.mock.calls[0][0])).toContain('/api/mangas/7/gaps');
  });
});

describe('edition links, shelf value tile and shelf filters', () => {
  it('edition links get the 44 px touch target and a name that starts with the visible code', () => {
    const manga = { id: 5, title: 'Ninja Akira', language: 'de', work_key: 'anilist:1', editions: [{ id: 6, title: 'Ninja Akira', language: 'en', region: 'US' }] };
    render(<MemoryRouter><EditionSwitcher manga={manga} canEdit={false} /></MemoryRouter>);
    const link = screen.getByRole('link', { name: /^EN-US – Zur Ausgabe Englisch \(Vereinigte Staaten\): Ninja Akira$/ });
    expect(link.textContent).toBe('EN-US');
    expect(link.className).toMatch(/\bhit-44\b/);
  });

  it('the other-currency line of the value tile wraps instead of being cut off', () => {
    render(<CollectionStats totalSeries={2} totalOwnedVolumes={3} totalCollectionValue={10} completedSeries={0} handleOpenStats={vi.fn()}
      otherCurrencyTotals={[{ currency: 'JPY', value: 329 }, { currency: 'USD', value: 203.5 }]} />);
    const line = screen.getByText((_, el) => el?.id?.endsWith('-other'));
    expect(plain(line.textContent)).toBe('+ 329 ¥ · 203,50 $');
    expect(line.className).not.toMatch(/\btruncate\b/);
    expect(line.className).toMatch(/\bbreak-words\b/);
  });

  it('a language or genre filter with no hits is "Keine Treffer", and the reset clears both', () => {
    const setters = { setSearch: vi.fn(), setStatusFilter: vi.fn(), setPublisherFilter: vi.fn(), setTagFilter: vi.fn(), setLanguageFilter: vi.fn() };
    const base = {
      canEdit: true, error: null, filtered: [], getStatusBadge: () => null, handleDeleteManga: vi.fn(), handleOpenModal: vi.fn(),
      isOffline: false, loading: false, onRetry: vi.fn(), publisherFilter: 'ALL', search: '', statusFilter: 'ALL', viewMode: 'grid', ...setters
    };
    const { rerender } = render(<MemoryRouter><MangaCollectionGrid {...base} languageFilter="ja" /></MemoryRouter>);
    expect(screen.getByText('Keine Treffer gefunden')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Filter & Suche zurücksetzen/ }));
    expect(setters.setLanguageFilter).toHaveBeenCalledWith('ALL');
    expect(setters.setTagFilter).toHaveBeenCalledWith([]);
    rerender(<MemoryRouter><MangaCollectionGrid {...base} tagFilter={['Romance']} /></MemoryRouter>);
    expect(screen.getByText('Keine Treffer gefunden')).toBeTruthy();
    rerender(<MemoryRouter><MangaCollectionGrid {...base} /></MemoryRouter>);
    expect(screen.queryByText('Keine Treffer gefunden')).toBeNull();
  });
});
