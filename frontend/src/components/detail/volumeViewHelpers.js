import { inferVolumeType, getEditionLabel, getSpecialEditionNumber, getVolumeDisplayTitle } from '../../utils/volumeHelpers';
import { formatEuro, formatDate } from '../../utils/format';
import { t } from '../../i18n/index.js';

export { formatEuro };

const EDITION_NAME_WORDS = /collector'?s?\s*edition|limited\s*edition|limitierte?\s*edition|special\s*edition|spezial\s*edition|sonderausgabe|premium\s*edition|deluxe(\s*edition)?|variant(\s*cover)?/gi;

/**
 * Badge for card, spine and list. `type` is always inferVolumeType(vol), so badges agree with chips and counts.
 * Returns { type, label, short, text } plus, for a special edition, `number` (the volume number the spine shows).
 */
export function getVolumeBadge(vol) {
  const type = inferVolumeType(vol);
  const raw = String(vol.volume_number ?? '').trim();
  if (type === 'schuber') {
    return { type, label: t('Schuber'), short: t('Schuber'), text: raw.replace(/^schuber\s*/i, '') };
  }
  if (type === 'special_edition') {
    const { label, short } = getEditionLabel(vol);
    const num = getSpecialEditionNumber(vol);
    const rest = raw.replace(EDITION_NAME_WORDS, '').replace(/\s+/g, ' ').trim();
    // the number comes from the data, never from parsing the (translated) badge text
    const number = num ? String(num) : rest.match(/^Band (.+)$/)?.[1] || '';
    return { type, label, short, number, text: num ? t('Band {num}', { num }) : rest };
  }
  if (type === 'special') {
    return { type, label: t('Special'), short: 'EXTRA', text: raw.replace(/special\s*|extra\s*|sonderband\s*/gi, '').trim() };
  }
  return { type: 'volume', label: t('Einzelband'), short: '', text: getVolumeDisplayTitle(vol) };
}

/** 'owned' | 'preordered' | 'ordered' | 'upcoming' | 'missing' */
export function volumeStatusKind(status) {
  switch (status) {
    case 'Vorhanden': return 'owned';
    case 'Vorbestellt': return 'preordered';
    case 'Bestellt': return 'ordered';
    case 'Erscheint bald': return 'upcoming';
    default: return 'missing';
  }
}

// i18n
const STATUS_SPOKEN = { preordered: 'vorbestellt', ordered: 'bestellt', upcoming: 'erscheint bald', missing: 'fehlt' };

/** Accessible name of a spine: title, then the status unless owned, then "gelesen" when the checkmark is drawn. */
export function getSpineAriaLabel(vol, isRead) {
  const kind = volumeStatusKind(vol.status);
  const parts = [getVolumeDisplayTitle(vol)];
  if (kind !== 'owned') parts.push(t(STATUS_SPOKEN[kind]));
  else if (isRead) parts.push(t('gelesen'));
  return parts.join(', ');
}

/** Counts toward a person's "owned / total": preorders, orders and announced volumes are not on the shelf yet. */
export const isCollectibleVolume = (vol) => !['Vorbestellt', 'Bestellt', 'Erscheint bald'].includes(vol.status);

/** '2026-11-12' -> '12.11.2026', '2026-11' -> '11/2026'; anything else is returned unchanged, null as ''. */
export const formatShortDate = (value) => formatDate(value);

const localIsoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 'erschienen' or 'erscheint' for a (possibly month-only) release date; is_released from Manga Passion wins. */
export function releaseVerb(dateStr, isReleased, today = new Date()) {
  if (typeof isReleased === 'boolean') return isReleased ? t('erschienen') : t('erscheint');
  const s = String(dateStr ?? '').trim();
  const ref = localIsoDate(today).slice(0, s.length);
  return s && s < ref ? t('erschienen') : t('erscheint');
}

/** Caption of a gap: official only for a confirmed Manga Passion edition, estimated for the local fallback. */
export function gapLabel(gapsOfficial) {
  if (gapsOfficial === true) return t('Offizielle Lücke in Reihe');
  if (gapsOfficial === false) return t('Lücke (geschätzt)');
  return t('Lücke in Reihe');
}

/** Real volumes and ghost gaps among the shelf items (the header counts volumes, layout keeps counting both). */
export function countShelfItems(items) {
  const gaps = items.filter(i => i.isGap).length;
  return { volumes: items.length - gaps, gaps };
}

/** Short state of the Manga Passion check for the pill: edition publisher, loading, error/outage or no edition. */
export function mpPillText({ mpGapData, mpGapLoading, mpGapError }) {
  if (mpGapData?.edition) return mpGapData.edition.publisher;
  if (mpGapLoading) return t('Prüfe...');
  if (mpGapError || mpGapData?.unavailable) return t('Nicht erreichbar');
  if (mpGapData?.matched === false) return t('Keine Edition');
  return t('Abgleich');
}
