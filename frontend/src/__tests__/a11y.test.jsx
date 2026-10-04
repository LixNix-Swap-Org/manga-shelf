// Covers accessibility behaviour across shared components, dialogs, titles and keyboard handling.
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { MAIN_ID, SkipLink, pageTitle, useDocumentTitle, usePageHeading } from '../components/common/PageChrome';
import FilePickerButton from '../components/common/FilePickerButton';
import Spinner from '../components/common/Spinner';
import { langFor } from '../components/common/lang';
import RadarTabs from '../components/dashboard/radar/RadarTabs';
import MangaCollectionGrid, { seriesSummary } from '../components/dashboard/MangaCollectionGrid';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import MangaHeroCard from '../components/detail/MangaHeroCard';
import AddVolumeBar from '../components/detail/AddVolumeBar';
import ReaderBar from '../components/detail/ReaderBar';
import VolumeFilterBar from '../components/detail/VolumeFilterBar';
import VolumeGridView from '../components/detail/VolumeGridView';
import VolumeListView from '../components/detail/VolumeListView';
import LightboxGallery from '../components/detail/LightboxGallery';
import VolumeEditModal from '../components/detail/VolumeEditModal';
import GapNotices from '../components/detail/GapNotices';
import MpFilters from '../components/dashboard/radar/MpFilters';
import useDetailKeyboard from '../hooks/useDetailKeyboard';
import { getStatusBadge } from '../utils/collectionHelpers';
import { fakeResponse } from './fakeResponse';
import AppErrorBoundary from '../AppErrorBoundary';

const json = (status, body) => fakeResponse(status, body);

afterEach(() => {
  document.title = '';
});

describe('page structure', () => {
  function Page({ title, heading, ready = true }) {
    useDocumentTitle(title);
    const ref = usePageHeading(ready);
    return (
      <>
        <SkipLink />
        <nav><Link to="/b">Weiter</Link><Link to="/a">Zurück</Link></nav>
        <main id={MAIN_ID} tabIndex={-1}>
          {ready && <h1 ref={ref} tabIndex={-1}>{heading}</h1>}
          <button type="button">Im Inhalt</button>
        </main>
      </>
    );
  }

  const renderRoutes = (initial = '/a') => render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/a" element={<Page title="Sammlung" heading="Seite A" />} />
        <Route path="/b" element={<Page title="One Piece" heading="Seite B" />} />
      </Routes>
    </MemoryRouter>
  );

  it('formats per-page titles and falls back to the app name', () => {
    expect(pageTitle('Einkaufsliste')).toBe('Einkaufsliste – Manga Shelf');
    expect(pageTitle('  ')).toBe('Manga Shelf & Tracker');
    expect(pageTitle(null)).toBe('Manga Shelf & Tracker');
  });

  it('sets the document title per page and keeps focus where it is on the first page', () => {
    renderRoutes();
    expect(document.title).toBe('Sammlung – Manga Shelf');
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to the new page heading after a navigation', () => {
    renderRoutes();
    fireEvent.click(screen.getByRole('link', { name: 'Weiter' }));
    expect(document.title).toBe('One Piece – Manga Shelf');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Seite B' }));
  });

  it('a heading that renders later (data still loading) gets the focus once it is there', () => {
    function Late() {
      const [ready, setReady] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setReady(true)}>laden</button>
          <Page title="Später" heading="Spät" ready={ready} />
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/a']}>
        <Routes>
          <Route path="/a" element={<Link to="/late">los</Link>} />
          <Route path="/late" element={<Late />} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('link', { name: 'los' }));
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    act(() => { screen.getByRole('button', { name: 'laden' }).click(); });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Spät' }));
  });

  it('the skip link is the first focusable element and moves focus into the main region', () => {
    renderRoutes();
    const skip = screen.getByRole('link', { name: 'Zum Inhalt springen' });
    expect(skip.className).toMatch(/\bsr-only\b/);
    expect(skip.className).toMatch(/focus:not-sr-only/);
    expect(skip.getAttribute('href')).toBe(`#${MAIN_ID}`);
    expect(document.querySelector('a, button')).toBe(skip);
    const main = screen.getByRole('main');
    main.scrollIntoView = vi.fn();
    main.getBoundingClientRect = () => ({ top: -400, height: 2000 });
    fireEvent.click(skip);
    expect(document.activeElement).toBe(main);
    expect(main.scrollIntoView).toHaveBeenCalled();
  });

  it('the skip link keeps the main region clear of a sticky header and does not scroll when it is already in view', () => {
    render(
      <MemoryRouter>
        <SkipLink />
        <header data-sticky-header="" style={{ position: 'sticky', top: 0 }}>Kopf</header>
        <main id={MAIN_ID} tabIndex={-1}>Inhalt</main>
      </MemoryRouter>
    );
    const header = document.querySelector('header');
    header.getBoundingClientRect = () => ({ top: 0, height: 119.5 });
    const main = screen.getByRole('main');
    main.scrollIntoView = vi.fn();
    const skip = screen.getByRole('link', { name: 'Zum Inhalt springen' });

    main.getBoundingClientRect = () => ({ top: 152, height: 2000 });
    fireEvent.click(skip);
    expect(document.activeElement).toBe(main);
    expect(main.scrollIntoView).not.toHaveBeenCalled();

    main.getBoundingClientRect = () => ({ top: -600, height: 2000 });
    fireEvent.click(skip);
    expect(main.style.scrollMarginTop).toBe('120px');
    expect(main.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });

    header.style.position = 'static';
    main.style.scrollMarginTop = '';
    fireEvent.click(skip);
    expect(main.style.scrollMarginTop).toBe('');
  });

  it('the Dashboard header marks itself as the sticky header the skip link clears', () => {
    const noop = vi.fn();
    render(
      <DashboardHeader
        activeMainView="shelf" canEdit={false} handleBarcodeDetected={noop} handleInstallClick={noop} handleOpenCsvModal={noop}
        handleOpenModal={noop} handleOpenPasswordModal={noop} handleOpenRestoreModal={noop} handleOpenStats={noop}
        handleOpenUsersModal={noop} isInstallable={false} isInstalledApp={false} isOfflineMode={false} isVisitor={false}
        mobileMenuOpen={false} onLogout={noop} radarData={null} search="" searchInputRef={{ current: null }}
        setMobileMenuOpen={noop} setSearch={noop} setView={noop} shoppingData={null} user={{ id: 1, username: 'anna', role: 'editor' }}
      />
    );
    const header = screen.getByRole('banner');
    expect(header.hasAttribute('data-sticky-header')).toBe(true);
    expect(header.className).toMatch(/(^|\s)sticky(\s|$)/);
    expect(screen.getAllByPlaceholderText('Titel, Autor, Tag, ISBN oder Notiz suchen...').length).toBeGreaterThan(0);
  });

  it('a page that is still loading keeps the previous title instead of the generic one', () => {
    function Detail({ title }) {
      useDocumentTitle(title);
      return null;
    }
    const { rerender } = render(<Detail title="Sammlung" />);
    expect(document.title).toBe('Sammlung – Manga Shelf');
    rerender(<Detail title={null} />);
    expect(document.title).toBe('Sammlung – Manga Shelf');
    rerender(<Detail title="One Piece" />);
    expect(document.title).toBe('One Piece – Manga Shelf');
    rerender(<Detail title="" />);
    expect(document.title).toBe('Manga Shelf & Tracker');
  });

  it('the error screen of a crashed route sets its own title', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const swallow = (e) => e.preventDefault();
    window.addEventListener('error', swallow);
    try {
      document.title = 'One Piece – Manga Shelf';
      function Boom() { throw new Error('kaputt'); }
      render(<AppErrorBoundary><Boom /></AppErrorBoundary>);
      expect(screen.getByText('Etwas ist schiefgelaufen')).toBeTruthy();
      expect(document.title).toBe('Fehler – Manga Shelf');
    } finally {
      window.removeEventListener('error', swallow);
      vi.restoreAllMocks();
    }
  });
});

describe('shared building blocks', () => {
  it('FilePickerButton is a named button that opens the hidden input and passes the change on', () => {
    const onChange = vi.fn();
    render(<FilePickerButton accept="image/*" onChange={onChange} label="Foto auswählen">Foto</FilePickerButton>);
    const button = screen.getByRole('button', { name: 'Foto auswählen' });
    const input = document.querySelector('input[type="file"]');
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute('aria-hidden')).toBe('true');
    input.click = vi.fn();
    fireEvent.click(button);
    expect(input.click).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a disabled FilePickerButton disables the input too', () => {
    render(<FilePickerButton disabled onChange={vi.fn()}>Foto</FilePickerButton>);
    expect(screen.getByRole('button', { name: 'Foto' }).disabled).toBe(true);
    expect(document.querySelector('input[type="file"]').disabled).toBe(true);
  });

  it('Spinner announces itself as a status with a German label', () => {
    render(<Spinner label="Cover wird hochgeladen…" />);
    expect(screen.getByRole('status').textContent).toBe('Cover wird hochgeladen…');
  });

  it('langFor marks Kana and Han titles as Japanese only', () => {
    expect(langFor('ワンピース')).toBe('ja');
    expect(langFor('進撃の巨人')).toBe('ja');
    expect(langFor('One Piece')).toBeUndefined();
    expect(langFor(null)).toBeUndefined();
  });
});

describe('RadarTabs', () => {
  function Tabs() {
    const [view, setView] = useState('passion');
    return <RadarTabs radarSubView={view} setRadarSubView={setView} radarData={null} mpCount={3} mpYear={2026} mpMonth={10} />;
  }

  it('is a tablist with the selected tab in the tab order and arrow keys that switch', () => {
    render(<Tabs />);
    const list = screen.getByRole('tablist', { name: 'Release-Radar' });
    const [passion, personal] = within(list).getAllByRole('tab');
    expect(passion.getAttribute('aria-selected')).toBe('true');
    expect(passion.tabIndex).toBe(0);
    expect(personal.tabIndex).toBe(-1);
    expect(passion.getAttribute('aria-controls')).toBe('radar-tabpanel');
    passion.focus();
    fireEvent.keyDown(passion, { key: 'ArrowRight' });
    expect(personal.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(personal);
    fireEvent.keyDown(personal, { key: 'ArrowRight' });
    expect(passion.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(passion, { key: 'End' });
    expect(personal.getAttribute('aria-selected')).toBe('true');
  });
});

describe('collection grid and toolbar', () => {
  const manga = {
    id: 9, title: 'Frieren', status: 'Laufend', owned_volumes: 4, regular_owned: 4, total_volumes: 12, read_volume_count: 2,
    alt_title: '葬送のフリーレン', author: 'Kanehito Yamada', publisher: 'Egmont'
  };
  const gridProps = (over = {}) => ({
    canEdit: true, error: null, filtered: [manga], getStatusBadge, handleDeleteManga: vi.fn(), handleOpenModal: vi.fn(),
    isOffline: false, loading: false, onRetry: vi.fn(), publisherFilter: 'ALL', search: '', setPublisherFilter: vi.fn(),
    setSearch: vi.fn(), setStatusFilter: vi.fn(), statusFilter: 'ALL', viewMode: 'grid', ...over
  });
  const renderGrid = (over) => render(<MemoryRouter><MangaCollectionGrid {...gridProps(over)} /></MemoryRouter>);

  it('a card link is named by the title and author line and described by one status sentence; badges are hidden', () => {
    renderGrid();
    const link = screen.getByRole('link', { name: /^Frieren\b/ });
    expect(link.getAttribute('aria-labelledby').split(' ')).toHaveLength(2);
    const summary = document.getElementById(link.getAttribute('aria-describedby'));
    expect(summary.textContent).toBe('Laufend, 4 von 12 Bänden, 2 von 4 gelesen');
    expect(summary.className).toMatch(/sr-only/);
    expect(screen.getByText('Laufend').closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('seriesSummary covers series without total, extras and fully read ones', () => {
    expect(seriesSummary({ status: 'Abgeschlossen' }, { owned: 1, total: 0, extras: 2 }, { read: 1, owned: 1, complete: true }))
      .toBe('Abgeschlossen, 1 Band, 2 Extras, alle gelesen');
    expect(seriesSummary({ status: 'Laufend' }, { owned: 3, total: 0, extras: 0 }, { read: 0, owned: 3 }))
      .toBe('Laufend, 3 Bände, ungelesen');
  });

  it('the list view has a named progress bar and marks the Japanese title', () => {
    renderGrid({ viewMode: 'list' });
    const bar = screen.getByRole('progressbar', { name: 'Fortschritt' });
    expect(bar.getAttribute('aria-valuetext')).toBe('4 von 12 Bänden');
    expect(screen.getByText('葬送のフリーレン').getAttribute('lang')).toBe('ja');
    expect(screen.getByRole('button', { name: 'Frieren löschen' }).className).toMatch(/\bp-1\.5\b/);
  });

  it('grid cards carry no backdrop blur', () => {
    const { container } = renderGrid();
    expect(container.querySelector('[class*="backdrop-blur"]')).toBeNull();
  });

  it('toolbar: icon-only reset has a name and the count uses German plural rules', () => {
    render(
      <CollectionToolbar
        availablePublishers={['Egmont']} filterCounts={{}} filtered={[manga]} publisherFilter="ALL" search="x"
        setPublisherFilter={vi.fn()} setSearch={vi.fn()} setSortBy={vi.fn()} setStatusFilter={vi.fn()} setViewMode={vi.fn()}
        sortBy="title_asc" statusFilter="ALL" viewMode="grid"
      />
    );
    expect(screen.getByRole('button', { name: 'Filter und Suche zurücksetzen' })).toBeTruthy();
    expect(screen.getByText('1 Manga')).toBeTruthy();
  });
});

describe('detail page controls', () => {
  const heroProps = (over = {}) => ({
    canEdit: true, completionPct: 25, editing: false, formData: { title: 'Titel', status: 'Laufend', cover_image: '', alt_title: '' },
    handleCoverUpload: vi.fn(), handleDeleteManga: vi.fn(), handleEditLookup: vi.fn(), handleUpdate: vi.fn(e => e.preventDefault()),
    manga: { title: 'Titel', cover_image: '' }, ownedCount: 3, totalTarget: 12, totalOwnedValue: 0, saving: false,
    setEditLookupResults: vi.fn(), setEditing: vi.fn(), startEditing: vi.fn(), cancelEditing: vi.fn(), setFormData: vi.fn(),
    uploadingCover: false, ...over
  });

  it('hero: named delete button, progress bar with value text, cover picker as a button', () => {
    const headingRef = { current: null };
    render(<MangaHeroCard {...heroProps({ headingRef })} />);
    expect(headingRef.current).toBe(screen.getByRole('heading', { level: 1, name: 'Titel' }));
    expect(screen.getByRole('button', { name: 'Reihe löschen' }).getAttribute('title')).toBe('Reihe löschen');
    const bar = screen.getByRole('progressbar', { name: 'Sammlungs-Fortschritt' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.getAttribute('aria-valuetext')).toBe('3 von 12 Bänden');
    const picker = screen.getByRole('button', { name: /Cover ändern/ });
    // touch screens have no hover: the picker must be visible there
    expect(picker.className).toMatch(/\[@media\(hover:none\)\]:opacity-100/);
    expect(picker.className).toMatch(/focus-visible:opacity-100/);
    expect(document.getElementById('cover-upload').type).toBe('file');
  });

  it('hero edit form: every field has a label', () => {
    render(<MangaHeroCard {...heroProps({ editing: true, formData: { title: 'T', alt_title: '', author: '', publisher: '', status: 'Laufend', total_volumes: '', cover_image: '', description: '' } })} />);
    for (const label of ['Titel der Reihe', 'Alternativer Titel', 'Autor / Mangaka', 'Standard-Verlag', 'Status', 'Geplante Gesamtbände', 'Cover-Bild', 'Beschreibung']) {
      expect(screen.getByLabelText(label), label).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Cover-Bild hochladen' })).toBeTruthy();
  });

  it('add bar: all inputs are labelled and the photo is picked with a button', () => {
    render(
      <AddVolumeBar
        canEdit handleAddSingleVolume={vi.fn(e => e.preventDefault())} handleUploadNewSingleCover={vi.fn()} newVolumeCover=""
        newVolumeNum="" newVolumePrice="" newVolumeReleaseDate="" newVolumeStatus="Vorhanden" newVolumeType="volume"
        setNewVolumeCover={vi.fn()} setNewVolumeNum={vi.fn()} setNewVolumePrice={vi.fn()} setNewVolumeReleaseDate={vi.fn()}
        setNewVolumeStatus={vi.fn()} setNewVolumeType={vi.fn()} uploadingNewCover={false}
      />
    );
    for (const label of ['Typ', 'Nummer', 'Preis in Euro', 'Status', 'Erscheinungsdatum (für Release-Radar)']) {
      expect(screen.getByLabelText(label), label).toBeTruthy();
    }
    expect(screen.getByPlaceholderText(/Preis/).getAttribute('placeholder')).toBe('Preis (€, z. B. 7,99)');
    expect(screen.getByRole('form', { name: /Band, Special Edition oder Schuber hinzufügen/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Foto auswählen' })).toBeTruthy();
  });

  it('reader bar: reading progress is a progress bar', () => {
    render(
      <ReaderBar
        readers={[{ user_id: 1, username: 'ed', read_count: 2, total_owned: 4 }]} selectedReaderId={1} setSelectedReaderId={vi.fn()}
        user={{ id: 1 }} ownedCount={4} currentReaderReadCount={2} currentReaderUnreadCount={2}
      />
    );
    const bar = screen.getByRole('progressbar', { name: 'Lesefortschritt' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(bar.getAttribute('aria-valuetext')).toBe('2 von 4 gelesen');
    expect(screen.getByRole('group', { name: 'Leser auswählen' })).toBeTruthy();
  });

  it('filter bar: selects and search are named, the gap toggle reports its state', () => {
    render(
      <VolumeFilterBar
        availablePublishers={[]} baseVolumesForType={[]} conditionsList={[]} currentReaderReadCount={0} currentReaderUnreadCount={0}
        detectedGaps={[3]} handleResetFilters={vi.fn()} handleSetVolumeViewMode={vi.fn()} handleToggleShowGaps={vi.fn()}
        hasActiveFilters isOffline missingCount={0} ownedCount={0} preorderedCount={0} regularVolumeCount={0} schuberCount={0}
        setShowMpEditionModal={vi.fn()} setVolumeConditionFilter={vi.fn()} setVolumeFilter={vi.fn()} setVolumePublisherFilter={vi.fn()}
        setVolumeSearch={vi.fn()} setVolumeSort={vi.fn()} setVolumeTypeFilter={vi.fn()} showGaps specialCount={0}
        specialEditionCount={0} upcomingCount={0} volumeConditionFilter="ALL" volumeFilter="ALL" volumePublisherFilter="ALL"
        volumeSearch="" volumeSort="number_asc" volumeTypeFilter="ALL" volumeViewMode="grid" volumes={[]}
      />
    );
    for (const name of ['Verlag filtern', 'Zustand filtern', 'Sortierung']) expect(screen.getByRole('combobox', { name })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Bände durchsuchen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Lücken:/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Alle Filter zurücksetzen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fehlt noch \(0 \+ 1 Lücke\)/ })).toBeTruthy();
  });

  it('grid card: 24px status toggle named with the volume, cover opens the gallery as a button', () => {
    const openVolumeGallery = vi.fn();
    render(
      <VolumeGridView
        canEdit displayVolumeItems={[{ volume: { id: 4, volume_number: '4', type: 'volume', status: 'Fehlt', cover_image: '/uploads/c.jpg', images: [] } }]}
        handleDeleteVolume={vi.fn()} handleOpenEditVolume={vi.fn()} handleToggleVolume={vi.fn()} handleToggleVolumeRead={vi.fn()}
        manga={{ id: 1, publisher: '' }} mpGapMap={new Map()} openVolumeGallery={openVolumeGallery} readers={[]} selectedReaderId={1}
        setFillingGapNumber={vi.fn()} user={{ id: 1, role: 'editor' }}
      />
    );
    const toggle = screen.getByRole('button', { name: 'Status: Fehlt – Band 4' });
    expect(toggle.className).toMatch(/\bw-6 h-6\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Fotogalerie öffnen: Band 4' }));
    expect(openVolumeGallery).toHaveBeenCalledTimes(1);
    for (const name of ['Band 4 bearbeiten', 'Band 4 löschen']) {
      expect(screen.getByRole('button', { name }).className).toMatch(/\bp-1\.5\b/);
    }
  });

  it('grid and list: card actions and gap buttons carry the volume in their names, no name repeats', () => {
    const volume = (id, number, extra = {}) => ({ id, volume_number: String(number), type: 'volume', status: 'Vorhanden', read_users: [], images: [], ...extra });
    const props = {
      canEdit: true, handleDeleteVolume: vi.fn(), handleOpenEditVolume: vi.fn(), handleToggleVolume: vi.fn(), handleToggleVolumeRead: vi.fn(),
      manga: { id: 1, publisher: '' }, mpGapMap: new Map(), openVolumeGallery: vi.fn(), readers: [], selectedReaderId: 1,
      setFillingGapNumber: vi.fn(), user: { id: 1, role: 'editor' },
      displayVolumeItems: [
        { volume: volume(1, 1) },
        { volume: volume(2, 2, { cover_image: '/uploads/a.jpg', images: ['/uploads/a.jpg', '/uploads/b.jpg'] }) },
        { isGap: true, gapNumber: 3 },
        { isGap: true, gapNumber: 4 }
      ]
    };
    const names = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent.trim());
    const { unmount } = render(<VolumeGridView {...props} />);
    for (const name of ['Foto für Band 1 hochladen', 'Band 1 bearbeiten', 'Band 1 löschen', 'Band 2 bearbeiten', 'Band 2 löschen',
      '2 Fotos von Band 2 öffnen', 'Band 3 erfassen', 'Band 3 zu Sammlung hinzufügen', 'Band 4 erfassen', 'Band 4 zu Sammlung hinzufügen']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'Band löschen' })).toBeNull();
    const grid = names();
    expect(new Set(grid).size).toBe(grid.length);
    unmount();

    render(<VolumeListView {...props} />);
    for (const name of ['Band 1 bearbeiten', 'Band 2 löschen', 'Band 3: Fehlt (Lücke) – erfassen', 'Band 4 erfassen', 'Status: Im Besitz – Band 1', 'Ungelesen – Band 2']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    const list = names();
    expect(new Set(list).size).toBe(list.length);
  });

  it('gap notices count with German plurals', () => {
    render(
      <GapNotices
        canEdit showGaps detectedGaps={[3]} detectedGapEntries={[{ type: 'volume' }]} volumeFilter="ALL" gapsAllowedByFilters
        volumeViewMode="grid" mpGapData={{ matched: true, link_confirmed: true, total_official_volumes: 1, edition: { title: 'Ed' } }}
        handleBatchFillGaps={vi.fn()} setShowMpEditionModal={vi.fn()}
      />
    );
    expect(screen.getByText(/1 Lücke entdeckt/)).toBeTruthy();
    expect(screen.getByText(/geprüft mit Manga Passion/).textContent).toMatch(/1 Band\)/);
    expect(screen.getByRole('button', { name: /Manga-Passion-Edition/ })).toBeTruthy();
  });

  it('radar filters report the toggle state of their chips', () => {
    render(
      <MpFilters
        mpData={null} mpCurrent={false} mpPrintOnly setMpPrintOnly={vi.fn()} mpMySeriesOnly={false} setMpMySeriesOnly={vi.fn()}
        mpPublisherFilter="ALL" setMpPublisherFilter={vi.fn()} mpSearch="x" setMpSearch={vi.fn()} filtersActive onResetFilters={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Nur Print-Bände' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Nur meine Reihen/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Suche leeren' }).className).toMatch(/\bp-1\.5\b/);
  });
});

describe('lightbox', () => {
  const images = ['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg'];
  const base = { title: 'Band 1', subtitle: '', volume: { cover_image: images[0] }, images, currentIndex: 0 };

  it('every control has a name and the position is announced in words', () => {
    render(<LightboxGallery lightboxData={base} setLightboxData={vi.fn()} onClose={vi.fn()} canEdit onSetCover={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Bildergalerie' });
    for (const name of ['Galerie schließen', 'Vorheriges Bild', 'Nächstes Bild', 'Original in neuem Tab öffnen']) {
      expect(within(dialog).getByRole(name.startsWith('Original') ? 'link' : 'button', { name })).toBeTruthy();
    }
    expect(within(dialog).getByText('Bild 1 von 3')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Bild 1 anzeigen (Cover)' }).getAttribute('aria-current')).toBe('true');
  });

  it('the cover button names its state, is no toggle and does nothing on the current cover', () => {
    const onSetCover = vi.fn();
    const { rerender } = render(<LightboxGallery lightboxData={base} setLightboxData={vi.fn()} onClose={vi.fn()} canEdit onSetCover={onSetCover} />);
    const current = screen.getByRole('button', { name: 'Aktuelles Cover' });
    expect(current.hasAttribute('aria-pressed')).toBe(false);
    expect(current.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(current);
    expect(onSetCover).not.toHaveBeenCalled();

    rerender(<LightboxGallery lightboxData={{ ...base, currentIndex: 1 }} setLightboxData={vi.fn()} onClose={vi.fn()} canEdit onSetCover={onSetCover} />);
    const other = screen.getByRole('button', { name: 'Als Cover festlegen' });
    expect(other.hasAttribute('aria-pressed')).toBe(false);
    expect(other.hasAttribute('aria-disabled')).toBe(false);
    expect(other.textContent).toBe('Als Cover festlegen');
    fireEvent.click(other);
    expect(onSetCover).toHaveBeenCalledWith(images[1]);
  });

  // on the detail page the arrow keys must move exactly one image (no second handler)
  it('one arrow key press on the detail page moves exactly one image', () => {
    function DetailHarness() {
      const [lightboxData, setLightboxData] = useState(base);
      useDetailKeyboard({
        lightboxData, setLightboxData, activeVolume: null, setActiveVolume: vi.fn(), showBatchModal: false, setShowBatchModal: vi.fn(),
        showBatchReadModal: false, setShowBatchReadModal: vi.fn(), fillingGapNumber: null, setFillingGapNumber: vi.fn(),
        showMpEditionModal: false, setShowMpEditionModal: vi.fn(), editing: false, setEditing: vi.fn(), volumeViewMode: 'spine',
        filteredVolumes: [], focusedVolumeId: null, setFocusedVolumeId: vi.fn(), canEdit: true,
        handleToggleVolumeRead: vi.fn(), handleOpenEditVolume: vi.fn()
      });
      return <LightboxGallery lightboxData={lightboxData} setLightboxData={setLightboxData} onClose={() => setLightboxData(null)} />;
    }
    render(<DetailHarness />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Bild 2 von 3')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Bild 3 von 3')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Bildergalerie' })).toBeNull();
  });
});

// photo results that arrive late are merged into the current form, never into a stale copy
describe('volume editor photos (C10)', () => {
  const volume = { id: 7, manga_id: 1, type: 'volume', volume_number: '3', status: 'Vorhanden', owners: [], images: ['/uploads/old.jpg'], cover_image: '/uploads/old.jpg', isbn: '', release_date: '' };

  const setup = (routes) => {
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      const key = `${init.method || 'GET'} ${url}`;
      const hit = Object.keys(routes).find(k => key.startsWith(k));
      if (!hit) throw new Error(`unexpected request ${key}`);
      return routes[hit](url, init);
    }));
    return render(<VolumeEditModal isOpen activeVolume={volume} manga={{ id: 1, reader_stats: [] }} mangaId={1} canEdit user={{ id: 1, role: 'editor' }} onClose={vi.fn()} onSuccess={vi.fn()} />);
  };

  it('a slow upload keeps a photo added meanwhile and a photo removed meanwhile stays removed', async () => {
    let finishUpload;
    const { container } = setup({
      'POST /api/upload/multiple': () => new Promise((resolve) => { finishUpload = () => resolve(json(200, { urls: ['/uploads/up.jpg'] })); }),
      'POST /api/upload-remote': () => json(200, { url: '/uploads/remote.jpg' })
    });
    fireEvent.change(container.querySelector('input[type="file"][multiple]'), { target: { files: [new File(['x'], 'u.jpg', { type: 'image/jpeg' })] } });
    await waitFor(() => expect(finishUpload).toBeTypeOf('function'));

    fireEvent.click(screen.getByRole('button', { name: 'URL eingeben' }));
    fireEvent.change(screen.getByPlaceholderText(/Bild-URL/), { target: { value: 'https://example.com/b.jpg' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    await waitFor(() => expect(screen.getAllByRole('img', { name: /^Foto / })).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Foto 1 löschen' }));
    expect(screen.getAllByRole('img', { name: /^Foto / })).toHaveLength(1);

    await act(async () => { finishUpload(); });
    await waitFor(() => expect(screen.getAllByRole('img', { name: /^Foto / })).toHaveLength(2));
    const srcs = screen.getAllByRole('img', { name: /^Foto / }).map(img => img.getAttribute('src'));
    expect(srcs).toEqual(['/uploads/remote.jpg', '/uploads/up.jpg']);
  });

  it('photo controls are named per photo', () => {
    setup({});
    expect(screen.getByRole('button', { name: 'Foto 1 löschen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fotos hochladen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Weitere Fotos hinzufügen' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'URL eingeben' }));
    expect(screen.getByRole('button', { name: 'Abbrechen', expanded: true })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Bild-URL oder Manga-Passion-Link' })).toBeTruthy();
  });
});
