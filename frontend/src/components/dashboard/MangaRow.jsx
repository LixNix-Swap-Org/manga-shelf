import { memo } from 'react';
import { BookOpen, BuildingComplex, Trash } from 'lucide-react';
import { Link } from 'react-router-dom';
import CoverImage from '../common/CoverImage';
import { getSeriesProgress } from '../../utils/volumeHelpers';
import { getReadState } from '../../utils/collectionHelpers';
import { formatCount, formatEuro } from '../../utils/format';
import { langFor } from '../common/lang';

const COVER_FALLBACK = (
  <div className="w-full h-full flex items-center justify-center text-slate-700">
    <BookOpen className="w-4 h-4" />
  </div>
);

/** One row of the list view; `onDelete(event, id, title)` must be stable for the memo to hold. */
function MangaRow({ manga, canEdit, getStatusBadge, onDelete, className }) {
  const { owned, total, extras, pct } = getSeriesProgress(manga);
  const readState = getReadState(manga);

  return (
    <tr className={className}>
      <td className="py-2.5 px-4">
        <Link to={`/manga/${manga.id}`} aria-label={manga.title} className="block w-10 h-14 rounded-lg overflow-hidden bg-slate-950 border border-slate-800 shrink-0">
          <CoverImage
            src={manga.cover_image}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
            fallback={COVER_FALLBACK}
          />
        </Link>
      </td>
      <td className="py-2.5 px-4">
        <Link to={`/manga/${manga.id}`} className="font-bold text-white hover:text-brand-400 transition-colors text-sm line-clamp-1">
          {manga.title}
        </Link>
        <div className="text-slate-400 text-xs mt-0.5 line-clamp-1">
          {manga.author || 'Kein Autor'}
          {manga.alt_title && <span className="text-slate-400 ml-1.5">(<span lang={langFor(manga.alt_title)}>{manga.alt_title}</span>)</span>}
        </div>
      </td>
      <td className="py-2.5 px-4 hidden sm:table-cell text-slate-300">
        {manga.publisher ? (
          <span className="flex items-center gap-1">
            <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" />
            <span>{manga.publisher}</span>
          </span>
        ) : (
          <>
            <span className="text-slate-500" aria-hidden="true">—</span>
            <span className="sr-only">Kein Verlag</span>
          </>
        )}
      </td>
      <td className="py-2.5 px-4">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${getStatusBadge(manga.status)}`}>
          {manga.status}
        </span>
      </td>
      <td className="py-2.5 px-4">
        <div className="flex items-center gap-2">
          <span className="font-bold text-white font-mono">
            {owned} {total > 0 ? `/ ${total}` : 'Bde.'}{extras > 0 ? ` +${extras}` : ''}
          </span>
          {readState.read > 0 ? (
            <span className={`text-[10px] font-mono ${readState.complete ? 'text-emerald-400 font-bold' : 'text-sky-300'}`}>
              ({readState.read} gelesen • {readState.pct}%)
            </span>
          ) : (
            <span className="text-[10px] text-slate-400 font-mono">(Ungelesen)</span>
          )}
        </div>
        {pct !== null && (
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${owned} von ${formatCount(total, 'Band', 'Bänden')}`}
            aria-label="Fortschritt"
            className="w-24 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800 mt-1"
          >
            <div className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 rounded-full" style={{ width: `${pct}%` }} />
          </div>
        )}
      </td>
      <td className="py-2.5 px-4 text-right hidden md:table-cell font-mono font-bold text-emerald-400">
        {manga.total_value > 0 ? formatEuro(manga.total_value) : '—'}
      </td>
      <td className="py-2.5 px-4 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <Link to={`/manga/${manga.id}`} className="btn-secondary py-1 px-2.5 text-xs text-brand-400 hover:text-white">
            Details
          </Link>
          {canEdit && (
            <button
              type="button"
              onClick={(e) => onDelete(e, manga.id, manga.title)}
              className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              title="Manga löschen"
              aria-label={`${manga.title} löschen`}
            >
              <Trash className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

export default memo(MangaRow);
