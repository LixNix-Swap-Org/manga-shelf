import { Users } from 'lucide-react';
import { ownerColor } from './OwnerBadges';
import { isCollectibleVolume } from './volumeViewHelpers';
import { t } from '../../i18n/index.js';

/**
 * The people whose ownership can be filtered: accounts that may own something, plus visitors / guests once they own a
 * volume here or are the current filter. Empty below two people (nothing to choose).
 */
export function ownerChoices({ users, volumes, ownerFilter }) {
  const collectible = (volumes || []).filter(isCollectibleVolume);
  const ownedBy = (userId) => collectible.filter(v => (v.owners || []).some(o => String(o.user_id) === String(userId))).length;
  const shown = (users || []).filter(u => !u.role || u.role === 'admin' || u.role === 'editor'
    || ownedBy(u.user_id) > 0 || String(ownerFilter) === String(u.user_id));
  return shown.length < 2 ? [] : shown.map(u => ({ user: u, owned: ownedBy(u.user_id), total: collectible.length }));
}

/** The round mark of a single choice in the chip panels (the rows are toggle buttons, aria-pressed carries the state). */
export const Radio = ({ on }) => (
  <span
    aria-hidden="true"
    className={`w-3.5 h-3.5 shrink-0 rounded-full border-2 ${on ? 'border-sky-400' : 'border-slate-500'}`}
    style={on ? { background: 'radial-gradient(#38bdf8 40%, transparent 45%)' } : undefined}
  />
);

/**
 * "Wessen Bände zeigen?" in the reader chip of the detail page: how many volumes each person owns, filter by a person
 * and "Nur zeigen, was noch fehlt". Only with two or more people.
 */
export default function OwnerFilterBar({ users, volumes, ownerFilter, setOwnerFilter, ownerMissing, setOwnerMissing }) {
  const choices = ownerChoices({ users, volumes, ownerFilter });
  if (!choices.length) return null;
  const row = (on) => `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm ${on ? 'bg-brand-700/30 text-white font-semibold' : 'text-slate-300 hover:bg-slate-800/70'}`;
  return (
    <div className="space-y-1">
      <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
        <Users className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" /> {t('Wessen Bände zeigen?')}
      </span>
      <div role="group" aria-label={t('Besitz filtern')} className="space-y-0.5">
        <button
          type="button"
          aria-pressed={ownerFilter === 'ALL'}
          onClick={() => { setOwnerFilter('ALL'); setOwnerMissing(false); }}
          className={row(ownerFilter === 'ALL')}
        >
          <Radio on={ownerFilter === 'ALL'} />
          {t('Alle')}
        </button>
        {choices.map(({ user: u, owned, total }) => {
          const selected = String(ownerFilter) === String(u.user_id);
          return (
            <button
              key={u.user_id}
              type="button"
              onClick={() => setOwnerFilter(selected ? 'ALL' : u.user_id)}
              aria-pressed={selected}
              className={row(selected)}
            >
              <Radio on={selected} />
              <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ background: ownerColor(u.user_id) }} />
              <span>{u.display_name || u.username}</span>
              <span className="ml-auto text-[11px] font-mono px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300">
                {owned} / {total}
              </span>
            </button>
          );
        })}
      </div>
      {ownerFilter !== 'ALL' && (
        <label className="text-xs text-slate-300 flex items-center gap-1.5 cursor-pointer px-2.5 pt-1">
          <input type="checkbox" checked={ownerMissing} onChange={e => setOwnerMissing(e.target.checked)} />
          {t('Nur zeigen, was noch fehlt')}
        </label>
      )}
    </div>
  );
}
