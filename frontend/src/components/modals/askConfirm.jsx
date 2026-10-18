import { useEffect, useSyncExternalStore } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { t } from '../../i18n/index.js';

// One confirmation at a time, shared by every caller. Without a mounted <ConfirmHost /> (tests, early boot)
// askConfirm falls back to window.confirm, so a caller never hangs.
let current = null;
let hostCount = 0;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
const pagePath = () => (typeof window === 'undefined' ? '' : window.location.pathname);

// a yes counts only on the page that asked: after a navigation the question belongs to a page that is gone
function settle(value) {
  const pending = current;
  current = null;
  emit();
  pending?.resolve(Boolean(value) && pending.path === pagePath());
}

/**
 * Awaitable replacement for window.confirm(): `if (!(await askConfirm(text))) return;`
 * Native dialogs are suppressed in embedded browsers, which made destructive buttons look dead.
 * `text` is the finished (already translated) message; options: title, confirmLabel, danger.
 * A question asked while another confirmation is open answers false at once; Back (the dialog's history entry) and a
 * navigation answer false too.
 */
export function askConfirm(text, { title, confirmLabel, danger = true } = {}) {
  if (hostCount === 0) return Promise.resolve(window.confirm(text));
  if (current) return Promise.resolve(false);
  return new Promise((resolve) => {
    current = { text, title, confirmLabel, danger, resolve, path: pagePath() };
    emit();
  });
}

const subscribe = (listener) => {
  listeners.add(listener);
  hostCount += 1;
  return () => {
    listeners.delete(listener);
    hostCount -= 1;
  };
};
const snapshot = () => current;

export default function ConfirmHost() {
  const pending = useSyncExternalStore(subscribe, snapshot, snapshot);

  // the host sits outside the router: leaving the page (Back to another page, or a pushed route where the browser
  // reports it through the Navigation API) answers the open question with no
  useEffect(() => {
    if (!pending || typeof window === 'undefined') return undefined;
    const leftPage = () => { if (current === pending && pending.path !== pagePath()) settle(false); };
    const navigation = window.navigation;
    window.addEventListener('popstate', leftPage);
    navigation?.addEventListener?.('navigatesuccess', leftPage);
    return () => {
      window.removeEventListener('popstate', leftPage);
      navigation?.removeEventListener?.('navigatesuccess', leftPage);
    };
  }, [pending]);

  return (
    <ConfirmDialog
      isOpen={pending !== null}
      title={pending?.title || t('Bestätigen')}
      message={pending?.text}
      confirmLabel={pending?.confirmLabel || (pending?.danger ? t('Löschen') : t('Bestätigen'))}
      cancelLabel={t('Abbrechen')}
      isDanger={pending?.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
