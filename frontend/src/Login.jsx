import { useState, useId } from 'react';
import { BookOpen, User, Lock, ArrowRight, Info } from 'lucide-react';
import { MESSAGES } from './appShell';
import { apiFetch, readJson, rememberToken } from './utils/api';
import { useDocumentTitle } from './components/common/PageChrome';

export default function Login({ onLogin, notice }) {
  useDocumentTitle('Anmelden');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const usernameId = useId();
  const passwordId = useId();

  const fail = (message) => {
    setError(message);
    setAttempt((n) => n + 1);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
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
        fail(data?.error || (res.status === 401 ? 'Ungültige Anmeldedaten' : 'Anmeldung fehlgeschlagen'));
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

        {notice && !error && (
          <div role="status" className="flex items-start gap-2 bg-sky-500/10 border border-sky-500/40 text-sky-200 p-3.5 rounded-xl mb-6 text-sm text-left">
            <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}

        {error && (
          <div key={attempt} role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-6 text-sm text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={usernameId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Benutzername
            </label>
            <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-700/80 rounded-xl px-4 py-2.5 focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all">
              <User className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" aria-hidden="true" />
              <input
                id={usernameId}
                name="username"
                type="text"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm"
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
            <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-700/80 rounded-xl px-4 py-2.5 focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all">
              <Lock className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" aria-hidden="true" />
              <input
                id={passwordId}
                name="password"
                type="password"
                autoComplete="current-password"
                className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm"
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
