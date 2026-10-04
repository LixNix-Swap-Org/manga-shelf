import { useState, useEffect, useRef, useId } from 'react';
import { Users, UserPlus, Shield, User, Lock, X, Trash, KeyRound, RefreshCw } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { apiFetch, rememberToken } from '../../utils/api';
import { formatDay } from '../../utils/format';
import { parseUtcTimestamp } from './statsFormat';
import { t, tn } from '../../i18n/index.js';
import { serverText } from '../../i18n/serverText.js';

const MIN_PASSWORD_LENGTH = 8;
const EMPTY_USER = { username: '', password: '', role: 'editor' };
// i18n
const SESSION_EXPIRED = 'Deine Sitzung ist abgelaufen oder ungültig. Bitte lade die Seite neu und melde dich an.';
// i18n
const ROLE_LABELS = { admin: 'Admin', editor: 'Editor', visitor: 'Gast', guest: 'Gast' };
// i18n
const ROLE_OPTIONS = [
  ['editor', 'Editor'],
  ['visitor', 'Gast'],
  ['admin', 'Admin']
];

const isReadOnlyRole = (role) => role === 'visitor' || role === 'guest';
const roleLabel = (role) => (ROLE_LABELS[role] ? t(ROLE_LABELS[role]) : role);
const formatCreated = (value) => {
  const date = parseUtcTimestamp(value);
  return (date && formatDay(date)) || t('unbekannt');
};

async function readJson(res) {
  try {
    return JSON.parse(await res.text());
  } catch (_) {
    return null;
  }
}

function errorMessage(res, data, fallback) {
  if (res.status === 401) return t(SESSION_EXPIRED);
  const server = serverText(data);
  if (server) return server;
  return t('{message} (HTTP {status})', { message: fallback, status: res.status });
}

export default function UserManagementModal({ isOpen, onClose, currentUser }) {
  const [usersList, setUsersList] = useState([]);
  const [usersLoaded, setUsersLoaded] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [listError, setListError] = useState('');
  const [userError, setUserError] = useState('');
  const [userSuccess, setUserSuccess] = useState('');
  const [newUser, setNewUser] = useState(EMPTY_USER);
  const [creatingUser, setCreatingUser] = useState(false);
  const [pendingIds, setPendingIds] = useState({});
  const [resetTargetId, setResetTargetId] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const usersRequestRef = useRef(0);
  const fieldId = useId();

  const setPending = (id, value) => setPendingIds(prev => {
    const next = { ...prev };
    if (value) next[id] = value; else delete next[id];
    return next;
  });

  const showResult = (error, success = '') => {
    setUserError(error);
    setUserSuccess(success);
  };

  const fetchUsers = async () => {
    const id = ++usersRequestRef.current;
    setLoadingUsers(true);
    setListError('');
    try {
      const res = await apiFetch('/api/users');
      const data = await readJson(res);
      if (id !== usersRequestRef.current) return;
      if (res.ok && Array.isArray(data)) {
        setUsersList(data);
        setUsersLoaded(true);
      } else {
        setListError(res.ok ? t('Benutzerliste konnte nicht geladen werden.') : errorMessage(res, data, t('Benutzerliste konnte nicht geladen werden')));
      }
    } catch (_) {
      if (id === usersRequestRef.current) setListError(t('Netzwerkfehler beim Laden der Benutzerliste.'));
    } finally {
      if (id === usersRequestRef.current) setLoadingUsers(false);
    }
  };

  useEffect(() => {
    usersRequestRef.current++;
    if (isOpen) {
      showResult('');
      setNewUser(EMPTY_USER);
      setUsersList([]);
      setUsersLoaded(false);
      setListError('');
      setPendingIds({});
      setResetTargetId(null);
      setResetPassword('');
      fetchUsers();
    }
  }, [isOpen]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    if (!newUser.username.trim() || !newUser.password) {
      showResult(t('Bitte Benutzername und Passwort eingeben.'));
      return;
    }
    if (newUser.password.length < MIN_PASSWORD_LENGTH) {
      showResult(tn('Passwort muss mindestens {n} Zeichen lang sein.', 'Passwort muss mindestens {n} Zeichen lang sein.', MIN_PASSWORD_LENGTH));
      return;
    }

    setCreatingUser(true);
    showResult('');

    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        body: newUser
      });
      const data = await readJson(res);
      if (res.ok) {
        showResult('', t('Benutzer "{username}" erfolgreich angelegt!', { username: newUser.username.trim() }));
        setNewUser(EMPTY_USER);
        await fetchUsers();
      } else {
        showResult(errorMessage(res, data, t('Fehler beim Erstellen des Benutzers')));
      }
    } catch (_) {
      showResult(t('Netzwerkfehler beim Erstellen des Benutzers.'));
    } finally {
      setCreatingUser(false);
    }
  };

  const handleRoleChange = async (target, role) => {
    if (role === target.role) return;
    showResult('');
    setPending(target.id, 'role');
    try {
      const res = await apiFetch(`/api/users/${target.id}`, {
        method: 'PUT',
        body: { role }
      });
      const data = await readJson(res);
      if (res.ok) {
        const newRole = data?.user?.role || role;
        setUsersList(prev => prev.map(u => (u.id === target.id ? { ...u, role: newRole } : u)));
        showResult('', t('Rolle von "{username}" ist jetzt {role}.', { username: target.username, role: roleLabel(newRole) }));
      } else {
        showResult(errorMessage(res, data, t('Rolle konnte nicht geändert werden')));
        if (res.status === 404 || res.status === 409) fetchUsers();
      }
    } catch (_) {
      showResult(t('Netzwerkfehler beim Ändern der Rolle.'));
    } finally {
      setPending(target.id, null);
    }
  };

  const openReset = (target) => {
    setResetTargetId(prev => (prev === target.id ? null : target.id));
    setResetPassword('');
  };

  const handleResetPassword = async (e, target) => {
    e.preventDefault();
    if (resetPassword.length < MIN_PASSWORD_LENGTH) {
      showResult(tn('Passwort muss mindestens {n} Zeichen lang sein.', 'Passwort muss mindestens {n} Zeichen lang sein.', MIN_PASSWORD_LENGTH));
      return;
    }
    showResult('');
    setPending(target.id, 'password');
    try {
      const res = await apiFetch(`/api/users/${target.id}`, {
        method: 'PUT',
        body: { password: resetPassword }
      });
      const data = await readJson(res);
      if (res.ok) {
        // only an own reset answers with a token: it revokes the old one, and the app build continues with the new one
        rememberToken(data, { rotate: true });
        setResetTargetId(null);
        setResetPassword('');
        showResult('', t('Neues Passwort für "{username}" gesetzt. {username} wurde auf allen Geräten abgemeldet.', { username: target.username }));
      } else {
        showResult(errorMessage(res, data, t('Passwort konnte nicht zurückgesetzt werden')));
        if (res.status === 404 || res.status === 409) fetchUsers();
      }
    } catch (_) {
      showResult(t('Netzwerkfehler beim Zurücksetzen des Passworts.'));
    } finally {
      setPending(target.id, null);
    }
  };

  const handleDeleteUser = async (target) => {
    if (!confirm(t('Möchtest du den Benutzer "{username}" wirklich löschen? Sein Lesestatus wird gelöscht; Bände, die nur dieser Benutzer besitzt, gehen an dich über.', { username: target.username }))) return;
    showResult('');
    setPending(target.id, 'delete');
    try {
      const res = await apiFetch(`/api/users/${target.id}`, { method: 'DELETE' });
      const data = await readJson(res);
      if (res.ok) {
        setUsersList(prev => prev.filter(u => u.id !== target.id));
        if (resetTargetId === target.id) setResetTargetId(null);
        showResult('', t('Benutzer "{username}" wurde gelöscht.', { username: target.username }));
      } else {
        showResult(errorMessage(res, data, t('Fehler beim Löschen des Benutzers')));
        if (res.status === 404) fetchUsers();
      }
    } catch (_) {
      showResult(t('Netzwerkfehler beim Löschen des Benutzers.'));
    } finally {
      setPending(target.id, null);
    }
  };

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  const countLabel = listError ? ' (?)' : usersLoaded ? ` (${usersList.length})` : '';

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('Benutzerverwaltung')}
      tabIndex={-1}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-2xl rounded-2xl sm:rounded-3xl p-5 sm:p-8 short:p-4 border border-slate-700/80 shadow-2xl relative">

        <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/40 text-purple-400 flex items-center justify-center">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">{t('Benutzerverwaltung')}</h2>
              <p className="text-xs text-slate-400">{t('Verwalte Zugänge und lege neue Benutzer an')}</p>
            </div>
          </div>
          <button
            id="btn-close-users-modal-x"
            type="button"
            onClick={onClose}
            aria-label={t('Schließen')}
            className="hit-44 shrink-0 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {userError && (
          <div role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2">
            <span>{userError}</span>
          </div>
        )}
        <div
          role="status"
          className={userSuccess ? 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 p-3.5 rounded-xl mb-5 text-sm flex items-center gap-2' : 'sr-only'}
        >
          {userSuccess && <span>{userSuccess}</span>}
        </div>

        <div className="bg-slate-950/60 p-4 sm:p-5 rounded-2xl border border-slate-800 mb-6">
          <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-brand-400" /> {t('Neuen Benutzer anlegen')}
          </h3>

          <form onSubmit={handleCreateUser} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor={`${fieldId}-name`} className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  {t('Benutzername')}
                </label>
                <input
                  id={`${fieldId}-name`}
                  name="new-user-name"
                  type="text"
                  placeholder={t('z.B. alex')}
                  autoComplete="off"
                  className="input-field text-base sm:text-xs py-2"
                  required
                  value={newUser.username}
                  onChange={e => setNewUser({ ...newUser, username: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor={`${fieldId}-password`} className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  {t('Passwort')}
                </label>
                <input
                  id={`${fieldId}-password`}
                  name="new-user-password"
                  type="password"
                  placeholder={t('Mind. 8 Zeichen')}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  className="input-field text-base sm:text-xs py-2"
                  required
                  value={newUser.password}
                  onChange={e => setNewUser({ ...newUser, password: e.target.value })}
                />
              </div>

              <div>
                <label htmlFor={`${fieldId}-role`} className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  {t('Rolle')}
                </label>
                <select
                  id={`${fieldId}-role`}
                  className="input-field bg-slate-950 text-base sm:text-xs py-2"
                  value={newUser.role}
                  onChange={e => setNewUser({ ...newUser, role: e.target.value })}
                >
                  <option value="editor">{t('Editor (Mangas verwalten)')}</option>
                  <option value="visitor">{t('Gast (Nur Lesezugriff)')}</option>
                  <option value="admin">{t('Administrator (Vollzugriff)')}</option>
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
                  <div aria-hidden="true" className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <UserPlus className="w-3.5 h-3.5" />
                )}
                {t('Benutzer erstellen')}
              </button>
            </div>
          </form>
        </div>

        <div>
          <h3 className="text-sm font-bold text-slate-200 mb-3 flex items-center gap-2">
            <Users className="w-4 h-4 text-slate-400" /> {t('Registrierte Benutzer')}{countLabel}
          </h3>

          {listError ? (
            <div role="alert" className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs space-y-3 text-center">
              <p>{t('Die Benutzerliste konnte nicht geladen werden: {listError}', { listError })}</p>
              <button type="button" onClick={fetchUsers} disabled={loadingUsers} className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5">
                <RefreshCw className={`w-3.5 h-3.5 ${loadingUsers ? 'animate-spin' : ''}`} aria-hidden="true" /> {t('Erneut laden')}
              </button>
            </div>
          ) : loadingUsers && !usersLoaded ? (
            <div aria-busy="true" className="p-6 text-center text-slate-400 text-xs">{t('Lade Benutzerliste...')}</div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto overflow-x-hidden custom-scrollbar pr-1">
              {usersList.map(u => {
                const isSelf = u.id === currentUser?.id;
                const pending = pendingIds[u.id];
                const resetOpen = resetTargetId === u.id;

                return (
                  <div key={u.id} className="p-3 rounded-xl bg-slate-900/60 border border-slate-800 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center font-bold text-xs ${
                          u.role === 'admin'
                            ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                            : isReadOnlyRole(u.role)
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                            : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                        }`}>
                          {u.role === 'admin' ? (
                            <Shield className="w-4 h-4" />
                          ) : isReadOnlyRole(u.role) ? (
                            <Lock className="w-4 h-4" />
                          ) : (
                            <User className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-bold text-white truncate" title={u.username}>{u.username}</span>
                            {isSelf && (
                              <span className="shrink-0 text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                                {t('Du')}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-slate-400">
                            {t('Erstellt am {date}', { date: formatCreated(u.created_at) })}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 [@media(pointer:coarse)]:gap-5 shrink-0 ml-auto">
                        {isSelf ? (
                          <span
                            className={`text-[10px] px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider border ${
                              u.role === 'admin'
                                ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
                                : isReadOnlyRole(u.role)
                                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                                : 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                            }`}
                            title={t('Die eigene Rolle kann hier nicht geändert werden')}
                          >
                            {roleLabel(u.role)}
                          </span>
                        ) : (
                          <select
                            aria-label={t('Rolle von {username}', { username: u.username })}
                            value={u.role}
                            disabled={Boolean(pending)}
                            onChange={e => handleRoleChange(u, e.target.value)}
                            className="input-field bg-slate-950 text-base sm:text-[11px] py-1 px-2 w-auto"
                          >
                            {ROLE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
                            {!ROLE_LABELS[u.role] || u.role === 'guest'
                              ? <option value={u.role}>{u.role === 'guest' ? t('Gast (alte Rolle)') : u.role}</option>
                              : null}
                          </select>
                        )}

                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => openReset(u)}
                            disabled={Boolean(pending)}
                            aria-expanded={resetOpen}
                            aria-label={t('Passwort von {username} zurücksetzen', { username: u.username })}
                            title={t('Passwort zurücksetzen')}
                            className="hit-44 p-1.5 hover:bg-slate-700/60 text-slate-400 hover:text-white rounded-lg transition-colors"
                          >
                            <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        )}

                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(u)}
                            disabled={Boolean(pending)}
                            className="hit-44 p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors"
                            title={t('Benutzer "{username}" löschen', { username: u.username })}
                            aria-label={t('Benutzer {username} löschen', { username: u.username })}
                          >
                            <Trash className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>

                    {resetOpen && (
                      <form onSubmit={e => handleResetPassword(e, u)} className="mt-3 pt-3 border-t border-slate-800 space-y-2">
                        <label htmlFor={`${fieldId}-reset-${u.id}`} className="block text-[11px] font-semibold text-slate-400">
                          {t('Neues Passwort für {username}', { username: u.username })}
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            id={`${fieldId}-reset-${u.id}`}
                            type="password"
                            autoComplete="new-password"
                            placeholder={t('Neues Passwort')}
                            className="input-field text-base sm:text-xs py-1.5 flex-1 min-w-0"
                            value={resetPassword}
                            onChange={e => setResetPassword(e.target.value)}
                            autoFocus
                          />
                          <button type="submit" disabled={Boolean(pending)} className="btn-primary text-xs py-1.5 px-3">
                            {t('Zurücksetzen')}
                          </button>
                          <button type="button" onClick={() => setResetTargetId(null)} className="btn-secondary text-xs py-1.5 px-3">
                            {t('Abbrechen')}
                          </button>
                        </div>
                        <p className="text-[10px] text-slate-400">
                          {t('Mindestens {minPasswordLength} Zeichen. {username} wird danach auf allen Geräten abgemeldet.', { minPasswordLength: MIN_PASSWORD_LENGTH, username: u.username })}
                        </p>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-[10px] text-slate-400 mt-2">{t('Dein eigenes Passwort änderst du über das Schloss-Symbol oben rechts („Konto: Passwort und API-Schlüssel“, Reiter „Passwort“).')}</p>
        </div>

        <div className="flex justify-end pt-5 mt-5 border-t border-slate-800">
          <button
            id="btn-close-users-modal"
            type="button"
            onClick={onClose}
            className="btn-secondary text-xs"
          >
            {t('Schließen')}
          </button>
        </div>

      </div>
    </div>
  );
}
