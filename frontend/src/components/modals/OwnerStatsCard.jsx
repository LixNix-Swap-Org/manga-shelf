const euro = (n) => (n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Besitz pro Benutzer: Bände, Reihen, Wert und wie viele Bände doppelt (mit anderen geteilt) vorhanden sind. Nur ab zwei Nutzern. */
export default function OwnerStatsCard({ ownerStats }) {
  if (!Array.isArray(ownerStats) || ownerStats.length < 2) return null;
  const max = Math.max(1, ...ownerStats.map(o => o.volume_count));
  return (
    <div id="stats-owners" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4">Besitz pro Nutzer</h4>
      <div className="space-y-3">
        {ownerStats.map(o => (
          <div key={o.user_id}>
            <div className="flex justify-between text-xs mb-1">
              <span className="font-semibold text-slate-200">{o.username}</span>
              <span className="text-slate-400">
                {o.volume_count} Bände · {o.series_count} Reihen · {euro(o.total_value)} €
                {o.shared_count > 0 && <span className="text-amber-300"> · {o.shared_count} doppelt</span>}
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
              <div className="h-full bg-emerald-500/70" style={{ width: `${(o.volume_count / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
