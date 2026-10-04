import { compareVolumesByNumber } from '../../utils/volumeHelpers.js';
import { formatNumber, formatEuro, formatCount, formatPercent, formatMonth, formatDateTime } from '../../utils/format.js';

const toNumber = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

export const fmtNumber = (n, digits = 0) => formatNumber(toNumber(n), digits);
export const fmtEuro = (n) => formatEuro(toNumber(n));
export const fmtPct = (n) => formatPercent(toNumber(n), 1);
/** "1 Band" / "1.234 Bände". */
export const countLabel = (n, singular, plural) => formatCount(toNumber(n), singular, plural);
/** Width for a CSS percentage: a plain number with a dot decimal, clamped to 0..100. */
export const cssPct = (n) => Math.min(100, Math.max(0, toNumber(n)));

/** 'YYYY-MM' -> 'Mär'. */
export const monthShort = (key) => formatMonth(String(key), { style: 'short', year: false });
/** 'YYYY-MM' -> 'Mär 2026'. */
export const monthLabel = (key) => formatMonth(String(key), { style: 'short' });

/** SQLite 'YYYY-MM-DD HH:MM:SS' is UTC without a zone; ISO strings are parsed as given. */
export const parseUtcTimestamp = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const fmtDateTime = (value) => {
  const d = parseUtcTimestamp(value);
  return d ? formatDateTime(d) : '–';
};

export const PUBLISHER_COLORS = [
  'bg-sky-500', 'bg-indigo-500', 'bg-emerald-500', 'bg-amber-500',
  'bg-rose-500', 'bg-purple-500', 'bg-teal-500', 'bg-orange-500'
];
export const OTHER_PUBLISHERS_COLOR = 'bg-slate-500';
export const publisherColor = (idx) => (idx < PUBLISHER_COLORS.length ? PUBLISHER_COLORS[idx] : OTHER_PUBLISHERS_COLOR);

/**
 * Segments of the stacked publisher bar: the first `topN` publishers plus one 'Sonstige' segment for the rest.
 * Widths come from the volume counts (the rounded percentages need not add up to 100).
 */
export function publisherSegments(list, topN = PUBLISHER_COLORS.length) {
  const pubs = Array.isArray(list) ? list : [];
  const total = pubs.reduce((sum, p) => sum + toNumber(p.volume_count), 0);
  const share = (volumes, fallbackPct) => (total > 0 ? (volumes / total) * 100 : cssPct(fallbackPct));
  const segments = pubs.slice(0, topN).map((p, idx) => ({
    key: p.publisher,
    label: p.publisher,
    volumes: toNumber(p.volume_count),
    width: share(toNumber(p.volume_count), p.percentage),
    color: publisherColor(idx)
  }));
  const rest = pubs.slice(topN);
  if (rest.length > 0) {
    const volumes = rest.reduce((sum, p) => sum + toNumber(p.volume_count), 0);
    const width = total > 0 ? share(volumes) : Math.max(0, 100 - segments.reduce((sum, s) => sum + s.width, 0));
    segments.push({ key: '__other__', label: `Sonstige (${countLabel(rest.length, 'Verlag', 'Verlage')})`, volumes, width, color: OTHER_PUBLISHERS_COLOR });
  }
  return segments;
}

/** Read volumes of one series in shelf order (regular, special editions, Schuber, specials). */
export const sortReadVolumes = (volumes) => [...(volumes || [])].sort((a, b) => compareVolumesByNumber(a, b));
