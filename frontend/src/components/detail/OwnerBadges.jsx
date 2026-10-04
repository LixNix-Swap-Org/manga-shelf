import { Users } from 'lucide-react';

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

/** Owners of a volume as coloured badges with the initials of the reader avatars; from two owners also "2×". Nothing when there is only one person. */
export default function OwnerBadges({ vol, multiUser }) {
  const owners = vol?.owners || [];
  if (!multiUser || owners.length === 0) return null;
  const names = owners.map(o => o.username).join(', ');
  return (
    <span role="img" aria-label={`Besitzer: ${names}`} className="inline-flex items-center gap-1 shrink-0" title={`Besitzer: ${names}`}>
      {owners.length > 1 && (
        <span aria-hidden="true" className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1">
          <Users className="w-2.5 h-2.5" /> {owners.length}×
        </span>
      )}
      {owners.map(o => (
        <span
          key={o.user_id}
          aria-hidden="true"
          className="px-1 h-4 min-w-4 rounded-full text-[9px] font-bold flex items-center justify-center text-slate-950"
          style={{ background: ownerColor(o.user_id) }}
        >
          {readerInitials(o.username)}
        </span>
      ))}
    </span>
  );
}
