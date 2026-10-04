import { Clock, Coins, Heart, TrendingUp, Wallet } from 'lucide-react';
import { fmtNumber, fmtEuro, countLabel } from '../statsFormat';
import { t, tn } from '../../../i18n/index.js';
import { rich } from '../../../i18n/react.jsx';

/** The KPI cards of the overview: value, monthly spending, collecting time, value of every volume and the wishlist. */
export default function KpiCards({ summary, canEditStartDate, editingStartDate, onToggleStartDate }) {
  const totalOwnedVal = Number(summary.total_owned_value) || 0;
  const totalPossibleVal = Number(summary.total_possible_value) || 0;
  const avgMonthly = Number(summary.avg_monthly_spending) || 0;
  const avgPrice = Number(summary.avg_price_per_volume) || 0;
  const collMonths = summary.collection_months ?? 1;
  const collYearsText = fmtNumber(summary.collection_years ?? 0, 1);
  const collDays = summary.collection_days ?? 0;
  const ownedVols = summary.total_owned_volumes ?? 0;
  const unpricedVols = Math.max(0, ownedVols - (summary.priced_owned_volumes ?? ownedVols));
  const totalVolsRecorded = summary.total_volumes_recorded ?? 0;
  const wishedSeries = Number(summary.wished_series) || 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
      <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-950/40 via-slate-900/90 to-slate-950 border border-emerald-500/30 shadow-lg">
        <div className="flex items-center justify-between text-emerald-400 mb-2">
          <span className="text-xs font-bold uppercase tracking-wider">{t('Sammlungswert')}</span>
          <Coins className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="text-2xl font-extrabold text-white font-mono">{fmtEuro(totalOwnedVal)}</div>
        <p className="text-[11px] text-slate-400 mt-1">
          {unpricedVols > 0
            ? t('{volumes} im Besitz (Ø {price}/Band, {unpriced} ohne Preis)', { volumes: countLabel(ownedVols, 'Band', 'Bände'), price: fmtEuro(avgPrice), unpriced: fmtNumber(unpricedVols) })
            : t('{volumes} im Besitz (Ø {price}/Band)', { volumes: countLabel(ownedVols, 'Band', 'Bände'), price: fmtEuro(avgPrice) })}
        </p>
      </div>

      <div className="p-4 rounded-2xl bg-gradient-to-br from-sky-950/40 via-slate-900/90 to-slate-950 border border-sky-500/30 shadow-lg">
        <div className="flex items-center justify-between text-sky-400 mb-2">
          <span className="text-xs font-bold uppercase tracking-wider">{t('Monatsausgaben')}</span>
          <TrendingUp className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="text-2xl font-extrabold text-sky-300 font-mono">{fmtEuro(avgMonthly)}</div>
        <p className="text-[11px] text-slate-400 mt-1">{t('Durchschnitt pro Monat über {count}', { count: countLabel(collMonths, 'Monat', 'Monate') })}</p>
      </div>

      <div className="p-4 rounded-2xl bg-gradient-to-br from-amber-950/40 via-slate-900/90 to-slate-950 border border-amber-500/30 shadow-lg">
        <div className="flex items-center justify-between text-amber-400 mb-2">
          <span className="text-xs font-bold uppercase tracking-wider">{t('Sammelzeit')}</span>
          <Clock className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="text-2xl font-extrabold text-amber-300 font-mono">
          {tn('{n} Jahr', '{n} Jahre', collYearsText === '1' ? 1 : Number(summary.collection_years ?? 0), { n: collYearsText })}
        </div>
        <p className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
          <span>{t('{days} aktiv', { days: countLabel(collDays, 'Tag', 'Tage') })}</span>
          {canEditStartDate && (
            <button
              type="button"
              aria-expanded={editingStartDate}
              onClick={onToggleStartDate}
              className="text-amber-400 hover:text-amber-300 underline font-medium text-[10px]"
            >
              {editingStartDate ? t('Schließen') : t('Datum ändern')}
            </button>
          )}
        </p>
      </div>

      <div className="p-4 rounded-2xl bg-gradient-to-br from-purple-950/40 via-slate-900/90 to-slate-950 border border-purple-500/30 shadow-lg">
        <div className="flex items-center justify-between text-purple-400 mb-2">
          <span className="text-xs font-bold uppercase tracking-wider">{t('Vollständiger Wert')}</span>
          <Wallet className="w-4 h-4" aria-hidden="true" />
        </div>
        <div className="text-2xl font-extrabold text-purple-300 font-mono">{fmtEuro(totalPossibleVal)}</div>
        <p className="text-[11px] text-slate-400 mt-1">
          {tn(
            'Wert des {n} erfassten Bands (jeder Status)',
            'Gesamtwert aller {n} erfassten Bände (jeder Status)',
            totalVolsRecorded,
            { n: fmtNumber(totalVolsRecorded) }
          )}
        </p>
      </div>

      {wishedSeries > 0 && (
        <div id="stats-wishlist" className="sm:col-span-2 lg:col-span-4 px-4 py-3 rounded-2xl bg-gradient-to-r from-rose-950/30 via-slate-900/90 to-slate-950 border border-rose-500/30 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-rose-300 text-xs font-bold uppercase tracking-wider">
            <Heart className="w-4 h-4" aria-hidden="true" /> {t('Wunschliste')}
          </span>
          <span className="text-sm text-slate-200">
            {rich('{series} · {cost} bekannt', {
              series: <strong className="font-mono text-white">{countLabel(wishedSeries, 'Reihe', 'Reihen')}</strong>,
              cost: <span className="font-mono text-rose-200">{fmtEuro(summary.wished_known_cost)}</span>
            })}
          </span>
        </div>
      )}
    </div>
  );
}
