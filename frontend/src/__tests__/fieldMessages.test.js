// Form fields report their errors in the app language: one document listener replaces the browser's own messages.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { fieldMessage, installFieldMessages } from '../utils/fieldMessages';
import { setLanguage } from '../i18n/index.js';

let remove = () => {};
beforeEach(() => { remove = installFieldMessages(document); });
afterEach(async () => {
  remove();
  document.body.innerHTML = '';
  await setLanguage('de');
});

const field = (html) => {
  document.body.innerHTML = `<form>${html}</form>`;
  return document.querySelector('input, select, textarea');
};

describe('fieldMessages', () => {
  it('names the problem of a field in German', () => {
    const cases = [
      ['<input required>', '', 'Bitte fülle dieses Feld aus.'],
      ['<input type="number" min="1" max="200">', '0', 'Der Wert muss mindestens 1 sein.'],
      ['<input type="number" min="0" max="200">', '201', 'Der Wert darf höchstens 200 sein.'],
      ['<input type="number" min="0" max="7.5" step="any">', '9', 'Der Wert darf höchstens 7,5 sein.'],
      ['<input type="number" step="1">', '2.5', 'Bitte gib eine ganze Zahl ein.'],
      ['<input type="url">', 'kein link', 'Bitte gib eine gültige Adresse ein (beginnt mit https://).'],
      ['<input maxlength="3">', '', ''],
      ['<input pattern="\\d{4}" title="Vier Ziffern">', 'abc', 'Vier Ziffern']
    ];
    for (const [html, value, expected] of cases) {
      const el = field(html);
      el.value = value;
      expect(fieldMessage(el), html).toBe(expected);
    }
  });

  it('sets the message on an invalid submit and clears it on the next input', () => {
    const el = field('<input type="number" min="0" max="200">');
    el.value = '201';
    expect(document.querySelector('form').checkValidity()).toBe(false);
    expect(el.validationMessage).toBe('Der Wert darf höchstens 200 sein.');
    el.value = '150';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    expect(el.validationMessage).toBe('');
    expect(document.querySelector('form').checkValidity()).toBe(true);
  });

  it('follows the UI language', async () => {
    await setLanguage('en');
    const el = field('<input type="number" min="0" max="200">');
    el.value = '201';
    document.querySelector('form').checkValidity();
    expect(el.validationMessage).toBe('The value must be at most 200.');
  });
});
