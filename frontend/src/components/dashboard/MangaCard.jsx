import { memo } from 'react';
import { BookCheck, BookOpen, BuildingComplex, Coins } from 'lucide-react';
import { Link } from 'react-router-dom';
import CoverImage from '../common/CoverImage';
import { getSeriesProgress } from '../../utils/volumeHelpers';
import { getReadState } from '../../utils/collectionHelpers';
import { formatCount, formatMoney } from '../../utils/format';
import { splitAuthors } from '../../utils/seriesMeta';
import { langFor } from '../common/lang';
import { t, tn } from '../../i18n/index.js';
import { mangaStatusLabel } from '../../utils/enumLabels.js';
import LanguagePill, { useDefaultLanguage } from '../common/LanguagePill';
import { editionCurrency, editionLanguage, editionName, editionRegion } from '../../utils/editions';

/** What the card shows as badges and progress bar, as one sentence for screen readers. */
export function seriesSummary(manga, { owned, total, extras }, readState, defaultLanguage = null) {
  const parts = [mangaStatusLabel(manga.status)];
  const language = editionLanguage(manga);
  if (defaultLanguage && language !== defaultLanguage) parts.push(t('Ausgabe: {language}', { language: editionName(language, editionRegion(manga)) }));
  parts.push(total > 0 ? t('{owned} von {volumes}', { owned, volumes: formatCount(total, 'Band', 'Bänden') }) : formatCount(owned, 'Band', 'Bände'));
  if (extras > 0) parts.push(tn('{n} Extras', '{n} Extras', extras));
  if (readState.read > 0) parts.push(readState.complete ? t('alle gelesen') : t('{read} von {owned} gelesen', { read: readState.read, owned: readState.owned }));
  else parts.push(t('ungelesen'));
  return parts.filter(Boolean).join(', ');
}

// a component, so the text is translated at render time (never t() at module scope)
function CoverFallback() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 p-4 text-center">
      <BookOpen className="w-10 h-10 mb-2 opacity-50 text-slate-500" />
      <span className="text-xs text-slate-400">{t('Kein Cover')}</span>
    </div>
  );
}
const COVER_FALLBACK = <CoverFallback />;

// the wrapper is the positioned card; the link's ::after makes the whole card clickable
export const CARD_LINK_CLASS =
  'flex flex-col after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-brand-400';
export const CARD_TITLE_CLASS =
  'font-bold text-sm text-white line-clamp-2 min-h-[2.5rem] leading-snug break-words hyphens-auto [overflow-wrap:anywhere] group-hover:text-brand-400 transition-colors';
// above the link's overlay; the gaps between the names still open the series
export const CARD_AUTHORS_CLASS = 'relative z-[1] pointer-events-none mt-0.5 flex flex-wrap gap-x-1 text-xs text-slate-400';
const AUTHOR_BUTTON_CLASS = 'hit-44 pointer-events-auto text-left break-words';

/** Author names as buttons that filter the shelf; one per name of the author field. */
export function AuthorButtons({ names, onAuthorClick, buttonClassName = '' }) {
  return names.map((name, i) => (
    <span key={`${name}-${i}`} className={buttonClassName ? 'min-w-0 max-w-full' : undefined}>
      <button
        type="button"
        onClick={() => onAuthorClick(name)}
        className={`hover:text-brand-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded ${buttonClassName}`}
        title={t('Alle Reihen von {name}', { name })}
      >
        {name}
        {/* inside the button, so a wrapped name keeps its comma; not part of the name */}
        {i < names.length - 1 && <span aria-hidden="true">,</span>}
      </button>
      {i < names.length - 1 && ' '}
    </span>
  ));
}

/**
 * One grid card inside the grid's wrapper, which draws the card frame. The link covers the whole card (::after), the
 * author buttons sit above it inside the frame (no button inside a link).
 */
function MangaCard({ manga, getStatusBadge, onAuthorClick }) {
  const progress = getSeriesProgress(manga);
  const { owned, total, extras, pct } = progress;
  const readState = getReadState(manga);
  const titleId = `manga-card-${manga.id}-title`;
  const summaryId = `manga-card-${manga.id}-summary`;
  const authorId = `manga-card-${manga.id}-author`;
  const authors = onAuthorClick ? splitAuthors(manga.author) : [];
  const defaultLanguage = useDefaultLanguage();

  return (
    <>
      <Link
        to={`/manga/${manga.id}`}
        aria-labelledby={authors.length ? titleId : `${titleId} ${authorId}`}
        aria-describedby={summaryId}
        className={CARD_LINK_CLASS}
      >
        <div className="aspect-[2/3] bg-slate-950 relative overflow-hidden rounded-t-2xl">
          <CoverImage
            src={manga.cover_image}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            fallback={COVER_FALLBACK}
          />

          <span id={summaryId} className="sr-only">{seriesSummary(manga, progress, readState, defaultLanguage)}</span>
          <div aria-hidden="true" className="absolute top-2 left-2 right-2 flex justify-between items-start gap-1 pointer-events-none min-w-0">
            <span className="rounded-full bg-slate-950/85 shrink min-w-0 flex items-center gap-1">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wide lg:tracking-wider border truncate ${getStatusBadge(manga.status)}`}>
                {mangaStatusLabel(manga.status)}
              </span>
              <LanguagePill language={editionLanguage(manga)} />
            </span>

            <span className="bg-slate-950/85 border border-slate-800 text-white text-[11px] font-bold px-1.5 py-0.5 rounded-lg shrink-0 whitespace-nowrap">
              {owned} {total > 0 ? `/ ${total}` : t('Bde.')}{extras > 0 ? ` +${extras}` : ''}
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

        <div className="px-3.5 pt-3.5">
          <h3 id={titleId} lang={langFor(manga.title) || 'de'} className={CARD_TITLE_CLASS} title={manga.title}>
            {manga.title}
          </h3>
          {!authors.length && (
            <p id={authorId} className="text-xs text-slate-400 truncate mt-0.5" title={manga.author || ''}>
              {manga.author || t('Kein Autor')}
            </p>
          )}
        </div>
      </Link>

      <div className="px-3.5 pb-3.5 flex flex-col flex-1 justify-between">
        <div>
          {authors.length > 0 && (
            <p className={CARD_AUTHORS_CLASS}>
              <AuthorButtons names={authors} onAuthorClick={onAuthorClick} buttonClassName={AUTHOR_BUTTON_CLASS} />
            </p>
          )}
          {manga.publisher && (
            <p className="text-[11px] text-slate-400 flex items-center gap-1 mt-1 truncate" title={t('Verlag: {publisher}', { publisher: manga.publisher })}>
              <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{manga.publisher}</span>
            </p>
          )}
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[11px]">
          {manga.total_value > 0 ? (
            <span className="font-mono font-bold text-emerald-400 flex items-center gap-1 whitespace-nowrap">
              <Coins className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              {formatMoney(manga.total_value, editionCurrency(manga))}
            </span>
          ) : (
            <span className="text-slate-400">
              {pct !== null ? t('{pct}% komplett', { pct }) : formatCount(owned, 'Band', 'Bände')}
            </span>
          )}
          <span aria-hidden="true" className="text-brand-400 font-semibold group-hover:translate-x-0.5 transition-transform whitespace-nowrap">{t('Details →')}</span>
        </div>
      </div>
    </>
  );
}

export default memo(MangaCard);
