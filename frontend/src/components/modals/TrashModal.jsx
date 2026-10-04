import { useCallback, useEffect, useState } from 'react';
import { BookOpen, RotateCcw, Trash2 } from 'lucide-react';
import ToolDialog from './ToolDialog';
import CoverImage from '../common/CoverImage';
import api from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatCount, formatDate, formatDateTime } from '../../utils/format';
import { getVolumeDisplayTitle } from '../../utils/volumeHelpers';

const sqlTime = (value) => new Date(String(value || '').replace(' ', 'T') + 'Z');

/** "Reihe · 12 Bände" or "Band 3" for one trash entry. */
export function trashEntryLabel(item) {
  if (item.kind === 'manga') return `Reihe · ${formatCount(item.volume_count || 0, 'Eintrag', 'Einträge')}`;
  return getVolumeDisplayTitle({ volume_number: item.volume_number, type: item.type });
}

/**
 * Papierkorb: deleted series and volumes of the last 30 days. Editors restore or delete an entry for good, admins empty
 * the whole trash. `onChanged` runs after every change (the dashboard reloads its lists).
 */
export default function TrashModal({ onClose, user, onChanged }) {
  const canEdit = Boolean(user) && (user.role === 'admin' || user.role === 'editor');
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get('/api/trash'));
    } catch (e) {
      setError(e?.message || 'Papierkorb konnte nicht geladen werden.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (id, action) => {
    setBusyId(id);
    try {
      await action();
      onChanged?.();
      await load();
    } catch (e) {
      notify.error(e, { fallback: 'Aktion fehlgeschlagen' });
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const restore = (item) => run(item.id, async () => {
    await api.post(`/api/trash/${item.id}/restore`);
    notify.success(item.kind === 'manga' ? `„${item.title}“ wiederhergestellt` : `${trashEntryLabel(item)} von „${item.title}“ wiederhergestellt`);
  });
  const purge = (item) => run(item.id, () => api.del(`/api/trash/${item.id}`));
  const empty = () => run('all', async () => {
    const res = await api.del('/api/trash');
    notify.success(`${formatCount(res?.removed || 0, 'Eintrag', 'Einträge')} endgültig gelöscht`);
  });

  const items = data?.items || [];
  const days = data?.retention_days || 30;

  return (
    <ToolDialog
      id="trash-modal"
      title="Papierkorb"
      subtitle={`Gelöschte Reihen und Bände bleiben ${days} Tage wiederherstellbar, mit Besitz und Lesestand.`}
      Icon={Trash2}
      onClose={onClose}
      busy={busyId !== null}
      footer={isAdmin && items.length > 0 && (
        confirmId === 'all' ? (
          <button type="button" onClick={empty} className="btn-danger text-xs px-4 py-2" disabled={busyId !== null}>
            Wirklich alles endgültig löschen?
          </button>
        ) : (
          <button type="button" onClick={() => setConfirmId('all')} className="btn-secondary text-xs px-4 py-2 text-rose-300">
            Papierkorb leeren
          </button>
        )
      )}
    >
      {error ? (
        <div role="alert" className="py-10 text-center space-y-3">
          <p className="text-sm text-rose-300">{error}</p>
          <button type="button" onClick={load} className="btn-secondary text-xs px-4 py-2">Erneut versuchen</button>
        </div>
      ) : !data ? (
        <p role="status" className="py-10 text-center text-sm text-slate-400">Papierkorb wird geladen…</p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">Der Papierkorb ist leer.</p>
      ) : (
        <ul className="space-y-2" aria-label="Gelöschte Einträge">
          {items.map((item) => (
            <li key={item.id} className="trash-entry flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
              <CoverImage
                src={item.cover_image}
                className="w-10 h-14 rounded object-cover shrink-0"
                fallback={<div className="w-10 h-14 rounded bg-slate-800 flex items-center justify-center text-slate-400 shrink-0"><BookOpen className="w-4 h-4" aria-hidden="true" /></div>}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-white truncate">{item.title || 'Ohne Titel'}</p>
                <p className="text-xs text-slate-300">{trashEntryLabel(item)}</p>
                <p className="text-[11px] text-slate-400">
                  Gelöscht {formatDateTime(sqlTime(item.deleted_at))}{item.deleted_by_name ? ` von ${item.deleted_by_name}` : ''}
                  {item.purge_at ? ` · endgültig weg am ${formatDate(item.purge_at)}` : ''}
                </p>
                {!item.restorable && (
                  <p className="text-[11px] text-amber-300">
                    {item.series_in_trash ? 'Die Reihe liegt im Papierkorb – zuerst die Reihe wiederherstellen.' : 'Die Reihe gibt es nicht mehr.'}
                  </p>
                )}
              </div>
              {canEdit && (
                <div className="flex flex-col sm:flex-row gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => restore(item)}
                    disabled={!item.restorable || busyId !== null}
                    className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5"
                    aria-label={`„${item.title}“ ${trashEntryLabel(item)} wiederherstellen`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Wiederherstellen
                  </button>
                  {confirmId === item.id ? (
                    <button type="button" onClick={() => purge(item)} disabled={busyId !== null} className="btn-danger text-xs px-3 py-1.5">
                      Wirklich löschen?
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(item.id)}
                      disabled={busyId !== null}
                      className="btn-secondary text-xs px-3 py-1.5 text-rose-300"
                      aria-label={`„${item.title}“ ${trashEntryLabel(item)} endgültig löschen`}
                    >
                      Endgültig löschen
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </ToolDialog>
  );
}
