import { useCallback, useEffect, useId, useState } from 'react';
import { Library, Pencil, Trash2, UserPlus } from 'lucide-react';
import ToolDialog from './ToolDialog';
import ConfirmDialog from './ConfirmDialog';
import api from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatCount } from '../../utils/format';
import { t } from '../../i18n/index.js';

const ROLES = ['owner', 'editor', 'viewer'];
const ROLE_LABEL = {
  owner: () => t('Besitzer'),
  editor: () => t('Bearbeiter'),
  viewer: () => t('Leser')
};

/**
 * Regale (shelves): every collection has members with a role. Owners rename, share and delete a shelf; everybody can
 * leave a shelf they do not own. `onChanged` runs after anything that changes what the shelf list shows.
 */
export default function ShelvesModal({ onClose, user, onChanged }) {
  const [shelves, setShelves] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(null);
  const [members, setMembers] = useState([]);
  const [newMember, setNewMember] = useState('');
  const [newRole, setNewRole] = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [shelfToDelete, setShelfToDelete] = useState(null);
  const [memberToRemove, setMemberToRemove] = useState(null);
  const [directory, setDirectory] = useState([]);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('#6366f1');
  const [renaming, setRenaming] = useState(false);
  const listId = useId();
  const renameId = useId();
  const colorId = useId();
  const nameId = useId();
  const memberId = useId();
  const roleId = useId();
  const canCreate = user?.role === 'admin' || user?.role === 'editor';

  const load = useCallback(async () => {
    setError(null);
    try {
      setShelves((await api.get('/api/shelves')).shelves);
    } catch (e) {
      setError(e?.message || t('Regale konnten nicht geladen werden.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openShelf = async (shelf) => {
    setOpen(shelf.id);
    setMembers([]);
    setRenaming(false);
    setEditName(shelf.name);
    setEditColor(shelf.color || '#6366f1');
    try {
      setMembers((await api.get(`/api/shelves/${shelf.id}`)).members || []);
      if (shelf.role === 'owner') {
        const dir = await api.get('/api/users/directory').catch(() => null);
        setDirectory(dir?.users || []);
      }
    } catch (e) {
      notify.error(e);
    }
  };

  const run = async (action, success) => {
    setBusy(true);
    try {
      const result = await action();
      if (success) notify.success(success);
      onChanged?.();
      await load();
      return result;
    } catch (e) {
      notify.error(e);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const create = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    run(() => api.post('/api/shelves', { name: name.trim() }), t('Regal angelegt')).then(() => setName(''));
  };

  const addMember = (e) => {
    e.preventDefault();
    if (!newMember.trim() || open === null) return;
    run(async () => {
      const res = await api.post(`/api/shelves/${open}/members`, { username: newMember.trim(), role: newRole });
      setMembers(res.members || []);
      setNewMember('');
    }, t('Mitglied hinzugefügt'));
  };

  const setRole = (member, role) => run(async () => {
    const res = await api.put(`/api/shelves/${open}/members/${member.user_id}`, { role });
    setMembers(res.members || []);
  });

  const saveShelf = (e) => {
    e.preventDefault();
    if (!editName.trim() || open === null) return;
    run(() => api.put(`/api/shelves/${open}`, { name: editName.trim(), color: editColor }), t('Regal gespeichert'))
      .then((res) => { if (res !== null) setRenaming(false); });
  };

  const removeMember = (member) => run(async () => {
    const res = await api.del(`/api/shelves/${open}/members/${member.user_id}`);
    if (member.user_id === user?.id) setOpen(null);
    else setMembers(res.members || []);
  });

  const handleConfirmRemove = async () => {
    const target = memberToRemove;
    if (!target) return;
    await removeMember(target);
    setMemberToRemove(null);
  };

  const candidates = directory.filter((u) => !members.some((m) => m.user_id === u.id));

  const removeShelf = (shelf) => {
    setShelfToDelete(shelf);
  };

  const handleConfirmDelete = async () => {
    if (!shelfToDelete) return;
    const target = shelfToDelete;
    const res = await run(() => api.del(`/api/shelves/${target.id}`), t('Regal gelöscht'));
    setShelfToDelete(null);
    if (res) {
      setOpen(null);
    }
  };

  const current = shelves?.find((s) => s.id === open) || null;

  return (
    <ToolDialog id="shelves-modal" title={t('Regale')} subtitle={t('Sammlungen teilen und trennen')} Icon={Library} onClose={onClose} busy={busy}>
      {error && <p role="alert" className="text-sm text-red-300 mb-3">{error}</p>}
      {canCreate && (
        <form onSubmit={create} className="flex gap-2 mb-5">
          <label htmlFor={nameId} className="sr-only">{t('Neues Regal')}</label>
          <input id={nameId} className="input-field flex-1" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t('Neues Regal')} />
          <button type="submit" className="btn-primary text-xs px-4 py-2" disabled={busy || !name.trim()}>{t('Anlegen')}</button>
        </form>
      )}
      <ul className="space-y-2">
        {(shelves || []).map((shelf) => (
          <li key={shelf.id} className="rounded-2xl border border-slate-700/80 bg-slate-900/60">
            <button type="button" onClick={() => (open === shelf.id ? setOpen(null) : openShelf(shelf))} aria-expanded={open === shelf.id}
              className="w-full flex items-center gap-3 p-3 text-left">
              <span className="w-3 h-3 rounded-full shrink-0" style={{ background: shelf.color }} aria-hidden="true" />
              <span className="font-bold text-white truncate flex-1">{shelf.name}</span>
              <span className="text-xs text-slate-400">{ROLE_LABEL[shelf.role]?.() || shelf.role} · {formatCount(shelf.series_count, 'Reihe', 'Reihen')}</span>
            </button>
            {current?.id === shelf.id && (
              <div className="px-3 pb-3 space-y-3">
                {shelf.role === 'owner' && (renaming ? (
                  <form onSubmit={saveShelf} className="flex flex-wrap items-center gap-2">
                    <label htmlFor={renameId} className="sr-only">{t('Name des Regals')}</label>
                    <input id={renameId} className="input-field flex-1 min-w-[8rem]" value={editName} maxLength={80} onChange={(e) => setEditName(e.target.value)} />
                    <label htmlFor={colorId} className="sr-only">{t('Farbe')}</label>
                    <input id={colorId} type="color" className="h-9 w-10 shrink-0 rounded-lg bg-transparent" value={editColor} onChange={(e) => setEditColor(e.target.value)} />
                    <button type="submit" className="btn-primary text-xs px-3 py-2" disabled={busy || !editName.trim()}>{t('Speichern')}</button>
                    <button type="button" className="btn-secondary text-xs px-3 py-2" onClick={() => setRenaming(false)} disabled={busy}>{t('Abbrechen')}</button>
                  </form>
                ) : (
                  <button type="button" className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5" onClick={() => setRenaming(true)} disabled={busy}>
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> {t('Umbenennen')}
                  </button>
                ))}
                <h3 className="text-xs font-bold text-slate-300">{t('Mitglieder')}</h3>
                <ul className="space-y-1.5">
                  {members.map((m) => (
                    <li key={m.user_id} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 truncate text-slate-200">{m.username}</span>
                      {shelf.role === 'owner' ? (
                        <select className="input-field !w-auto shrink-0 text-xs py-1" value={m.role} aria-label={`${m.username}: ${t('Rolle')}`} onChange={(e) => setRole(m, e.target.value)} disabled={busy}>
                          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]()}</option>)}
                        </select>
                      ) : <span className="text-xs text-slate-400">{ROLE_LABEL[m.role]?.() || m.role}</span>}
                      {(shelf.role === 'owner' || m.user_id === user?.id) && (
                        <button type="button" className="hit-44 text-slate-400 hover:text-red-300 p-1" onClick={() => setMemberToRemove(m)} disabled={busy}
                          aria-label={`${m.username}: ${t('Entfernen')}`} title={t('Entfernen')}>
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {shelf.role === 'owner' && (
                  <>
                    <form onSubmit={addMember} className="flex flex-wrap gap-2">
                      <label htmlFor={memberId} className="sr-only">{t('Benutzername')}</label>
                      <input id={memberId} className="input-field flex-1 min-w-[8rem]" value={newMember} onChange={(e) => setNewMember(e.target.value)} placeholder={t('Benutzername')} list={listId} autoComplete="off" />
                      <datalist id={listId}>
                        {candidates.map((u) => <option key={u.id} value={u.username} />)}
                      </datalist>
                      <label htmlFor={roleId} className="sr-only">{t('Rolle')}</label>
                      <select id={roleId} className="input-field w-auto" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]()}</option>)}
                      </select>
                      <button type="submit" className="btn-secondary text-xs px-3 py-2 flex items-center gap-1.5" disabled={busy || !newMember.trim()}>
                        <UserPlus className="w-3.5 h-3.5" aria-hidden="true" /> {t('Hinzufügen')}
                      </button>
                    </form>
                    {!shelf.is_default && (
                      <button type="button" className="btn-secondary text-xs px-3 py-2 text-red-300" onClick={() => removeShelf(shelf)} disabled={busy}>{t('Regal löschen')}</button>
                    )}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {memberToRemove && (
        <ConfirmDialog
          isOpen
          title={t('Mitglied entfernen')}
          message={memberToRemove.user_id === user?.id
            ? t('Du verlierst den Zugriff auf dieses Regal. Wirklich verlassen?')
            : t('„{name}“ aus diesem Regal entfernen?', { name: memberToRemove.username })}
          confirmLabel={t('Entfernen')}
          cancelLabel={t('Abbrechen')}
          busy={busy}
          onConfirm={handleConfirmRemove}
          onCancel={() => setMemberToRemove(null)}
        />
      )}
      {shelfToDelete && (
        <ConfirmDialog
          isOpen={Boolean(shelfToDelete)}
          title={t('Regal löschen')}
          message={t('Regal „{name}“ wirklich löschen?', { name: shelfToDelete.name })}
          confirmLabel={t('Löschen')}
          cancelLabel={t('Abbrechen')}
          busy={busy}
          onConfirm={handleConfirmDelete}
          onCancel={() => setShelfToDelete(null)}
        />
      )}
    </ToolDialog>
  );
}
