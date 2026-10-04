import { useState, useId } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, User, Lock, ArrowRight, Info, Server, RefreshCw, ShieldAlert } from 'lucide-react';
import { MESSAGES } from './appShell';
import { apiFetch, readJson, rememberToken, isAppMode } from './utils/api';
import { useDocumentTitle } from './components/common/PageChrome';
import useConnection from './app/useConnection';
import { hostLabel, isSecureEnough, INSECURE_URL_TEXT } from './app/serverStore';
import { PROBE_ERRORS, needsLoginAtAddress, getActiveBase } from './app/connection';

/** App build: the address in use is plain http outside the home network, where a token is never sent. */
export const insecureAddress = (base = getActiveBase()) => Boolean(base) && !isSecureEnough(base);

/** App build: which server this login is for, its connection state and the way to another server. */
function ServerInfo({ onRetry }) {
  const { state, server, baseUrl, lastError } = useConnection();
  const [retrying, setRetrying] = useState(false);
  if (!server) return null;
  const insecure = insecureAddress(baseUrl);
  const retry = async () => {
    setRetrying(true);
    try { await onRetry?.(); } finally { setRetrying(false); }
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-950/60 border border-slate-700/70 rounded-xl px-3.5 py-2.5 mb-6 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <Server className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block font-semibold text-slate-200 truncate">{server.name}</span>
          <span className={`block truncate ${state === 'offline' ? 'text-amber-300' : 'text-slate-400'}`}>
            {state === 'offline'
              ? (lastError && lastError !== PROBE_ERRORS.unreachable ? `Nicht erreichbar – ${lastError}` : 'Nicht erreichbar')
              : hostLabel(baseUrl)}
          </span>
          {!insecure && state !== 'offline' && needsLoginAtAddress(server, baseUrl) && (
            <span className="block text-amber-300">Neue Adresse – bitte erneut anmelden</span>
          )}
        </span>
      </div>
      {insecure && (
        <div role="alert" className="basis-full flex items-start gap-2 text-red-300">
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {INSECURE_URL_TEXT}.{' '}
            <Link to="/server" state={{ edit: server.id }} className="font-semibold underline underline-offset-2">Server bearbeiten</Link>
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 shrink-0">
        {state === 'offline' && onRetry && (
          <button type="button" onClick={retry} disabled={retrying} className="btn-secondary text-xs py-1.5 px-2.5 inline-flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} aria-hidden="true" /> Erneut verbinden
          </button>
        )}
        <Link to="/server" className="text-brand-300 hover:text-brand-200 font-medium underline-offset-2 hover:underline">Server wechseln</Link>
      </div>
    </div>
  );
}

// the input fills the whole box (the icon lets taps through), so a tap anywhere in it focuses the field
const FIELD_ICON_CLASS = 'absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none';

export default function Login({ onLogin, notice, onRetry }) {
  useDocumentTitle('Anmelden');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldsInvalid, setFieldsInvalid] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const usernameId = useId();
  const passwordId = useId();
  const errorId = useId();

  const fail = (message, invalid = false) => {
    setError(message);
    setFieldsInvalid(invalid);
    setAttempt((n) => n + 1);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldsInvalid(false);
    // the token of this login would never be sent to this address: do not ask the server for one
    if (isAppMode() && insecureAddress()) {
      fail(INSECURE_URL_TEXT);
      return;
    }
    setLoading(true);

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: { username, password }
      });
      const data = await readJson(res);
      if (res.ok) {
        rememberToken(data);
        // Wait for the session check, so a cookie the browser refused does not leave the form silently as it was
        const outcome = await onLogin();
        if (outcome && outcome.status !== 'online' && outcome.status !== 'offline') {
          fail(outcome.status === 'unauthorized' ? MESSAGES.cookieRejected : MESSAGES.loginUnconfirmed);
        }
      } else {
        fail(data?.error || (res.status === 401 ? 'Ungültige Anmeldedaten' : 'Anmeldung fehlgeschlagen'), res.status === 400 || res.status === 401);
      }
    } catch (err) {
      fail('Verbindungsfehler zum Server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gradient-to-b from-[#0b0f19] via-[#0f172a] to-[#0b0f19]">
      <div className="glass-panel p-8 sm:p-10 rounded-3xl w-full max-w-md border border-slate-700/80 shadow-2xl relative">
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center mb-4 shadow-xl shadow-brand-500/25">
            <BookOpen className="w-8 h-8 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Manga Shelf</h1>
          <p className="text-sm text-slate-400 mt-1">Melde dich bei deiner Sammlung an</p>
        </div>

        {isAppMode() && <ServerInfo onRetry={onRetry} />}

        {notice && !error && (
          <div role="status" className="flex items-start gap-2 bg-sky-500/10 border border-sky-500/40 text-sky-200 p-3.5 rounded-xl mb-6 text-sm text-left">
            <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}

        {error && (
          <div key={attempt} id={errorId} role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-6 text-sm text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={usernameId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Benutzername
            </label>
            <div className="relative bg-slate-950/70 border border-slate-700/80 rounded-xl focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all">
              <User className={FIELD_ICON_CLASS} aria-hidden="true" />
              <input
                id={usernameId}
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                className="block w-full bg-transparent border-0 rounded-xl pl-11 pr-4 py-2.5 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm"
                aria-invalid={fieldsInvalid || undefined}
                aria-describedby={fieldsInvalid && error ? errorId : undefined}
                required
                autoFocus
                placeholder="Dein Benutzername"
                value={username}
                onChange={e => setUsername(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label htmlFor={passwordId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Passwort
            </label>
            <div className="relative bg-slate-950/70 border border-slate-700/80 rounded-xl focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all">
              <Lock className={FIELD_ICON_CLASS} aria-hidden="true" />
              <input
                id={passwordId}
                name="password"
                type="password"
                autoComplete="current-password"
                className="block w-full bg-transparent border-0 rounded-xl pl-11 pr-4 py-2.5 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm"
                aria-invalid={fieldsInvalid || undefined}
                aria-describedby={fieldsInvalid && error ? errorId : undefined}
                required
                placeholder="Dein Passwort"
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn-primary w-full mt-6 py-3 flex items-center justify-center gap-2 text-sm shadow-xl"
            disabled={loading}
            aria-busy={loading || undefined}
          >
            {loading ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" aria-hidden="true"></div>
                <span className="sr-only">Anmeldung läuft…</span>
              </>
            ) : (
              <>
                Anmelden <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </>
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
