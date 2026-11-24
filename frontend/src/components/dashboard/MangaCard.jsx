import { memo } from 'react';
import { BookCheck, BookOpen, BuildingComplex, Coins, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import CoverImage from '../common/CoverImage';
import { getSeriesProgress, getChapterProgress, isWebtoon } from '../../utils/volumeHelpers';
import { getReadState, seriesOwners } from '../../utils/collectionHelpers';
import { ownerColor, readerInitials } from '../detail/OwnerBadges';
import { formatCount, formatMoney, formatNumber } from '../../utils/format';
import { splitAuthors } from '../../utils/seriesMeta';
import { langFor } from '../common/lang';
import { t, tn } from '../../i18n/index.js';
import { mangaStatusLabel } from '../../utils/enumLabels.js';
import LanguagePill, { useDefaultLanguage } from '../common/LanguagePill';
import WebtoonPill from '../common/WebtoonPill';
import { editionCurrency, editionLanguage, editionName, editionRegion } from '../../utils/editions';

/** What the card shows as badges and progress bar, as one sentence for screen readers. */
export function seriesSummary(manga, { owned, total, extras }, readState, defaultLanguage = null) {
  const parts = [mangaStatusLabel(manga.status)];
  const language = editionLanguage(manga);
  if (defaultLanguage && language !== defaultLanguage) parts.push(t('Ausgabe: {language}', { language: editionName(language, editionRegion(manga)) }));
  if (isWebtoon(manga)) {
    const chapters = getChapterProgress(manga);
    parts.push(t('Webtoon'));
    parts.push(chapters.total > 0
      ? tn('{read} von {n} Kapitel gelesen', '{read} von {n} Kapiteln gelesen', chapters.total, { read: formatNumber(chapters.read, 1) })
      : tn('{n} Kapitel gelesen', '{n} Kapitel gelesen', chapters.read));
    if (owned > 0) parts.push(formatCount(owned, 'Band', 'Bände'));
    return parts.filter(Boolean).join(', ');
  }
  parts.push(total > 0 ? t('{owned} von {volumes}', { owned, volumes: formatCount(total, 'Band', 'Bänden') }) : formatCount(owned, 'Band', 'Bände'));
  if (extras > 0) parts.push(tn('{n} Extra', '{n} Extras', extras));
  if (readState.read > 0) parts.push(readState.complete ? t('alle gelesen') : t('{read} von {owned} gelesen', { read: readState.read, owned: readState.owned }));
  else parts.push(t('ungelesen'));
  return parts.filter(Boolean).join(', ');
}

// a component, so the text is translated at render time (never t() at module scope)
function CoverFallback() {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-b from-slate-900 to-slate-950 p-4 text-center">
      <BookOpen className="w-10 h-10 mb-2 opacity-50 text-slate-400" />
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
/** Most people the owner row names before "+n". */
const OWNER_ROW_MAX = 3;

/**
 * Who owns volumes of the series and how many: the people icon, then the person's circle and volume count, most first
 * ("Ma 7 · Le 3 · +2"). Only on a shelf with more than one person; the title names everybody.
 */
export function SeriesOwnerRow({ manga }) {
  const owners = seriesOwners(manga).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  if (owners.length === 0) return null;
  const names = owners.map(o => (o.count == null ? o.name : `${o.name}: ${formatCount(o.count, 'Band', 'Bände')}`)).join(', ');
  const shown = owners.slice(0, OWNER_ROW_MAX);
  const rest = owners.length - shown.length;
  return (
    <p role="img" aria-label={t('Besitzer: {names}', { names })} title={t('Besitzer: {names}', { names })} data-series-owners
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-slate-200 min-w-0">
      <Users className="w-3 h-3 text-amber-400 shrink-0" aria-hidden="true" />
      {shown.map(o => (
        <span key={o.id} aria-hidden="true" className="inline-flex items-center gap-1">
          <span className="px-1 h-4 min-w-4 rounded-full text-[9px] font-bold flex items-center justify-center text-slate-950" style={{ background: ownerColor(o.id) }}>
            {readerInitials(o.name)}
          </span>
          {o.count != null && <span className="font-mono leading-none">{formatNumber(o.count)}</span>}
        </span>
      ))}
      {rest > 0 && <span aria-hidden="true" className="text-amber-300">+{formatNumber(rest)}</span>}
    </p>
  );
}

function MangaCard({ manga, getStatusBadge, onAuthorClick, showOwners = false }) {
  const progress = getSeriesProgress(manga);
  const { owned, total, extras, pct } = progress;
  // a webtoon counts chapters: its badge, bar and footer follow the caller's chapter progress
  const chapters = isWebtoon(manga) ? getChapterProgress(manga) : null;
  const barPct = chapters ? chapters.pct : pct;
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
              {chapters
                ? `${chapters.read}${chapters.total > 0 ? ` / ${chapters.total}` : ''} ${t('Kap.')}`
                : <>{owned} {total > 0 ? `/ ${total}` : (owned === 1 ? t('Band') : t('Bde.'))}{extras > 0 ? ` +${extras}` : ''}</>}
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

          {/* bottom left, the top row is full with status, language and count */}
          {chapters && (
            <span aria-hidden="true" className="absolute bottom-3 left-2 pointer-events-none">
              <WebtoonPill format={manga.format} />
            </span>
          )}

          {barPct !== null && (
            <div aria-hidden="true" className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/60">
              <div className={`h-full bg-gradient-to-r ${chapters ? 'from-teal-500 to-sky-400' : 'from-brand-500 to-emerald-400'} transition-all duration-500`} style={{ width: `${barPct}%` }} />
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
          {manga.publisher && manga.publisher !== 'Unbekannt' && ( // i18n-ignore: stored placeholder value
            <p className="text-[11px] text-slate-400 flex items-center gap-1 mt-1 truncate" title={t('Verlag: {publisher}', { publisher: manga.publisher })}>
              <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{manga.publisher}</span>
            </p>
          )}
          {showOwners && <SeriesOwnerRow manga={manga} />}
        </div>

        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[11px]">
          {manga.total_value > 0 ? (
            <span className="font-mono font-bold text-emerald-400 flex items-center gap-1 whitespace-nowrap">
              <Coins className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              {formatMoney(manga.total_value, editionCurrency(manga))}
            </span>
          ) : (
            <span className="text-slate-400">
              {chapters
                ? (chapters.pct !== null ? t('{pct}% gelesen', { pct: chapters.pct }) : tn('{n} Kapitel gelesen', '{n} Kapitel gelesen', chapters.read))
                : (pct !== null ? t('{pct}% komplett', { pct }) : formatCount(owned, 'Band', 'Bände'))}
            </span>
          )}
          <span aria-hidden="true" className="text-brand-400 font-semibold group-hover:translate-x-0.5 transition-transform whitespace-nowrap">{t('Details →')}</span>
        </div>
      </div>
    </>
  );
}

export default memo(MangaCard);
