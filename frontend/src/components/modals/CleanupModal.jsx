import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrushCleaning, CircleCheck } from 'lucide-react';
import ToolDialog from './ToolDialog';
import api from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatCount, formatDate } from '../../utils/format';
import { getVolumeDisplayTitle } from '../../utils/volumeHelpers';

export const CHECKS = {
  duplicate_titles: { label: 'Gleicher Titel mehrfach', hint: 'Oft eine zweite Ausgabe – sonst ein Doppel, das zusammengehört.', kind: 'groups' },
  series_without_cover: { label: 'Reihen ohne Cover', kind: 'series' },
  series_without_mp_link: { label: 'Reihen ohne Manga-Passion-Verknüpfung', hint: 'Ohne Verknüpfung gibt es keine Lückenprüfung und keine Erscheinungstermine.', kind: 'series' },
  series_without_author: { label: 'Reihen ohne Autor', kind: 'series' },
  series_without_total: { label: 'Reihen ohne Gesamtbände', kind: 'series' },
  volumes_without_price: { label: 'Vorhandene Bände ohne Preis', hint: 'Fehlen im Sammlungswert.', kind: 'volumes' },
  volumes_without_purchase_date: { label: 'Vorhandene Bände ohne Kaufdatum', hint: 'Fehlen in den Monatsausgaben.', kind: 'volumes' },
  volumes_without_isbn: { label: 'Vorhandene Bände ohne ISBN', hint: 'Werden beim Scannen im Laden nicht erkannt.', kind: 'volumes' },
  invalid_isbns: { label: 'Ungültige ISBNs', hint: 'Prüfziffer falsch oder keine Buchnummer.', kind: 'volumes' },
  overdue_preorders: { label: 'Vorbestellungen, vermutlich erschienen', hint: 'Der Erscheinungstag ist vorbei.', kind: 'volumes' },
  legacy_read_status: { label: 'Alter Status „Gelesen“', hint: 'Wird zu „Vorhanden“ plus Lesestand.', kind: 'volumes' },
  publishers_outdated: { label: 'Verlage in alter Schreibweise', kind: 'publishers' },
  publishers_unknown: { label: 'Verlage außerhalb der Verlagsliste', hint: 'Ein Tippfehler oder eine Schreibweise, die zusammengeführt werden sollte?', kind: 'publishers' }
};

const FIX_LABELS = { legacy_read: 'Jetzt umstellen', normalize_publishers: 'Schreibweisen vereinheitlichen' };

function Items({ check, onNavigate }) {
  const kind = CHECKS[check.id]?.kind;
  const seriesLink = (id, text) => <Link to={`/manga/${id}`} onClick={onNavigate} className="text-brand-300 hover:text-brand-200 underline-offset-2 hover:underline">{text}</Link>;
  return (
    <ul className="mt-2 space-y-1 text-xs text-slate-300">
      {check.items.map((item) => {
        if (kind === 'groups') {
          return (
            <li key={item.key}>
              {item.series.map((s, i) => (
                <span key={s.id}>{i > 0 && ' · '}{seriesLink(s.id, `${s.title}${s.publisher ? ` (${s.publisher})` : ''}`)}</span>
              ))}
            </li>
          );
        }
        if (kind === 'series') return <li key={item.id}>{seriesLink(item.id, item.title)}{item.publisher ? <span className="text-slate-400"> · {item.publisher}</span> : null}</li>;
        if (kind === 'publishers') {
          return (
            <li key={item.name}>
              {item.name}{item.canonical ? <> → <strong className="text-white">{item.canonical}</strong></> : null}
              <span className="text-slate-400"> · {formatCount(item.series_count, 'Reihe', 'Reihen')}, {formatCount(item.volume_count, 'Band', 'Bände')}</span>
            </li>
          );
        }
        return (
          <li key={item.id}>
            {seriesLink(item.manga_id, item.title)} · {getVolumeDisplayTitle(item)}
            {item.isbn && check.id === 'invalid_isbns' ? <span className="font-mono text-slate-400"> · {item.isbn}</span> : null}
            {item.release_date && check.id === 'overdue_preorders' ? <span className="text-slate-400"> · erschienen {formatDate(item.release_date)}</span> : null}
          </li>
        );
      })}
      {check.count > check.items.length && <li className="text-slate-400">… und {formatCount(check.count - check.items.length, 'weiterer', 'weitere')}</li>}
    </ul>
  );
}

/**
 * Sammlung aufräumen (GET /api/maintenance/quality): what is incomplete or inconsistent, with links to the series and
 * one-click fixes where they are safe. `onOpenPublishers` opens the merge screen (admins); `onChanged` runs after a fix.
 */
export default function CleanupModal({ onClose, user, onChanged, onOpenPublishers, onNavigate }) {
  const canEdit = Boolean(user) && (user.role === 'admin' || user.role === 'editor');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get('/api/maintenance/quality'));
    } catch (e) {
      setError(e?.message || 'Prüfung konnte nicht geladen werden.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (id, action) => {
    setBusy(id);
    try {
      await action();
      onChanged?.();
      await load();
    } catch (e) {
      notify.error(e, { fallback: 'Korrektur fehlgeschlagen' });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const fix = (check) => run(check.id, async () => {
    const res = await api.post('/api/maintenance/fix', { check: check.fix });
    notify.success(`${formatCount(res.changed, 'Eintrag', 'Einträge')} korrigiert`);
  });
  const markOwned = (check) => run(check.id, async () => {
    const res = await api.post('/api/volumes/bulk', { ids: check.items.map(v => v.id), set: { status: 'Vorhanden' } });
    notify.success(`${formatCount(res.updated, 'Band', 'Bände')} als vorhanden markiert`);
  });

  const checks = data?.checks || [];
  const open = checks.filter(c => c.count > 0);
  const done = checks.filter(c => c.count === 0);

  return (
    <ToolDialog
      id="cleanup-modal"
      title="Sammlung aufräumen"
      subtitle="Unvollständige oder uneinheitliche Daten auf einen Blick."
      Icon={BrushCleaning}
      onClose={onClose}
      busy={busy !== null}
    >
      {error ? (
        <div role="alert" className="py-10 text-center space-y-3">
          <p className="text-sm text-rose-300">{error}</p>
          <button type="button" onClick={load} className="btn-secondary text-xs px-4 py-2">Erneut versuchen</button>
        </div>
      ) : !data ? (
        <p role="status" className="py-10 text-center text-sm text-slate-400">Sammlung wird geprüft…</p>
      ) : (
        <div className="space-y-2">
          {open.length === 0 && <p className="py-6 text-center text-sm text-emerald-300">Alles aufgeräumt – keine Auffälligkeiten.</p>}
          {open.map((check) => {
            const meta = CHECKS[check.id] || { label: check.id };
            return (
              <details key={check.id} id={`quality-${check.id}`} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
                <summary className="flex flex-wrap items-center gap-2 cursor-pointer text-sm">
                  <span className="font-semibold text-white">{meta.label}</span>
                  <span className="text-[11px] rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2 py-0.5 font-mono">{check.count}</span>
                </summary>
                {meta.hint && <p className="text-[11px] text-slate-400 mt-1">{meta.hint}</p>}
                <div className="flex flex-wrap gap-2 mt-2">
                  {canEdit && check.fix && FIX_LABELS[check.fix] && (
                    <button type="button" onClick={() => fix(check)} disabled={busy !== null} className="btn-primary text-xs px-3 py-1.5">{FIX_LABELS[check.fix]}</button>
                  )}
                  {canEdit && check.id === 'overdue_preorders' && (
                    confirm === check.id ? (
                      <button type="button" onClick={() => markOwned(check)} disabled={busy !== null} className="btn-primary text-xs px-3 py-1.5">
                        {formatCount(check.items.length, 'Band', 'Bände')} wirklich als vorhanden markieren?
                      </button>
                    ) : (
                      <button type="button" onClick={() => setConfirm(check.id)} className="btn-secondary text-xs px-3 py-1.5">Als vorhanden markieren…</button>
                    )
                  )}
                  {user?.role === 'admin' && onOpenPublishers && check.id.startsWith('publishers_') && (
                    <button type="button" onClick={onOpenPublishers} className="btn-secondary text-xs px-3 py-1.5">Verlage zusammenführen…</button>
                  )}
                </div>
                <Items check={check} onNavigate={onNavigate} />
              </details>
            );
          })}
          {done.length > 0 && (
            <p className="text-[11px] text-slate-400 flex flex-wrap items-center gap-1.5 pt-2">
              <CircleCheck className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              In Ordnung: {done.map(c => CHECKS[c.id]?.label || c.id).join(' · ')}
            </p>
          )}
        </div>
      )}
    </ToolDialog>
  );
}
