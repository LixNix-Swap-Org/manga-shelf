// useDashboardKeyboard: Escape closes the topmost layer, "/" focuses the search.
import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, renderHook, screen, fireEvent, act } from '@testing-library/react';
import useDashboardKeyboard from '../hooks/useDashboardKeyboard';
import ChangePasswordModal from '../components/modals/ChangePasswordModal';

const escape = (target = window) => fireEvent.keyDown(target, { key: 'Escape' });
const slash = (target = window) => fireEvent.keyDown(target, { key: '/' });

const baseOptions = (extra = {}) => ({
  showAddModal: false, setShowAddModal: vi.fn(), showStatsModal: false, setShowStatsModal: vi.fn(),
  showUsersModal: false, setShowUsersModal: vi.fn(), showRestoreModal: false, setShowRestoreModal: vi.fn(),
  mobileMenuOpen: false, setMobileMenuOpen: vi.fn(), search: '', setSearch: vi.fn(), searchInputRef: { current: null },
  ...extra
});

const dialog = ({ busy = false } = {}) => {
  const node = document.createElement('div');
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  if (busy) node.setAttribute('data-busy', 'true');
  node.innerHTML = '<select><option>a</option></select><button>ok</button>';
  document.body.appendChild(node);
  return node;
};

describe('useDashboardKeyboard', () => {
  it('Escape closes the add dialog through its close callback (clears a scan prefill), not the raw setter', () => {
    const opts = baseOptions({ showAddModal: true, closeAddModal: vi.fn() });
    renderHook(() => useDashboardKeyboard(opts));
    escape();
    expect(opts.closeAddModal).toHaveBeenCalledTimes(1);
    expect(opts.setShowAddModal).not.toHaveBeenCalled();
  });

  it('without a close callback the setter is still used', () => {
    const opts = baseOptions({ showStatsModal: true });
    renderHook(() => useDashboardKeyboard(opts));
    escape();
    expect(opts.setShowStatsModal).toHaveBeenCalledWith(false);
  });

  it('Escape does not close a dialog that marks itself busy (running restore / submit)', () => {
    const node = dialog({ busy: true });
    const opts = baseOptions({ showRestoreModal: true, search: 'abc' });
    renderHook(() => useDashboardKeyboard(opts));
    escape(document.body);
    expect(opts.setShowRestoreModal).not.toHaveBeenCalled();
    expect(opts.setSearch).not.toHaveBeenCalled();
    node.setAttribute('data-busy', 'false');
    escape(document.body);
    expect(opts.setShowRestoreModal).toHaveBeenCalledWith(false);
    node.remove();
  });

  it('an Escape a dialog already handled (preventDefault) is ignored', () => {
    const node = dialog();
    node.addEventListener('keydown', (e) => e.preventDefault());
    const opts = baseOptions({ showAddModal: true, closeAddModal: vi.fn() });
    renderHook(() => useDashboardKeyboard(opts));
    escape(node);
    expect(opts.closeAddModal).not.toHaveBeenCalled();
    node.remove();
  });

  it('Escape in the password dialog closes it and keeps the shelf search', () => {
    function Harness() {
      const searchInputRef = useRef(null);
      const [search, setSearch] = useState('abc');
      const [showPasswordModal, setShowPasswordModal] = useState(true);
      useDashboardKeyboard({ ...baseOptions(), search, setSearch, searchInputRef });
      return (
        <>
          <input ref={searchInputRef} aria-label="Suche" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ChangePasswordModal isOpen={showPasswordModal} onClose={() => setShowPasswordModal(false)} />
        </>
      );
    }
    render(<Harness />);
    escape(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Suche').value).toBe('abc');
  });

  it("'/' does not pull focus out of an open dialog (select, button)", () => {
    const search = document.createElement('input');
    document.body.appendChild(search);
    const node = dialog();
    const opts = baseOptions({ showUsersModal: true, searchInputRef: { current: search } });
    renderHook(() => useDashboardKeyboard(opts));
    const select = node.querySelector('select');
    select.focus();
    slash(select);
    expect(document.activeElement).toBe(select);
    const button = node.querySelector('button');
    button.focus();
    slash(button);
    expect(document.activeElement).toBe(button);
    node.remove();
    search.remove();
  });

  it("without a dialog '/' focuses the search and Escape clears it; modifier combos are left alone", () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const opts = baseOptions({ search: 'abc', searchInputRef: { current: input } });
    renderHook(() => useDashboardKeyboard(opts));
    fireEvent.keyDown(document.body, { key: '/', ctrlKey: true });
    expect(document.activeElement).not.toBe(input);
    slash(document.body);
    expect(document.activeElement).toBe(input);
    escape(input);
    expect(opts.setSearch).toHaveBeenCalledWith('');
    expect(document.activeElement).not.toBe(input);
    input.remove();
  });

  it('Escape closes the mobile menu before touching the search', () => {
    const opts = baseOptions({ mobileMenuOpen: true, search: 'abc' });
    renderHook(() => useDashboardKeyboard(opts));
    escape();
    expect(opts.setMobileMenuOpen).toHaveBeenCalledWith(false);
    expect(opts.setSearch).not.toHaveBeenCalled();
  });

  it('uses the latest options without re-subscribing', () => {
    const closeAddModal = vi.fn();
    const { rerender } = renderHook((props) => useDashboardKeyboard(props), { initialProps: baseOptions() });
    act(() => rerender(baseOptions({ showAddModal: true, closeAddModal })));
    escape();
    expect(closeAddModal).toHaveBeenCalledTimes(1);
  });
});
