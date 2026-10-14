import { useSyncExternalStore } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { t } from '../../i18n/index.js';

// One confirmation at a time, shared by every caller. Without a mounted <ConfirmHost /> (tests, early boot)
// askConfirm falls back to window.confirm, so a caller never hangs.
let current = null;
let hostCount = 0;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

function settle(value) {
  const pending = current;
  current = null;
  emit();
  pending?.resolve(value);
}

/**
 * Awaitable replacement for window.confirm(): `if (!(await askConfirm(text))) return;`
 * Native dialogs are suppressed in embedded browsers, which made destructive buttons look dead.
 * `text` is the finished (already translated) message; options: title, confirmLabel, danger.
 */
export function askConfirm(text, { title, confirmLabel, danger = true } = {}) {
  if (hostCount === 0) return Promise.resolve(window.confirm(text));
  if (current) settle(false);
  return new Promise((resolve) => {
    current = { text, title, confirmLabel, danger, resolve };
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
