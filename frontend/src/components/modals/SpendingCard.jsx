import { useState } from 'react';
import { fmtEuro, countLabel, monthLabel, monthShort } from './statsFormat';

const hasPurchases = (m) => Boolean(m && (m.total > 0 || m.volumes > 0));
const monthSummary = (m, sep = ' · ') => `${monthLabel(m.month)}: ${fmtEuro(m.total)}${sep}${countLabel(m.volumes, 'Band', 'Bände')}`;

/** Spending by purchase date: last 12 months as bars, yearly totals, volumes with a purchase year only and without a purchase date. */
export default function SpendingCard({ spending }) {
  const [selectedMonth, setSelectedMonth] = useState(null);
  if (!spending) return null;
  const { by_month: months = [], by_year: years = [], year_only: yearOnly, without_date: none } = spending;
  const max = Math.max(1, ...months.map(m => m.total || 0));
  const hasData = years.length > 0;
  const recentEmpty = months.every(m => !hasPurchases(m));
  const active = months.find(m => m.month === selectedMonth)
    || [...months].reverse().find(hasPurchases)
    || months[months.length - 1];
  const range = months.length > 0 ? `${monthLabel(months[0].month)} – ${monthLabel(months[months.length - 1].month)}` : '';

  return (
    <div id="stats-spending" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4">Ausgaben nach Kaufdatum</h3>
      {!hasData ? (
        <p className="text-xs text-slate-400">Noch keine Käufe mit Kaufdatum erfasst.</p>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="text-[11px] text-slate-400 mb-2">Letzte 12 Monate{range && ` (${range})`}</p>
            {recentEmpty ? (
              <p className="text-xs text-slate-400">Keine Käufe in den letzten 12 Monaten.</p>
            ) : (
              <>
                <div className="flex items-end gap-1.5 h-28" role="group" aria-label={`Ausgaben je Monat, ${range}`}>
                  {months.map(m => {
                    const isActive = m.month === active?.month;
                    return (
                      <button
                        key={m.month}
                        type="button"
                        aria-label={monthSummary(m, ', ')}
                        aria-pressed={isActive}
                        title={monthSummary(m)}
                        onClick={() => setSelectedMonth(m.month)}
                        onFocus={() => setSelectedMonth(m.month)}
                        className="flex-1 flex flex-col items-center justify-end h-full min-w-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                      >
                        <span
                          aria-hidden="true"
                          className={`block w-full rounded-t ${isActive ? 'bg-emerald-400' : 'bg-emerald-500/70'}`}
                          style={{ height: `${((m.total || 0) / max) * 100}%`, minHeight: hasPurchases(m) ? 3 : 0 }}
                        />
                        <span aria-hidden="true" className={`text-[9px] mt-1 ${isActive ? 'text-emerald-300 font-semibold' : 'text-slate-400'}`}>
                          {monthShort(m.month)}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {active && (
                  <p className="text-[11px] text-slate-300 mt-2 font-mono" aria-live="polite">{monthSummary(active)}</p>
                )}
              </>
            )}
          </div>
          <div className="space-y-1.5">
            {[...years].reverse().map(y => (
              <div key={y.year} className="flex justify-between text-xs">
                <span className="text-slate-300 font-semibold">{y.year}</span>
                <span className="font-mono text-slate-400"><strong className="text-emerald-400">{fmtEuro(y.total)}</strong> · {countLabel(y.volumes, 'Band', 'Bände')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {yearOnly?.volumes > 0 && (
        <p className="text-[11px] text-slate-400 mt-3">
          {countLabel(yearOnly.volumes, 'Band', 'Bände')} ({fmtEuro(yearOnly.total)}) {yearOnly.volumes === 1 ? 'hat nur ein Kaufjahr und fehlt' : 'haben nur ein Kaufjahr und fehlen'} im Monatsdiagramm.
        </p>
      )}
      {none?.volumes > 0 && (
        <p className="text-[11px] text-slate-400 mt-3">
          {countLabel(none.volumes, 'Band', 'Bände')} ({fmtEuro(none.total)}) {none.volumes === 1 ? 'hat kein verwertbares Kaufdatum und fehlt' : 'haben kein verwertbares Kaufdatum und fehlen'} hier.
        </p>
      )}
    </div>
  );
}
