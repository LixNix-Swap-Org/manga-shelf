import { Users } from 'lucide-react';

const OWNER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#2dd4bf', '#facc15', '#f87171'];

/** Feste Farbe je Benutzer, damit Marken und Filter dieselbe Person gleich zeigen. */
export function ownerColor(userId) {
  const n = Math.abs(parseInt(userId, 10) || 0);
  return OWNER_COLORS[n % OWNER_COLORS.length];
}

/** Besitzer eines Bandes als farbige Marken mit zwei Buchstaben; ab zwei Besitzern zusätzlich „2×“. Nichts, wenn es nur eine Person gibt. */
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
          {String(o.username).slice(0, 2).toLowerCase()}
        </span>
      ))}
    </span>
  );
}
