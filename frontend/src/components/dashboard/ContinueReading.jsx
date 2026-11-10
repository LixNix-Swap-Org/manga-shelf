import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Check } from 'lucide-react';
import CoverImage from '../common/CoverImage';
import { get, post } from '../../utils/api';
import { notify } from '../../utils/notify';
import { t } from '../../i18n/index.js';

export const CONTINUE_READING_LIMIT = 3;

/** The first entries of GET /api/stats/reading's continue_reading that have a next volume. */
export function continueReadingItems(data, limit = CONTINUE_READING_LIMIT) {
  const list = Array.isArray(data?.continue_reading) ? data.continue_reading : [];
  return list.filter((item) => item && item.manga_id != null && item.next_volume).slice(0, limit);
}

/**
 * "Weiterlesen" strip on the shelf: the last series the user read whose next owned volume is unread. Hidden while
 * offline, while loading, on an error and when there is nothing to continue. With `canMark`, each entry has a
 * "+1 gelesen" button that marks its next volume as read (undo from the toast); `onChanged` runs after each change.
 */
export default function ContinueReading({ userId, enabled = true, canMark = false, onChanged }) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(null);
  const headingId = useId();
  const controllerRef = useRef(null);

  const load = useCallback(() => {
    controllerRef.current?.abort();
    if (!enabled || !userId) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    get('/api/stats/reading', { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setItems(continueReadingItems(data)); })
      .catch(() => { if (!controller.signal.aborted) setItems([]); });
  }, [enabled, userId]);

  useEffect(() => {
    load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const setRead = async (volumeId, read) => {
    await post(`/api/volumes/${volumeId}/read`, { read });
    load();
    onChanged?.();
  };

  const markNext = async (item) => {
    const next = item.next_volume;
    setBusy(item.manga_id);
    try {
      await setRead(next.id, true);
      notify.success(t('„{title}“ Band {volume} als gelesen markiert', { title: item.title || t('Ohne Titel'), volume: next.volume_number }), {
        action: { label: t('Rückgängig'), onClick: () => { setRead(next.id, false).catch((e) => notify.error(e)); } }
      });
    } catch (e) {
      notify.error(e);
    } finally {
      setBusy(null);
    }
  };

  if (!items.length) return null;
  return (
    <section id="continue-reading" aria-labelledby={headingId} className="mb-6 sm:mb-8">
      <h3 id={headingId} className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-1.5 mb-2.5">
        <BookOpen className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> {t('Weiterlesen')}
      </h3>
      <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-4">
        {items.map((item) => {
          const next = item.next_volume;
          const unread = Number(item.unread_after) > 1 ? item.unread_after : null;
          return (
            <li key={item.manga_id} className="relative">
              <Link
                to={`/manga/${item.manga_id}`}
                className={`continue-reading-entry glass-panel flex items-center gap-3 p-2.5 ${canMark ? 'pr-24' : ''} rounded-2xl border border-slate-800/80 hover:border-emerald-500/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400`}
              >
                <CoverImage
                  src={[next.cover_image, item.cover_image]}
                  className="w-10 h-14 rounded object-cover shrink-0"
                  fallback={<div className="w-10 h-14 rounded bg-slate-800 flex items-center justify-center text-slate-400 shrink-0"><BookOpen className="w-4 h-4" aria-hidden="true" /></div>}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white truncate">{item.title || t('Ohne Titel')}</span>
                  <span className="block text-[11px] text-slate-400">{unread !== null
                    ? t('Weiter mit Band {volume} · {unread} ungelesen', { volume: next.volume_number, unread })
                    : t('Weiter mit Band {volume}', { volume: next.volume_number })}</span>
                </span>
              </Link>
              {canMark && (
                <button
                  type="button"
                  className="continue-reading-mark absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 min-h-[36px] px-2.5 rounded-xl text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
                  aria-label={t('Band {volume} von „{title}“ als gelesen markieren', { volume: next.volume_number, title: item.title || t('Ohne Titel') })}
                  disabled={busy === item.manga_id}
                  onClick={() => markNext(item)}
                >
                  <Check className="w-3.5 h-3.5" aria-hidden="true" /> {t('+1 gelesen')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
