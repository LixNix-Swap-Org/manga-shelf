// "Erklärtexte anzeigen" (Einstellungen → Allgemein, this device only): the short explaining sentences under the headings
// of the shopping list and the radar. On unless switched off; a change shows at once in every open view of this tab.
import { useSyncExternalStore } from 'react';

export const HELP_TEXTS_KEY = 'mangashelf_help_texts';
const EVENT = 'mangashelf:help-texts';

export function helpTextsOn() {
  try {
    return globalThis.localStorage?.getItem(HELP_TEXTS_KEY) !== '0';
  } catch (_) {
    return true;
  }
}

export function setHelpTexts(on) {
  try {
    if (on) globalThis.localStorage?.removeItem(HELP_TEXTS_KEY);
    else globalThis.localStorage?.setItem(HELP_TEXTS_KEY, '0');
  } catch (_) { /* storage unavailable: the switch stays as it was */ }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange) {
  const onStorage = (e) => { if (!e.key || e.key === HELP_TEXTS_KEY) onChange(); };
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** True while the explaining sentences show on this device. */
export const useHelpTexts = () => useSyncExternalStore(subscribe, helpTextsOn, () => true);
