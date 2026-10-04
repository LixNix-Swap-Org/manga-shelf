import { useEffect, useId, useRef, useState } from 'react';
import { Languages } from 'lucide-react';
import { LANGUAGES, deviceLanguage, getLanguage, getStoredLanguage, isAvailable, t } from '../../i18n/index.js';
import { useLanguage } from '../../i18n/react.jsx';
import { chooseLanguage, markFocusLanguage, takeFocusLanguage, takeReopenAccount } from '../../i18n/preference.js';

const nameOf = (code) => LANGUAGES.find((l) => l.code === code)?.name || code;

// arrow keys on a closed select fire change at once (Chromium on Windows/Linux): wait until the user stops stepping
export const KEYBOARD_COMMIT_MS = 400;
// i18n-ignore: key names
const STEP_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

// UI language: native select with every language in its own name plus "follow the device". `beforeChange(code)` runs only when
// the choice really switches the language (the account dialog marks itself for reopening; the switch remounts the page).
// Focus returns to the select after that remount.
export default function LanguageSelect({ className = '', beforeChange, showLabel = true }) {
  useLanguage();
  const id = useId();
  const selectRef = useRef(null);
  const keyboard = useRef(false);
  const timer = useRef(null);
  const refocus = useRef(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [failed, setFailed] = useState(false);
  const value = draft ?? (getStoredLanguage() || '');

  useEffect(() => {
    if (takeFocusLanguage()) selectRef.current?.focus();
    return () => clearTimeout(timer.current);
  }, []);

  // disabling the focused select drops its focus: give it back when nothing remounted
  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    selectRef.current?.focus();
  }, [busy]);

  const apply = async (code, { keepFocus = true } = {}) => {
    clearTimeout(timer.current);
    timer.current = null;
    refocus.current = keepFocus && document.activeElement === selectRef.current;
    const before = getLanguage();
    const next = code && isAvailable(code) ? code : deviceLanguage();
    const switching = next !== before;
    setBusy(true);
    setFailed(false);
    try {
      if (switching) {
        beforeChange?.(code);
        if (keepFocus) markFocusLanguage();
      }
      await chooseLanguage(code);
    } finally {
      // no remount happened (same language, or the catalog did not load): the marks must not fire later
      if (switching && getLanguage() === before) {
        takeReopenAccount();
        takeFocusLanguage();
        setFailed(true);
      }
      setDraft(null);
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (STEP_KEYS.has(e.key) || e.key.length === 1) keyboard.current = true;
    if (e.key === 'Enter' && timer.current) {
      e.preventDefault();
      apply(e.currentTarget.value);
    }
  };

  const onChange = (e) => {
    const code = e.target.value;
    if (!keyboard.current) {
      apply(code);
      return;
    }
    keyboard.current = false;
    setDraft(code);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => apply(code), KEYBOARD_COMMIT_MS);
  };

  // leaving the select commits a stepped choice; focus stays where the user moved it
  const onBlur = (e) => {
    keyboard.current = false;
    if (timer.current) apply(e.currentTarget.value, { keepFocus: false });
  };

  return (
    <div className={`flex items-center gap-2 text-xs text-slate-300 ${failed ? 'flex-wrap' : ''} ${className}`}>
      <Languages className="w-4 h-4 text-slate-400 shrink-0" aria-hidden="true" />
      <label htmlFor={id} className={showLabel ? 'font-semibold' : 'sr-only'}>{t('Sprache')}</label>
      <select
        ref={selectRef}
        id={id}
        className="input-field py-1 text-sm w-auto"
        value={value}
        disabled={busy}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
        onMouseDown={() => { keyboard.current = false; }}
        onChange={onChange}
        onBlur={onBlur}
      >
        <option value="">{t('Gerätesprache ({name})', { name: nameOf(deviceLanguage()) })}</option>
        {LANGUAGES.map((l) => (
          // i18n-ignore: every language in its own name
          <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>
        ))}
      </select>
      {failed && <p role="alert" className="basis-full text-amber-300">{t('Sprache offline nicht verfügbar')}</p>}
    </div>
  );
}
