import { useEffect, useId, useState } from 'react';
import { Users } from 'lucide-react';
import { apiFetch, readJson } from '../../../utils/api';

/**
 * Besitzer eines Bandes (Mehrbenutzer). Jeder schaltet seinen eigenen Besitz um, Admins auch den der anderen.
 * Änderungen gehen sofort an POST /api/volumes/:id/owners, unabhängig vom Speichern-Knopf des Formulars.
 * onChanged bekommt die Antwort ({ status, owners }): der Server leitet daraus den Status des Bandes ab.
 */
export default function OwnersField({ volumeId, owners: initialOwners, users, currentUser, onChanged }) {
  const [owners, setOwners] = useState(initialOwners || []);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const labelId = useId();

  useEffect(() => { setOwners(initialOwners || []); }, [initialOwners, volumeId]);

  if (!volumeId || !users || users.length < 2) return null;
  const isAdmin = currentUser?.role === 'admin';

  const toggle = async (u) => {
    const owned = owners.some(o => o.user_id === u.user_id);
    setBusyId(u.user_id);
    setError('');
    try {
      const res = await apiFetch(`/api/volumes/${volumeId}/owners`, {
        method: 'POST',
        body: { owned: !owned, ...(u.user_id !== currentUser?.id ? { user_id: u.user_id } : {}) }
      });
      const data = (await readJson(res)) ?? {};
      if (!res.ok) throw new Error(data.error || 'Fehler beim Speichern');
      setOwners(data.owners || []);
      if (onChanged) onChanged(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <span id={labelId} className="block text-xs font-semibold text-slate-300 mb-1.5 flex items-center gap-1.5">
        <Users className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> Besitzer
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
