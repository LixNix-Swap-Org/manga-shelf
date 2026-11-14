import { Handshake, Users } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { formatNumber } from '../../utils/format';

const OWNER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#2dd4bf', '#facc15', '#f87171'];

/** Fixed colour per user, so badges and filters show the same person alike. */
export function ownerColor(userId) {
  const n = Math.abs(parseInt(userId, 10) || 0);
  return OWNER_COLORS[n % OWNER_COLORS.length];
}

/** Two letters for a reader avatar: the initials of two words, else the first two letters ("admin" -> "Ad"). */
export function readerInitials(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length > 1) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  const word = words[0];
  return word.charAt(0).toUpperCase() + word.charAt(1).toLowerCase();
}

/** How many copies each owner has of the volume: Map user id -> count (at least 1 per owner). */
export function copiesPerOwner(vol) {
  const counts = new Map();
  for (const c of vol?.copies || []) {
    const id = String(c.owner_user_id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * Owners of a volume: the people icon and one coloured circle with initials per owner, in an amber pill like the
 * "Besitz" side of the reader/owner chip. A small number on a circle says that person has more than one copy.
 * Nothing with only one person on the shelf.
 */
export default function OwnerBadges({ vol, multiUser }) {
  const owners = vol?.owners || [];
  if (!multiUser || owners.length === 0) return null;
  const copies = copiesPerOwner(vol);
  const copiesOf = (o) => Math.max(1, copies.get(String(o.user_id)) || 0);
  const names = owners.map(o => (copiesOf(o) > 1 ? `${o.username} ×${formatNumber(copiesOf(o))}` : o.username)).join(', ');
  return (
    <span
      role="img"
      aria-label={t('Besitzer: {names}', { names })}
      title={t('Besitzer: {names}', { names })}
      data-owner-badges
      className="inline-flex items-center gap-1 shrink-0 rounded-full pl-1 pr-1.5 py-0.5 bg-amber-500/15 border border-amber-500/40 text-amber-300"
    >
      <Users className="w-2.5 h-2.5" aria-hidden="true" />
      {owners.map(o => {
        const n = copiesOf(o);
        return (
          <span
            key={o.user_id}
            aria-hidden="true"
            className={`relative px-1 h-4 min-w-4 ${n > 1 ? 'mr-1.5' : ''} rounded-full text-[9px] font-bold flex items-center justify-center text-slate-950`}
            style={{ background: ownerColor(o.user_id) }}
          >
            {readerInitials(o.username)}
            {n > 1 && (
              <span data-copy-count className="absolute -top-1.5 -right-2 min-w-3 h-3 px-0.5 rounded-full bg-slate-900 border border-amber-400 text-amber-300 text-[8px] leading-none flex items-center justify-center">
                {formatNumber(n)}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/** "Verliehen" when a copy of the volume is lent out; the title names who has it. */
export function LentBadge({ vol, className = '' }) {
  const lent = (vol?.copies || []).filter(c => c.lent_to);
  if (lent.length === 0) return null;
  const names = lent.map(c => c.lent_to).join(', ');
  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-violet-500/20 text-violet-200 border border-violet-500/40 ${className}`}
      title={t('Ausgeliehen an: {names}', { names })}
      data-lent
    >
      <Handshake className="w-2.5 h-2.5" aria-hidden="true" />
      <span>{t('Verliehen')}</span>
      <span className="sr-only">{t('Ausgeliehen an: {names}', { names })}</span>
    </span>
  );
}
