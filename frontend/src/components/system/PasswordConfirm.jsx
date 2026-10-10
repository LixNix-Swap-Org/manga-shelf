import { useEffect, useId, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { t } from '../../i18n/index.js';

/** Current password before a server-changing action: Enter submits, Escape cancels only this form, errors stay inline. */
export default function PasswordConfirm({ username = '', busy = false, error = '', submitLabel, onSubmit, onCancel }) {
  const ids = useId();
  const inputRef = useRef(null);
  const [password, setPassword] = useState('');
  const fieldId = `${ids}-password`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (!error) return;
    inputRef.current?.focus();
    inputRef.current?.select?.();
  }, [error]);

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && password) onSubmit(password);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      {username && <input type="text" name="username" autoComplete="username" className="input-field" value={username} readOnly hidden />}
      <label htmlFor={fieldId} className="block text-xs font-semibold text-slate-300">{t('Passwort zur Bestätigung')}</label>
      <input
        ref={inputRef}
        id={fieldId}
        type="password"
        name="current-password"
        autoComplete="current-password"
        className="input-field"
        required
        readOnly={busy}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? `${hintId} ${errorId}` : hintId}
      />
      <p id={hintId} className="text-[11px] text-slate-400">{t('Falsche Eingaben zählen zur Anmeldesperre deines Kontos.')}</p>
      {error && <p id={errorId} role="alert" className="text-xs text-rose-300">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary text-xs inline-flex items-center gap-1.5" disabled={busy || !password}>
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />} {submitLabel}
        </button>
        <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={onCancel}>{t('Abbrechen')}</button>
      </div>
    </form>
  );
}
