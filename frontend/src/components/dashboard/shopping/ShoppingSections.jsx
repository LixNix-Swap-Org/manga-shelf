// Parts of the shopping list: print sheet, load progress and the wished series (split from ShoppingListView.jsx).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { formatCount, formatMoney, formatNumber } from '../../../utils/format';
import { editionCurrency } from '../../../utils/editions';
import { groupByPublisher, itemText, publisherLabel } from '../../../utils/shareList';
import { PRIORITY_LABELS, priorityBadgeClass, wishersText, canDropWish } from '../../../utils/priority';
import CoverImage from '../../common/CoverImage';
import { BookOpen, BuildingComplex, Heart } from 'lucide-react';
import { t } from '../../../i18n/index.js';

// MangaDetail's back link returns here instead of the shelf
export const FROM_SHOPPING = { from: '/?view=shopping' };

export const COVER_FALLBACK = (
  <div className="w-16 h-24 bg-slate-800 rounded-xl flex items-center justify-center text-slate-400 border border-slate-700/60">
    <BookOpen className="w-6 h-6" aria-hidden="true" />
  </div>
);

export const PRINT_SHEET_ID = 'shopping-print-sheet';
export const PRINT_CSS = `
#${PRINT_SHEET_ID} { display: none; }
@media print {
  @page { margin: 15mm; }
  html, body { background: #fff !important; }
  body > *:not(#${PRINT_SHEET_ID}) { display: none !important; }
  #${PRINT_SHEET_ID} { display: block !important; color: #000; font: 11pt/1.4 system-ui, sans-serif; }
  #${PRINT_SHEET_ID} h1 { font-size: 16pt; font-weight: 700; margin: 0 0 2pt; }
  #${PRINT_SHEET_ID} h2 { font-size: 12pt; font-weight: 700; margin: 12pt 0 4pt; padding-bottom: 2pt; border-bottom: 1px solid #888; break-after: avoid; }
  #${PRINT_SHEET_ID} ul { list-style: none; margin: 0; padding: 0; }
  #${PRINT_SHEET_ID} li { padding: 1.5pt 0; break-inside: avoid; }
}`;

/** Print-only copy of the visible list, grouped by publisher; the app around it is hidden while printing. */
export function PrintSheet({ items, wished, normalizePubName, filtered, summary }) {
  return createPortal(
    <div id={PRINT_SHEET_ID}>
      {/* i18n-ignore: style sheet, no text */}
      <style>{PRINT_CSS}</style>
      <h1>{t('Einkaufsliste')}</h1>
      <p>{summary}{filtered ? t(' · gefiltert') : ''}</p>
      {groupByPublisher(items, normalizePubName).map((group) => (
        <section key={group.publisher}>
          <h2>{publisherLabel(group.publisher)}</h2>
          <ul>
            {group.items.map((item) => <li key={item.id}>☐ {itemText(item)}</li>)}
          </ul>
        </section>
      ))}
      {wished.length > 0 && (
        <section>
          <h2>{t('Gewünschte Reihen')}</h2>
          <ul>
            {wished.map((s) => <li key={s.id}>♡ {s.title}{s.publisher ? ` (${publisherLabel(s.publisher)})` : ''}</li>)}
          </ul>
        </section>
      )}
    </div>,
    document.body
  );
}

export function ListProgress({ shown, total, onMore, sentinelRef }) {
  return (
    <div ref={sentinelRef} className="mt-4 flex flex-col items-center gap-2 text-xs text-slate-400">
      <p>{t('Zeige {shown} von {total}', { shown: formatNumber(shown), total: formatNumber(total) })}</p>
      <button type="button" onClick={onMore} className="btn-secondary text-xs py-1.5 px-3">
        {t('Weitere anzeigen')}
      </button>
    </div>
  );
}

/** Wished series: a card per series with cover, publisher, priority, what is already known to be missing. */
export function WishedSeriesSection({ series: allSeries, canRemove, removing, onRemove }) {
  // wishes per person (migration 57): everybody's by default, "Nur meine" narrows to the own wishlist
  const [onlyMine, setOnlyMine] = useState(false);
  const hasOwn = allSeries.some((s) => s.my_wish !== null && s.my_wish !== undefined);
  const series = onlyMine ? allSeries.filter((s) => s.my_wish !== null && s.my_wish !== undefined) : allSeries;
  return (
    <section id="shop-wished-series" aria-labelledby="shop-wished-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="shop-wished-heading" className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <Heart className="w-4 h-4 text-rose-400" aria-hidden="true" />
          {t('Gewünschte Reihen')} <span className="text-xs font-normal text-slate-400">({series.length})</span>
        </h3>
        {(hasOwn || onlyMine) && (
          <button
            type="button"
            id="btn-shop-only-my-wishes"
            onClick={() => setOnlyMine((v) => !v)}
            aria-pressed={onlyMine}
            className={`text-xs px-3 py-1.5 rounded-xl border font-semibold transition-colors ${
              onlyMine ? 'bg-rose-500/20 text-rose-200 border-rose-500/50' : 'text-slate-400 border-slate-700 hover:text-slate-200'
            }`}
          >
            {t('Nur meine Wünsche')}
          </button>
        )}
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
        {series.map((s) => (
          <li key={s.id} className="glass-card rounded-2xl p-3 border border-rose-500/25 flex gap-3 bg-slate-900/60">
            <CoverImage
              src={s.cover_image}
              className="w-16 h-24 object-cover rounded-xl shadow-md border border-slate-800 shrink-0"
              fallback={COVER_FALLBACK}
            />
            <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
              <div>
                <p className="text-xs font-bold text-white line-clamp-2 break-words hyphens-auto" title={s.title}>{s.title}</p>
                <p className="text-[11px] text-slate-400 mt-1 truncate flex items-center gap-1">
                  <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" aria-hidden="true" />
                  <span className="truncate">{publisherLabel(s.publisher)}</span>
                </p>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-lg border ${priorityBadgeClass(s.wish_priority)}`} title={t('Wunsch-Priorität')}>
                    {s.wish_priority > 0 ? t(PRIORITY_LABELS[s.wish_priority]) : t('Wunsch')}
                  </span>
                  <span className="text-[11px] text-slate-300">
                    {s.known_missing_count > 0
                      ? t('{count} bekannt · {price}', { count: formatCount(s.known_missing_count, 'Band', 'Bände'), price: formatMoney(s.known_missing_cost, editionCurrency(s)) })
                      : t('Noch keine Bände bekannt')}
                  </span>
                </div>
                {wishersText(s.wishes) && (
                  <p className="text-[11px] text-rose-200/90 mt-1 break-words" data-wishers>
                    {t('Gewünscht von {names}', { names: wishersText(s.wishes) })}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 mt-2.5">
                <Link
                  to={`/manga/${s.id}`}
                  state={FROM_SHOPPING}
                  className="px-2.5 py-1.5 rounded-xl border border-brand-500/40 text-brand-300 hover:bg-brand-700 hover:text-white text-xs font-semibold"
                  aria-label={t('Zur Reihe {title}', { title: s.title })}
                >
                  {t('Zur Reihe')}
                </Link>
                {canRemove && canDropWish(s) && (
                  <button
                    type="button"
                    onClick={() => onRemove(s)}
                    disabled={removing.has(s.id)}
                    aria-busy={removing.has(s.id) || undefined}
                    aria-label={t('{title} von meiner Wunschliste nehmen', { title: s.title })}
                    className="px-2.5 py-1.5 rounded-xl border border-slate-700 text-slate-300 hover:text-white hover:border-rose-500/50 text-xs font-semibold disabled:opacity-50"
                  >
                    {t('Von meiner Wunschliste')}
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
