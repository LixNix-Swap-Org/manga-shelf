import { useState } from 'react';
import { BookOpen, User, Lock, Sparkles, ArrowRight } from 'lucide-react';

export default function Setup({ onComplete }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Bitte fülle alle Felder aus.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      });
      const data = await res.json();
      if (res.ok) {
        onComplete();
      } else {
        setError(data.error || 'Fehler bei der Initialisierung');
      }
    } catch (err) {
      setError('Verbindungsfehler zum Server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4 bg-gradient-to-b from-[#0b0f19] via-[#0f172a] to-[#0b0f19]">
      <div className="glass-panel p-8 sm:p-10 rounded-3xl w-full max-w-md border border-slate-700/80 shadow-2xl relative animate-fade-in">
        <div className="text-center mb-8">
          <div className="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-tr from-brand-600 to-emerald-400 flex items-center justify-center mb-4 shadow-xl shadow-brand-500/25">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Ersteinrichtung</h1>
          <p className="text-sm text-slate-400 mt-1">Erstelle dein Administrator-Konto für MangaShelf</p>
        </div>

        {error && (
          <div className="bg-red-500/15 border border-red-500/40 text-red-300 p-3.5 rounded-xl mb-6 text-sm text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Admin-Benutzername
            </label>
            <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-700/80 rounded-xl px-4 py-2.5 focus-within:ring-2 focus-within:ring-brand-500/50 focus-within:border-brand-500 transition-all">
              <User className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" />
              <input 
                type="text" 
                className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 text-sm" 
                required 
                autoFocus
                placeholder="z.B. admin"
                value={username} 
                onChange={e => setUsername(e.target.value)} 
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Passwort
            </label>
            <div className="flex items-center gap-3 bg-slate-950/70 border border-slate-700/80 rounded-xl px-4 py-2.5 focus-within:ring-2 focus-within:ring-brand-500/50 focus-within:border-brand-500 transition-all">
              <Lock className="w-4 h-4 text-slate-400 shrink-0 pointer-events-none" />
              <input 
                type="password" 
                className="w-full bg-transparent border-0 p-0 text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-0 text-sm" 
                required 
                placeholder="Sicheres Passwort"
                value={password} 
                onChange={e => setPassword(e.target.value)} 
              />
            </div>
          </div>

          <button 
            type="submit" 
            className="btn-primary w-full mt-6 py-3 flex items-center justify-center gap-2 text-sm shadow-xl"
            disabled={loading}
          >
            {loading ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <>
                Admin-Konto anlegen & starten <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
