import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookCheck, BookPlus, History, Library, Pencil, Plus } from 'lucide-react';
import { apiFetch, readJson } from '../../../utils/api';
import { formatDate, formatTime } from '../../../utils/format';
import { compactVolumes } from '../../dashboard/TodoList';
import { t } from '../../../i18n/index.js';

const KIND_ICON = {
  read: { Icon: BookCheck, className: 'text-emerald-400' },
  owned: { Icon: Library, className: 'text-amber-300' },
  added: { Icon: Plus, className: 'text-sky-400' },
  changed: { Icon: Pencil, className: 'text-slate-300' },
  series_added: { Icon: BookPlus, className: 'text-brand-300' },
  series_changed: { Icon: Pencil, className: 'text-slate-300' }
};

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The sentence of one entry of GET /api/activity ("Lena hat Bände 1–3 von „Frieren“ gelesen"). */
export function activityText(item) {
  const title = item.title || t('Ohne Titel');
  const name = item.username;
  const vols = item.count === 1
    ? t('Band {volume}', { volume: item.volumes?.[0] ?? '' })
    : t('Bände {volumes}', { volumes: compactVolumes(item.volumes) });
  switch (item.kind) {
    case 'read':
      return t('{name} hat {vols} von „{title}“ gelesen', { name, vols, title });
    case 'owned':
      return t('{name} besitzt jetzt {vols} von „{title}“', { name, vols, title });
    case 'added':
      return name ? t('{name} hat {vols} zu „{title}“ hinzugefügt', { name, vols, title }) : t('{vols} zu „{title}“ hinzugefügt', { vols, title });
    case 'changed':
      return name ? t('{name} hat {vols} von „{title}“ geändert', { name, vols, title }) : t('{vols} von „{title}“ geändert', { vols, title });
    case 'series_added':
      return name ? t('{name} hat „{title}“ angelegt', { name, title }) : t('„{title}“ angelegt', { title });
    default:
      return t('{name} hat „{title}“ bearbeitet', { name: name || t('Jemand'), title });
  }
}

/** "Heute", "Gestern" or the date of a local day ('YYYY-MM-DD'). */
function dayLabel(day, now = new Date()) {
  if (day === localDay(now)) return t('Heute');
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day === localDay(yesterday)) return t('Gestern');
  return formatDate(day, { long: true });
}

/**
 * Tab "Aktivität" of the statistics page: who recently read, bought, added or changed what in the chosen shelf (GET
 * /api/activity), by day, newest first. The server reads the rows' own timestamps, so only the latest change of a
 * volume shows; the footer says so.
 */
export default function ActivityCard({ shelfId = null }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setData(null);
    setFailed(false);
    const url = shelfId && shelfId !== 'all' ? `/api/activity?shelf_id=${encodeURIComponent(shelfId)}` : '/api/activity';
    apiFetch(url)
      .then(async (res) => {
        const body = res.ok ? await readJson(res) : null;
        if (!live) return;
        if (body && Array.isArray(body.items)) setData(body);
        else setFailed(true);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [shelfId]);

  if (failed) return <p className="py-12 text-center text-sm text-slate-400">{t('Aktivität konnte nicht geladen werden.')}</p>;
  if (!data) return <p role="status" className="py-12 text-center text-sm text-slate-400">{t('Wird geladen…')}</p>;
  if (!data.items.length) {
    return <p className="py-12 text-center text-sm text-slate-400">{t('In den letzten {days} Tagen ist nichts passiert.', { days: data.days })}</p>;
  }

  const days = [];
  for (const item of data.items) {
    const day = localDay(new Date(item.at));
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, items: [] });
    days[days.length - 1].items.push(item);
  }
  const showShelf = !shelfId || shelfId === 'all';
  return (
    <div id="stats-activity" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-1.5">
        <History className="w-4 h-4 text-sky-400" aria-hidden="true" /> {t('Aktivität der letzten {days} Tage', { days: data.days })}
      </h3>
      <div className="space-y-5">
        {days.map(({ day, items }) => (
          <section key={day} aria-label={dayLabel(day)}>
            <h4 className="text-[11px] font-semibold text-slate-400 mb-2">{dayLabel(day)}</h4>
            <ul className="space-y-1.5">
              {items.map((item) => {
                const { Icon, className } = KIND_ICON[item.kind] || KIND_ICON.changed;
                return (
                  <li key={`${item.kind}-${item.user_id ?? ''}-${item.manga_id}-${item.at}`} className="flex items-start gap-2.5 text-sm">
                    <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${className}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <Link to={`/manga/${item.manga_id}`} className="text-slate-200 hover:text-brand-300 break-words">{activityText(item)}</Link>
                      {showShelf && item.shelf_name && <span className="text-[11px] text-slate-400"> · {item.shelf_name}</span>}
                    </span>
                    <time dateTime={item.at} className="text-[11px] text-slate-400 font-mono shrink-0">{formatTime(item.at)}</time>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <p className="text-[10px] text-slate-400 mt-4">{t('Je Band zählt nur die letzte Änderung; Gelöschtes erscheint hier nicht.')}</p>
    </div>
  );
}
