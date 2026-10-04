// Small UI regressions: bottom nav and keyboard, owner badges, volume editor header, backup export, offline padding.
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import BottomNav from '../components/common/BottomNav';
import { useKeyboardOpen, isTypingTarget } from '../hooks/useKeyboardOpen';
import useDialogA11y from '../hooks/useDialogA11y';
import * as detailBar from '../components/detail/DetailBottomBar';
import OwnerBadges from '../components/detail/OwnerBadges';
import { readerInitials } from '../components/detail/VolumeGridView';
import TypeNumberFields from '../components/detail/volumeEdit/TypeNumberFields';
import EditHeader from '../components/detail/volumeEdit/EditHeader';
import BackupExportModal from '../components/modals/BackupExportModal';
import { notify } from '../utils/notify';
import appSource from '../App.jsx?raw';

vi.mock('../local/localTransport', () => ({ getLocalRuntime: vi.fn(async () => ({})) }));
vi.mock('../local/backupZip', () => ({ buildBackupZip: vi.fn(async () => new Uint8Array(10)), readBackupZip: vi.fn() }));

const classesOf = (el) => String(el.className).split(/\s+/);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BottomNav and the on-screen keyboard', () => {
  const renderNav = () => render(
    <>
      <input aria-label="Suche" />
      <BottomNav activeMainView="shelf" setView={vi.fn()} onScan={vi.fn()} setMobileMenuOpen={vi.fn()} />
    </>
  );

  it('hides while a text field has focus and comes back on blur; its own buttons do not hide it', () => {
    renderNav();
    const nav = () => document.getElementById('bottom-nav');
    expect(classesOf(nav())).not.toContain('hidden');
    const field = screen.getByLabelText('Suche');
    act(() => field.focus());
    expect(classesOf(nav())).toContain('hidden');
    expect(nav().getAttribute('data-keyboard')).toBe('open');
    act(() => field.blur());
    expect(classesOf(nav())).not.toContain('hidden');
    act(() => document.getElementById('btn-mobile-radar').focus());
    expect(classesOf(nav())).not.toContain('hidden');
  });

  it('hides while the visual viewport is squeezed by the keyboard', () => {
    const listeners = new Set();
    const viewport = {
      height: window.innerHeight, scale: 1,
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn)
    };
    vi.stubGlobal('visualViewport', viewport);
    renderNav();
    act(() => {
      viewport.height = window.innerHeight - 300;
      listeners.forEach((fn) => fn());
    });
    expect(classesOf(document.getElementById('bottom-nav'))).toContain('hidden');
  });

  it('stays shown while a field in an open modal has focus, so closing the dialog returns focus to "Mehr"', () => {
    const listeners = new Set();
    const viewport = {
      height: window.innerHeight, scale: 1,
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn)
    };
    vi.stubGlobal('visualViewport', viewport);
    function AddDialog({ onClose }) {
      const ref = useDialogA11y(true, { onClose, history: false });
      return (
        <div ref={ref} role="dialog" aria-modal="true" aria-label="Neuer Manga">
          <input aria-label="Titel" autoFocus />
          <button type="button" onClick={onClose}>Schließen</button>
        </div>
      );
    }
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <BottomNav activeMainView="shelf" setView={vi.fn()} onScan={vi.fn()} setMobileMenuOpen={() => setOpen(true)} />
          {open && <AddDialog onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Harness />);
    const nav = document.getElementById('bottom-nav');
    const more = document.getElementById('btn-mobile-menu-toggle');
    act(() => more.focus());
    fireEvent.click(more);
    expect(document.activeElement).toBe(screen.getByLabelText('Titel'));
    act(() => {
      viewport.height = window.innerHeight - 300;
      listeners.forEach((fn) => fn());
    });
    expect(classesOf(nav)).not.toContain('hidden');
    expect(nav.getAttribute('data-keyboard')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.activeElement).toBe(more);
    // the keyboard is still closing: the bar holding the focus stays shown
    act(() => listeners.forEach((fn) => fn()));
    expect(classesOf(nav)).not.toContain('hidden');
    expect(document.activeElement).toBe(more);
  });

  it('the hook lives in hooks/ and DetailBottomBar re-exports it', () => {
    expect(detailBar.useKeyboardOpen).toBe(useKeyboardOpen);
    expect(detailBar.isTypingTarget).toBe(isTypingTarget);
  });
});

describe('owner badges and reader avatars', () => {
  it('owner badges show the same initials as the reader avatars', () => {
    render(<OwnerBadges multiUser vol={{ owners: [{ user_id: 1, username: 'admin' }, { user_id: 2, username: 'Max Mustermann' }] }} />);
    const badge = screen.getByRole('img', { name: 'Besitzer: admin, Max Mustermann' });
    expect(badge.textContent).toContain(readerInitials('admin'));
    expect(badge.textContent).toContain('Ad');
    expect(badge.textContent).toContain('MM');
    expect(badge.textContent).not.toContain('ad');
  });
});

describe('volume editor', () => {
  it('the entry types are plain text without emoji', () => {
    render(<TypeNumberFields editVolForm={{ type: 'volume', volume_number: '1' }} setEditVolForm={vi.fn()} />);
    const labels = Array.from(screen.getByLabelText(/Eintragstyp/).options).map((o) => o.textContent);
    expect(labels).toEqual(['Einzelband', 'Special Edition', 'Schuber', 'Special / Extra']);
  });

  it('the header is compact below 500 px height and the close button has a 44 px hit area', () => {
    render(<EditHeader activeVolume={{ volume_number: '3', type: 'volume' }} editVolForm={{ volume_number: '3', type: 'volume' }} onClose={vi.fn()} />);
    const close = screen.getByRole('button', { name: 'Schließen' });
    expect(classesOf(close)).toContain('hit-44');
    expect(classesOf(close.parentElement)).toContain('short:py-2');
    expect(classesOf(screen.getByText(/Typ, Details, Preis/))).toContain('short:hidden');
  });
});

describe('BackupExportModal export', () => {
  it('says the backup was created, not saved: the share sheet decides what happens next', async () => {
    const success = vi.spyOn(notify, 'success').mockImplementation(() => 1);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL ??= () => '';
    URL.revokeObjectURL ??= () => {};
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    render(<BackupExportModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sicherung exportieren' }));
    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(success.mock.calls[0][0]).toMatch(/^Sicherung erstellt \(/);
  });
});

describe('dashboard offline padding', () => {
  it('the last row clears the offline banner above the bottom navigation', () => {
    expect(appSource).toContain("user?.offline ? 'max-sm:pb-[calc(env(safe-area-inset-bottom)+4rem)]'");
  });
});
