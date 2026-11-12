import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import { get } from '../../utils/api';
import { t, tn } from '../../i18n/index.js';

export const TODO_PREVIEW = 3;

// i18n
const KIND_LABEL = { elsewhere: 'Anderes Regal', overdue: 'Erschienen?', lent: 'Verliehen', gap: 'Lücke' };
const KIND_CLASS = {
  elsewhere: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  overdue: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  lent: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  gap: 'bg-amber-500/15 text-amber-300 border-amber-500/30'
};

/**
 * Volume numbers as a short list: three or more consecutive whole numbers become a range ("21–113"), everything else
 * (two in a row, 12.5, specials) stays as it is, in the given order.
 */
export function compactVolumes(volumes) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push(`${run[0]}–${run[run.length - 1]}`);
    else out.push(...run.map(String));
    run = [];
  };
  for (const v of volumes || []) {
    const s = String(v).trim();
    const n = /^\d+$/.test(s) ? Number(s) : null;
    if (n !== null && run.length && n === run[run.length - 1] + 1) {
      run.push(n);
    } else {
      flush();
      if (n !== null) run.push(n);
      else out.push(s);
    }
  }
  flush();
  return out.join(', ');
}

/** The sentence of one entry of GET /api/todo. */
export function todoText(item) {
  const title = item.title || t('Ohne Titel');
  const one = item.count === 1;
  const volume = item.volumes?.[0] ?? '';
  const volumes = compactVolumes(item.volumes);
  if (item.kind === 'elsewhere') {
    return one
      ? t('{title}: Band {volume} steht schon im Regal „{shelf}“', { title, volume, shelf: item.shelf_name })
      : t('{title}: Bände {volumes} stehen schon im Regal „{shelf}“', { title, volumes, shelf: item.shelf_name });
  }
  if (item.kind === 'overdue') {
    return one
      ? t('{title}: Band {volume} sollte erschienen sein', { title, volume })
      : t('{title}: Bände {volumes} sollten erschienen sein', { title, volumes });
  }
  if (item.kind === 'lent') {
    // the server lists lendings of 90 days and more: "seit 3 Monaten"
    const months = Math.max(1, Math.floor((Number(item.days) || 0) / 30));
    const vars = { title, volume, volumes, name: item.lent_to || '' };
    return one
      ? tn('{title}: Band {volume} seit {n} Monat an {name} verliehen', '{title}: Band {volume} seit {n} Monaten an {name} verliehen', months, vars)
      : tn('{title}: Bände {volumes} seit {n} Monat an {name} verliehen', '{title}: Bände {volumes} seit {n} Monaten an {name} verliehen', months, vars);
  }
  return one
    ? t('{title}: Band {volume} fehlt', { title, volume })
    : tn('{title}: {n} Band fehlt ({volumes})', '{title}: {n} Bände fehlen ({volumes})', item.count, { title, volumes });
}

/**
 * "Zu erledigen" on the shelf: the open points of the collection from GET /api/todo (volumes owned in another shelf,
 * orders that should be out, copies lent out for months, gaps), each linking to its series. Shows the first TODO_PREVIEW, the rest on demand.
 * Hidden offline, on an error and when nothing is open. `reloadKey` reloads it (the dashboard passes its data time).
 */
export default function TodoList({ enabled = true, shelfId = null, reloadKey, onCount }) {
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();

  useEffect(() => {
    if (!enabled) {
      setData(null);
      onCount?.(0);
      return undefined;
    }
    const controller = new AbortController();
    const query = shelfId ? `?shelf_id=${encodeURIComponent(shelfId)}` : '';
    get(`/api/todo${query}`, { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return;
        const items = Array.isArray(body?.items) ? body.items : [];
        setData({ items, total: Number(body?.total) || items.length });
        onCount?.(Number(body?.total) || items.length);
      })
      .catch(() => { if (!controller.signal.aborted) { setData(null); onCount?.(0); } });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onCount is a callback, not an input
  }, [enabled, shelfId, reloadKey]);

  if (!data || !data.items.length) return null;
  const shown = expanded ? data.items : data.items.slice(0, TODO_PREVIEW);
  return (
    <section id="todo-list" tabIndex={-1} aria-labelledby={headingId} className="mb-6 sm:mb-8 rounded-2xl border border-amber-500/35 bg-amber-500/[0.06] p-3 sm:p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400">
      <h3 id={headingId} className="text-sm font-bold text-amber-300 flex items-center gap-1.5 mb-2">
        <ListChecks className="w-4 h-4" aria-hidden="true" /> {t('Zu erledigen ({count})', { count: data.total })}
      </h3>
      <ul className="space-y-1.5">
        {shown.map((item) => (
          <li key={`${item.kind}-${item.manga_id}-${item.lent_to ?? ''}`} className="flex items-center gap-2.5 min-h-[40px] text-sm">
            <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${KIND_CLASS[item.kind] || KIND_CLASS.gap}`}>{t(KIND_LABEL[item.kind] || KIND_LABEL.gap)}</span>
            <span className="min-w-0 flex-1 text-slate-200 truncate">{todoText(item)}</span>
            <Link to={`/manga/${item.manga_id}`} aria-label={t('„{title}“ öffnen', { title: item.title || t('Ohne Titel') })} className="shrink-0 text-xs font-semibold text-sky-400 hover:text-sky-300 px-2 py-1.5 rounded-lg hover:bg-slate-800/60">
              {t('Öffnen')}
            </Link>
          </li>
        ))}
      </ul>
      {data.items.length > TODO_PREVIEW && (
        <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="mt-2 text-xs font-semibold text-amber-300 hover:text-amber-200">
          {expanded ? t('Weniger zeigen') : t('Alle {count} zeigen', { count: data.items.length })}
        </button>
      )}
    </section>
  );
}
