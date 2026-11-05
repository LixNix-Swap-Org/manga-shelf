import { useId } from 'react';
import { Tv } from 'lucide-react';
import { displayTitle, filterAnime, kindLabel, kindOf } from '../../utils/animeHelpers';
import { animeProgressLabel } from '../../utils/enumLabels';
import { t, tn } from '../../i18n/index.js';
import { langFor } from '../common/lang';

// the shelf search is about series; the anime part stays a short row
export const ANIME_HIT_LIMIT = 6;
export const ANIME_SEARCH_MIN_CHARS = 2;

/** Entries of the anime list that match the header search (same matcher as the anime tab), best title first. */
export function animeSearchHits(list, query) {
  const q = String(query || '').trim();
  if (q.length < ANIME_SEARCH_MIN_CHARS || !Array.isArray(list) || !list.length) return [];
  return filterAnime(list, { search: q });
}

/**
 * "In deiner Anime-Liste": anime, films and shows matching the header search, under the shelf toolbar. A hit opens the
 * anime detail; with more than ANIME_HIT_LIMIT hits "Alle im Anime-Tab" switches the view.
 */
export default function AnimeSearchHits({ hits, onOpen, onShowAll }) {
  const headingId = useId();
  if (!hits.length) return null;
  const shown = hits.slice(0, ANIME_HIT_LIMIT);
  return (
    <section aria-labelledby={headingId} className="glass-panel rounded-2xl border border-slate-800 p-3 sm:p-4 mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h2 id={headingId} className="text-sm font-bold text-white flex items-center gap-2">
          <Tv className="w-4 h-4 text-brand-400" aria-hidden="true" />
          {t('In deiner Anime-Liste')}
          <span className="text-xs font-normal text-slate-400">{tn('{n} Treffer', '{n} Treffer', hits.length)}</span>
        </h2>
        {hits.length > shown.length && onShowAll && (
          <button type="button" onClick={onShowAll} className="hit-44 text-xs text-brand-300 hover:text-white underline underline-offset-2">
            {t('Alle im Anime-Tab')}
          </button>
        )}
      </div>
      <ul className="flex flex-wrap gap-2">
        {shown.map((anime) => {
          const title = displayTitle(anime);
          const status = anime.my_progress?.status ? animeProgressLabel(anime.my_progress.status) : null;
          const kind = kindOf(anime) !== 'anime' ? kindLabel(kindOf(anime)) : null;
          return (
            <li key={anime.id} className="min-w-0 max-w-full">
              <button
                type="button"
                onClick={() => onOpen(anime)}
                className="hit-44 max-w-full text-left px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700 hover:border-brand-500/60 hover:bg-slate-800 text-xs text-slate-200 flex items-center gap-2"
              >
                <span className="font-semibold text-white truncate" lang={langFor(title) || undefined}>{title}</span>
                {[kind, status].filter(Boolean).map((label) => (
                  <span key={label} className="shrink-0 text-[11px] text-slate-400">{label}</span>
                ))}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
