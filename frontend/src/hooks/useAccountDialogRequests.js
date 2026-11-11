// Opening the account dialog on a tab (split from Dashboard.jsx): the header buttons, the desktop menu "Quellen &
// Schlüssel…" (an in-page event while the shelf is mounted, else navigation state used once) and the reopen after a
// language switch remounted the page.
import { useEffect, useState } from 'react';
import { takeReopenAccount } from '../i18n/preference.js';

export const OPEN_ACCOUNT_EVENT = 'mangashelf:open-account';

export default function useAccountDialogRequests({ location, navigate }) {
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [accountTab, setAccountTab] = useState('general');
  const handleOpenPasswordModal = () => {
    setAccountTab('general');
    setShowPasswordModal(true);
  };

  const openApiKeys = () => {
    setAccountTab('services');
    setShowPasswordModal(true);
  };
  // App sends the desktop menu "Quellen & Schlüssel…" here: as an in-page event while the shelf is mounted (no history
  // write, open dialogs keep their entries), else as navigation state that is used once
  useEffect(() => {
    const onOpenAccount = (event) => {
      if (event.detail !== 'keys') return;
      event.preventDefault();
      setAccountTab('services');
      setShowPasswordModal(true);
    };
    window.addEventListener(OPEN_ACCOUNT_EVENT, onOpenAccount);
    return () => window.removeEventListener(OPEN_ACCOUNT_EVENT, onOpenAccount);
  }, []);
  // a language switch from the account dialog remounted the page: the dialog comes back on its language tab
  useEffect(() => {
    const tab = takeReopenAccount();
    if (!tab) return;
    setAccountTab(tab);
    setShowPasswordModal(true);
  }, []);
  const openAccount = location.state?.openAccount;
  useEffect(() => {
    if (openAccount !== 'keys') return;
    openApiKeys();
    navigate({ search: location.search }, { replace: true, state: null });
  }, [openAccount]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once per request

  return { showPasswordModal, setShowPasswordModal, accountTab, handleOpenPasswordModal, openApiKeys };
}
