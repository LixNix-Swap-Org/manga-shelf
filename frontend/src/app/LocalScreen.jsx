import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, CloudDownload, CloudUpload, FileArchive, GitMerge, KeyRound, Server, Smartphone } from 'lucide-react';
import { useDocumentTitle } from '../components/common/PageChrome';
import { getLocalProfile } from '../local/profile';
import api from '../utils/api';
import SourcesPanel from './SourcesPanel';
import { TAKEOVER } from './takeoverTexts';

const TakeoverDialog = lazy(() => import('./TakeoverDialog'));
const BackupExportModal = lazy(() => import('../components/modals/BackupExportModal'));

const ICONS = { push: CloudUpload, merge: GitMerge, pull: CloudDownload };

/**
 * Device screen of the standalone mode (route /server while local): profile, keys, backup, takeover dialogs, mode switch.
 * onOpen() reopens the collection after sign-out, onReplaced() reloads it after a restore.
 */
export default function LocalScreen({ user, notice, onOpen, onReplaced, onTakeover, onLeave, onSwitchProfile }) {
  useDocumentTitle('Auf diesem Gerät');
  const ids = useId();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [profiles, setProfiles] = useState([]);
  const navigate = useNavigate();

  // a restored server backup brings its users along: each one is a profile of this device
  useEffect(() => {
    if (!user) return undefined;
    let active = true;
    api.get('/api/users').then((list) => { if (active && Array.isArray(list)) setProfiles(list); }).catch(() => {});
    return () => { active = false; };
  }, [user]);
  const profile = user ?? (getLocalProfile() ? { username: getLocalProfile().name } : null);

  const toCollection = (outcome) => {
    if (outcome?.status === 'local' || outcome?.status === 'online' || outcome?.status === 'offline') navigate('/', { replace: true });
  };

  const open = async () => {
    setBusy(true);
    try { toCollection(await onOpen()); } finally { setBusy(false); }
  };

  const leave = async () => {
    if (!confirm('Mit einem Server verbinden? Die Sammlung ohne Server bleibt auf diesem Gerät gespeichert und lässt sich hier jederzeit wieder öffnen.')) return;
    toCollection(await onLeave());
  };

  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gradient-to-b from-[#0b0f19] via-[#0f172a] to-[#0b0f19] pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="max-w-xl mx-auto space-y-5">
        <header className="flex items-center gap-3">
          {user && (
            <Link to="/" className="btn-secondary p-2 text-slate-300" aria-label="Zurück zur Sammlung" title="Zurück zur Sammlung">
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            </Link>
          )}
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5 text-white" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-white tracking-tight">Auf diesem Gerät</h1>
            <p className="text-xs text-slate-400">Ohne Server – die Sammlung liegt nur hier</p>
          </div>
        </header>

        {notice && !user && <p role="alert" className="text-sm text-red-300">{notice}</p>}

        <section className="glass-panel rounded-2xl p-4 border border-brand-500/40 flex items-center justify-between gap-3" aria-label="Profil">
          <div className="flex items-center gap-2 min-w-0">
            <Smartphone className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              <span className="block font-bold text-white truncate">{profile?.username || 'Lokales Profil'}</span>
              <span className="block text-[11px] text-slate-400">Profil ohne Passwort · alle Rechte</span>
            </span>
          </div>
          {!user && (
            <button type="button" className="btn-primary text-sm" onClick={open} disabled={busy} aria-busy={busy || undefined}>Sammlung öffnen</button>
          )}
          {user && profiles.length > 1 && onSwitchProfile && (
            <label className="text-xs text-slate-300 flex items-center gap-2">
              Profil
              <select
                aria-label="Profil wechseln"
                className="input-field py-1 text-sm w-auto"
                value={user.id}
                disabled={busy}
                onChange={async (e) => {
                  const next = profiles.find((p) => p.id === Number(e.target.value));
                  if (!next) return;
                  setBusy(true);
                  try { toCollection(await onSwitchProfile({ id: next.id, name: next.username })); } finally { setBusy(false); }
                }}
              >
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.username}</option>)}
              </select>
            </label>
          )}
        </section>

        <section className="glass-panel rounded-2xl p-4 border border-slate-700/70 space-y-3" aria-labelledby={`${ids}-sources`}>
          <button type="button" id={`${ids}-sources`} aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((o) => !o)}
            className="w-full flex items-center justify-between text-left font-bold text-white">
            <span className="inline-flex items-center gap-2"><KeyRound className="w-4 h-4 text-brand-400" aria-hidden="true" /> Quellen &amp; Schlüssel</span>
            {sourcesOpen ? <ChevronDown className="w-4 h-4" aria-hidden="true" /> : <ChevronRight className="w-4 h-4" aria-hidden="true" />}
          </button>
          {sourcesOpen && (user ? <SourcesPanel headingLevel={2} /> : <p className="text-xs text-slate-400">Erst die Sammlung öffnen.</p>)}
        </section>

        <section className="glass-panel rounded-2xl p-4 border border-slate-700/70 space-y-2" aria-label="Sicherung und Server">
          <button type="button" id="btn-local-backup" className="btn-secondary w-full text-sm inline-flex items-center gap-2" onClick={() => setDialog('backup')} disabled={!user}>
            <FileArchive className="w-4 h-4" aria-hidden="true" /> Sicherung exportieren/importieren
          </button>
          {['push', 'merge', 'pull'].map((kind) => {
            const Icon = ICONS[kind];
            return (
              <button key={kind} type="button" id={`btn-takeover-${kind}`} className="btn-secondary w-full text-sm inline-flex items-center gap-2" onClick={() => setDialog(kind)} disabled={!user}>
                <Icon className="w-4 h-4" aria-hidden="true" /> {TAKEOVER[kind].title}
                <span className="sr-only">: {TAKEOVER[kind].subtitle}</span>
              </button>
            );
          })}
        </section>

        <section className="glass-panel rounded-2xl p-4 border border-slate-700/70 space-y-2" aria-labelledby={`${ids}-mode`}>
          <h2 id={`${ids}-mode`} className="font-bold text-white">Modus wechseln</h2>
          <p className="text-xs text-slate-400">Mit einem eigenen Manga-Shelf-Server verbinden. Die Sammlung auf diesem Gerät bleibt erhalten.</p>
          <button type="button" id="btn-leave-local" className="btn-secondary text-sm inline-flex items-center gap-2" onClick={leave}>
            <Server className="w-4 h-4" aria-hidden="true" /> Mit Server verbinden
          </button>
        </section>
      </div>

      <Suspense fallback={null}>
        {dialog === 'backup' && <BackupExportModal onClose={() => setDialog(null)} onReplaced={async () => { setDialog(null); toCollection(await onReplaced()); }} />}
        {dialog && dialog !== 'backup' && (
          <TakeoverDialog kind={dialog} onClose={() => setDialog(null)} onDone={async (action) => { setDialog(null); toCollection(await onTakeover(action)); }} />
        )}
      </Suspense>
    </main>
  );
}
