import { useEffect, useId, useRef, useState } from 'react';
import { CloudDownload, CloudUpload, GitMerge, LogIn, TriangleAlert } from 'lucide-react';
import ToolDialog from '../components/modals/ToolDialog';
import { notify } from '../utils/notify';
import { formatCount } from '../utils/format';
import { getLocalRuntime } from '../local/localTransport';
import {
  remoteLogin, inspectTransfer, finishTransfer, cancelTransfer, serverHasData, mergeCsv, pullFromServer
} from './takeover';
import { saveServer, findServerByUrl, hostLabel, originOf } from './serverStore';
import { TAKEOVER } from './takeoverTexts';

const ICONS = { push: CloudUpload, merge: GitMerge, pull: CloudDownload };

const countsText = (c) => (c ? `${formatCount(c.mangas ?? 0, 'Reihe', 'Reihen')}, ${formatCount(c.volumes ?? 0, 'Band', 'Bände')}` : '');

function LoginForm({ onLoggedIn, busy, setBusy }) {
  const ids = useId();
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const session = await remoteLogin({ url, username, password });
      onLoggedIn(session, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Am Server anmelden">
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <div>
        <label htmlFor={`${ids}-url`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Serveradresse</label>
        <input id={`${ids}-url`} className="input-field font-mono" type="url" required autoCapitalize="none" spellCheck={false}
          placeholder="https://manga.example.org" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${ids}-user`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Benutzername</label>
          <input id={`${ids}-user`} className="input-field" required autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div>
          <label htmlFor={`${ids}-pw`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">Passwort</label>
          <input id={`${ids}-pw`} className="input-field" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end">
        <button type="submit" disabled={busy} className="btn-primary text-sm inline-flex items-center gap-1.5" aria-busy={busy || undefined}>
          <LogIn className="w-4 h-4" aria-hidden="true" /> {busy ? 'Melde an…' : 'Anmelden'}
        </button>
      </div>
    </form>
  );
}

/** Saves the server with the session of this dialog (only for the origin signed in at) and returns its id. */
export function rememberServer(session) {
  const existing = findServerByUrl(session.base);
  const saved = saveServer({
    ...(existing ? { id: existing.id, urls: existing.urls } : { name: hostLabel(session.base), urls: [session.base] }),
    token: session.token,
    tokenOrigins: [originOf(session.base)]
  });
  return saved.id;
}

/**
 * One of the three takeover dialogs . `onDone({ mode: 'local' })` when the device keeps working
 * standalone, `onDone({ mode: 'server', serverId })` to connect to the server afterwards.
 */
export default function TakeoverDialog({ kind, onClose, onDone, initialSession = null }) {
  const info = TAKEOVER[kind];
  const [session, setSession] = useState(initialSession);
  const password = useRef('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inspect, setInspect] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState(null);
  const staged = useRef(null);

  useEffect(() => () => {
    if (staged.current) cancelTransfer(staged.current.session, staged.current.id);
  }, []);

  const run = async (work) => {
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(err.message || 'Unerwarteter Fehler');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const loggedIn = (next, pw) => {
    password.current = pw;
    setSession(next);
    if (kind === 'push' && next.user.role !== 'admin') setError('Nur ein Administrator kann eine Sammlung auf den Server übertragen. Für ein anderes Konto „Zusammenführen“ verwenden.');
  };

  const check = () => run(async () => {
    const rt = await getLocalRuntime();
    if (kind === 'push') {
      const answer = await inspectTransfer(session, rt, { password: password.current, appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '' });
      staged.current = { session, id: answer.staging_id };
      setInspect(answer);
    } else if (kind === 'merge') {
      setPreview(await mergeCsv(session, rt, { dryRun: true }));
    }
  });

  const apply = () => run(async () => {
    const rt = await getLocalRuntime();
    if (kind === 'push') {
      const { session: again } = await finishTransfer(session, inspect.staging_id, { username: session.user.username, password: password.current });
      staged.current = null;
      notify.success(`Übertragen: ${countsText(inspect.counts)} sind jetzt auf dem Server.`);
      onDone({ mode: 'server', serverId: rememberServer(again) });
    } else if (kind === 'merge') {
      const done = await mergeCsv(session, rt, { dryRun: false });
      setResult({ text: `Zusammengeführt: ${formatCount(done.created_series, 'neue Reihe', 'neue Reihen')}, ${formatCount(done.created_volumes, 'neuer Band', 'neue Bände')}, ${formatCount(done.skipped_existing, 'Band war', 'Bände waren')} schon vorhanden.`, choose: true });
    } else {
      const done = await pullFromServer(session, rt, { onProgress: (n, total) => setProgress({ n, total }) });
      setResult({ text: `Übernommen: ${countsText(done.counts)} (Profil „${done.profile.username}“)${done.kind === 'snapshot' ? ', Besitz und Lesestatus nur von dir' : ''}.`, choose: true, profile: done.profile });
    }
  });

  const finish = (mode) => {
    if (mode === 'server') onDone({ mode: 'server', serverId: rememberServer(session) });
    else onDone({ mode: 'local', profile: result?.profile ?? null });
  };

  const needsConfirm = (kind === 'push' && serverHasData(inspect)) || kind === 'pull';
  let body;
  if (!session) {
    body = <LoginForm onLoggedIn={loggedIn} busy={busy} setBusy={setBusy} />;
  } else if (result) {
    body = (
      <div className="space-y-3" role="status">
        <p className="text-sm text-emerald-200">{result.text}</p>
        {result.choose && (
          <div className="flex flex-wrap gap-2 justify-end">
            <button type="button" className="btn-secondary text-sm" onClick={() => finish('local')}>Ohne Server weiterarbeiten</button>
            <button type="button" className="btn-primary text-sm" onClick={() => finish('server')}>Mit dem Server verbinden</button>
          </div>
        )}
      </div>
    );
  } else {
    const ready = kind === 'pull' || inspect || preview;
    body = (
      <div className="space-y-3">
        <p className="text-xs text-slate-400">Angemeldet als <strong className="text-slate-200">{session.user.username}</strong> bei <span className="font-mono">{hostLabel(session.base)}</span>.</p>
        {inspect && (
          <dl className="grid grid-cols-2 gap-2 text-sm" aria-label="Vergleich">
            <dt className="text-slate-400">Aus der App</dt><dd className="text-slate-100">{countsText(inspect.counts)}, {formatCount(inspect.counts.uploads, 'Bild', 'Bilder')}</dd>
            <dt className="text-slate-400">Jetzt auf dem Server</dt><dd className="text-slate-100">{countsText(inspect.current_counts)}, {formatCount(inspect.current_counts.users, 'Benutzer', 'Benutzer')}</dd>
          </dl>
        )}
        {inspect && serverHasData(inspect) && (
          <p role="alert" className="flex gap-2 text-sm text-amber-200"><TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />Auf dem Server liegen schon Daten – sie würden ersetzt. Für einen Server mit Daten ist „Zusammenführen“ gedacht.</p>
        )}
        {inspect?.warnings?.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-slate-300 space-y-1">{inspect.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        )}
        {preview && (
          <div className="text-sm text-slate-200 space-y-1" aria-label="Vorschau">
            <p>Probelauf: {formatCount(preview.created_series, 'neue Reihe', 'neue Reihen')}, {formatCount(preview.created_volumes, 'neuer Band', 'neue Bände')}, {formatCount(preview.skipped_existing, 'Band ist', 'Bände sind')} schon vorhanden.</p>
            {preview.errors?.length > 0 && <p className="text-amber-200">{formatCount(preview.errors.length, 'Zeile wird', 'Zeilen werden')} übersprungen.</p>}
          </div>
        )}
        {kind === 'pull' && (
          <p className="text-sm text-amber-200">{session.user.role === 'admin' ? 'Das komplette Backup des Servers ersetzt die Sammlung auf diesem Gerät.' : 'Die Offline-Kopie des Servers ersetzt die Sammlung auf diesem Gerät.'}</p>
        )}
        {ready && needsConfirm && (
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            {kind === 'pull' ? 'Sammlung auf diesem Gerät ersetzen' : 'Daten auf dem Server trotzdem ersetzen'}
          </label>
        )}
        {progress && <p role="status" className="text-xs text-slate-400">Cover {progress.n} von {progress.total}…</p>}
      </div>
    );
  }

  const canCheck = session && !result && !inspect && !preview && kind !== 'pull' && !(kind === 'push' && session.user.role !== 'admin');
  const canApply = session && !result && (kind === 'pull' || inspect || preview) && (!needsConfirm || confirmed);
  const footer = (
    <>
      {canCheck && <button type="button" className="btn-secondary text-xs px-4 py-2" disabled={busy} onClick={check}>{kind === 'push' ? 'Prüfen' : 'Probelauf'}</button>}
      {canApply && (
        <button type="button" className="btn-primary text-xs px-4 py-2" disabled={busy} aria-busy={busy || undefined} onClick={apply}>
          {kind === 'push' ? 'Übertragen' : kind === 'merge' ? 'Importieren' : 'Holen'}
        </button>
      )}
    </>
  );

  return (
    <ToolDialog id={`takeover-${kind}`} title={info.title} subtitle={info.subtitle} Icon={ICONS[kind]} onClose={onClose} busy={busy} footer={footer}>
      <div className="space-y-4">
        <p className="text-sm text-slate-300">{info.intro}</p>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        {body}
      </div>
    </ToolDialog>
  );
}
