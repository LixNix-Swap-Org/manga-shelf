import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Lock, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import useTabList from '../../hooks/useTabList';
import api, { apiFetch, isLocalMode, readJson, rememberToken } from '../../utils/api';
import { notify } from '../../utils/notify';
import ApiKeyCard from './ApiKeyCard';

/** Own password change (PUT /api/auth/password): current password, new password twice. Other devices are logged out. */
function PasswordTab({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (next !== repeat) {
      setError('Die beiden neuen Passwörter sind nicht gleich.');
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch('/api/auth/password', {
        method: 'PUT',
        body: { current_password: current, new_password: next }
      });
      const data = (await readJson(res)) ?? {};
      if (res.ok) {
        rememberToken(data, { rotate: true });
        setDone(true);
      }
      else setError(data.error || 'Das Passwort konnte nicht geändert werden.');
    } catch (err) {
      setError('Netzwerkfehler');
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4">
        <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 p-3.5 rounded-xl text-sm">
          Dein Passwort wurde geändert. Auf anderen Geräten musst du dich neu anmelden.
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary text-sm">Schließen</button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3 rounded-xl text-sm">{error}</div>
      )}
      <div>
        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5" htmlFor="pw-current">Aktuelles Passwort</label>
        <input id="pw-current" type="password" autoComplete="current-password" className="input-field" required autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5" htmlFor="pw-new">Neues Passwort (mind. 8 Zeichen)</label>
        <input id="pw-new" type="password" autoComplete="new-password" className="input-field" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5" htmlFor="pw-repeat">Neues Passwort wiederholen</label>
        <input id="pw-repeat" type="password" autoComplete="new-password" className="input-field" required minLength={8} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </div>
      <div className="flex justify-end gap-3 pt-3 border-t border-slate-800">
        <button type="button" onClick={onClose} className="btn-secondary text-sm" disabled={saving}>Abbrechen</button>
        <button type="submit" className="btn-primary text-sm" disabled={saving}>{saving ? 'Wird gespeichert...' : 'Passwort ändern'}</button>
      </div>
    </form>
  );
}

/**
 * Loads the guides and key states; `admin` adds the instance keys. Returns the cards' data and their actions
 * (shared by the account dialog and the setup assistant).
 */
export function useApiKeys({ admin = false, user = true } = {}) {
  const [guides, setGuides] = useState(null);
  const [userKeys, setUserKeys] = useState([]);
  const [instanceKeys, setInstanceKeys] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [g, own, inst] = await Promise.all([
        api.get('/api/sources/guides'),
        user ? api.get('/api/auth/api-keys') : Promise.resolve([]),
        admin ? api.get('/api/admin/api-keys') : Promise.resolve(null)
      ]);
      setGuides(Array.isArray(g) ? g : []);
      setUserKeys(Array.isArray(own) ? own : []);
      setInstanceKeys(Array.isArray(inst?.keys) ? inst.keys : []);
    } catch (err) {
      setError(err.message || 'Schlüssel konnten nicht geladen werden');
    }
  }, [admin, user]);

  useEffect(() => { load(); }, [load]);

  const base = (scope) => (scope === 'instance' ? '/api/admin/api-keys' : '/api/auth/api-keys');
  const replace = (scope, entry) => (scope === 'instance' ? setInstanceKeys : setUserKeys)((list) => list.map((k) => (k.provider === entry.provider ? entry : k)));

  /** Resolves true when stored, else the error text for the card. */
  const save = async (scope, provider, secret, { allowBackground = false } = {}) => {
    setBusy(`${scope}:${provider}`);
    try {
      const body = scope === 'instance' ? { secret } : { secret, allow_background: allowBackground };
      replace(scope, await api.put(`${base(scope)}/${provider}`, body, { timeout: 30000 }));
      notify.success('Schlüssel geprüft und gespeichert');
      return true;
    } catch (err) {
      return err.message || 'Schlüssel konnte nicht gespeichert werden';
    } finally {
      setBusy(null);
    }
  };

  const remove = async (scope, provider) => {
    setBusy(`${scope}:${provider}`);
    try {
      await api.del(`${base(scope)}/${provider}`);
      await load();
      notify.success('Schlüssel entfernt');
    } catch (err) {
      notify.error(err);
    } finally {
      setBusy(null);
    }
  };

  const toggleBackground = async (provider, on) => {
    try {
      replace('user', await api.put(`/api/auth/api-keys/${provider}`, { allow_background: on }));
    } catch (err) {
      notify.error(err);
    }
  };

  const guideOf = (id) => (guides || []).find((g) => g.id === id);
  return { guides, guideOf, userKeys, instanceKeys, error, busy, save, remove, toggleBackground, reload: load };
}

function KeysTab({ isAdmin }) {
  const keys = useApiKeys({ admin: isAdmin });
  if (keys.error) return <p role="alert" className="text-sm text-rose-300">{keys.error}</p>;
  if (!keys.guides) return <p className="text-sm text-slate-400" role="status">Wird geladen…</p>;
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        Eigene Schlüssel sind freiwillig: ohne sie laufen Suche und Daten über den gemeinsamen Zugang des Servers, nur mit dessen Limit.
        Gespeicherte Schlüssel werden verschlüsselt abgelegt und nie wieder angezeigt.
      </p>
      {keys.userKeys.map((state) => {
        const guide = keys.guideOf(state.provider);
        return guide ? (
          <ApiKeyCard
            key={state.provider}
            guide={guide}
            state={state}
            scope="user"
            busy={keys.busy === `user:${state.provider}`}
            onSave={(secret, opts) => keys.save('user', state.provider, secret, opts)}
            onRemove={() => keys.remove('user', state.provider)}
            onToggleBackground={(on) => keys.toggleBackground(state.provider, on)}
          />
        ) : null;
      })}
      {isAdmin && keys.instanceKeys.length > 0 && (
        <div className="space-y-3 border-t border-slate-800 pt-4" data-testid="instance-keys">
          <h3 className="text-sm font-bold text-white">Für alle (Instanz)</h3>
          <p className="text-xs text-slate-400">Gilt für alle Benutzer ohne eigenen Schlüssel. Eine Umgebungsvariable hat Vorrang.</p>
          {keys.instanceKeys.map((state) => {
            const guide = keys.guideOf(state.provider);
            return guide ? (
              <ApiKeyCard
                key={state.provider}
                guide={guide}
                state={state}
                scope="instance"
                busy={keys.busy === `instance:${state.provider}`}
                onSave={(secret) => keys.save('instance', state.provider, secret)}
                onRemove={() => keys.remove('instance', state.provider)}
              />
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { id: 'password', label: 'Passwort', Icon: Lock },
  { id: 'keys', label: 'API-Schlüssel', Icon: KeyRound }
];
// without a server there is no password, only the keys
const LOCAL_TABS = TABS.filter((t) => t.id !== 'password');

/** Account dialog (lock icon in the header): own password and personal API keys; admins also the instance keys. */
export default function AccountModal({ isOpen, onClose, user, initialTab = 'password' }) {
  const tabs = isLocalMode() ? LOCAL_TABS : TABS;
  const [chosen, setTab] = useState(initialTab);
  const tab = tabs.some((t) => t.id === chosen) ? chosen : tabs[0].id;
  const dialogRef = useDialogA11y(isOpen);
  const { tabListProps, tabProps, panelProps } = useTabList({ tabs: tabs.map((t) => t.id), selected: tab, onSelect: setTab, prefix: 'account' });

  useEffect(() => {
    if (isOpen) setTab(initialTab);
  }, [isOpen, initialTab]);

  if (!isOpen) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={tab === 'password' ? 'Passwort ändern' : 'API-Schlüssel'}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="outline-none dialog-overlay z-50 bg-black/75 backdrop-blur-sm animate-fade-in"
    >
      <div className="dialog-box glass-panel max-w-xl rounded-2xl sm:rounded-3xl p-5 sm:p-8 short:p-4 border border-slate-700/80 shadow-2xl">
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-500/20 border border-brand-500/40 text-brand-400 flex items-center justify-center">
              <Lock className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 className="text-xl font-bold text-white">Konto</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Schließen" className="hit-44 shrink-0 text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div {...tabListProps} aria-label="Bereich" className="flex gap-1 mb-5 bg-slate-900/80 border border-slate-800 p-1 rounded-xl w-fit">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              {...tabProps(id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 ${tab === id ? 'bg-brand-700 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" /> {label}
            </button>
          ))}
        </div>

        <div {...panelProps}>
          {tab === 'password' ? <PasswordTab onClose={onClose} /> : <KeysTab isAdmin={user?.role === 'admin'} />}
        </div>
      </div>
    </div>
  );
}
