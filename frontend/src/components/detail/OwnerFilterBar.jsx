import { Users } from 'lucide-react';
import { ownerColor } from './OwnerBadges';
import { isCollectibleVolume } from './volumeViewHelpers';
import { t } from '../../i18n/index.js';

/** Ownership per person: how many volumes each person owns, filter "hat" / "fehlt noch". Only with two or more users. */
export default function OwnerFilterBar({ users, volumes, ownerFilter, setOwnerFilter, ownerMissing, setOwnerMissing }) {
  const collectible = (volumes || []).filter(isCollectibleVolume);
  const ownedBy = (userId) => collectible.filter(v => (v.owners || []).some(o => String(o.user_id) === String(userId))).length;
  const total = collectible.length;
  // accounts that cannot own anything (visitor / guest) only appear once they own something here
  const shown = (users || []).filter(u => !u.role || u.role === 'admin' || u.role === 'editor'
    || ownedBy(u.user_id) > 0 || String(ownerFilter) === String(u.user_id));
  if (shown.length < 2) return null;
  return (
    <div className="mb-4 p-3.5 bg-slate-950/80 rounded-2xl border border-slate-800 flex flex-wrap items-center gap-2.5">
      <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
        <Users className="w-4 h-4 text-amber-400" /> {t('Besitz:')}
      </span>
      <div role="group" aria-label={t('Besitz filtern')} className="flex flex-wrap items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs">
        <button
          type="button"
          aria-pressed={ownerFilter === 'ALL'}
          onClick={() => { setOwnerFilter('ALL'); setOwnerMissing(false); }}
          className={`px-3 py-1.5 rounded-lg font-medium ${ownerFilter === 'ALL' ? 'bg-brand-700 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
        >
          {t('Alle')}
        </button>
        {shown.map(u => {
          const selected = String(ownerFilter) === String(u.user_id);
          return (
            <button
              key={u.user_id}
              type="button"
              onClick={() => setOwnerFilter(selected ? 'ALL' : u.user_id)}
              aria-pressed={selected}
              className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-2 ${selected ? 'bg-brand-700 text-white font-semibold' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ background: ownerColor(u.user_id) }} />
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
          {t('Nur zeigen, was noch fehlt')}
        </label>
      )}
    </div>
  );
}
