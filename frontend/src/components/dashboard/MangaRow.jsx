import { memo } from 'react';
import { BookOpen, BuildingComplex, Trash } from 'lucide-react';
import { Link } from 'react-router-dom';
import CoverImage from '../common/CoverImage';
import { getSeriesProgress } from '../../utils/volumeHelpers';
import { getReadState } from '../../utils/collectionHelpers';
import { formatCount, formatMoney } from '../../utils/format';
import { langFor } from '../common/lang';
import { splitAuthors } from '../../utils/seriesMeta';
import { AuthorButtons } from './MangaCard';
import { t } from '../../i18n/index.js';
import { mangaStatusLabel } from '../../utils/enumLabels.js';
import LanguagePill from '../common/LanguagePill';
import { editionCurrency, editionLanguage, editionRegion } from '../../utils/editions';

const COVER_FALLBACK = (
  <div className="w-full h-full flex items-center justify-center text-slate-700">
    <BookOpen className="w-4 h-4" />
  </div>
);

/** One row of the list view; `onDelete(event, id, title)` and `onAuthorClick(name)` must be stable for the memo to hold. */
function MangaRow({ manga, canEdit, getStatusBadge, onDelete, onAuthorClick, className }) {
  const { owned, total, extras, pct } = getSeriesProgress(manga);
  const readState = getReadState(manga);
  const authors = onAuthorClick ? splitAuthors(manga.author) : [];

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
        <div className="flex items-center gap-1.5 min-w-0">
          <Link to={`/manga/${manga.id}`} className="font-bold text-white hover:text-brand-400 transition-colors text-sm line-clamp-1 min-w-0">
            {manga.title}
          </Link>
          <LanguagePill language={editionLanguage(manga)} region={editionRegion(manga)} />
        </div>
        <div className="text-slate-400 text-xs mt-0.5 [@media(pointer:coarse)]:mt-1.5 [@media(pointer:fine)]:line-clamp-1">
          {authors.length ? <AuthorButtons names={authors} onAuthorClick={onAuthorClick} buttonClassName="hit-44" /> : (manga.author || t('Kein Autor'))}
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
            <span className="sr-only">{t('Kein Verlag')}</span>
          </>
        )}
      </td>
      <td className="py-2.5 px-4">
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${getStatusBadge(manga.status)}`}>
          {mangaStatusLabel(manga.status)}
        </span>
      </td>
      <td className="py-2.5 px-4 min-w-[9rem]">
        <div className="flex flex-col items-start gap-0.5">
          <span className="font-bold text-white font-mono whitespace-nowrap">
            {owned} {total > 0 ? `/ ${total}` : (owned === 1 ? t('Band') : t('Bde.'))}{extras > 0 ? ` +${extras}` : ''}
          </span>
          {readState.read > 0 ? (
            <span className={`text-[10px] font-mono whitespace-nowrap ${readState.complete ? 'text-emerald-400 font-bold' : 'text-sky-300'}`}>
              {t('({read} gelesen • {pct}%)', { read: readState.read, pct: readState.pct })}
            </span>
          ) : (
            <span className="text-[10px] text-slate-400 font-mono whitespace-nowrap">{t('(Ungelesen)')}</span>
          )}
        </div>
        {pct !== null && (
          <div
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={t('{owned} von {count}', { owned, count: formatCount(total, 'Band', 'Bänden') })}
            aria-label={t('Fortschritt')}
            className="w-24 h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800 mt-1"
          >
            <div className="h-full bg-gradient-to-r from-brand-500 to-emerald-400 rounded-full" style={{ width: `${pct}%` }} />
          </div>
        )}
      </td>
      <td className="py-2.5 px-4 text-right hidden md:table-cell font-mono font-bold text-emerald-400">
        {manga.total_value > 0 ? formatMoney(manga.total_value, editionCurrency(manga)) : '—'}
      </td>
      <td className="py-2.5 px-4 text-right">
        <div className="flex items-center justify-end gap-1.5">
          <Link to={`/manga/${manga.id}`} className="btn-secondary py-1 px-2.5 text-xs text-brand-400 hover:text-white">
            {t('Details')}
          </Link>
          {canEdit && (
            <button
              type="button"
              onClick={(e) => onDelete(e, manga.id, manga.title)}
              className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
              title={t('Manga löschen')}
              aria-label={t('{title} löschen', { title: manga.title })}
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
