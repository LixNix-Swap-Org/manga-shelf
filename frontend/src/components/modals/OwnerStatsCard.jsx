import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fmtEuro, countLabel, cssPct } from './statsFormat';

function OwnerPublishers({ rows }) {
  return (
    <ul className="mt-2 space-y-1 pl-3 border-l border-slate-800">
      {rows.map(r => (
        <li key={r.publisher} className="flex justify-between gap-2 text-[11px]">
          <span className="text-slate-300 truncate">{r.publisher}</span>
          <span className="font-mono text-slate-400 shrink-0">{countLabel(r.volume_count, 'Band', 'Bände')} · {fmtEuro(r.total_value)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Ownership per user: volumes, series, value (list price) and how many volumes are shared with others; per owner
 * expandable by publisher (owner_publishers). Only with two or more users.
 */
export default function OwnerStatsCard({ ownerStats, ownerPublishers = [] }) {
  const [open, setOpen] = useState(() => new Set());
  const baseId = useId();
  if (!Array.isArray(ownerStats) || ownerStats.length < 2) return null;
  const max = Math.max(1, ...ownerStats.map(o => o.volume_count));
  const byUser = new Map();
  for (const row of Array.isArray(ownerPublishers) ? ownerPublishers : []) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }
  const toggle = (id) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const anyShared = ownerStats.some(o => o.shared_count > 0);

  return (
    <div id="stats-owners" className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
      <h3 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4">Besitz pro Nutzer</h3>
      <div className="space-y-3">
        {ownerStats.map(o => {
          const pubs = byUser.get(o.user_id) || [];
          const expanded = open.has(o.user_id);
          const listId = `${baseId}-${o.user_id}`;
          return (
            <div key={o.user_id}>
              <div className="flex justify-between text-xs mb-1 gap-2">
                <span className="font-semibold text-slate-200">{o.username}</span>
                <span className="text-slate-400 text-right">
                  {countLabel(o.volume_count, 'Band', 'Bände')} · {countLabel(o.series_count, 'Reihe', 'Reihen')} · {fmtEuro(o.total_value)}
                  {o.shared_count > 0 && <span className="text-amber-300"> · {o.shared_count} geteilt</span>}
                </span>
              </div>
              <div aria-hidden="true" className="h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                <div className="h-full bg-emerald-500/70" style={{ width: `${cssPct((o.volume_count / max) * 100)}%` }} />
              </div>
              {pubs.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={listId}
                    onClick={() => toggle(o.user_id)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300"
                  >
                    <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                    Verlage von {o.username}
                  </button>
                  {expanded && <div id={listId}><OwnerPublishers rows={pubs} /></div>}
                </>
              )}
            </div>
          );
        })}
      </div>
      {anyShared && (
        <p className="text-[10px] text-slate-400 mt-3">Geteilte Bände zählen bei jedem Besitzer voll; Wert = Listenpreis des Bands.</p>
      )}
    </div>
  );
}
