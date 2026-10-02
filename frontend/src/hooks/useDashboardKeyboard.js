import { useEffect } from 'react';

/** '/' focuses the search, Escape closes the topmost dialog / menu or clears the search. */
export default function useDashboardKeyboard({
  showAddModal, setShowAddModal, showStatsModal, setShowStatsModal, showUsersModal, setShowUsersModal,
  showRestoreModal, setShowRestoreModal, mobileMenuOpen, setMobileMenuOpen, search, setSearch, searchInputRef
}) {
  // Keyboard shortcuts: '/' to focus search, 'Escape' to close open modals or blur/clear
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showAddModal) {
          setShowAddModal(false);
          return;
        }
        if (showStatsModal) {
          setShowStatsModal(false);
          return;
        }
        if (showUsersModal) {
          setShowUsersModal(false);
          return;
        }
        if (showRestoreModal) {
          setShowRestoreModal(false);
          return;
        }
        if (mobileMenuOpen) {
          setMobileMenuOpen(false);
          return;
        }
        if (document.activeElement === searchInputRef.current) {
          setSearch('');
          searchInputRef.current?.blur();
        } else if (search) {
          setSearch('');
        }
      } else if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal, showStatsModal, showUsersModal, showRestoreModal, mobileMenuOpen, search]);
}
