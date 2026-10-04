import { useState, useEffect } from 'react';
import { Lock, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { apiFetch, readJson, rememberToken } from '../../utils/api';

/** Own password change (PUT /api/auth/password): current password, new password twice. Other devices are logged out. */
export default function ChangePasswordModal({ isOpen, onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialogRef = useDialogA11y(isOpen);

  useEffect(() => {
    if (isOpen) {
      setCurrent('');
      setNext('');
      setRepeat('');
      setError('');
      setDone(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

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
        rememberToken(data);
        setDone(true);
      }
      else setError(data.error || 'Das Passwort konnte nicht geändert werden.');
    } catch (err) {
      setError('Netzwerkfehler');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Passwort ändern"
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      className="outline-none fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto animate-fade-in"
    >
      <div className="glass-panel w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-8 border border-slate-700/80 shadow-2xl my-3 sm:my-8">
        <div className="flex items-center justify-between mb-5 pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-500/20 border border-brand-500/40 text-brand-400 flex items-center justify-center">
              <Lock className="w-5 h-5" />
            </div>
            <h2 className="text-xl font-bold text-white">Passwort ändern</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {done ? (
          <div className="space-y-4">
            <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 p-3.5 rounded-xl text-sm">
              Dein Passwort wurde geändert. Auf anderen Geräten musst du dich neu anmelden.
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="btn-primary text-sm">Schließen</button>
            </div>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
