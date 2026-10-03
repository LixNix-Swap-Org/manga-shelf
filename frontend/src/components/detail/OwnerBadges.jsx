import { Users } from 'lucide-react';

/** Besitzer eines Bandes als Initialen-Marken; ab zwei Besitzern zusätzlich „2×“. Nichts, wenn es nur eine Person gibt. */
export default function OwnerBadges({ vol, multiUser }) {
  const owners = vol?.owners || [];
  if (!multiUser || owners.length === 0) return null;
  const names = owners.map(o => o.username).join(', ');
  return (
    <span className="inline-flex items-center gap-1 shrink-0" title={`Besitzer: ${names}`}>
      {owners.length > 1 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1">
          <Users className="w-2.5 h-2.5" /> {owners.length}×
        </span>
      )}
      {owners.map(o => (
        <span
          key={o.user_id}
          className="w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center border bg-slate-800 border-slate-600 text-slate-200"
        >
          {String(o.username).charAt(0).toUpperCase()}
        </span>
      ))}
    </span>
  );
}
