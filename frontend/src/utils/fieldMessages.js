// The browser's own messages of form fields ("Der Wert muss kleiner als oder gleich 200 sein") follow the browser
// language, not the app language. One listener per document replaces them with translated texts by the kind of error;
// the next input clears ours again, so a corrected value is never held back by an old message.
import { formatNumber } from './format';
import { t, tn } from '../i18n/index.js';

const MARK = 'fieldMessage';
const NUMERIC = new Set(['number', 'range']);

const limit = (el, value) => (NUMERIC.has(el.type) && value !== '' && Number.isFinite(Number(value)) ? formatNumber(Number(value), 2) : value);

/** The translated text for the first problem of a field's validity, or '' when there is none we know. */
export function fieldMessage(el) {
  const v = el.validity;
  if (!v) return '';
  if (v.valueMissing) return el.type === 'checkbox' ? t('Bitte bestätige dieses Feld.') : t('Bitte fülle dieses Feld aus.');
  if (v.badInput) return NUMERIC.has(el.type) ? t('Bitte gib eine Zahl ein.') : t('Bitte gib einen gültigen Wert ein.');
  if (v.rangeUnderflow) return t('Der Wert muss mindestens {min} sein.', { min: limit(el, el.min) });
  if (v.rangeOverflow) return t('Der Wert darf höchstens {max} sein.', { max: limit(el, el.max) });
  if (v.stepMismatch) return el.step === '1' || el.step === '' ? t('Bitte gib eine ganze Zahl ein.') : t('Bitte gib einen passenden Wert ein.');
  if (v.typeMismatch) {
    if (el.type === 'url') return t('Bitte gib eine gültige Adresse ein (beginnt mit https://).');
    if (el.type === 'email') return t('Bitte gib eine gültige E-Mail-Adresse ein.');
    return t('Bitte gib einen gültigen Wert ein.');
  }
  if (v.tooShort) return tn('Bitte mindestens {n} Zeichen eingeben.', 'Bitte mindestens {n} Zeichen eingeben.', Number(el.minLength));
  if (v.tooLong) return tn('Bitte höchstens {n} Zeichen eingeben.', 'Bitte höchstens {n} Zeichen eingeben.', Number(el.maxLength));
  // a pattern names what it wants in the field's title, as the browser shows it
  if (v.patternMismatch) return el.title || t('Bitte halte dich an das verlangte Format.');
  return '';
}

function onInvalid(e) {
  const el = e.target;
  if (!el || typeof el.setCustomValidity !== 'function') return;
  // only our own message is replaced: the field's state decides, never a text from before
  if (el.dataset?.[MARK]) el.setCustomValidity('');
  const text = fieldMessage(el);
  if (!text) return;
  el.setCustomValidity(text);
  if (el.dataset) el.dataset[MARK] = '1';
}

function onEdit(e) {
  const el = e.target;
  if (!el?.dataset?.[MARK] || typeof el.setCustomValidity !== 'function') return;
  el.setCustomValidity('');
  delete el.dataset[MARK];
}

/** Installs the listeners once per document; returns the function that removes them (tests). */
export function installFieldMessages(doc = document) {
  if (!doc || doc.__fieldMessages) return () => {};
  doc.addEventListener('invalid', onInvalid, true);
  doc.addEventListener('input', onEdit, true);
  doc.addEventListener('change', onEdit, true);
  doc.__fieldMessages = true;
  return () => {
    doc.removeEventListener('invalid', onInvalid, true);
    doc.removeEventListener('input', onEdit, true);
    doc.removeEventListener('change', onEdit, true);
    delete doc.__fieldMessages;
  };
}
