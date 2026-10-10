import { useId } from 'react';
import { Tv } from 'lucide-react';
import { formatCount, formatNumber } from '../../../utils/format';
import { t, tn } from '../../../i18n/index.js';

/** Watch time as '3 Std. 20 Min.' / '2 Tage 4 Std.'. */
export function watchTime(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return t('{minutes} Min.', { minutes: m });
  const hours = Math.floor(m / 60);
  if (hours < 48) return m % 60 ? t('{hours} Std. {minutes} Min.', { hours, minutes: m % 60 }) : t('{hours} Std.', { hours });
  const days = Math.floor(hours / 24);
  return hours % 24 ? tn('{n} Tag {hours} Std.', '{n} Tage {hours} Std.', days, { hours: hours % 24 }) : tn('{n} Tag', '{n} Tage', days);
}

function Tile({ label, value }) {
  return (
    <div className="rounded-xl bg-slate-900/80 border border-slate-800 py-2">
      <dt className="text-[10px] text-slate-400 uppercase tracking-wider">{label}</dt>
      <dd className="text-lg font-bold text-white font-mono">{formatNumber(value || 0)}</dd>
    </div>
  );
}

/** Anime card of the statistics (only when the anime list has entries). */
export default function AnimeStatsCard({ anime }) {
  const mineId = useId();
  if (!anime || !anime.total) return null;
  return (
    <div id="stats-anime" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
        <Tv className="w-4 h-4 text-fuchsia-400" aria-hidden="true" /> {t('Anime')}
      </h3>
      <div className="grid grid-cols-4 gap-2 text-center mb-4 items-end">
        <dl>
          <Tile label={t('Einträge')} value={anime.total} />
        </dl>
        <div role="group" aria-labelledby={mineId} className="col-span-3 min-w-0">
          <p id={mineId} className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">{t('Meine Liste')}</p>
          <dl className="grid grid-cols-3 gap-2">
            {[[t('Schauen'), anime.watching], [t('Gesehen'), anime.completed], [t('Geplant'), anime.planned]].map(([label, value]) => (
              <Tile key={label} label={label} value={value} />
            ))}
          </dl>
        </div>
      </div>
      {anime.per_user?.length > 0 && (
        <ul className="space-y-1.5">
          {anime.per_user.map((u) => (
            <li key={u.user_id} className="flex items-center justify-between text-xs text-slate-300">
              <span className="font-semibold text-slate-100">{u.username}</span>
              <span>{formatCount(u.episodes_watched, 'Folge', 'Folgen')} · {watchTime(u.watch_minutes)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
