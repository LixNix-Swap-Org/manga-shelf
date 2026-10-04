// Touch target sizes across dialogs and lists, Login field markup and MangaCard title language.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { fakeResponse } from './fakeResponse';
import Login from '../Login';
import CollectionToolbar from '../components/dashboard/CollectionToolbar';
import DashboardFooter from '../components/dashboard/DashboardFooter';
import ConnectQr from '../components/common/ConnectQr';
import CsvExchangeModal from '../components/dashboard/CsvExchangeModal';
import ScanCandidatesDialog from '../components/dashboard/ScanCandidatesDialog';
import MpEditionModal from '../components/detail/MpEditionModal';
import MangaCollectionGrid, { GRID_DELETE_BUTTON_CLASS } from '../components/dashboard/MangaCollectionGrid';
import MainViewSwitcher from '../components/dashboard/MainViewSwitcher';
import MangaRow from '../components/dashboard/MangaRow';
import UserManagementModal from '../components/modals/UserManagementModal';
import VolumeListView from '../components/detail/VolumeListView';
import { getStatusBadge } from '../utils/collectionHelpers';

const classes = (el) => (el.getAttribute('class') || '').split(/\s+/);
const json = (status, body) => fakeResponse(status, body);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('touch targets of 44 px', () => {
  it('view toggles of the shelf toolbar', () => {
    render(
      <CollectionToolbar
        availablePublishers={[]} filterCounts={{}} filtered={[]} publisherFilter="ALL" search=""
        setPublisherFilter={vi.fn()} setSearch={vi.fn()} setSortBy={vi.fn()} setStatusFilter={vi.fn()} setViewMode={vi.fn()}
        sortBy="title_asc" statusFilter="ALL" viewMode="grid"
      />
    );
    for (const id of ['btn-view-grid', 'btn-view-list']) {
      expect(classes(document.getElementById(id))).toEqual(expect.arrayContaining(['hit-44', '[@media(pointer:coarse)]:px-[15px]']));
    }
  });

  it('footer buttons: offline copy, install, connect app', () => {
    render(
      <DashboardFooter
        user={{ id: 1, role: 'editor' }} isOfflineMode={false} networkOffline={false} refreshingCopy={false}
        handleRefreshOfflineCopy={vi.fn()} offlineCopyAt={null} isInstallable isInstalledApp={false} handleInstallClick={vi.fn()}
      />
    );
    expect(classes(screen.getByRole('button', { name: /Offline-Kopie erstellen/ }))).toContain('hit-44');
    expect(classes(screen.getByRole('button', { name: /App installieren/ }))).toContain('hit-44');
    expect(classes(document.getElementById('footer-connect-app'))).toContain('hit-44');
  });

  it('close buttons of the connect, CSV, scan candidate and Manga Passion dialogs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { url: 'http://intern:3000', name: 'Manga Shelf', instance_id: 'i' })));
    const qr = render(<ConnectQr />);
    fireEvent.click(screen.getByRole('button', { name: /Mit App verbinden/ }));
    const connect = screen.getByRole('dialog', { name: 'Mit App verbinden' });
    expect(classes(within(connect).getByRole('button', { name: 'Schließen' }))).toContain('hit-44');
    qr.unmount();

    const csv = render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit={false} />);
    expect(classes(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Schließen' })[0])).toContain('hit-44');
    csv.unmount();

    const scan = render(
      <ScanCandidatesDialog candidates={[{ id: 1, title: 'A', cover_image: null }]} bookTitle="X" canEdit={false}
        onChoose={vi.fn()} onCreateNew={vi.fn()} onClose={vi.fn()} />
    );
    expect(classes(within(screen.getByRole('dialog')).getByRole('button', { name: 'Schließen' }))).toContain('hit-44');
    scan.unmount();

    render(
      <MpEditionModal
        isOpen onClose={vi.fn()} manga={{ title: 'Ed', publisher: 'Carlsen', total_volumes: 2, manga_passion_id: 7 }}
        mpGapData={{ matched: true, link_confirmed: true, edition: { id: 7, title: 'Ed', publisher: 'Carlsen', total_volumes: 2 }, discrepancy: {}, candidate_editions: [] }}
        mpGapLoading={false} fetchMpGaps={vi.fn()} handleSyncTotalVolumes={vi.fn()} handleBatchAutofillManga={vi.fn()}
        batchAutofilling={false} handleSelectMpEdition={vi.fn()} canEdit={false}
      />
    );
    expect(classes(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Schließen' })[0])).toContain('hit-44');
  });

  it('the grid delete button uses the shared hit area instead of its own inset', () => {
    expect(GRID_DELETE_BUTTON_CLASS.split(' ')).toContain('hit-44');
    expect(GRID_DELETE_BUTTON_CLASS).not.toMatch(/before:-inset/);
    render(
      <MemoryRouter>
        <MangaCollectionGrid
          canEdit error={null} filtered={[{ id: 1, title: 'Reihe 1', status: 'Laufend', owned_volumes: 1, regular_owned: 1 }]}
          getStatusBadge={getStatusBadge} handleDeleteManga={vi.fn()} handleOpenModal={vi.fn()} isOffline={false} loading={false}
          onRetry={vi.fn()} publisherFilter="ALL" search="" setPublisherFilter={vi.fn()} setSearch={vi.fn()} setStatusFilter={vi.fn()}
          sortBy="title_asc" statusFilter="ALL" viewMode="grid"
        />
      </MemoryRouter>
    );
    expect(classes(screen.getByRole('button', { name: 'Reihe 1 löschen' }))).toContain('hit-44');
  });

  it('main view tabs grow to 44 px on touch screens', () => {
    render(<MainViewSwitcher activeMainView="collection" onSelectView={vi.fn()} mangaCount={1} shoppingData={null} radarData={null} />);
    for (const id of ['btn-nav-shelf', 'btn-nav-shopping', 'btn-nav-radar', 'btn-nav-anime']) {
      expect(classes(document.getElementById(id))).toContain('[@media(pointer:coarse)]:py-3.5');
    }
  });

  it('author buttons of a list row', () => {
    render(
      <MemoryRouter>
        <table><tbody>
          <MangaRow manga={{ id: 3, title: 'Reihe', author: 'Oda, Toriyama', status: 'Laufend', owned_volumes: 1 }}
            canEdit={false} getStatusBadge={getStatusBadge} onDelete={vi.fn()} onAuthorClick={vi.fn()} />
        </tbody></table>
      </MemoryRouter>
    );
    expect(classes(screen.getByRole('button', { name: /Alle Reihen von Oda|Oda/ }))).toContain('hit-44');
    expect(classes(screen.getByRole('button', { name: /Toriyama/ }))).toContain('hit-44');
    const authors = screen.getByRole('button', { name: /Toriyama/ }).closest('div');
    expect(classes(authors)).not.toContain('line-clamp-1');
    expect(classes(authors)).toContain('[@media(pointer:fine)]:line-clamp-1');
  });

  it('row buttons of the user management keep their hit areas apart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, [
      { id: 1, username: 'admin', role: 'admin', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, username: 'erika', role: 'editor', created_at: '2026-02-01T00:00:00Z' }
    ])));
    render(<UserManagementModal isOpen onClose={vi.fn()} currentUser={{ id: 1, username: 'admin', role: 'admin' }} />);
    const reset = await screen.findByRole('button', { name: 'Passwort von erika zurücksetzen' });
    const remove = screen.getByRole('button', { name: 'Benutzer erika löschen' });
    expect(classes(reset)).toContain('hit-44');
    expect(classes(remove)).toContain('hit-44');
    expect(classes(reset.parentElement)).toContain('[@media(pointer:coarse)]:gap-5');
  });

  it('edit and delete icons of the volume list', () => {
    const volume = { id: 1, volume_number: '1', type: 'volume', status: 'Vorhanden', read_users: [], images: [], cover_image: '/uploads/a.jpg' };
    render(
      <VolumeListView
        canEdit handleDeleteVolume={vi.fn()} handleOpenEditVolume={vi.fn()} handleToggleVolume={vi.fn()} handleToggleVolumeRead={vi.fn()}
        manga={{ id: 1, publisher: '' }} mpGapMap={new Map()} openVolumeGallery={vi.fn()} readers={[]} selectedReaderId={1}
        setFillingGapNumber={vi.fn()} user={{ id: 1, role: 'editor' }} displayVolumeItems={[{ volume }]}
      />
    );
    const edit = screen.getByRole('button', { name: 'Band 1 bearbeiten' });
    expect(classes(edit)).toContain('hit-44');
    expect(classes(screen.getByRole('button', { name: 'Band 1 löschen' }))).toContain('hit-44');
    expect(classes(edit.parentElement)).toContain('[@media(pointer:coarse)]:gap-5');
    expect(classes(screen.getByRole('button', { name: /Status: Im Besitz/ }))).toContain('hit-44');
    expect(classes(screen.getByRole('button', { name: /Ungelesen – Band 1/ }))).toContain('hit-44');
    expect(classes(screen.getByRole('button', { name: 'Fotogalerie öffnen: Band 1' }))).toContain('hit-44');
  });

  it('gap buttons of the volume list', () => {
    render(
      <VolumeListView
        canEdit handleDeleteVolume={vi.fn()} handleOpenEditVolume={vi.fn()} handleToggleVolume={vi.fn()} handleToggleVolumeRead={vi.fn()}
        manga={{ id: 1, publisher: '' }} mpGapMap={new Map()} openVolumeGallery={vi.fn()} readers={[]} selectedReaderId={1}
        setFillingGapNumber={vi.fn()} user={{ id: 1, role: 'editor' }} displayVolumeItems={[{ isGap: true, gapNumber: 3 }]}
      />
    );
    expect(classes(screen.getByRole('button', { name: 'Band 3: Fehlt (Lücke) – erfassen' }))).toContain('hit-44');
    expect(classes(screen.getByRole('button', { name: 'Band 3 erfassen' }))).toContain('hit-44');
  });
});

describe('Login', () => {
  const renderLogin = () => render(<MemoryRouter><Login onLogin={vi.fn()} /></MemoryRouter>);

  it('the input fills its whole box, the icon lets taps through', () => {
    renderLogin();
    for (const label of ['Benutzername', 'Passwort']) {
      const input = screen.getByLabelText(label);
      expect(classes(input)).toEqual(expect.arrayContaining(['w-full', 'py-2.5', 'pl-11']));
      expect(classes(input)).not.toContain('p-0');
      const box = input.parentElement;
      expect(classes(box)).toContain('relative');
      expect(box.className).not.toMatch(/\bpy-/);
      const icon = box.querySelector('svg');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(classes(icon)).toEqual(expect.arrayContaining(['absolute', 'pointer-events-none']));
    }
  });

  it('wrong credentials mark both fields invalid and describe them by the alert; a network error does not', async () => {
    const fetchMock = vi.fn(async () => json(401, { error: 'Ungültige Anmeldedaten' }));
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();
    const user = screen.getByLabelText('Benutzername');
    const password = screen.getByLabelText('Passwort');
    expect(user.getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(user, { target: { value: 'anna' } });
    fireEvent.change(password, { target: { value: 'falsch' } });
    fireEvent.submit(user.closest('form'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Ungültige Anmeldedaten');
    for (const field of [user, password]) {
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(field.getAttribute('aria-describedby')).toBe(alert.id);
    }

    fetchMock.mockImplementation(async () => { throw new TypeError('offline'); });
    fireEvent.submit(user.closest('form'));
    expect((await screen.findByText('Verbindungsfehler zum Server')).getAttribute('role')).toBe('alert');
    expect(user.getAttribute('aria-invalid')).toBeNull();
    expect(password.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('MangaCard title language', () => {
  it('Japanese titles hyphenate as Japanese, the rest as German', () => {
    render(
      <MemoryRouter>
        <MangaCollectionGrid
          canEdit={false} error={null} getStatusBadge={getStatusBadge} handleDeleteManga={vi.fn()} handleOpenModal={vi.fn()}
          filtered={[
            { id: 1, title: '進撃の巨人 – Shingeki no Kyojin', status: 'Laufend', owned_volumes: 1, regular_owned: 1 },
            { id: 2, title: 'Donaudampfschifffahrt', status: 'Laufend', owned_volumes: 1, regular_owned: 1 }
          ]}
          isOffline={false} loading={false} onRetry={vi.fn()} publisherFilter="ALL" search="" setPublisherFilter={vi.fn()}
          setSearch={vi.fn()} setStatusFilter={vi.fn()} sortBy="title_asc" statusFilter="ALL" viewMode="grid"
        />
      </MemoryRouter>
    );
    expect(document.getElementById('manga-card-1-title').getAttribute('lang')).toBe('ja');
    expect(document.getElementById('manga-card-2-title').getAttribute('lang')).toBe('de');
  });
});
