import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { BuildingComplex, GitMerge, X } from 'lucide-react';
import ToolDialog from './ToolDialog';
import api from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatCount } from '../../utils/format';
import { foldText } from '../../utils/search';

/** Target the merge suggests: the selected spelling with the most series and volumes. */
export function suggestedTarget(publishers, selected) {
  const chosen = publishers.filter(p => selected.includes(p.name));
  if (!chosen.length) return '';
  const best = [...chosen].sort((a, b) => (b.series_count + b.volume_count) - (a.series_count + a.volume_count))[0];
  return best.canonical || best.name;
}

/**
 * Verlage zusammenführen (admins): selected spellings are merged into one name. The server remembers them as
 * aliases, so new scans and imports land on the same name. `onChanged` runs after a merge.
 */
export default function PublishersModal({ onClose, user, onChanged }) {
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const filterId = useId();
  const targetId = useId();
  const listId = useId();

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get('/api/publishers'));
    } catch (e) {
      setError(e?.message || 'Verlage konnten nicht geladen werden.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const publishers = useMemo(() => data?.publishers || [], [data]);
  const visible = useMemo(() => {
    const q = foldText(filter).trim();
    return q ? publishers.filter(p => foldText(p.name).includes(q) || foldText(p.canonical).includes(q)) : publishers;
  }, [publishers, filter]);

  const toggle = (name) => {
    const next = selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name];
    setSelected(next);
    if (!target || selected.length === 0) setTarget(suggestedTarget(publishers, next));
  };

  const cleanTarget = target.replace(/\s+/g, ' ').trim();
  const from = selected.filter(n => n !== cleanTarget);
  const isRename = from.length === 1 && !publishers.some(p => p.name === cleanTarget);
  const canMerge = isAdmin && Boolean(cleanTarget) && from.length > 0;

  const merge = async () => {
    setBusy(true);
    try {
      const res = await api.post('/api/publishers/merge', { from, to: cleanTarget });
      notify.success(`${formatCount(res.updated_series, 'Reihe', 'Reihen')} und ${formatCount(res.updated_volumes, 'Band', 'Bände')} auf „${res.to}“ umgestellt`);
      setSelected([]);
      setTarget('');
      onChanged?.();
      await load();
    } catch (e) {
      notify.error(e, { fallback: 'Zusammenführen fehlgeschlagen' });
    } finally {
      setBusy(false);
    }
  };

  const removeAlias = async (alias) => {
    setBusy(true);
    try {
      await api.del(`/api/publishers/aliases/${encodeURIComponent(alias)}`);
      await load();
    } catch (e) {
      notify.error(e, { fallback: 'Alias konnte nicht entfernt werden' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolDialog
      id="publishers-modal"
      title="Verlage zusammenführen"
      subtitle="Verschiedene Schreibweisen eines Verlags zu einem Namen zusammenfassen oder einen Verlag umbenennen."
      Icon={BuildingComplex}
      onClose={onClose}
      busy={busy}
    >
      {error ? (
        <div role="alert" className="py-10 text-center space-y-3">
          <p className="text-sm text-rose-300">{error}</p>
          <button type="button" onClick={load} className="btn-secondary text-xs px-4 py-2">Erneut versuchen</button>
        </div>
      ) : !data ? (
        <p role="status" className="py-10 text-center text-sm text-slate-400">Verlage werden geladen…</p>
      ) : (
        <div className="space-y-4">
          {isAdmin && (
            <div className="p-3 rounded-2xl border border-brand-500/40 bg-slate-950/80 space-y-2">
              <label htmlFor={targetId} className="block text-xs font-semibold text-slate-300">
                {selected.length ? `${formatCount(selected.length, 'Schreibweise', 'Schreibweisen')} ausgewählt – zusammenführen als` : 'Schreibweisen unten auswählen, dann den gemeinsamen Namen festlegen'}
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id={targetId}
                  list={listId}
                  className="input-field flex-1 min-w-[180px]"
                  value={target}
                  maxLength={300}
                  onChange={e => setTarget(e.target.value)}
                  placeholder="Gemeinsamer Verlagsname"
                />
                <datalist id={listId}>
                  {publishers.map(p => <option key={p.name} value={p.canonical} />)}
                </datalist>
                <button type="button" onClick={merge} disabled={!canMerge || busy} className="btn-primary text-xs px-4 py-2 flex items-center gap-1.5">
                  <GitMerge className="w-3.5 h-3.5" aria-hidden="true" /> {isRename ? 'Umbenennen' : 'Zusammenführen'}
                </button>
              </div>
              <p className="text-[11px] text-slate-400">Alle Reihen und Bände mit diesen Schreibweisen werden umgestellt; spätere Scans und Importe übernehmen den Namen automatisch.</p>
            </div>
          )}

          <label htmlFor={filterId} className="sr-only">Verlage filtern</label>
          <input id={filterId} type="search" className="input-field" placeholder="Verlag suchen…" value={filter} onChange={e => setFilter(e.target.value)} />

          <ul className="space-y-1" aria-label="Verlage in der Sammlung">
            {visible.map(p => (
              <li key={p.name} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm">
                {isAdmin && (
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-brand-500"
                    checked={selected.includes(p.name)}
                    onChange={() => toggle(p.name)}
                    aria-label={`${p.name} auswählen`}
                  />
                )}
                <span className="flex-1 min-w-0">
                  <span className="text-white font-medium break-words">{p.name}</span>
                  {p.outdated && <span className="ml-2 text-[11px] text-amber-300">→ {p.canonical}</span>}
                  {!p.known && !p.outdated && <span className="ml-2 text-[10px] rounded px-1.5 py-0.5 bg-slate-800 text-slate-400">nicht in der Verlagsliste</span>}
                </span>
                <span className="text-[11px] text-slate-400 font-mono shrink-0">
                  {formatCount(p.series_count, 'Reihe', 'Reihen')} · {formatCount(p.volume_count, 'Band', 'Bände')}
                </span>
              </li>
            ))}
            {visible.length === 0 && <li className="text-xs text-slate-400 py-4 text-center">Kein Verlag gefunden.</li>}
          </ul>

          {data.aliases?.length > 0 && (
            <details className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
              <summary className="text-xs font-semibold text-slate-300 cursor-pointer">Gespeicherte Schreibweisen ({data.aliases.length})</summary>
              <ul className="mt-2 space-y-1">
                {data.aliases.map(a => (
                  <li key={a.alias} className="flex items-center gap-2 text-xs text-slate-300">
                    <span className="font-mono text-slate-400">{a.alias}</span> → <span className="text-white">{a.canonical}</span>
                    {isAdmin && (
                      <button type="button" onClick={() => removeAlias(a.alias)} disabled={busy} className="ml-auto text-slate-400 hover:text-rose-300" aria-label={`Schreibweise „${a.alias}“ entfernen`}>
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </ToolDialog>
  );
}
