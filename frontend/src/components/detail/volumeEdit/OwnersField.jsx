import { useEffect, useId, useState } from 'react';
import { Users } from 'lucide-react';
import { ApiError, apiFetch, readJson } from '../../../utils/api';
import { notify } from '../../../utils/notify';
import { t } from '../../../i18n/index.js';
import { serverText } from '../../../i18n/serverText.js';

const hasKey = (obj, key) => Boolean(obj) && Object.hasOwn(obj, key);

/**
 * Body that reverses one owners answer: an un-own comes back with the removed row's price and date, a buy goes again;
 * both put the volume's purchase date back (previous_purchase_date). null when the answer cannot be reversed.
 */
export function ownersUndoBody(data, wasOwned, target = {}) {
  const restoreDate = hasKey(data, 'previous_purchase_date') ? { previous_purchase_date: data.previous_purchase_date ?? null } : {};
  if (!wasOwned) return { owned: false, ...target, ...restoreDate };
  const removed = data?.removed_owner;
  if (!removed) return null;
  return {
    owned: true,
    ...target,
    ...(removed.price !== null && removed.price !== undefined ? { price: removed.price } : {}),
    ...(removed.purchase_date ? { purchase_date: removed.purchase_date } : {}),
    ...restoreDate
  };
}

/**
 * Owners of a volume (multi-user): everyone toggles their own, admins also others. Changes go straight to
 * POST /api/volumes/:id/owners; `onChanged` gets { status, owners } (the server derives the status), the toast offers undo.
 */
export default function OwnersField({ volumeId, owners: initialOwners, users, currentUser, onChanged }) {
  const [owners, setOwners] = useState(initialOwners || []);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const labelId = useId();

  useEffect(() => { setOwners(initialOwners || []); }, [initialOwners, volumeId]);

  if (!volumeId || !users || users.length < 2) return null;
  const isAdmin = currentUser?.role === 'admin';

  const send = async (u, body) => {
    setBusyId(u.user_id);
    try {
      const res = await apiFetch(`/api/volumes/${volumeId}/owners`, { method: 'POST', body });
      const data = (await readJson(res)) ?? {};
      if (!res.ok) throw new ApiError(serverText(data) || t('Fehler beim Speichern'), { status: res.status, ref: data.ref ?? null });
      setOwners(data.owners || []);
      return data;
    } finally {
      setBusyId(null);
    }
  };

  const undo = async (u, body) => {
    try {
      const data = await send(u, body);
      // the answer has no purchase_date: the restored one is what this request set
      const restored = hasKey(body, 'previous_purchase_date') ? { purchase_date: body.previous_purchase_date } : {};
      if (onChanged) onChanged({ ...data, ...restored });
    } catch (e) {
      notify.error(e, { fallback: t('Rückgängig machen fehlgeschlagen') });
    }
  };

  const toggle = async (u) => {
    const owned = owners.some(o => o.user_id === u.user_id);
    const target = u.user_id !== currentUser?.id ? { user_id: u.user_id } : {};
    setError('');
    let data;
    try {
      data = await send(u, { owned: !owned, ...target });
    } catch (e) {
      setError(e.message);
      return;
    }
    if (onChanged) onChanged(data);
    const undoBody = ownersUndoBody(data, owned, target);
    if (!undoBody) return;
    const name = u.display_name || u.username;
    notify.success(owned ? t('{name} besitzt den Band nicht mehr', { name }) : t('{name} als Besitzer eingetragen', { name }), {
      action: { label: t('Rückgängig'), onClick: () => undo(u, undoBody) }
    });
  };

  return (
    <div>
      <span id={labelId} className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
        <Users className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {t('Besitzer')}
      </span>
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
        {users.map(u => {
          const owned = owners.some(o => o.user_id === u.user_id);
          const canToggle = isAdmin || u.user_id === currentUser?.id;
          return (
            <button
              key={u.user_id}
              type="button"
              disabled={!canToggle || busyId === u.user_id}
              onClick={() => toggle(u)}
              aria-pressed={owned}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                owned
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                  : 'text-slate-400 border-slate-700 hover:text-slate-200'
              } ${canToggle ? '' : 'opacity-60 cursor-default'}`}
            >
              {u.display_name || u.username}
            </button>
          );
        })}
      </div>
      {error && <p role="alert" className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  );
}
