import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Check } from 'lucide-react';
import CoverImage from '../common/CoverImage';
import { get, post } from '../../utils/api';
import { notify } from '../../utils/notify';
import { t } from '../../i18n/index.js';

export const CONTINUE_READING_LIMIT = 3;

const continueCache = new Map();
export function clearContinueReadingCache() {
  continueCache.clear();
}

/** The first entries of GET /api/stats/reading's continue_reading that have a next volume. */
export function continueReadingItems(data, limit = CONTINUE_READING_LIMIT) {
  const list = Array.isArray(data?.continue_reading) ? data.continue_reading : [];
  return list.filter((item) => item && item.manga_id != null && item.next_volume).slice(0, limit);
}

/**
 * "Weiterlesen" strip on the shelf: the last series the user read whose next owned volume is unread. Hidden while
 * offline, while loading, on an error and when there is nothing to continue.
 */
export default function ContinueReading({ userId, enabled = true, canEdit = false, onReadChanged = null }) {
  const [items, setItems] = useState(() => (enabled && userId ? continueCache.get(userId) || [] : []));
  const [busyId, setBusyId] = useState(null);
  const headingId = useId();

  const reload = useCallback((signal) => {
    if (!enabled || !userId) {
      setItems([]);
      return Promise.resolve();
    }
    return get('/api/stats/reading', signal ? { signal } : undefined)
      .then((data) => {
        if (signal?.aborted) return;
        const next = continueReadingItems(data);
        continueCache.set(userId, next);
        setItems(next);
      })
      .catch(() => {
        if (!signal?.aborted) {
          continueCache.delete(userId);
          setItems([]);
        }
      });
  }, [enabled, userId]);

  useEffect(() => {
    if (!enabled || !userId) {
      setItems([]);
      return undefined;
    }
    const cached = continueCache.get(userId);
    if (cached) setItems(cached);
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [enabled, userId, reload]);

  const markRead = async (item) => {
    const next = item?.next_volume;
    if (!canEdit || !next?.id || busyId !== null) return;
    setBusyId(next.id);
    const label = `${item.title || t('Ohne Titel')} – ${t('Band {num}', { num: next.volume_number })}`;
    try {
      await post(`/api/volumes/${next.id}/read`, { read: true });
      await reload();
      onReadChanged?.();
      notify.success(t('„{title}“ als gelesen markiert', { title: label }), {
        action: {
          label: t('Rückgängig'),
          onClick: async () => {
            try {
              await post(`/api/volumes/${next.id}/read`, { read: false });
              await reload();
              onReadChanged?.();
            } catch (err) {
              notify.error(err);
            }
          }
        }
      });
    } catch (err) {
      notify.error(err);
    } finally {
      setBusyId(null);
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
          const seriesTitle = item.title || t('Ohne Titel');
          const volumeLabel = `${seriesTitle} – ${t('Band {num}', { num: next.volume_number })}`;
          return (
            <li key={item.manga_id} className="continue-reading-entry glass-panel flex items-center gap-1 p-1.5 pr-2 rounded-2xl border border-slate-800/80 hover:border-emerald-500/50 transition-colors">
              <Link
                to={`/manga/${item.manga_id}`}
                className="flex items-center gap-3 p-1 rounded-xl min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <CoverImage
                  src={[next.cover_image, item.cover_image]}
                  className="w-10 h-14 rounded object-cover shrink-0"
                  fallback={<div className="w-10 h-14 rounded bg-slate-800 flex items-center justify-center text-slate-400 shrink-0"><BookOpen className="w-4 h-4" aria-hidden="true" /></div>}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-white truncate">{seriesTitle}</span>
                  <span className="block text-[11px] text-slate-400">{unread !== null
                    ? t('Weiter mit Band {volume} · {unread} ungelesen', { volume: next.volume_number, unread })
                    : t('Weiter mit Band {volume}', { volume: next.volume_number })}</span>
                </span>
              </Link>
              {canEdit && next?.id != null && (
                <button
                  type="button"
                  disabled={busyId === next.id}
                  onClick={() => markRead(item)}
                  aria-label={`${t('Als gelesen markieren')} – ${volumeLabel}`}
                  title={t('Als gelesen markieren')}
                  className="hit-44 shrink-0 p-2 rounded-xl text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 transition-colors disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  <Check className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
