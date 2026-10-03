import { useState, useEffect } from 'react';
import { Users, UserPlus, Shield, User, Lock, X, Trash2 } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';

export default function UserManagementModal({ isOpen, onClose, currentUser }) {
  const [usersList, setUsersList] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userError, setUserError] = useState('');
  const [userSuccess, setUserSuccess] = useState('');
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'editor' });
  const [creatingUser, setCreatingUser] = useState(false);

  const fetchUsers = async () => {
    try {
      setLoadingUsers(true);
      const res = await fetch('/api/users');
      if (res.ok) {
        setUsersList(await res.json());
      }
    } catch (e) {
      console.error('Failed to fetch users:', e);
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setUserError('');
      setUserSuccess('');
      setNewUser({ username: '', password: '', role: 'editor' });
      fetchUsers();
    }
  }, [isOpen]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    if (!newUser.username.trim() || !newUser.password) {
      setUserError('Bitte Benutzername und Passwort eingeben.');
      return;
    }
    if (newUser.password.length < 8) {
      setUserError('Passwort muss mindestens 8 Zeichen lang sein.');
      return;
    }

    setCreatingUser(true);
    setUserError('');
    setUserSuccess('');

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newUser)
      });
      const data = await res.json();
      if (res.ok) {
        setUserSuccess(`Benutzer "${newUser.username.trim()}" erfolgreich angelegt!`);
        setNewUser({ username: '', password: '', role: 'editor' });
        await fetchUsers();
      } else {
        setUserError(data.error || 'Fehler beim Erstellen des Benutzers');
      }
    } catch (err) {
      setUserError('Netzwerkfehler');
    } finally {
      setCreatingUser(false);
    }
  };

  const handleDeleteUser = async (userId, targetUsername) => {
    if (!confirm(`Möchtest du den Benutzer "${targetUsername}" wirklich löschen?`)) return;
    try {
      const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchUsers();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Löschen');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    }
  };

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  return (
    <div 
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Benutzerverwaltung"
      tabIndex={-1}
      className="outline-none fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto animate-fade-in"
    >
      <div className="glass-panel w-full max-w-2xl rounded-2xl sm:rounded-3xl p-5 sm:p-8 border border-slate-700/80 shadow-2xl my-3 sm:my-8 relative">
        
        {/* Header */}
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/40 text-purple-400 flex items-center justify-center">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Benutzerverwaltung</h2>
              <p className="text-xs text-slate-400">Verwalte Zugänge und lege neue Benutzer an</p>
            </div>
          </div>
          <button 
            id="btn-close-users-modal-x"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Feedback messages */}
        {userError && (
          <div className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
            <span>{userError}</span>
          </div>
        )}
        {userSuccess && (
          <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
            <span>{userSuccess}</span>
          </div>
        )}

        {/* Section 1: Create New User */}
        <div className="bg-slate-950/60 p-4 sm:p-5 rounded-2xl border border-slate-800 mb-6">
          <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-brand-400" /> Neuen Benutzer anlegen
          </h3>
          
          <form onSubmit={handleCreateUser} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Benutzername
                </label>
                <input 
                  type="text" 
                  placeholder="z.B. alex" 
                  className="input-field text-xs py-2"
                  required
                  value={newUser.username} 
                  onChange={e => setNewUser({ ...newUser, username: e.target.value })} 
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Passwort
                </label>
                <input 
                  type="password" 
                  placeholder="Mind. 8 Zeichen" 
                  className="input-field text-xs py-2"
                  required
                  value={newUser.password} 
                  onChange={e => setNewUser({ ...newUser, password: e.target.value })} 
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Rolle
                </label>
                <select 
                  className="input-field bg-slate-950 text-xs py-2"
                  value={newUser.role}
                  onChange={e => setNewUser({ ...newUser, role: e.target.value })}
                >
                  <option value="editor">Editor (Mangas verwalten)</option>
                  <option value="visitor">Besucher / Gast (Nur Lesezugriff)</option>
                  <option value="admin">Administrator (Vollzugriff)</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <button 
                type="submit" 
                className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                disabled={creatingUser}
              >
                {creatingUser ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <UserPlus className="w-3.5 h-3.5" />
                )}
                Benutzer erstellen
              </button>
            </div>
          </form>
        </div>

        {/* Section 2: List of Users */}
        <div>
          <h3 className="text-sm font-bold text-slate-200 mb-3 flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-400" /> Registrierte Benutzer ({usersList.length})
          </h3>

          {loadingUsers ? (
            <div className="p-6 text-center text-slate-500 text-xs">Lade Benutzerliste...</div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto custom-scrollbar pr-1">
              {usersList.map(u => {
                const isSelf = u.id === currentUser?.id;

                return (
                  <div 
                    key={u.id}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-xs"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs ${
                        u.role === 'admin' 
                          ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' 
                          : (u.role === 'visitor' || u.role === 'guest')
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                      }`}>
                        {u.role === 'admin' ? (
                          <Shield className="w-4 h-4" />
                        ) : (u.role === 'visitor' || u.role === 'guest') ? (
                          <Lock className="w-4 h-4" />
                        ) : (
                          <User className="w-4 h-4" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{u.username}</span>
                          {isSelf && (
                            <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                              Du
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-500">
                          Erstellt am {u.created_at ? new Date(u.created_at).toLocaleDateString('de-DE') : 'unbekannt'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider border ${
                        u.role === 'admin' 
                          ? 'bg-purple-500/20 text-purple-300 border-purple-500/40' 
                          : (u.role === 'visitor' || u.role === 'guest')
                          ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                          : 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                      }`}>
                        {u.role === 'visitor' || u.role === 'guest' ? 'Besucher' : u.role}
                      </span>

                      {!isSelf && (
                        <button
                          onClick={() => handleDeleteUser(u.id, u.username)}
                          className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors"
                          title={`Benutzer "${u.username}" löschen`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Close Button */}
        <div className="flex justify-end pt-5 mt-5 border-t border-slate-800">
          <button 
            id="btn-close-users-modal"
            type="button" 
            onClick={onClose} 
            className="btn-secondary text-xs"
          >
            Schließen
          </button>
        </div>

      </div>
    </div>
  );
}
