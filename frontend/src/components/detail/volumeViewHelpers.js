import { inferVolumeType, getEditionLabel, getSpecialEditionNumber, getVolumeDisplayTitle } from '../../utils/volumeHelpers';
import { formatEuro, formatDate } from '../../utils/format';

export { formatEuro };

const EDITION_NAME_WORDS = /collector'?s?\s*edition|limited\s*edition|limitierte?\s*edition|special\s*edition|spezial\s*edition|sonderausgabe|premium\s*edition|deluxe(\s*edition)?|variant(\s*cover)?/gi;

/**
 * Badge for card, spine and list. `type` is always inferVolumeType(vol), so badges agree with chips and counts.
 * Returns { type, label, short, text }.
 */
export function getVolumeBadge(vol) {
  const type = inferVolumeType(vol);
  const raw = String(vol.volume_number ?? '').trim();
  if (type === 'schuber') {
    return { type, label: 'Schuber', short: 'Schuber', text: raw.replace(/^schuber\s*/i, '') };
  }
  if (type === 'special_edition') {
    const { label, short } = getEditionLabel(vol);
    const num = getSpecialEditionNumber(vol);
    return { type, label, short, text: num ? `Band ${num}` : raw.replace(EDITION_NAME_WORDS, '').replace(/\s+/g, ' ').trim() };
  }
  if (type === 'special') {
    return { type, label: 'Special', short: 'EXTRA', text: raw.replace(/special\s*|extra\s*|sonderband\s*/gi, '').trim() };
  }
  return { type: 'volume', label: 'Einzelband', short: '', text: getVolumeDisplayTitle(vol) };
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

const STATUS_SPOKEN = { preordered: 'vorbestellt', ordered: 'bestellt', upcoming: 'erscheint bald', missing: 'fehlt' };

/** Accessible name of a spine: title, then the status unless owned, then "gelesen" when the checkmark is drawn. */
export function getSpineAriaLabel(vol, isRead) {
  const kind = volumeStatusKind(vol.status);
  const parts = [getVolumeDisplayTitle(vol)];
  if (kind !== 'owned') parts.push(STATUS_SPOKEN[kind]);
  else if (isRead) parts.push('gelesen');
  return parts.join(', ');
}

/** Counts toward a person's "owned / total": preorders, orders and announced volumes are not on the shelf yet. */
export const isCollectibleVolume = (vol) => !['Vorbestellt', 'Bestellt', 'Erscheint bald'].includes(vol.status);

/** '2026-11-12' -> '12.11.2026', '2026-11' -> '11/2026'; anything else is returned unchanged, null as ''. */
export const formatShortDate = (value) => formatDate(value);

const localIsoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 'erschienen' or 'erscheint' for a (possibly month-only) release date; is_released from Manga Passion wins. */
export function releaseVerb(dateStr, isReleased, today = new Date()) {
  if (typeof isReleased === 'boolean') return isReleased ? 'erschienen' : 'erscheint';
  const s = String(dateStr ?? '').trim();
  const ref = localIsoDate(today).slice(0, s.length);
  return s && s < ref ? 'erschienen' : 'erscheint';
}

/** Caption of a gap: official only for a confirmed Manga Passion edition, estimated for the local fallback. */
export function gapLabel(gapsOfficial) {
  if (gapsOfficial === true) return 'Offizielle Lücke in Reihe';
  if (gapsOfficial === false) return 'Lücke (geschätzt)';
  return 'Lücke in Reihe';
}

/** Real volumes and ghost gaps among the shelf items (the header counts volumes, layout keeps counting both). */
export function countShelfItems(items) {
  const gaps = items.filter(i => i.isGap).length;
  return { volumes: items.length - gaps, gaps };
}

/** Short state of the Manga Passion check for the pill: edition publisher, loading, error/outage or no edition. */
export function mpPillText({ mpGapData, mpGapLoading, mpGapError }) {
  if (mpGapData?.edition) return mpGapData.edition.publisher;
  if (mpGapLoading) return 'Prüfe...';
  if (mpGapError || mpGapData?.unavailable) return 'Nicht erreichbar';
  if (mpGapData?.matched === false) return 'Keine Edition';
  return 'Abgleich';
}
