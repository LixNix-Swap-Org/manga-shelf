import { useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpen, Smartphone } from 'lucide-react';
import { useDocumentTitle } from '../components/common/PageChrome';
import SourcesPanel from './SourcesPanel';

export const PROFILE_NAME_MAX = 40;

function Steps({ current }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-brand-300">Schritt {current} von 3</p>;
}

/**
 * Onboarding of the standalone mode (route /lokal): step 1 was "Ohne Server nutzen" on the server screen, step 2 names
 * the local profile, step 3 connects the sources (optional). `onStart({ name })` creates the local database.
 */
export default function LocalSetup({ user, onStart }) {
  useDocumentTitle('Ohne Server nutzen');
  const ids = useId();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = Boolean(user?.local);

  const start = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Bitte einen Namen für dein Profil eingeben.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const outcome = await onStart({ name: trimmed });
      if (outcome?.status !== 'local') setError(outcome?.error || 'Die lokale Sammlung konnte nicht angelegt werden.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gradient-to-b from-[#0b0f19] via-[#0f172a] to-[#0b0f19] pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="max-w-xl mx-auto space-y-6">
        <header className="flex items-center gap-3">
          {!local && (
            <Link to="/server" className="btn-secondary p-2 text-slate-300" aria-label="Zurück" title="Zurück">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            </Link>
          )}
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5 text-white" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-white tracking-tight">Ohne Server nutzen</h1>
            <p className="text-xs text-slate-400">Die Sammlung liegt nur auf diesem Gerät; später lässt sie sich auf einen Server übertragen.</p>
          </div>
        </header>

        {!local ? (
          <form onSubmit={start} className="glass-panel rounded-2xl p-4 sm:p-5 border border-slate-700/70 space-y-4" aria-labelledby={`${ids}-title`}>
            <Steps current={2} />
            <h2 id={`${ids}-title`} className="text-lg font-bold text-white flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-brand-400" aria-hidden="true" /> Dein Profil
            </h2>
            <p className="text-sm text-slate-300">Besitz und Lesestatus gehören zu diesem Profil – wie ein Benutzer auf einem Server, nur ohne Passwort.</p>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <div>
              <label htmlFor={`${ids}-name`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Name</label>
              <input id={`${ids}-name`} className="input-field" placeholder="z. B. Felix" maxLength={PROFILE_NAME_MAX} autoFocus
                value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={busy} className="btn-primary text-sm inline-flex items-center gap-1.5" aria-busy={busy || undefined}>
                {busy ? 'Lege an…' : 'Sammlung anlegen'} <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </form>
        ) : (
          <section className="glass-panel rounded-2xl p-4 sm:p-5 border border-slate-700/70 space-y-4" aria-labelledby={`${ids}-sources`}>
            <Steps current={3} />
            <h2 id={`${ids}-sources`} className="text-lg font-bold text-white">Quellen verbinden (optional)</h2>
            <SourcesPanel />
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              <button type="button" className="btn-secondary text-sm" onClick={() => navigate('/', { replace: true })}>Überspringen</button>
              <button type="button" className="btn-primary text-sm" onClick={() => navigate('/', { replace: true })}>Fertig</button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
