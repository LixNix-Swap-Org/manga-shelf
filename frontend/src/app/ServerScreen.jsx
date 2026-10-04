import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, BookOpen, Check, ClipboardPaste, Pencil, Plug, Plus, Server, ShieldAlert, Trash, Wifi, WifiOff, X } from 'lucide-react';
import { useDocumentTitle } from '../components/common/PageChrome';
import { notify } from '../utils/notify';
import { formatRelative, formatCount } from '../utils/format';
import { getOutbox, retiredServerId } from '../utils/outbox';
import { flushPendingLogout } from '../appShell';
import useConnection from './useConnection';
import {
  getServers, saveServer, removeServer, subscribeServers, findServerByInstance, findServerByUrl, normalizeUrls, hostLabel,
  isSecureEnough, INSECURE_URL_TEXT, getPendingLogouts
} from './serverStore';
import { probeUrl, PROBE_ERRORS, getActiveBase, getToken } from './connection';

const TakeoverDialog = lazy(() => import('./TakeoverDialog'));
const LocalOffer = lazy(() => import('./LocalOffer'));
import { parseConnectLink, takePendingDeepLink } from './deepLink';
import LanguageSelect from '../components/common/LanguageSelect';
import { t } from '../i18n/index.js';

const EMPTY_FORM = { id: null, name: '', urls: '', instanceId: null };

function useServers() {
  const [servers, setServers] = useState(getServers);
  useEffect(() => subscribeServers(() => setServers(getServers())), []);
  return servers;
}

/** The server entry a connect link belongs to: same instance id, else one that already has the address. */
export function serverForLink(link) {
  return findServerByInstance(link.instanceId) ?? findServerByUrl(link.url);
}

/**
 * The saved server a link offers a new address for (same instance id, address not yet saved), or null. Such a link is
 * never applied silently: the screen asks first (the token only goes there after a new sign-in at that address).
 */
export function linkOffer(link) {
  const server = findServerByInstance(link.instanceId);
  return server && !server.urls.includes(link.url) ? { server, url: link.url } : null;
}

/** Form values for a link: a server that already has the address is opened as it is, else a new entry is prefilled. */
export function formFromLink(link) {
  const existing = serverForLink(link);
  if (existing?.urls.includes(link.url)) {
    return { id: existing.id, name: existing.name, urls: existing.urls.join('\n'), instanceId: existing.instanceId ?? link.instanceId };
  }
  return { id: null, name: link.name && link.name !== 'Manga Shelf' ? link.name : '', urls: link.url, instanceId: link.instanceId };
}

const insecureError = (urls) => {
  const insecure = urls.filter((u) => !isSecureEnough(u));
  return insecure.length ? `${t(INSECURE_URL_TEXT)}: ${insecure.join(', ')}` : '';
};

function AddressOffer({ offer, onDone }) {
  const ids = useId();
  const { server, url } = offer;
  const blocked = insecureError([url]);
  const add = () => {
    saveServer({ id: server.id, urls: [...server.urls, url] });
    notify.info(t('Adresse zu „{name}“ hinzugefügt', { name: server.name }));
    onDone();
  };
  return (
    <div className="space-y-3" role="group" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="text-lg font-bold text-white">{t('Adresse zu „{name}“ hinzufügen?', { name: server.name })}</h2>
      <p className="font-mono text-sm text-slate-200 break-all">{url}</p>
      {blocked
        ? <p role="alert" className="text-sm text-red-300">{blocked}</p>
        : <p className="text-xs text-slate-400">{t('Deine Anmeldung wird erst an diese Adresse gesendet, nachdem du dich dort neu angemeldet hast. Füge sie nur hinzu, wenn du den Link selbst geöffnet hast.')}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-800">
        <button type="button" onClick={onDone} className="btn-secondary text-sm">{t('Abbrechen')}</button>
        {!blocked && (
          <button type="button" onClick={add} className="btn-primary text-sm inline-flex items-center gap-1.5">
            <Plus className="w-4 h-4" aria-hidden="true" /> {t('Adresse hinzufügen')}
          </button>
        )}
      </div>
    </div>
  );
}

function ProbeResults({ results }) {
  if (!results.length) return null;
  return (
    <ul className="space-y-1 text-xs" aria-label={t('Ergebnis der Verbindungsprüfung')}>
      {results.map((r) => (
        <li key={r.url} className={`flex items-center gap-1.5 ${r.ok ? 'text-emerald-300' : 'text-amber-300'}`}>
          {r.ok ? <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
          <span className="font-mono break-all">{r.url}</span>
          <span>– {r.ok ? (r.version ? t('erreichbar (Version {version})', { version: r.version }) : t('erreichbar')) : t(PROBE_ERRORS[r.error] || PROBE_ERRORS.unreachable)}</span>
        </li>
      ))}
    </ul>
  );
}

// i18n
const NO_URL_ERROR = 'Bitte mindestens eine Adresse mit http:// oder https:// eingeben.';

function ServerForm({ initial, onSaved, onCancel }) {
  const ids = useId();
  const [form, setForm] = useState(initial);
  const [results, setResults] = useState([]);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [urlsInvalid, setUrlsInvalid] = useState(false);
  const urlsRef = useRef(null);
  useEffect(() => { setForm(initial); setResults([]); setError(''); setUrlsInvalid(false); }, [initial]);

  const urls = normalizeUrls(form.urls);
  const fail = (message, field = false) => {
    setError(message);
    setUrlsInvalid(field);
    if (field) urlsRef.current?.focus();
  };

  const test = async () => {
    if (testing) return null;
    fail('');
    if (!urls.length) {
      fail(t(NO_URL_ERROR), true);
      return [];
    }
    const insecure = insecureError(urls);
    if (insecure) {
      fail(insecure, true);
      return null;
    }
    setTesting(true);
    try {
      const checked = await Promise.all(urls.map((url) => probeUrl(url, { instanceId: form.instanceId })));
      setResults(checked);
      const found = checked.find((r) => r.ok && r.instanceId);
      if (found && !form.instanceId) setForm((f) => ({ ...f, instanceId: found.instanceId }));
      return checked;
    } finally {
      setTesting(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (testing) return;
    fail('');
    if (!urls.length) {
      fail(t(NO_URL_ERROR), true);
      return;
    }
    const checked = results.length ? results : await test();
    if (!checked) return;
    const instanceId = form.instanceId ?? checked.find((r) => r.ok && r.instanceId)?.instanceId ?? null;
    try {
      const saved = saveServer({
        ...(form.id ? { id: form.id } : {}),
        name: form.name.trim() || hostLabel(urls[0]),
        urls,
        ...(instanceId ? { instanceId } : {})
      });
      onSaved(saved, checked.some((r) => r.ok));
    } catch (err) {
      fail(err.message);
    }
  };

  return (
    <form onSubmit={save} className="space-y-4" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="text-lg font-bold text-white">{form.id ? t('Server bearbeiten') : t('Server hinzufügen')}</h2>
      {error && <p id={`${ids}-error`} role="alert" className="text-sm text-red-300">{error}</p>}
      <div>
        <label htmlFor={`${ids}-name`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Name')}</label>
        <input
          id={`${ids}-name`}
          type="text"
          className="input-field"
          placeholder={t('z. B. Zuhause')}
          value={form.name}
          maxLength={80}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </div>
      <div>
        <label htmlFor={`${ids}-urls`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">{t('Adressen (eine pro Zeile)')}</label>
        <textarea
          id={`${ids}-urls`}
          ref={urlsRef}
          aria-invalid={urlsInvalid || undefined}
          aria-describedby={urlsInvalid && error ? `${ids}-urls-hint ${ids}-error` : `${ids}-urls-hint`}
          className="input-field font-mono min-h-[5.5rem]"
          placeholder={'https://manga.example.org\nhttp://192.168.1.10:3000'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={form.urls}
          onChange={(e) => { setForm((f) => ({ ...f, urls: e.target.value })); setResults([]); }}
        />
        <p id={`${ids}-urls-hint`} className="text-xs text-slate-400 mt-1">{t('Die App nimmt die erste Adresse, die antwortet – zum Beispiel die LAN-Adresse zu Hause und die öffentliche unterwegs.')}</p>
      </div>
      <div role="status" aria-live="polite" className="empty:!mt-0">
        <ProbeResults results={results} />
      </div>
      <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-slate-800">
        {onCancel && <button type="button" onClick={onCancel} className="btn-secondary text-sm">{t('Abbrechen')}</button>}
        <button type="button" onClick={test} aria-disabled={testing || undefined} className="btn-secondary text-sm inline-flex items-center gap-1.5 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed" aria-busy={testing || undefined}>
          <Plug className="w-4 h-4" aria-hidden="true" /> {testing ? t('Prüfe…') : t('Verbindung testen')}
        </button>
        <button type="submit" aria-disabled={testing || undefined} className="btn-primary text-sm inline-flex items-center gap-1.5 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed">
          <Check className="w-4 h-4" aria-hidden="true" /> {t('Speichern und verbinden')}
        </button>
      </div>
    </form>
  );
}

function PasteLink({ onLink }) {
  const ids = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const apply = (e) => {
    e.preventDefault();
    const link = parseConnectLink(text);
    if (!link) {
      setError(t('Kein gültiger Verbindungslink (manga-shelf://connect?…) und keine http(s)-Adresse.'));
      return;
    }
    setError('');
    setText('');
    onLink(link);
  };
  return (
    <form onSubmit={apply} className="space-y-2">
      <label htmlFor={`${ids}-link`} className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">{t('Verbindungslink einfügen')}</label>
      <div className="flex gap-2">
        <input
          id={`${ids}-link`}
          type="text"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${ids}-link-error` : undefined}
          className="input-field font-mono flex-1 min-w-0"
          placeholder="manga-shelf://connect?url=…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn-secondary text-sm inline-flex items-center gap-1.5 shrink-0">
          <ClipboardPaste className="w-4 h-4" aria-hidden="true" /> {t('Übernehmen')}
        </button>
      </div>
      {error && <p id={`${ids}-link-error`} role="alert" className="text-xs text-red-300">{error}</p>}
      <p className="text-xs text-slate-400">{t('Den Link zeigt die Web-Version unter „Mit App verbinden“ (unten auf der Startseite) als QR-Code und zum Kopieren.')}</p>
    </form>
  );
}

/** Addresses of a saved server where a sign-in is refused (plain http outside the home network, saved earlier). */
export const insecureUrls = (server) => server.urls.filter((u) => !isSecureEnough(u));

/** App build: saved servers, adding and editing them, the connection test; `onSelect(id)` resolves once App checked the session. */
export default function ServerScreen({ user, onSelect, onUseLocal, onTakeover }) {
  useDocumentTitle(t('Server'));
  const servers = useServers();
  const connection = useConnection();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState(() => (getServers().length ? null : EMPTY_FORM));
  const [offer, setOffer] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [pulling, setPulling] = useState(false);

  const openLink = (link) => {
    const next = linkOffer(link);
    setOffer(next);
    setForm(next ? null : formFromLink(link));
  };

  useEffect(() => {
    const link = takePendingDeepLink() ?? location.state?.link ?? null;
    if (link) openLink(link);
    // "Server bearbeiten" from the login (an address where no sign-in is possible)
    const edit = location.state?.edit ? getServers().find((s) => s.id === location.state.edit) : null;
    if (edit) setForm({ id: edit.id, name: edit.name, urls: edit.urls.join('\n'), instanceId: edit.instanceId ?? null });
  }, [location.state]);

  // changes kept from a removed server go to the server with the same instance id once it is saved again
  useEffect(() => {
    const outbox = getOutbox();
    for (const server of servers) {
      if (server.instanceId) outbox.moveServer(retiredServerId(server.instanceId), server.id).catch(() => {});
    }
  }, [servers]);

  const connect = async (id) => {
    setBusyId(id);
    try {
      const outcome = await onSelect(id);
      navigate(outcome?.status === 'online' || outcome?.status === 'offline' ? '/' : '/login', { replace: true });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (server) => {
    const outbox = getOutbox();
    let queued = 0;
    try {
      await outbox.load();
      queued = outbox.countServer(server.id);
    } catch (_) { /* no outbox: nothing to count */ }
    const changes = queued ? formatCount(queued, 'vorgemerkte Änderung geht', 'vorgemerkte Änderungen gehen') : '';
    const lost = !queued ? '' : ` ${server.instanceId
      ? t('{changes} verloren, außer du fügst denselben Server wieder hinzu.', { changes })
      : t('{changes} verloren.', { changes })}`;
    if (!confirm(t('Server „{name}“ entfernen? Die Anmeldung auf diesem Gerät wird dabei vergessen.{lost}', { name: server.name, lost }))) return;
    setBusyId(server.id);
    try {
      // an outstanding logout is sent now if the server answers, else given up with the entry
      if (getPendingLogouts(server.id).length) await flushPendingLogout({ serverId: server.id }).catch(() => false);
      removeServer(server.id);
      if (queued && server.instanceId) await outbox.moveServer(server.id, retiredServerId(server.instanceId));
      else await outbox.dropServer(server.id);
    } catch (_) { /* the entries stay stored */ } finally {
      setBusyId(null);
    }
    notify.info(t('„{name}“ entfernt', { name: server.name }));
  };

  const onSaved = (saved, reachable) => {
    setForm(null);
    if (!reachable) notify.info(t('Gespeichert. Der Server antwortet gerade nicht – die App verbindet sich, sobald er erreichbar ist.'));
    connect(saved.id);
  };

  const afterSwitch = (outcome) => {
    if (outcome?.status === 'local' || outcome?.status === 'online' || outcome?.status === 'offline') navigate('/', { replace: true });
    else if (outcome) navigate('/login', { replace: true });
  };
  const openLocalCollection = async () => afterSwitch(await onUseLocal());

  const activeId = connection.server?.id ?? null;

  return (
    <main className="min-h-screen p-4 sm:p-6 bg-gradient-to-b from-[#0b0f19] via-[#0f172a] to-[#0b0f19] pt-[max(1rem,env(safe-area-inset-top))]">
      <div className="max-w-xl mx-auto space-y-6">
        <header className="flex items-center gap-3">
          {user && (
            <Link to="/" className="btn-secondary p-2 text-slate-300" aria-label={t('Zurück zur Sammlung')} title={t('Zurück zur Sammlung')}>
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            </Link>
          )}
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand-600 to-sky-400 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5 text-white" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-white tracking-tight">{t('Server')}</h1>
            <p className="text-xs text-slate-400">{t('Mit welchem Manga-Shelf-Server sich die App verbindet')}</p>
          </div>
          <LanguageSelect className="ml-auto" showLabel={false} />
        </header>

        {onUseLocal && servers.length === 0 && <Suspense fallback={null}><LocalOffer user={user} onUseLocal={openLocalCollection} onPull={() => setPulling(true)} /></Suspense>}

        {servers.length > 0 && (
          <section aria-label={t('Gespeicherte Server')} className="space-y-3">
            {servers.map((server) => {
              const active = server.id === activeId;
              const online = active && connection.state === 'online';
              return (
                <article key={server.id} className={`glass-panel rounded-2xl p-4 border ${active ? 'border-brand-500/60' : 'border-slate-700/70'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="font-bold text-white flex items-center gap-2">
                        <Server className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" />
                        <span className="truncate">{server.name}</span>
                        {active && (
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${online ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' : 'text-amber-300 border-amber-500/40 bg-amber-500/10'}`}>
                            {online ? t('Verbunden') : (connection.state === 'connecting' ? t('Verbinde…') : t('Offline'))}
                          </span>
                        )}
                      </h2>
                      <ul className="mt-1 space-y-0.5 text-xs text-slate-400 font-mono break-all">
                        {server.urls.map((url) => (
                          <li key={url} className={url === (active ? connection.baseUrl : server.lastOkUrl) ? 'text-slate-200' : undefined}>{url}</li>
                        ))}
                      </ul>
                      {insecureUrls(server).length > 0 && (
                        <p className="mt-1 flex items-start gap-1 text-[11px] text-red-300" data-testid="insecure-server">
                          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                          <span>{t('Anmeldung nicht möglich: {urls} ist unverschlüsselt und nicht im Heimnetz. Bearbeiten und https:// verwenden.', { urls: insecureUrls(server).join(', ') })}</span>
                        </p>
                      )}
                      <p className="text-[11px] text-slate-400 mt-1">
                        {server.token ? t('Angemeldet') : t('Nicht angemeldet')}
                        {server.lastOkAt ? ` · ${t('zuletzt erreicht {time}', { time: formatRelative(server.lastOkAt) ?? '' })}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" onClick={() => setForm({ id: server.id, name: server.name, urls: server.urls.join('\n'), instanceId: server.instanceId ?? null })} className="btn-secondary p-2" aria-label={t('{name} bearbeiten', { name: server.name })} title={t('Bearbeiten')}>
                        <Pencil className="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button type="button" onClick={() => remove(server)} className="btn-secondary p-2 text-red-300" aria-label={t('{name} entfernen', { name: server.name })} title={t('Entfernen')}>
                        <Trash className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button type="button" onClick={() => connect(server.id)} disabled={busyId !== null} className="btn-primary text-sm inline-flex items-center gap-1.5" aria-busy={busyId === server.id || undefined}>
                      {online ? <Wifi className="w-4 h-4" aria-hidden="true" /> : <WifiOff className="w-4 h-4" aria-hidden="true" />}
                      {busyId === server.id ? t('Verbinde…') : (active ? t('Verbindung prüfen') : t('Verbinden'))}
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        <section className="glass-panel rounded-2xl p-4 sm:p-5 border border-slate-700/70">
          {offer ? (
            <AddressOffer offer={offer} onDone={() => setOffer(null)} />
          ) : form ? (
            <ServerForm initial={form} onSaved={onSaved} onCancel={servers.length ? () => setForm(null) : null} />
          ) : (
            <button type="button" onClick={() => setForm(EMPTY_FORM)} className="btn-secondary w-full text-sm inline-flex items-center justify-center gap-1.5">
              <Plus className="w-4 h-4" aria-hidden="true" /> {t('Server hinzufügen')}
            </button>
          )}
        </section>

        <section className="glass-panel rounded-2xl p-4 sm:p-5 border border-slate-700/70">
          <PasteLink onLink={openLink} />
        </section>

        {onUseLocal && servers.length > 0 && <Suspense fallback={null}><LocalOffer user={user} onUseLocal={openLocalCollection} onPull={() => setPulling(true)} /></Suspense>}
      </div>
      {pulling && (
        <Suspense fallback={null}>
          <TakeoverDialog
            kind="pull"
            initialSession={{ base: getActiveBase(), token: getToken(), user }}
            onClose={() => setPulling(false)}
            onDone={async (action) => { setPulling(false); afterSwitch(await onTakeover?.(action)); }}
          />
        </Suspense>
      )}
    </main>
  );
}
