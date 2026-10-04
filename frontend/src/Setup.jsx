import { useState, useId } from 'react';
import { User, Lock, Sparkles, ArrowRight, KeyRound } from 'lucide-react';
import { apiFetch, readJson, rememberToken } from './utils/api';
import { useDocumentTitle } from './components/common/PageChrome';

const MIN_PASSWORD_LENGTH = 8; // routes/auth.js enforces the same minimum

export default function Setup({ onComplete }) {
  useDocumentTitle('Ersteinrichtung');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const usernameId = useId();
  const passwordId = useId();
  const hintId = useId();
  const tokenId = useId();
  const tokenHintId = useId();

  const fail = (message) => {
    setError(message);
    setAttempt((n) => n + 1);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      fail('Bitte fülle alle Felder aus.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await apiFetch('/api/setup', {
        method: 'POST',
        body: { username: username.trim(), password, setup_token: setupToken.trim() }
      });
      const data = await readJson(res);
      if (res.ok) {
        rememberToken(data);
        await onComplete();
      } else if (data?.code === 'ADMIN_EXISTS') {
        // Another tab or browser finished the setup first: continue to the login
        await onComplete({ adminExists: true });
      } else {
        fail(data?.error || 'Fehler bei der Einrichtung');
      }
    } catch (err) {
      fail('Verbindungsfehler zum Server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gradient-to-b from-[#0b0f19] via-[#0f172a] to-[#0b0f19]">
      <div className="glass-panel p-8 sm:p-10 rounded-3xl w-full max-w-md border border-slate-700/80 shadow-2xl relative animate-fade-in">
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-tr from-brand-600 to-emerald-400 flex items-center justify-center mb-4 shadow-xl shadow-brand-500/25">
            <Sparkles className="w-8 h-8 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Ersteinrichtung</h1>
          <p className="text-sm text-slate-400 mt-1">Erstelle dein Administrator-Konto für MangaShelf</p>
        </div>

        {error && (
          <div key={attempt} role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-6 text-sm text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={tokenId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Einrichtungscode
            </label>
            <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-700/80 rounded-xl px-4 py-2.5 focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all">
              <KeyRound className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" aria-hidden="true" />
              <input
                id={tokenId}
                name="setup_token"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                aria-describedby={tokenHintId}
                className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm font-mono tracking-wider"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                value={setupToken}
                onChange={e => setSetupToken(e.target.value)}
              />
            </div>
            <p id={tokenHintId} className="mt-1.5 text-xs text-slate-400">
              Steht in der Server-Konsole bzw. im Log beim Start („Einrichtungscode für das erste Admin-Konto“) oder ist der Wert von SETUP_TOKEN.
            </p>
          </div>

          <div>
            <label htmlFor={usernameId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Admin-Benutzername
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
                placeholder="z. B. admin"
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
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                aria-describedby={hintId}
                className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm" 
                required 
                placeholder="Sicheres Passwort"
                value={password} 
                onChange={e => setPassword(e.target.value)} 
              />
            </div>
            <p id={hintId} className="mt-1.5 text-xs text-slate-400">Mindestens {MIN_PASSWORD_LENGTH} Zeichen.</p>
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
                <span className="sr-only">Konto wird angelegt…</span>
              </>
            ) : (
              <>
                Admin-Konto anlegen & starten <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </>
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
