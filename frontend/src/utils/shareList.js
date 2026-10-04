// The shopping list as plain text (share sheet, clipboard, einkaufsliste.txt) and grouped for the print sheet.
import { getVolumeDisplayTitle } from './volumeHelpers.js';
import { formatCount, formatDay, formatEuro, formatMoney } from './format.js';
import { editionCurrency } from './editions.js';
import { getOtherCurrencyTotals } from './collectionHelpers.js';
import { PRIORITY_WORDS } from './priority.js';
import { naturalCollator } from './search.js';
import { t } from '../i18n/index.js';

// i18n
const UNKNOWN = 'Unbekannt';

const publisherOf = (name, normalizePubName) => {
  const raw = String(name || '').trim() || UNKNOWN;
  return (normalizePubName ? normalizePubName(raw) : raw) || UNKNOWN;
};

/** A group's publisher as shown: the 'Unbekannt' fallback translated, real names as they are. */
export const publisherLabel = (name) => (name === UNKNOWN ? t(UNKNOWN) : name);

/** [{ publisher, items }] in alphabetical order ('Unbekannt' last); items keep the list's order. */
export function groupByPublisher(items, normalizePubName) {
  const groups = new Map();
  for (const item of items || []) {
    const name = publisherOf(item.effective_publisher, normalizePubName);
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { publisher: name, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => {
    if ((a.publisher === UNKNOWN) !== (b.publisher === UNKNOWN)) return a.publisher === UNKNOWN ? 1 : -1;
    return naturalCollator.compare(a.publisher, b.publisher);
  });
}

/** 'One Piece Band 108 – 7,50 € · Prio hoch · max. 6,00 € · ISBN 978…' (without the box); prices in the series currency. */
export function itemText(item) {
  const currency = editionCurrency(item);
  let line = `${item.manga_title || ''} ${getVolumeDisplayTitle(item)}`.trim();
  if (Number(item.price) > 0) line += ` – ${formatMoney(item.price, currency)}`;
  const extras = [];
  if (item.priority > 0 && PRIORITY_WORDS[item.priority]) extras.push(t('Prio {priority}', { priority: t(PRIORITY_WORDS[item.priority]) }));
  if (Number(item.target_price) > 0) extras.push(`max. ${formatMoney(item.target_price, currency)}`);
  if (item.isbn) extras.push(`ISBN ${item.isbn}`);
  return extras.length ? `${line} · ${extras.join(' · ')}` : line;
}

const wishedText = (s) => {
  const parts = [`${s.title}${s.publisher ? ` (${publisherLabel(s.publisher)})` : ''}`];
  if (s.wish_priority > 0 && PRIORITY_WORDS[s.wish_priority]) parts.push(t('Prio {priority}', { priority: t(PRIORITY_WORDS[s.wish_priority]) }));
  return parts.join(' · ');
};

const priceOf = (item) => (Number(item.price) > 0 ? Number(item.price) : 0);

/** Euro sum of the priced items (other currencies are never added in, as in the server totals). */
export const euroTotalOf = (items) => (items || []).reduce((sum, item) => sum + (editionCurrency(item) === 'EUR' ? priceOf(item) : 0), 0);

/**
 * '3 Bände · ca. 14,50 € + 96,00 $ · 25 ¥': the euro sum with the other currencies apart, never converted. Without
 * euro prices the other currencies stand alone; `always` shows '0,00 €' for a list without prices (print sheet).
 */
export function summaryText(items, { always = false } = {}) {
  const list = items || [];
  const total = euroTotalOf(list);
  const others = getOtherCurrencyTotals(list, priceOf).map((o) => formatMoney(o.value, o.currency)).join(' · ');
  let price = '';
  if (total > 0 || (always && list.length && !others)) price = others ? `${formatEuro(total)} + ${others}` : formatEuro(total);
  else if (others) price = others;
  return `${formatCount(list.length, 'Band', 'Bände')}${price ? t(' · ca. {price}', { price }) : ''}`;
}

/**
 * Plain text of what the list shows right now: volumes grouped by publisher with a box to tick, then the wished
 * series. `filtered` adds a note that search or publisher filter hide part of the list.
 */
export function buildShareText({ items = [], wished = [], normalizePubName, filtered = false, date = new Date() } = {}) {
  const day = formatDay(date);
  const lines = [filtered ? t('Einkaufsliste – Manga Shelf ({date}), gefiltert', { date: day }) : t('Einkaufsliste – Manga Shelf ({date})', { date: day })];
  lines.push(summaryText(items));
  for (const group of groupByPublisher(items, normalizePubName)) {
    lines.push('', publisherLabel(group.publisher));
    for (const item of group.items) lines.push(`☐ ${itemText(item)}`);
  }
  if (wished.length) {
    lines.push('', t('Gewünschte Reihen'));
    for (const s of wished) lines.push(`♡ ${wishedText(s)}`);
  }
  return lines.join('\n');
}

const isAbort = (err) => err?.name === 'AbortError';

function downloadText(text, filename, doc) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** True when this device has a share sheet for text (secure context, navigator.share). */
export const canShareText = (nav = globalThis.navigator) => Boolean(nav && typeof nav.share === 'function');

/**
 * Hands the text on: `share` tries the share sheet first; then the clipboard, then a download of einkaufsliste.txt.
 * Resolves to 'shared' | 'copied' | 'downloaded' | 'cancelled' (share sheet closed by the user).
 */
export async function shareText(text, { title = t('Einkaufsliste'), share = true, nav = globalThis.navigator, doc = globalThis.document } = {}) {
  if (share && canShareText(nav) && (typeof nav.canShare !== 'function' || nav.canShare({ title, text }))) {
    try {
      await nav.share({ title, text });
      return 'shared';
    } catch (err) {
      if (isAbort(err)) return 'cancelled';
    }
  }
  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text);
      return 'copied';
    } catch (_) { /* denied or no secure context: download instead */ }
  }
  downloadText(text, 'einkaufsliste.txt', doc);
  return 'downloaded';
}
