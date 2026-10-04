import { memo } from 'react';
import { BookCheck, BookOpen, BuildingComplex, Coins } from 'lucide-react';
import { Link } from 'react-router-dom';
import CoverImage from '../common/CoverImage';
import { getSeriesProgress } from '../../utils/volumeHelpers';
import { getReadState } from '../../utils/collectionHelpers';
import { formatCount, formatEuro } from '../../utils/format';

/** What the card shows as badges and progress bar, as one sentence for screen readers. */
export function seriesSummary(manga, { owned, total, extras }, readState) {
  const parts = [manga.status];
  parts.push(total > 0 ? `${owned} von ${formatCount(total, 'Band', 'Bänden')}` : formatCount(owned, 'Band', 'Bände'));
  if (extras > 0) parts.push(`${extras} Extras`);
  if (readState.read > 0) parts.push(readState.complete ? 'alle gelesen' : `${readState.read} von ${readState.owned} gelesen`);
  else parts.push('ungelesen');
  return parts.filter(Boolean).join(', ');
}

const COVER_FALLBACK = (
  <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 p-4 text-center">
    <BookOpen className="w-10 h-10 mb-2 opacity-50 text-slate-500" />
    <span className="text-xs text-slate-400">Kein Cover</span>
  </div>
);

/** The link of one grid card; the grid adds the wrapper and the delete button. */
function MangaCard({ manga, getStatusBadge }) {
  const progress = getSeriesProgress(manga);
  const { owned, total, extras, pct } = progress;
  const readState = getReadState(manga);
  const titleId = `manga-card-${manga.id}-title`;
  const summaryId = `manga-card-${manga.id}-summary`;

  return (
    <Link
      to={`/manga/${manga.id}`}
      aria-labelledby={titleId}
      aria-describedby={summaryId}
      className="glass-card rounded-2xl overflow-hidden border border-slate-800 flex flex-col h-full hover:shadow-2xl hover:shadow-brand-500/10 hover:-translate-y-1.5 transition-all duration-300"
    >
      <div className="aspect-[2/3] bg-slate-950 relative overflow-hidden">
        <CoverImage
          src={manga.cover_image}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          fallback={COVER_FALLBACK}
        />

        <span id={summaryId} className="sr-only">{seriesSummary(manga, progress, readState)}</span>
        <div aria-hidden="true" className="absolute top-2 left-2 right-2 flex justify-between items-start gap-1 pointer-events-none min-w-0">
          <span className="rounded-full bg-slate-950/85 shrink-0 max-w-[65%] min-w-0 flex">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border truncate ${getStatusBadge(manga.status)}`}>
              {manga.status}
            </span>
          </span>

          <span className="bg-slate-950/85 border border-slate-800 text-white text-[11px] font-bold px-1.5 py-0.5 rounded-lg shrink-0">
            {owned} {total > 0 ? `/ ${total}` : 'Bde.'}{extras > 0 ? ` +${extras}` : ''}
          </span>
        </div>

        {readState.read > 0 && (
          <div aria-hidden="true" className="absolute top-9 right-2 pointer-events-none">
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md flex items-center gap-1 border shadow-sm ${
              readState.complete
                ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-300'
                : 'bg-slate-950/85 border-sky-500/40 text-sky-300'
            }`}>
              <BookCheck className="w-2.5 h-2.5" />
              <span>{readState.read}{readState.complete ? ' ✓' : `/${readState.owned}`}</span>
            </span>
          </div>
        )}

        {pct !== null && (
          <div aria-hidden="true" className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/60">
            <div className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <div className="p-3.5 flex flex-col flex-1 justify-between bg-slate-900/40">
        <div>
          <h3 id={titleId} className="font-bold text-sm text-white line-clamp-2 min-h-[2.5rem] leading-snug group-hover:text-brand-400 transition-colors" title={manga.title}>
            {manga.title}
          </h3>
          <p className="text-xs text-slate-400 truncate mt-0.5" title={manga.author || ''}>
            {manga.author || 'Kein Autor'}
          </p>
          {manga.publisher && (
            <p className="text-[11px] text-slate-400 flex items-center gap-1 mt-1 truncate" title={`Verlag: ${manga.publisher}`}>
              <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" />
              <span className="truncate">{manga.publisher}</span>
            </p>
          )}
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
          {manga.total_value > 0 ? (
            <span className="font-mono font-bold text-emerald-400 flex items-center gap-1">
              <Coins className="w-3 h-3 text-emerald-400" />
              {formatEuro(manga.total_value)}
            </span>
          ) : (
            <span className="text-slate-400">
              {pct !== null ? `${pct}% komplett` : formatCount(owned, 'Band', 'Bände')}
            </span>
          )}
          <span aria-hidden="true" className="text-brand-400 font-semibold group-hover:translate-x-0.5 transition-transform">Details &rarr;</span>
        </div>
      </div>
    </Link>
  );
}

export default memo(MangaCard);
