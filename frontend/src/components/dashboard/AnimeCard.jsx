import { memo, useId } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Clock, Play, Plus, Tv } from 'lucide-react';
import CoverImage from '../common/CoverImage';
import { ownerColor } from '../detail/OwnerBadges';
import { langFor } from '../common/lang';
import { openLinkOutside } from '../../app/openExternal';
import {
  PROGRESS_STATUSES, displayTitle, formatYearLine, progressText, progressPercent, plusOneDisabled, countdownText, staleText,
  initials, sourceBadges, continueTarget
} from '../../utils/animeHelpers';

const COVER_FALLBACK = (
  <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 p-4 text-center">
    <Tv className="w-10 h-10 mb-2 opacity-50 text-slate-500" aria-hidden="true" />
    <span className="text-xs text-slate-400">Kein Cover</span>
  </div>
);

const ANIME_TITLE_CLASS = 'line-clamp-2 break-words hyphens-auto [overflow-wrap:anywhere]';

/**
 * One anime in the grid: cover, title, my progress (bar, +1, status), next episode and who else watches it. Clicking
 * the cover or the title opens the detail dialog. Without `canEdit` (visitor, offline) there are no controls.
 */
function AnimeCard({ anime, canEdit, onOpen, onPlusOne, onStatusChange, userId, now = new Date() }) {
  const titleId = useId();
  const mine = anime.my_progress;
  const watched = mine?.episodes_watched || 0;
  const percent = progressPercent(watched, anime.episodes);
  const countdown = countdownText(anime.next_airing, now);
  const stale = staleText(anime, now.getTime());
  const others = (anime.progress_users || []).filter((p) => p.user_id !== userId);
  const title = displayTitle(anime);
  const disabled = plusOneDisabled(mine, anime.episodes);
  const next = continueTarget(anime, { search: false });

  return (
    <article
      aria-labelledby={titleId}
      data-anime-id={anime.id}
      className="glass-card rounded-2xl overflow-hidden border border-slate-800 flex flex-col h-full"
    >
      <button
        type="button"
        onClick={() => onOpen(anime)}
        className="aspect-[2/3] bg-slate-950 relative overflow-hidden text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
        aria-label={`${title} öffnen`}
      >
        <CoverImage src={anime.cover_image} className="w-full h-full object-cover" fallback={COVER_FALLBACK} />
        <span aria-hidden="true" className="absolute top-2 left-2 right-2 flex flex-wrap gap-1 pointer-events-none">
          {sourceBadges(anime).map((label) => (
            <span key={label} className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-slate-950/85 border border-slate-700 text-slate-200">{label}</span>
          ))}
          {anime.manual && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-slate-950/85 border border-slate-700 text-slate-300">manuell</span>}
        </span>
      </button>

      <div className="p-3 flex flex-col gap-2 flex-1 min-w-0">
        <div className="min-w-0">
          <h3 id={titleId} lang={langFor(title) || 'de'} className="text-sm font-bold text-white leading-snug">
            <button type="button" onClick={() => onOpen(anime)} className="block max-w-full text-left hover:text-brand-300">
              <span className={ANIME_TITLE_CLASS}>{title}</span>
            </button>
          </h3>
          <p className="text-[11px] text-slate-400 flex items-center gap-1.5 mt-0.5 min-w-0">
            <span className="truncate">{formatYearLine(anime) || '–'}</span>
            {anime.manga_id && (
              <Link to={`/manga/${anime.manga_id}`} className="text-brand-300 hover:text-brand-200 shrink-0" title="Zur verknüpften Reihe" aria-label="Zur verknüpften Reihe">
                <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
              </Link>
            )}
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] text-slate-300 mb-1">
            <span className="min-w-0">{mine ? mine.status : 'Nicht auf meiner Liste'}</span>
            <span className="font-mono whitespace-nowrap shrink-0 ml-2" aria-label={`${watched} von ${anime.episodes > 0 ? anime.episodes : 'unbekannt vielen'} Folgen gesehen`}>
              {progressText(watched, anime.episodes)}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden" aria-hidden="true">
            <div className="h-full bg-gradient-to-r from-brand-600 to-sky-400" style={{ width: `${percent ?? (watched > 0 ? 100 : 0)}%`, opacity: percent === null && watched > 0 ? 0.4 : 1 }} />
          </div>
        </div>

        {countdown && (
          <p className="text-[11px] text-sky-300 flex items-center gap-1">
            <Clock className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span>{countdown}</span>
            {anime.next_airing?.estimated && <span className="text-[10px] px-1 rounded bg-slate-800 text-slate-300" title="Aus dem Sendeplatz geschätzt">geschätzt</span>}
          </p>
        )}
        {stale && <p className="text-[10px] text-slate-400">{stale}</p>}

        {others.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap" role="img" aria-label={`Schauen auch: ${others.map((o) => o.username).join(', ')}`}>
            {others.map((o) => (
              <span
                key={o.user_id}
                aria-hidden="true"
                title={`${o.username}: ${o.status}, ${o.episodes_watched} Folgen`}
                className="px-1 h-4 min-w-4 rounded-full text-[9px] font-bold flex items-center justify-center text-slate-950"
                style={{ background: ownerColor(o.user_id) }}
              >
                {initials(o.username)}
              </span>
            ))}
          </div>
        )}

        {next && (
          <a
            href={next.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => openLinkOutside(e, { preferApp: true })}
            aria-label={`${next.label}: ${title}`}
            className="hit-44 mt-auto btn-secondary text-[11px] leading-tight py-1.5 px-2 flex items-center justify-center gap-1 min-w-0"
          >
            <Play className="w-3 h-3 shrink-0" aria-hidden="true" />
            <span className="text-center">{next.label}</span>
          </a>
        )}

        {canEdit && (
          <div className={`${next ? '' : 'mt-auto '}flex items-center gap-1.5 pt-1`}>
            <button
              type="button"
              onClick={() => onPlusOne(anime)}
              disabled={disabled}
              className="btn-primary text-xs py-1.5 px-2.5 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label={`${title}: eine Folge mehr gesehen`}
              title="Eine Folge mehr gesehen"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />1
            </button>
            <label className="sr-only" htmlFor={`${titleId}-status`}>Status für {title}</label>
            <select
              id={`${titleId}-status`}
              value={mine?.status || ''}
              onChange={(e) => onStatusChange(anime, e.target.value)}
              className="input-field text-base sm:text-xs py-1.5 px-2 min-w-0 flex-1"
            >
              {!mine && <option value="">Status wählen</option>}
              {PROGRESS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      </div>
    </article>
  );
}

export default memo(AnimeCard);
