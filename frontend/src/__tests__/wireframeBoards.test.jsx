// Approved wireframe boards of 2026-11-24: tablet list row (publisher in the second line, arrow instead of "Details"),
// owner menu (phone sheet above the bars, measured popover elsewhere), the "show all matches" button of the phone
// search with two-step Escape, and the second backup location in the Backups dialog.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OwnerBadges, { placeMenu, bottomBarInset } from '../components/detail/OwnerBadges';
import MangaRow from '../components/dashboard/MangaRow';
import DashboardHeader from '../components/dashboard/DashboardHeader';
import SecondLocation, { SAME_DISK_HINT } from '../components/modals/backup/SecondLocation';
import { NARROW_QUERY } from '../components/common/BottomNav';
import { fakeResponse } from './fakeResponse';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubNarrow(narrow) {
  vi.stubGlobal('matchMedia', vi.fn((query) => ({
    matches: query === NARROW_QUERY ? narrow : false,
    media: query,
    addEventListener() {},
    removeEventListener() {}
  })));
}

describe('owner menu placement', () => {
  const view = { vw: 800, vh: 600 };
  const rect = (top, height = 24, left = 100) => ({ top, bottom: top + height, left });

  it('opens below when it fits, above when that side has more room, and scrolls inside when neither fits', () => {
    expect(placeMenu(rect(100), 200, view)).toEqual({ left: 100, top: 130, bottom: undefined, maxHeight: undefined });
    const up = placeMenu(rect(450), 300, view);
    expect(up.top).toBeUndefined();
    expect(up.bottom).toBe(600 - 450 + 6);
    expect(up.maxHeight).toBeUndefined();
    const tall = placeMenu(rect(250), 900, view);
    expect(tall.maxHeight).toBeLessThan(900);
    expect(tall.maxHeight).toBeGreaterThanOrEqual(120);
  });

  it('keeps the menu inside the screen and out of the bottom bars', () => {
    expect(placeMenu(rect(100, 24, 760), 100, view).left).toBe(800 - 208 - 8);
    // 300 px above, but the bars cover the lowest 150 px: the menu goes up
    expect(placeMenu(rect(300), 200, { ...view, inset: 150 }).top).toBeUndefined();
  });

  it('measures only the bars that sit at the bottom of the screen', () => {
    const doc = {
      getElementById: (id) => ({
        'bottom-nav': { getBoundingClientRect: () => ({ top: 536, bottom: 600, height: 64 }) },
        'detail-bottom-bar': { getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }) }
      })[id]
    };
    expect(bottomBarInset(doc, 600)).toBe(64);
    expect(bottomBarInset({ getElementById: () => null }, 600)).toBe(0);
  });
});

describe('owner menu', () => {
  const people = [{ user_id: 1, username: 'max' }, { user_id: 2, username: 'lukas' }];
  const vol = { id: 9, volume_number: 7, owners: [{ user_id: 1, username: 'max' }], copies: [{ id: 21, owner_user_id: 1, lent_to: null }] };

  it('is a sheet on phones: "Band N", 44 px rows, "Fertig" and a tap beside it close it', () => {
    stubNarrow(true);
    render(<OwnerBadges vol={vol} multiUser people={people} onToggleOwner={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Besitzer' }));
    const sheet = screen.getByRole('dialog', { name: 'Besitzer' });
    expect(sheet.hasAttribute('data-owner-sheet')).toBe(true);
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    // below the confirm dialog (z-[68]) and the toasts (z-[70]): the undo toast of a change made here stays visible
    expect(sheet.className).toContain('z-[67]');
    expect(document.querySelector('[data-owner-sheet-backdrop]').className).toContain('z-[66]');
    expect(within(sheet).getByText('Band 7')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /lukas/ }).className).toContain('min-h-[44px]');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Fertig' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Besitzer' }));
    fireEvent.click(document.querySelector('[data-owner-sheet-backdrop]'));
    expect(screen.queryByRole('dialog')).toBeNull();
    // a tap on iOS does not focus the pill: the focus still comes back to it
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Besitzer' }));
  });

  it('is a popover elsewhere: no sheet, Escape closes it and gives the focus back to the pill', () => {
    stubNarrow(false);
    render(<OwnerBadges vol={vol} multiUser people={people} onToggleOwner={vi.fn()} />);
    const pill = screen.getByRole('button', { name: 'Besitzer' });
    expect(pill.className).toContain('hit-44');
    fireEvent.click(pill);
    const menu = screen.getByRole('dialog', { name: 'Besitzer' });
    expect(menu.hasAttribute('data-owner-sheet')).toBe(false);
    expect(menu.style.position).toBe('fixed');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pill);
  });
});

describe('list row between 640 and 1023 px', () => {
  const renderRow = (props) => render(
    <MemoryRouter>
      <table><tbody>
        <MangaRow manga={{ id: 3, title: 'Reihe', author: 'Oda', publisher: 'Carlsen', status: 'Laufend', owned_volumes: 1 }}
          canEdit={false} getStatusBadge={() => null} onDelete={vi.fn()} {...props} />
      </tbody></table>
    </MemoryRouter>
  );

  it('shows the publisher in the second line, first when sorted by publisher, and an arrow with a full name', () => {
    const { unmount } = renderRow();
    const line = screen.getByTestId('row-publisher');
    expect(line.className).toContain('hidden sm:inline lg:hidden');
    expect(line.textContent).toBe(' · Carlsen');
    const arrow = screen.getByRole('link', { name: 'Details zu Reihe' });
    expect(arrow.className).toContain('hidden sm:inline-flex lg:hidden');
    expect(arrow.className).toContain('w-11 h-11');
    unmount();

    renderRow({ publisherFirst: true });
    expect(screen.getByTestId('row-publisher').textContent).toBe('Carlsen · ');
  });
});

describe('phone search', () => {
  const mangas = [{ id: 1, title: 'One Piece', author: 'Oda' }, { id: 2, title: 'One Punch-Man', author: 'ONE' }];
  function Header({ matchCount }) {
    const [search, setSearch] = useState('');
    const inputRef = useRef(null);
    return (
      <MemoryRouter>
        <DashboardHeader
          activeMainView="collection" canEdit handleBarcodeDetected={vi.fn()} handleInstallClick={vi.fn()} handleOpenCsvModal={vi.fn()}
          handleOpenModal={vi.fn()} handleOpenPasswordModal={vi.fn()} handleOpenRestoreModal={vi.fn()} handleOpenStats={vi.fn()}
          handleOpenUsersModal={vi.fn()} handleOpenTool={vi.fn()} isInstallable={false} isInstalledApp={false} isOfflineMode={false}
          isVisitor={false} mangas={mangas} mobileMenuOpen={false} onLogout={vi.fn()} onOpenSeries={vi.fn()} radarData={null}
          search={search} searchInputRef={inputRef} setMobileMenuOpen={vi.fn()} setSearch={setSearch} setView={vi.fn()}
          shoppingData={null} user={{ id: 7, username: 'anna', role: 'editor' }} matchCount={matchCount}
        />
      </MemoryRouter>
    );
  }

  it('offers all matches of the collection; the first Escape only closes the list, typing opens it again', () => {
    stubNarrow(true);
    render(<Header matchCount={2} />);
    const input = screen.getAllByRole('combobox').find((el) => el.tagName === 'INPUT');
    input.focus();
    fireEvent.change(input, { target: { value: 'one' } });
    const all = document.getElementById('btn-quick-access-show-all');
    expect(all.textContent).toBe('Alle 2 Treffer in der Sammlung zeigen');
    fireEvent.click(all);
    expect(document.getElementById('btn-quick-access-show-all')).toBeNull();
    expect(input.value).toBe('one');

    fireEvent.change(input, { target: { value: 'one p' } });
    expect(document.getElementById('btn-quick-access-show-all')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.getElementById('btn-quick-access-show-all')).toBeNull();
    expect(input.value).toBe('one p');
  });
});

describe('second backup location', () => {
  const base = { dir: null, from_env: false, ok_at: null, error: null, error_msg: null, error_at: null, copies: null, bytes: null, free_bytes: null, same_disk_hint: true };

  it('without a folder: the same-disk hint and the help text; saving sends the folder', async () => {
    const onSaved = vi.fn();
    const answer = { backups: [], copy: { ...base, dir: '/mnt/usb/manga', same_disk_hint: false, ok_at: '2026-11-24T10:00:00Z', copies: 2, bytes: 2048, free_bytes: 1e9 } };
    const fetchMock = vi.fn(async () => fakeResponse(200, answer));
    vi.stubGlobal('fetch', fetchMock);
    render(<SecondLocation copy={base} onSaved={onSaved} />);
    expect(screen.getByRole('note').textContent).toBe(SAME_DISK_HINT);
    const save = screen.getByRole('button', { name: 'Speichern' });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Ordner für Kopien'), { target: { value: ' /mnt/usb/manga ' } });
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(answer));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/backup/copy');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ dir: '/mnt/usb/manga' });
  });

  it('a refused folder shows the server reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(400, { error: 'Der Pfad ist zu lang.', code: 'BACKUP_COPY_DIR' })));
    render(<SecondLocation copy={base} />);
    fireEvent.change(screen.getByLabelText('Ordner für Kopien'), { target: { value: 'relativ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Der Pfad ist zu lang.');
  });

  it('a working folder shows the last copy; a failed one its reason; BACKUP_COPY_DIR locks the field', () => {
    const ok = { ...base, dir: '/mnt/nas', same_disk_hint: false, ok_at: '2026-11-24T10:00:00Z', copies: 3, bytes: 3 * 1024 * 1024, free_bytes: 50 * 1024 * 1024 };
    const { unmount } = render(<SecondLocation copy={ok} />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByTestId('copy-summary').textContent).toMatch(/^Letzte Kopie: .+ · 3 Kopien, .+ · .+ frei$/);
    unmount();

    const failed = { ...ok, error: 'Ordner /mnt/nas ist nicht erreichbar. Nächster Versuch beim nächsten Backup.', error_at: '2026-11-24T11:00:00Z', from_env: true };
    render(<SecondLocation copy={failed} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Kopie fehlgeschlagen/);
    expect(alert.textContent).toMatch(/nicht erreichbar/);
    expect(alert.textContent).toMatch(/Die Backups auf dem Server bleiben davon unberührt\./);
    expect(screen.queryByTestId('copy-summary')).toBeNull();
    expect(screen.getByLabelText('Ordner für Kopien').readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(screen.getByText('Festgelegt über die Variable BACKUP_COPY_DIR.')).toBeTruthy();
  });
});
