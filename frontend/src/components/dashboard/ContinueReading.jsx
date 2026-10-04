import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import CoverImage from '../common/CoverImage';
import { get } from '../../utils/api';

export const CONTINUE_READING_LIMIT = 3;

/** The first entries of GET /api/stats/reading's continue_reading that have a next volume. */
export function continueReadingItems(data, limit = CONTINUE_READING_LIMIT) {
  const list = Array.isArray(data?.continue_reading) ? data.continue_reading : [];
  return list.filter((item) => item && item.manga_id != null && item.next_volume).slice(0, limit);
}

/**
 * "Weiterlesen" strip on the shelf: the last series the user read whose next owned volume is unread. Hidden while
 * offline, while loading, on an error and when there is nothing to continue.
 */
export default function ContinueReading({ userId, enabled = true }) {
  const [items, setItems] = useState([]);
  const headingId = useId();

  useEffect(() => {
    if (!enabled || !userId) {
      setItems([]);
      return undefined;
    }
    const controller = new AbortController();
    get('/api/stats/reading', { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setItems(continueReadingItems(data)); })
      .catch(() => { if (!controller.signal.aborted) setItems([]); });
    return () => controller.abort();
  }, [enabled, userId]);

  if (!items.length) return null;
  return (
    <section id="continue-reading" aria-labelledby={headingId} className="mb-6 sm:mb-8">
      <h3 id={headingId} className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5 mb-2.5">
        <BookOpen className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> Weiterlesen
      </h3>
      <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-4">
        {items.map((item) => {
          const next = item.next_volume;
          const more = Number(item.unread_after) > 1 ? ` · ${item.unread_after} ungelesen` : '';
          return (
            <li key={item.manga_id}>
              <Link
                to={`/manga/${item.manga_id}`}
                className="continue-reading-entry glass-panel flex items-center gap-3 p-2.5 rounded-2xl border border-slate-800/80 hover:border-emerald-500/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <CoverImage
                  src={[next.cover_image, item.cover_image]}
                  className="w-10 h-14 rounded object-cover shrink-0"
                  fallback={<div className="w-10 h-14 rounded bg-slate-800 flex items-center justify-center text-slate-400 shrink-0"><BookOpen className="w-4 h-4" aria-hidden="true" /></div>}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white truncate">{item.title || 'Ohne Titel'}</span>
                  <span className="block text-[11px] text-slate-400">Weiter mit Band {next.volume_number}{more}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
