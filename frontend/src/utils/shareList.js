// The shopping list as plain text (share sheet, clipboard, einkaufsliste.txt) and grouped for the print sheet.
import { getVolumeDisplayTitle } from './volumeHelpers.js';
import { formatCount, formatDay, formatEuro } from './format.js';
import { PRIORITY_WORDS } from './priority.js';
import { naturalCollator } from './search.js';

const UNKNOWN = 'Unbekannt';

const publisherOf = (name, normalizePubName) => {
  const raw = String(name || '').trim() || UNKNOWN;
  return (normalizePubName ? normalizePubName(raw) : raw) || UNKNOWN;
};

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

/** 'One Piece Band 108 – 7,50 € · Prio hoch · max. 6,00 € · ISBN 978…' (without the box). */
export function itemText(item) {
  let line = `${item.manga_title || ''} ${getVolumeDisplayTitle(item)}`.trim();
  if (Number(item.price) > 0) line += ` – ${formatEuro(item.price)}`;
  const extras = [];
  if (item.priority > 0 && PRIORITY_WORDS[item.priority]) extras.push(`Prio ${PRIORITY_WORDS[item.priority]}`);
  if (Number(item.target_price) > 0) extras.push(`max. ${formatEuro(item.target_price)}`);
  if (item.isbn) extras.push(`ISBN ${item.isbn}`);
  return extras.length ? `${line} · ${extras.join(' · ')}` : line;
}

const wishedText = (s) => {
  const parts = [`${s.title}${s.publisher ? ` (${s.publisher})` : ''}`];
  if (s.wish_priority > 0 && PRIORITY_WORDS[s.wish_priority]) parts.push(`Prio ${PRIORITY_WORDS[s.wish_priority]}`);
  return parts.join(' · ');
};

const totalOf = (items) => (items || []).reduce((sum, item) => sum + (Number(item.price) > 0 ? Number(item.price) : 0), 0);

/**
 * Plain text of what the list shows right now: volumes grouped by publisher with a box to tick, then the wished
 * series. `filtered` adds a note that search or publisher filter hide part of the list.
 */
export function buildShareText({ items = [], wished = [], normalizePubName, filtered = false, date = new Date() } = {}) {
  const lines = [`Einkaufsliste – Manga Shelf (${formatDay(date)})${filtered ? ', gefiltert' : ''}`];
  const total = totalOf(items);
  lines.push(`${formatCount(items.length, 'Band', 'Bände')}${total > 0 ? ` · ca. ${formatEuro(total)}` : ''}`);
  for (const group of groupByPublisher(items, normalizePubName)) {
    lines.push('', group.publisher);
    for (const item of group.items) lines.push(`☐ ${itemText(item)}`);
  }
  if (wished.length) {
    lines.push('', 'Gewünschte Reihen');
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
export async function shareText(text, { title = 'Einkaufsliste', share = true, nav = globalThis.navigator, doc = globalThis.document } = {}) {
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
