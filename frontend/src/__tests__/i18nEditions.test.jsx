// Editions in different languages (wave I18N-D): codes and defaults, the language pill, the 'Sprache' filter, the
// edition switcher, the add/edit/volume forms, stats, the account's default language, Manga Passion gating and the
// service worker's language warm-up.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  availableLanguages, currencyForRegion, defaultRegionFor, editionCandidates, editionCurrency, editionDefaults, editionLanguage,
  editionsOf, getDefaultLanguage, isMpEdition, languageName, setDefaultLanguage, volumeLanguage
} from '../utils/editions';
import LanguagePill, { VolumeLanguagePill } from '../components/common/LanguagePill';
import OtherCurrencies from '../components/common/OtherCurrencies';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';
import EditionSwitcher from '../components/detail/EditionSwitcher';
import EditionsCard from '../components/modals/stats/EditionsCard';
import AddMangaModal from '../components/modals/AddMangaModal';
import AccountModal from '../components/modals/AccountModal';
import ReleaseRadarView from '../components/dashboard/ReleaseRadarView';
import useCollectionFilters from '../hooks/useCollectionFilters';
import useMpGaps from '../hooks/useMpGaps';
import { buildFormData, lookupMangaUrl, updateBody } from '../hooks/useMangaData';
import { buildEditorForm, buildSaveBody } from '../components/detail/volumeEdit/editorUtils';
import { filterAndSortMangas, getCollectionTotals, getOtherCurrencyTotals, readFilterParams, writeFilterParams } from '../utils/collectionHelpers';
import { formatMoney } from '../utils/format';
import { warmLanguageCache } from '../hooks/usePwaInstall';
import { fakeResponse } from './fakeResponse';
import DetailFields from '../components/detail/volumeEdit/DetailFields';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { createLocalRuntime } from '../local/runtime.js';
import { memoryStore } from '../local/store.js';

const json = (status, body) => fakeResponse(status, body);

/** routes: { 'METHOD /path': (url, init) => Response }; unknown requests fail the test. */
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
  setDefaultLanguage('de');
});
afterEach(() => {
  vi.unstubAllGlobals();
  setDefaultLanguage('de');
});

describe('edition helpers', () => {
  it('reads codes, old names and BCP-47 tags; unknown text and empty values are German', () => {
    expect(editionLanguage({ language: 'en' })).toBe('en');
    expect(editionLanguage({ language: 'Deutsch' })).toBe('de');
    expect(editionLanguage({ language: 'Englisch' })).toBe('en');
    expect(editionLanguage({ language: 'en-US' })).toBe('en');
    expect(editionLanguage({ language: 'Klingonisch' })).toBe('de');
    expect(editionLanguage({})).toBe('de');
    expect(volumeLanguage({ language: null }, { language: 'ja' })).toBe('ja');
    expect(volumeLanguage({ language: 'en' }, { language: 'ja' })).toBe('en');
    expect(editionCurrency({ currency: 'usd' })).toBe('USD');
    expect(editionCurrency({ currency: 'Euro' })).toBe('EUR');
    expect(isMpEdition({ language: 'Deutsch' })).toBe(true);
    expect(isMpEdition({ language: 'en' })).toBe(false);
  });

  it('defaults follow the account language, the UI region for it and that region\'s currency', () => {
    expect(defaultRegionFor('de')).toBe('DE');
    expect(defaultRegionFor('en')).toBeNull();
    expect(currencyForRegion('US')).toBe('USD');
    expect(currencyForRegion('')).toBe('EUR');
    expect(editionDefaults()).toEqual({ language: 'de', region: 'DE', currency: 'EUR' });
    setDefaultLanguage('ja');
    expect(editionDefaults()).toEqual({ language: 'ja', region: '', currency: 'EUR' });
    setDefaultLanguage('Klingon');
    expect(getDefaultLanguage()).toBe('de');
  });

  it('names come from Intl.DisplayNames in the UI language', () => {
    expect(languageName('en')).toBe('Englisch');
    expect(languageName('ja')).toBe('Japanisch');
  });

  it('counts the languages of a collection and finds editions inline, in the list and by title + author', () => {
    const list = [
      { id: 1, title: 'Frieren', author: 'Yamada', language: 'de', work_key: 'anilist:1' },
      { id: 2, title: 'Frieren', author: 'Yamada', language: 'en', work_key: 'anilist:1' },
      { id: 3, title: 'frieren', author: 'yamada', language: 'ja', work_key: null },
      { id: 4, title: 'Berserk', language: 'Deutsch' }
    ];
    expect(availableLanguages(list)).toEqual([{ code: 'de', count: 2 }, { code: 'en', count: 1 }, { code: 'ja', count: 1 }]);
    expect(editionsOf({ id: 1, editions: [{ id: 2 }, { id: 1 }] })).toEqual([{ id: 2 }]);
    expect(editionsOf({ id: 1, work_key: 'anilist:1' }, list).map(m => m.id)).toEqual([2]);
    expect(editionsOf({ id: 4 }, list)).toEqual([]);
    expect(editionCandidates(list[0], list).map(m => m.id)).toEqual([3]);
  });

  it('formats money in the edition currency; an invalid code is euro', () => {
    expect(formatMoney(7.5, 'EUR')).toBe('7,50 €');
    expect(formatMoney(7.5, 'USD')).toBe('7,50 $');
    expect(formatMoney(7.5, 'nope')).toBe('7,50 €');
    expect(formatMoney(null, 'USD', { empty: '–' })).toBe('–');
  });
});

describe('language pill', () => {
  it('is hidden for the default language and follows a change of it', () => {
    const { container } = render(<><LanguagePill language="de" /><LanguagePill language="en" region="US" /></>);
    expect(container.querySelectorAll('.language-pill')).toHaveLength(1);
    expect(screen.getByText('EN-US')).toBeTruthy();
    expect(screen.getByText('Ausgabe: Englisch (Vereinigte Staaten)')).toBeTruthy();
    act(() => setDefaultLanguage('en'));
    expect(container.querySelectorAll('.language-pill')).toHaveLength(1);
    expect(container.querySelector('.language-pill').dataset.language).toBe('de');
  });

  it('a volume shows a pill only when it is in another language than its series', () => {
    const manga = { language: 'en' };
    const { container, rerender } = render(<VolumeLanguagePill volume={{ language: null }} manga={manga} />);
    expect(container.textContent).toBe('');
    rerender(<VolumeLanguagePill volume={{ language: 'en' }} manga={manga} />);
    expect(container.textContent).toBe('');
    rerender(<VolumeLanguagePill volume={{ language: 'de' }} manga={manga} />);
    expect(container.querySelector('.language-pill').dataset.language).toBe('de');
  });
});

describe('Sprache filter', () => {
  const list = [
    { id: 1, title: 'Akira', language: 'de', status: 'Laufend' },
    { id: 2, title: 'Berserk', language: 'en', status: 'Laufend' },
    { id: 3, title: 'Claymore', language: 'Deutsch', status: 'Laufend' }
  ];
  const opts = { search: '', statusFilter: 'ALL', publisherFilter: 'ALL', sortBy: 'title_asc' };

  it('filters by the edition language and keeps it in the URL as ?lang=', () => {
    expect(filterAndSortMangas(list, { ...opts, languageFilter: 'de' }).map(m => m.id)).toEqual([1, 3]);
    expect(filterAndSortMangas(list, { ...opts, languageFilter: 'ALL' })).toHaveLength(3);
    expect(readFilterParams('?lang=en&view=shelf')).toEqual({ lang: 'en' });
    expect(readFilterParams('?lang=english')).toEqual({});
    expect(writeFilterParams('?view=shelf', { lang: 'en' })).toBe('?view=shelf&lang=en');
    expect(writeFilterParams('?lang=en', { lang: 'ALL' })).toBe('');
  });

  it('the hook restores the filter from the URL and drops a language the collection no longer has', async () => {
    const url = { search: '?lang=en', replace: vi.fn() };
    const { result, rerender } = renderHook(({ rows }) => useCollectionFilters(rows, { url }), { initialProps: { rows: list } });
    expect(result.current.languageFilter).toBe('en');
    expect(result.current.filtered.map(m => m.id)).toEqual([2]);
    expect(result.current.availableLanguages.map(l => l.code)).toEqual(['de', 'en']);
    rerender({ rows: list.filter(m => m.id !== 2) });
    await waitFor(() => expect(result.current.languageFilter).toBe('ALL'));
  });

  const toolbarProps = (extra) => ({
    availablePublishers: [], filterCounts: {}, filtered: [], publisherFilter: 'ALL', search: '', setPublisherFilter: vi.fn(), setSearch: vi.fn(),
    setSortBy: vi.fn(), setStatusFilter: vi.fn(), setViewMode: vi.fn(), sortBy: 'title_asc', statusFilter: 'ALL', viewMode: 'grid', ...extra
  });

  it('the toolbar chip shows only for more than one language and sets the filter; reset clears it', () => {
    const setLanguageFilter = vi.fn();
    const { rerender } = render(<CollectionToolbar {...toolbarProps({ availableLanguages: [{ code: 'de', count: 3 }], setLanguageFilter })} />);
    expect(screen.queryByLabelText('Sprache filtern')).toBeNull();
    rerender(<CollectionToolbar {...toolbarProps({ availableLanguages: [{ code: 'de', count: 3 }, { code: 'en', count: 1 }], setLanguageFilter })} />);
    const select = screen.getByLabelText('Sprache filtern');
    expect([...select.options].map(o => o.textContent)).toEqual(['Alle Sprachen', 'Deutsch (3)', 'Englisch (1)']);
    fireEvent.change(select, { target: { value: 'en' } });
    expect(setLanguageFilter).toHaveBeenCalledWith('en');
    rerender(<CollectionToolbar {...toolbarProps({ availableLanguages: [{ code: 'de', count: 3 }, { code: 'en', count: 1 }], languageFilter: 'en', setLanguageFilter })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Filter und Suche zurücksetzen' }));
    expect(setLanguageFilter).toHaveBeenLastCalledWith('ALL');
  });
});

describe('collection value per currency', () => {
  it('the totals count euro series; other currencies are listed apart, never converted', () => {
    const rows = [
      { id: 1, total_value: 10, owned_volumes: 1 },
      { id: 2, total_value: 20, currency: 'USD', owned_volumes: 2 },
      { id: 3, total_value: 5, currency: 'USD', owned_volumes: 1 },
      { id: 4, total_value: 0, currency: 'GBP', owned_volumes: 0 }
    ];
    expect(getCollectionTotals(rows)).toEqual({ totalOwnedVolumes: 4, totalCollectionValue: 10, completedSeries: 0 });
    expect(getOtherCurrencyTotals(rows)).toEqual([{ currency: 'USD', value: 25 }]);
    render(<OtherCurrencies list={[{ currency: 'EUR', total: 3 }, { currency: 'USD', total: 25 }]} />);
    expect(screen.getByText(/25,00/).textContent).toContain('$');
  });
});

/** Shows the current path, so a navigation can be asserted. */
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

describe('EditionSwitcher', () => {
  const manga = {
    id: 5, title: 'Frieren', author: 'Yamada', language: 'de', region: 'DE', work_key: 'anilist:1',
    editions: [{ id: 6, title: 'Frieren', language: 'en', region: 'US' }, { id: 7, title: 'Sousou no Frieren', language: 'ja', region: null }]
  };
  const renderSwitcher = (props) => render(
    <MemoryRouter initialEntries={['/manga/5']}>
      <Routes><Route path="/manga/:id" element={<><EditionSwitcher {...props} /><Where /></>} /></Routes>
    </MemoryRouter>
  );

  it('lists the editions as links with the current one marked; readers of an unlinked series see nothing', () => {
    renderSwitcher({ manga });
    expect(screen.getByRole('list', { name: 'Ausgaben' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'EN-US – Zur Ausgabe Englisch (Vereinigte Staaten): Frieren' }).getAttribute('href')).toBe('/manga/6');
    expect(screen.getByRole('link', { name: 'JA – Zur Ausgabe Japanisch: Sousou no Frieren' }).textContent).toBe('JA');
    expect(document.querySelector('[aria-current="page"]').textContent).toContain('DE-DE');
    expect(screen.queryByRole('button', { name: /Ausgabe/ })).toBeNull();
    const { container } = render(<MemoryRouter><EditionSwitcher manga={{ id: 1, editions: [] }} /></MemoryRouter>);
    expect(container.textContent).toBe('');
  });

  it('"+ Ausgabe" creates a linked edition and opens it', async () => {
    const fetchFn = mockFetch({
      'GET /api/mangas': () => json(200, [manga, { id: 9, title: 'Frieren', author: 'Yamada', language: 'fr' }]),
      'POST /api/mangas/5/editions': () => json(201, { success: true, id: 42, work_key: 'anilist:1' })
    });
    renderSwitcher({ manga: { ...manga, editions: [] }, canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /Ausgabe/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('select').value).toBe('en');
    fireEvent.change(screen.getByLabelText('Titel der Ausgabe'), { target: { value: 'Frieren (EN)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ausgabe anlegen' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/manga/42'));
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas/5/editions')[0])).toEqual({ language: 'en', region: null, currency: 'EUR', title: 'Frieren (EN)' });
  });

  it('links a suggested series (same title and author) and unlinks this one', async () => {
    const onChanged = vi.fn();
    const fetchFn = mockFetch({
      'GET /api/mangas': () => json(200, [manga, { id: 9, title: 'Frieren', author: 'Yamada', language: 'fr' }, { id: 10, title: 'Berserk', language: 'de' }]),
      'PUT /api/mangas/5/work': () => json(200, { success: true, work_key: 'anilist:1', editions: [] })
    });
    renderSwitcher({ manga, canEdit: true, onChanged });
    fireEvent.click(screen.getByRole('button', { name: /Ausgabe/ }));
    const select = await screen.findByLabelText('Reihe zum Verknüpfen');
    await waitFor(() => expect(select.querySelector('optgroup[label="Vorschläge"] option')?.value).toBe('9'));
    fireEvent.change(select, { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verknüpfen' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(bodyOf(callsTo(fetchFn, 'PUT /api/mangas/5/work')[0])).toEqual({ link_to: 9 });

    fireEvent.click(screen.getByRole('button', { name: /Ausgabe/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Diese Ausgabe lösen' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    expect(bodyOf(callsTo(fetchFn, 'PUT /api/mangas/5/work')[1])).toEqual({ link_to: null });
  });

  it('shows the server message when linking fails', async () => {
    mockFetch({
      'GET /api/mangas': () => json(200, [{ id: 9, title: 'X', language: 'fr' }]),
      'PUT /api/mangas/5/work': () => json(404, { error: 'Manga nicht gefunden', code: 'NOT_FOUND' })
    });
    renderSwitcher({ manga, canEdit: true });
    fireEvent.click(screen.getByRole('button', { name: /Ausgabe/ }));
    const select = await screen.findByLabelText('Reihe zum Verknüpfen');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verknüpfen' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Manga nicht gefunden');
  });
});

describe('add and edit forms', () => {
  it('a new series starts in the default language with the UI region and sends the work key of an AniList hit', async () => {
    setDefaultLanguage('de');
    const fetchFn = mockFetch({
      'GET /api/lookup/manga': () => json(200, [{ id: 'al_77', source: 'anilist', title: 'Dungeon Meshi', status: 'Abgeschlossen' }]),
      'POST /api/mangas': () => json(201, { id: 3, title: 'Dungeon Meshi' })
    });
    render(<AddMangaModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.getByLabelText('Sprache der Ausgabe').value).toBe('de');
    expect(screen.getByLabelText('Region').value).toBe('DE');
    expect(screen.getByLabelText('Währung').value).toBe('EUR');
    fireEvent.change(screen.getByLabelText('Sprache der Ausgabe'), { target: { value: 'en' } });
    expect(screen.getByLabelText('Region').value).toBe('');
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'US' } });
    expect(screen.getByLabelText('Währung').value).toBe('USD');
    fireEvent.change(screen.getByPlaceholderText(/One Piece/), { target: { value: 'Dungeon Meshi' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Fill/ }));
    await waitFor(() => expect(callsTo(fetchFn, 'GET /api/lookup/manga')).toHaveLength(1));
    expect(callsTo(fetchFn, 'GET /api/lookup/manga')[0][0]).toContain('language=en');
    await waitFor(() => expect(screen.getByPlaceholderText(/One Piece/).value).toBe('Dungeon Meshi'));
    fireEvent.click(document.querySelector('button[type="submit"]'));
    await waitFor(() => expect(callsTo(fetchFn, 'POST /api/mangas')).toHaveLength(1));
    expect(bodyOf(callsTo(fetchFn, 'POST /api/mangas')[0])).toMatchObject({ language: 'en', region: 'US', currency: 'USD', work_key: 'anilist:77' });
  });

  it('the edit form holds codes (an old name reads as its code) and sends a cleared region as null', () => {
    const base = buildFormData({ title: 'A', language: 'Deutsch' });
    expect(base).toMatchObject({ language: 'de', region: '', currency: 'EUR' });
    expect(updateBody({ region: '' }, base)).toEqual({ region: null });
    expect(updateBody({ language: 'en', currency: 'GBP' }, base)).toEqual({ language: 'en', currency: 'GBP' });
    expect(lookupMangaUrl('Frieren', 'de')).toBe('/api/lookup/manga?q=Frieren');
    expect(lookupMangaUrl('Frieren', 'ja')).toBe('/api/lookup/manga?q=Frieren&language=ja');
  });

  it('the volume editor keeps the language override; only a change is sent', () => {
    const base = buildEditorForm({ volume_number: '1', language: null });
    expect(base.language).toBe('');
    expect(buildSaveBody({ ...base, language: 'en' }, base)).toEqual({ language: 'en' });
    expect(buildSaveBody(base, base)).toEqual({});
  });
});

describe('volume editor fields', () => {
  it('offers "like the series" plus languages; the Manga Passion lookup only for German editions', () => {
    const setEditVolForm = vi.fn();
    const form = buildEditorForm({ volume_number: '1' });
    const { rerender } = render(<DetailFields editVolForm={form} setEditVolForm={setEditVolForm} handleAutofillVolumeData={vi.fn()} manga={{ language: 'en' }} />);
    const select = screen.getByLabelText('Sprache dieses Bands');
    expect(select.options[0].textContent).toBe('Wie die Reihe (Englisch)');
    expect(screen.queryByRole('button', { name: /Auto-Ausfüllen/ })).toBeNull();
    fireEvent.change(select, { target: { value: 'de' } });
    expect(setEditVolForm).toHaveBeenCalled();
    rerender(<DetailFields editVolForm={form} setEditVolForm={setEditVolForm} handleAutofillVolumeData={vi.fn()} manga={{ language: 'de' }} />);
    expect(screen.getByRole('button', { name: /Auto-Ausfüllen/ })).toBeTruthy();
  });
});

describe('statistics and radar', () => {
  it('the editions card lists languages and other currencies; one language in euro shows nothing', () => {
    const { container, rerender } = render(<EditionsCard languages={[{ language: 'de', series: 3, owned_volumes: 9 }]} currencies={[{ currency: 'EUR', series: 3, owned_value: 50 }]} />);
    expect(container.textContent).toBe('');
    rerender(<EditionsCard
      languages={[{ language: 'de', series: 3, owned_volumes: 9 }, { language: 'en', series: 1, owned_volumes: 2 }]}
      currencies={[{ currency: 'EUR', series: 3, owned_value: 50 }, { currency: 'USD', series: 1, owned_value: 19.98 }]}
    />);
    expect(screen.getByRole('rowheader', { name: /Englisch/ })).toBeTruthy();
    expect(screen.getByText('Weitere Währungen')).toBeTruthy();
    expect(screen.getByText(/19,98/).textContent).toContain('$');
  });

  it('the Manga Passion tab says it only covers the German market when the collection has other editions', () => {
    const props = {
      radarSubView: 'passion', setRadarSubView: vi.fn(), radarData: null, loadingRadar: false, fetchReleaseRadar: vi.fn(),
      radarPublisherFilter: 'ALL', setRadarPublisherFilter: vi.fn(), radarStatusFilter: 'ALL', setRadarStatusFilter: vi.fn(), radarSearch: '',
      setRadarSearch: vi.fn(), mpData: null, loadingMp: false, fetchMangaPassionReleases: vi.fn(), mpYear: 2026, setMpYear: vi.fn(), mpMonth: 10,
      setMpMonth: vi.fn(), handlePrevMonth: vi.fn(), handleNextMonth: vi.fn(), handleCurrentMonth: vi.fn(), mpPrintOnly: false,
      setMpPrintOnly: vi.fn(), mpMySeriesOnly: false, setMpMySeriesOnly: vi.fn(), mpPublisherFilter: 'ALL', setMpPublisherFilter: vi.fn(), mpSearch: '',
      setMpSearch: vi.fn(), canEdit: false, handleImportMangaPassion: vi.fn(), importingMpIds: new Set(), handleMarkDelivered: vi.fn(),
      markingDeliveredIds: new Set(), GERMAN_MONTHS: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
    };
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})));
    const { rerender } = render(<MemoryRouter><ReleaseRadarView {...props} /></MemoryRouter>);
    expect(document.getElementById('radar-mp-market-note')).toBeNull();
    rerender(<MemoryRouter><ReleaseRadarView {...props} foreignEditions /></MemoryRouter>);
    expect(document.getElementById('radar-mp-market-note').textContent).toContain('Nur deutscher Markt');
  });
});

describe('account default language', () => {
  it('saves users.default_language at once and updates the pills', async () => {
    const fetchFn = mockFetch({
      'PUT /api/auth/profile': () => json(200, { user: { id: 1, username: 'anna', locale: null, default_language: 'en' } })
    });
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 1, role: 'editor' }} initialTab="language" />);
    const select = screen.getByLabelText('Standardsprache deiner Ausgaben');
    expect(select.value).toBe('de');
    fireEvent.change(select, { target: { value: 'en' } });
    await waitFor(() => expect(getDefaultLanguage()).toBe('en'));
    expect(bodyOf(callsTo(fetchFn, 'PUT /api/auth/profile')[0])).toEqual({ default_language: 'en' });
    expect(select.value).toBe('en');
  });

  it('a refused change keeps the old language and shows the server message', async () => {
    mockFetch({ 'PUT /api/auth/profile': () => json(400, { error: 'Ungültiger Sprachcode (zwei Buchstaben, z. B. de)', code: 'LANGUAGE_INVALID' }) });
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 1, role: 'editor' }} initialTab="language" />);
    fireEvent.change(screen.getByLabelText('Standardsprache deiner Ausgaben'), { target: { value: 'ja' } });
    expect((await screen.findByRole('alert')).textContent).toContain('Ungültiger Sprachcode');
    expect(getDefaultLanguage()).toBe('de');
  });
});

describe('Manga Passion gating', () => {
  const props = (manga) => ({ id: '1', canEdit: true, volumes: [{ volume_number: '1' }, { volume_number: '3' }], manga, fetchManga: vi.fn(), setShowMpEditionModal: vi.fn() });

  it('no gap check for a non-German edition; gaps come from the volume numbers', async () => {
    const fetchFn = vi.fn(async () => json(200, { matched: true, gaps: [{ volume_number: '2' }] }));
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useMpGaps(props({ id: 1, language: 'en', total_volumes: 3 })));
    await act(async () => { await result.current.fetchMpGaps(); });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.current.mpEnabled).toBe(false);
    expect(result.current.mpGapData).toBeNull();
    expect(result.current.detectedGaps).toEqual([2]);
  });

  it('a German edition still asks Manga Passion', async () => {
    const fetchFn = vi.fn(async () => json(200, { matched: true, gaps: [] }));
    vi.stubGlobal('fetch', fetchFn);
    const { result } = renderHook(() => useMpGaps(props({ id: 1, language: 'Deutsch', total_volumes: 3 })));
    await act(async () => { await result.current.fetchMpGaps(); });
    expect(String(fetchFn.mock.calls[0][0])).toContain('/api/mangas/1/gaps');
    expect(result.current.mpEnabled).toBe(true);
  });
});

describe('service worker language warm-up', () => {
  it('asks the active, waiting and installing worker to cache the active language', () => {
    const worker = () => ({ postMessage: vi.fn() });
    const reg = { active: worker(), waiting: worker(), installing: { postMessage: () => { throw new Error('redundant'); } } };
    expect(() => warmLanguageCache(reg, 'en')).not.toThrow();
    expect(reg.active.postMessage).toHaveBeenCalledWith({ type: 'WARM_LANGUAGE', language: 'en' });
    expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: 'WARM_LANGUAGE', language: 'en' });
    expect(() => warmLanguageCache(null)).not.toThrow();
  });
});

describe('device collection (standalone mode)', () => {
  it('stores edition codes, links editions and keeps the default language like the server', async () => {
    const SQL = await initSqlJs();
    const offline = { fetch: async () => { throw new TypeError('offline'); }, fetchText: async () => { throw new Error('offline'); }, fetchImage: async () => { throw new Error('offline'); } };
    const rt = await createLocalRuntime({ SQL, store: memoryStore(), http: offline, profile: { name: 'Felix' }, persistDelayMs: 0 });
    try {
      const de = await rt.request('POST', '/api/mangas', { title: 'Frieren', language: 'Deutsch' });
      expect(de.status).toBeLessThan(300);
      const en = await rt.request('POST', `/api/mangas/${de.body.id}/editions`, { language: 'en', region: 'US', currency: 'USD' });
      expect(en.status).toBeLessThan(300);
      const detail = (await rt.request('GET', `/api/mangas/${de.body.id}`)).body;
      expect(detail.language).toBe('de');
      expect(detail.editions.map((e) => [e.id, e.language])).toEqual([[en.body.id, 'en']]);
      const list = (await rt.request('GET', '/api/mangas')).body;
      expect(list.find((m) => m.id === en.body.id)).toMatchObject({ language: 'en', region: 'US', currency: 'USD' });
      expect(availableLanguages(list).map((l) => l.code)).toEqual(['de', 'en']);
      expect((await rt.request('PUT', '/api/auth/profile', { default_language: 'en' })).body.user.default_language).toBe('en');
    } finally {
      await rt.close?.();
    }
  });
});
