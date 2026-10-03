import { Users } from 'lucide-react';
import { ownerColor } from './OwnerBadges';

/** Besitz pro Person: wie viele Bände jede Person besitzt, Filter „hat“ / „fehlt noch“. Nur ab zwei Nutzern. */
export default function OwnerFilterBar({ users, volumes, ownerFilter, setOwnerFilter, ownerMissing, setOwnerMissing }) {
  if (!users || users.length < 2) return null;
  const countable = volumes.filter(v => v.status === 'Vorhanden' || (v.owners || []).length > 0);
  const ownedBy = (userId) => volumes.filter(v => (v.owners || []).some(o => o.user_id === userId)).length;
  const total = volumes.filter(v => v.status !== 'Erscheint bald' && v.status !== 'Vorbestellt').length;
  return (
    <div className="mb-4 p-3.5 bg-slate-950/80 rounded-2xl border border-slate-800 flex flex-wrap items-center gap-2.5">
      <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
        <Users className="w-4 h-4 text-amber-400" /> Besitz:
      </span>
      <div className="flex flex-wrap items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs">
        <button
          type="button"
          onClick={() => { setOwnerFilter('ALL'); setOwnerMissing(false); }}
          className={`px-3 py-1.5 rounded-lg font-medium ${ownerFilter === 'ALL' ? 'bg-brand-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
        >
          Alle ({countable.length})
        </button>
        {users.map(u => {
          const selected = String(ownerFilter) === String(u.user_id);
          return (
            <button
              key={u.user_id}
              type="button"
              onClick={() => setOwnerFilter(selected ? 'ALL' : u.user_id)}
              aria-pressed={selected}
              className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-2 ${selected ? 'bg-brand-600 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: ownerColor(u.user_id) }} />
              <span>{u.display_name || u.username}</span>
              <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded-md ${selected ? 'bg-black/30 text-emerald-200' : 'bg-slate-800 text-slate-300'}`}>
                {ownedBy(u.user_id)} / {total}
              </span>
            </button>
          );
        })}
      </div>
      {ownerFilter !== 'ALL' && (
        <label className="text-xs text-slate-300 flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={ownerMissing} onChange={e => setOwnerMissing(e.target.checked)} />
          Nur zeigen, was noch fehlt
        </label>
      )}
    </div>
  );
}
