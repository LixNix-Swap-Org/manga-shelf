import { useEffect, useLayoutEffect, useRef } from 'react';

const OPEN_DIALOG = '[role="dialog"][aria-modal="true"]';

const isEditable = (el) => Boolean(el) && (
  el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
);

/**
 * '/' focuses the search, Escape closes the open dialog / menu or clears the search. A dialog with data-busy="true"
 * is not closed, a handled Escape (preventDefault) is ignored; while a dialog is open '/' does nothing.
 */
export default function useDashboardKeyboard(options) {
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });

  useEffect(() => {
    // State as it was when the key went down: the dialog's own handler may close it before the event reaches window.
    let snapshot = null;
    const takeSnapshot = (e) => {
      const dialog = document.querySelector(OPEN_DIALOG);
      return {
        event: e,
        opts: latest.current,
        dialogOpen: Boolean(dialog),
        busy: Boolean(document.querySelector(`${OPEN_DIALOG}[data-busy="true"]`))
      };
    };
    const onKeyDownCapture = (e) => { snapshot = takeSnapshot(e); };

    const onKeyDown = (e) => {
      const snap = snapshot && snapshot.event === e ? snapshot : takeSnapshot(e);
      snapshot = null;
      if (e.defaultPrevented) return;
      const { opts, dialogOpen, busy } = snap;
      const modals = [
        [opts.showAddModal, opts.closeAddModal || (() => opts.setShowAddModal?.(false))],
        [opts.showStatsModal, opts.closeStatsModal || (() => opts.setShowStatsModal?.(false))],
        [opts.showUsersModal, opts.closeUsersModal || (() => opts.setShowUsersModal?.(false))],
        [opts.showRestoreModal, opts.closeRestoreModal || (() => opts.setShowRestoreModal?.(false))],
        [opts.showPasswordModal, opts.closePasswordModal || (() => opts.setShowPasswordModal?.(false))]
      ];
      const openModal = modals.find(([shown]) => shown);

      if (e.key === 'Escape') {
        if (openModal || dialogOpen) {
          if (!busy && openModal) openModal[1]();
          return;
        }
        if (opts.mobileMenuOpen) {
          opts.setMobileMenuOpen(false);
          return;
        }
        const input = opts.searchInputRef?.current;
        if (input && document.activeElement === input) {
          opts.setSearch('');
          input.blur();
        } else if (opts.search) {
          opts.setSearch('');
        }
        return;
      }

      if (e.key === '/') {
        if (openModal || dialogOpen || e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target instanceof Element ? e.target : null;
        if (isEditable(document.activeElement) || isEditable(target)) return;
        if (target?.closest(OPEN_DIALOG) || document.activeElement?.closest?.(OPEN_DIALOG)) return;
        e.preventDefault();
        opts.searchInputRef?.current?.focus();
      }
    };

    window.addEventListener('keydown', onKeyDownCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
