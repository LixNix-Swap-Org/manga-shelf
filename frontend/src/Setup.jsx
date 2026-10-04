import { useState, useEffect, useId, useRef } from 'react';
import { User, Lock, Sparkles, ArrowRight, KeyRound, Plug } from 'lucide-react';
import { apiFetch, readJson, rememberToken } from './utils/api';
import { useDocumentTitle } from './components/common/PageChrome';
import ApiKeyCard from './components/modals/ApiKeyCard';
import { useApiKeys } from './components/modals/AccountModal';
import LanguageSelect from './components/common/LanguageSelect';
import { t as tr } from './i18n/index.js';
import { serverText } from './i18n/serverText.js';

const MIN_PASSWORD_LENGTH = 8; // routes/auth.js enforces the same minimum

/** Optional second step: instance keys (MyAnimeList, Google Books) over the admin routes; skippable. */
function SourcesStep({ onDone }) {
  const keys = useApiKeys({ admin: true, user: false });
  const [finishing, setFinishing] = useState(false);
  const headingRef = useRef(null);
  // replaces the setup form and its focused submit button
  useEffect(() => { headingRef.current?.focus(); }, []);
  const finish = async () => {
    setFinishing(true);
    try {
      await onDone();
    } finally {
      setFinishing(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="text-center">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center mb-3">
          <Plug className="w-6 h-6 text-brand-300" aria-hidden="true" />
        </div>
        <h1 ref={headingRef} tabIndex={-1} className="text-xl font-extrabold text-white focus:outline-none">{tr('Quellen verbinden (später möglich)')}</h1>
        <p className="text-sm text-slate-400 mt-1">
          {tr('Mit eigenen Schlüsseln bekommt dieser Server ein eigenes Limit bei MyAnimeList und Google Books, statt sich das anonyme mit allen zu teilen. Alles funktioniert auch ohne; später geht es im Konto-Dialog (Schloss-Symbol).')}
        </p>
      </div>
      {keys.error && <p className="text-sm text-amber-300" role="status">{keys.error}</p>}
      {keys.instanceKeys.map((state) => {
        const guide = keys.guideOf(state.provider);
        return guide ? (
          <ApiKeyCard
            key={state.provider}
            guide={guide}
            state={state}
            scope="instance"
            headingLevel={2}
            busy={keys.busy === `instance:${state.provider}`}
            onSave={(secret) => keys.save('instance', state.provider, secret)}
            onRemove={() => keys.remove('instance', state.provider)}
          />
        ) : null;
      })}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-secondary text-sm" onClick={finish} disabled={finishing}>{tr('Überspringen')}</button>
        <button type="button" className="btn-primary text-sm flex items-center gap-1.5" onClick={finish} disabled={finishing}>
          {tr('Weiter zur Sammlung')} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default function Setup({ onComplete }) {
  useDocumentTitle(tr('Ersteinrichtung'));
  const [step, setStep] = useState('account');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  // the desktop app sets the code itself and hands it over the bridge
  useEffect(() => {
    window.mangashelfDesktop?.setupToken?.().then((t) => { if (t) setSetupToken((cur) => cur || t); }).catch(() => {});
  }, []);
  const [error, setError] = useState('');
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const tokenRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const usernameId = useId();
  const passwordId = useId();
  const hintId = useId();
  const tokenId = useId();
  const tokenHintId = useId();
  const errorId = useId();

  const fail = (message, { badToken = false } = {}) => {
    setError(message);
    setTokenInvalid(badToken);
    setAttempt((n) => n + 1);
    if (badToken) tokenRef.current?.focus();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      fail(tr('Bitte fülle alle Felder aus.'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(tr('Das Passwort muss mindestens {minPasswordLength} Zeichen lang sein.', { minPasswordLength: MIN_PASSWORD_LENGTH }));
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
        setStep('sources');
      } else if (data?.code === 'ADMIN_EXISTS') {
        // Another tab or browser finished the setup first: continue to the login
        await onComplete({ adminExists: true });
      } else {
        fail(serverText(data) || tr('Fehler bei der Einrichtung'), { badToken: data?.code === 'SETUP_TOKEN_INVALID' });
      }
    } catch (err) {
      fail(tr('Verbindungsfehler zum Server'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4 bg-gradient-to-b from-[#0b0f19] via-[#0f172a] to-[#0b0f19]">
      <div className={`glass-panel p-8 sm:p-10 rounded-3xl w-full ${step === 'sources' ? 'max-w-xl' : 'max-w-md'} border border-slate-700/80 shadow-2xl relative animate-fade-in`}>
        {step === 'sources' ? <SourcesStep onDone={() => onComplete()} /> : (<>
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-tr from-brand-600 to-emerald-400 flex items-center justify-center mb-4 shadow-xl shadow-brand-500/25">
            <Sparkles className="w-8 h-8 text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">{tr('Ersteinrichtung')}</h1>
          <p className="text-sm text-slate-400 mt-1">{tr('Erstelle dein Administrator-Konto für MangaShelf')}</p>
          {/* before the admin exists the choice stays on this device; it is sent with the first sign-in */}
          <LanguageSelect className="justify-center mt-4" />
        </div>

        {error && (
          <div key={attempt} id={errorId} role="alert" className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-6 text-sm text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={tokenId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              {tr('Einrichtungscode')}
            </label>
            <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-700/80 rounded-xl px-4 py-2.5 focus-within:ring-2 focus-within:ring-brand-400 focus-within:border-brand-400 transition-all">
              <KeyRound className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" aria-hidden="true" />
              <input
                ref={tokenRef}
                id={tokenId}
                name="setup_token"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                autoFocus
                aria-describedby={tokenInvalid ? `${tokenHintId} ${errorId}` : tokenHintId}
                aria-invalid={tokenInvalid || undefined}
                className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-0 text-base sm:text-sm font-mono tracking-wider"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                value={setupToken}
                onChange={e => { setSetupToken(e.target.value); setTokenInvalid(false); }}
              />
            </div>
            <p id={tokenHintId} className="mt-1.5 text-xs text-slate-400">
              {tr('Steht in der Server-Konsole bzw. im Log beim Start („Einrichtungscode für das erste Admin-Konto“) oder ist der Wert von SETUP_TOKEN.')}
            </p>
          </div>

          <div>
            <label htmlFor={usernameId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              {tr('Admin-Benutzername')}
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
                placeholder={tr('z. B. admin')}
                value={username} 
                onChange={e => setUsername(e.target.value)} 
              />
            </div>
          </div>

          <div>
            <label htmlFor={passwordId} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              {tr('Passwort')}
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
                placeholder={tr('Sicheres Passwort')}
                value={password} 
                onChange={e => setPassword(e.target.value)} 
              />
            </div>
            <p id={hintId} className="mt-1.5 text-xs text-slate-400">{tr('Mindestens {minPasswordLength} Zeichen.', { minPasswordLength: MIN_PASSWORD_LENGTH })}</p>
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
                <span className="sr-only">{tr('Konto wird angelegt…')}</span>
              </>
            ) : (
              <>
                {tr('Admin-Konto anlegen & starten')} <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </>
            )}
          </button>
        </form>
        </>)}
      </div>
    </main>
  );
}
