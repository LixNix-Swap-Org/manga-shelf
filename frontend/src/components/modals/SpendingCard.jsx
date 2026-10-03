const euro = (n) => (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** Ausgaben nach Kaufdatum: letzte 12 Monate als Balken, Jahressummen und Bände ohne Kaufdatum. */
export default function SpendingCard({ spending }) {
  if (!spending) return null;
  const { by_month: months = [], by_year: years = [], without_date: none } = spending;
  const max = Math.max(1, ...months.map(m => m.total));
  const hasData = years.length > 0;
  return (
    <div id="stats-spending" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4">Ausgaben nach Kaufdatum</h4>
      {!hasData ? (
        <p className="text-xs text-slate-500">Noch keine Käufe mit Kaufdatum erfasst.</p>
      ) : (
        <div className="space-y-5">
          <div>
            <p className="text-[11px] text-slate-400 mb-2">Letzte 12 Monate</p>
            <div className="flex items-end gap-1.5 h-28" role="img" aria-label="Ausgaben der letzten 12 Monate">
              {months.map(m => (
                <div key={m.month} className="flex-1 flex flex-col items-center justify-end h-full min-w-0" title={`${m.month}: ${euro(m.total)} € (${m.volumes} Bände)`}>
                  <div className="w-full bg-emerald-500/70 rounded-t" style={{ height: `${(m.total / max) * 100}%`, minHeight: m.total > 0 ? 3 : 0 }} />
                  <span className="text-[9px] text-slate-500 mt-1">{MONTHS[Number(m.month.slice(5, 7)) - 1]}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            {[...years].reverse().map(y => (
              <div key={y.year} className="flex justify-between text-xs">
                <span className="text-slate-300 font-semibold">{y.year}</span>
                <span className="font-mono text-slate-400"><strong className="text-emerald-400">{euro(y.total)} €</strong> · {y.volumes} Bände</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {none && none.volumes > 0 && (
        <p className="text-[11px] text-slate-500 mt-3">{none.volumes} Bände ({euro(none.total)} €) haben kein Kaufdatum und fehlen hier.</p>
      )}
    </div>
  );
}
