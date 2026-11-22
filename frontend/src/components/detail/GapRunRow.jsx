import { BookOpen, BuildingComplex, ChevronDown, CircleExclamationPoint, Coins, Layers, ShoppingCart } from 'lucide-react';
import { getRegularGapMeta } from '../../utils/volumeHelpers';
import { formatEuro, gapLabel } from './volumeViewHelpers';
import { t, tn } from '../../i18n/index.js';

/** Lowest and highest number, the price total and the publisher of a run of gaps (for the row and its tests). */
export function gapRunSummary(run, mpGapMap, manga) {
  const numbers = run.gaps.map((g) => g.gapNumber);
  const metas = run.gaps.map((g) => g.gapMeta || getRegularGapMeta(mpGapMap, g.gapNumber) || null);
  const prices = metas.map((m) => Number(m?.price)).filter((p) => Number.isFinite(p) && p > 0);
  const publisher = metas.find((m) => m?.publisher)?.publisher || manga?.publisher || '';
  return {
    low: Math.min(...numbers),
    high: Math.max(...numbers),
    count: numbers.length,
    total: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    publisher
  };
}

/**
 * One row for a run of missing volumes in the card or list view: "Band 9 bis 29 fehlen (21 Bände)" with the price
 * total, Aufklappen/Zuklappen for the single gaps, "In die Einkaufsliste" (only the gaps Manga Passion reports, as
 * "Alle auf Einkaufsliste" does) and "Mehrere erfassen" (the batch dialog with this range).
 */
export default function GapRunRow({
  run, variant = 'card', mpGapMap, manga, gapsOfficial, canEdit, isOffline = false, colSpan = 1,
  shoppingGapNumbers = null, fillDisabled = false, fillTitle, fillingGapLoading = false,
  onToggle, onToShopping, onAddRange
}) {
  const { low, high, count, total, publisher } = gapRunSummary(run, mpGapMap, manga);
  const shoppingNumbers = shoppingGapNumbers ? run.gaps.map((g) => g.gapNumber).filter((n) => shoppingGapNumbers.has(n)) : [];
  const title = t('Band {from} bis {to} fehlen', { from: low, to: high });
  const editable = canEdit && !isOffline;
  const toggleLabel = run.expanded
    ? t('Band {from} bis {to} zuklappen', { from: low, to: high })
    : t('Band {from} bis {to} einzeln zeigen', { from: low, to: high });

  const body = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full">
      <div className="hidden sm:flex -space-x-3 shrink-0" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="w-8 h-11 rounded-md border border-dashed border-amber-500/40 bg-amber-950/40 flex items-center justify-center">
            {i === 2 && <BookOpen className="w-3.5 h-3.5 text-amber-500/60" />}
          </div>
        ))}
      </div>
      <div className="flex flex-col min-w-0 flex-1 basis-48">
        <span className="font-bold text-amber-300 text-sm leading-tight">
          {title} <span className="font-normal text-amber-300/80">{tn('({n} Band)', '({n} Bände)', count)}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-bold text-amber-300 bg-amber-950/60 border border-amber-500/30">
            <CircleExclamationPoint className="w-3 h-3 text-amber-400" aria-hidden="true" />
            {gapLabel(gapsOfficial)}
          </span>
          {total !== null && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md font-mono font-bold text-emerald-300 bg-emerald-950/60 border border-emerald-500/30">
              <Coins className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              {t('zusammen {price}', { price: formatEuro(total) })}
            </span>
          )}
          {publisher && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-slate-300 bg-slate-800/70 border border-slate-700/60 max-w-full truncate">
              <BuildingComplex className="w-3 h-3 text-brand-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{publisher}</span>
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs ml-auto">
        <button
          type="button"
          onClick={() => onToggle?.(run.key)}
          aria-expanded={run.expanded}
          aria-label={toggleLabel}
          className="hit-44 px-3 py-1.5 rounded-xl bg-slate-900 text-slate-300 border border-slate-700 hover:text-white hover:border-slate-600 font-medium flex items-center gap-1.5 transition-all cursor-pointer"
        >
          <span>{run.expanded ? t('Zuklappen') : t('Aufklappen')}</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${run.expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        {editable && shoppingNumbers.length > 0 && (
          <button
            type="button"
            onClick={() => onToShopping?.(shoppingNumbers)}
            disabled={fillDisabled}
            title={fillTitle}
            className="hit-44 px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {fillingGapLoading
              ? <span aria-hidden="true" className="w-3 h-3 border-2 border-amber-300 border-t-transparent rounded-full animate-spin" />
              : <ShoppingCart className="w-3.5 h-3.5" aria-hidden="true" />}
            <span>{t('In die Einkaufsliste')}</span>
          </button>
        )}
        {editable && (
          <button
            type="button"
            onClick={() => onAddRange?.({ from: low, to: high })}
            className="hit-44 px-3 py-1.5 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('Mehrere erfassen')}</span>
          </button>
        )}
      </div>
    </div>
  );

  if (variant === 'row') {
    return (
      <tr data-gap-run={run.key} className="border-b border-amber-500/20 bg-amber-950/10">
        <td colSpan={colSpan} className="py-2.5 px-3">{body}</td>
      </tr>
    );
  }
  return (
    <div data-gap-run={run.key} className="col-span-full p-3 rounded-2xl border border-dashed border-amber-500/50 bg-slate-900/60 text-sm shadow-sm shadow-amber-950/20">
      {body}
    </div>
  );
}
