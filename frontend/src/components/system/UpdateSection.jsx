import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CircleCheck, Download, ExternalLink, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import api, { readJson, TIMEOUTS } from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatDateTime, formatMegabytes, formatNumber, formatTime } from '../../utils/format';
import { serverText } from '../../i18n/serverText.js';
import { rich } from '../../i18n/react.jsx';
import { t } from '../../i18n/index.js';
import {
  announceUpdateOutcome, elapsedLine, getUpdateWatch, startUpdateWatch, stopUpdateWatch, subscribeUpdateWatch,
  watchStatusText, watchUpdateView
} from '../../utils/updateWatcher';
import PasswordConfirm from './PasswordConfirm';
import { Section } from './SystemSection';
import UpdateInstructions from './UpdateInstructions';
import VersionPicker from './VersionPicker';
import {
  adminNotes, APPLY_PHASES, compareVersions, DOWNLOAD_PHASES, errorText, ISSUES_URL, PHASE_TEXT,
  isSelectable, releasesBetween, releaseUrl, restartKind, SIGNATURE_CODES, sortReleases, startCommand
} from './updateModel';

const MB = 1024 * 1024;
const SIGSTORE_HOST = 'tuf-repo-cdn.sigstore.dev';
const STATUS_POLL_MS = 1000;
const RELEASES_POLL_MS = 3000;
const RELEASES_POLL_MAX = 10;

const linkClass = 'inline-flex items-center gap-1 underline';
const redBox = 'p-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-xs text-rose-200 space-y-2';
const amberBox = 'p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-xs text-amber-100 space-y-2';

const stagingIdOf = (status, update) => status?.staging_id || update?.staging?.staging_id || update?.staging?.id || null;

function retryTime(res, data) {
  const header = Number(res.headers?.get?.('retry-after'));
  const seconds = Number.isFinite(header) && header > 0 ? header : Number(data?.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? formatTime(Date.now() + seconds * 1000) : '';
}

function progressText(status) {
  const bytes = Number(status?.bytes) || 0;
  const total = Number(status?.total) || 0;
  const loaded = formatNumber(bytes / MB, 1);
  return total > 0
    ? t('Lädt… {loaded} von {total} MB', { loaded, total: formatNumber(total / MB, 1) })
    : t('Lädt… {loaded} MB', { loaded });
}

function restartText(kind, command) {
  if (kind === 'pterodactyl') {
    return t('Der Server startet danach neu. Die Panel-Konsole zeigt dabei einen Absturz mit Exit 75 – das ist beabsichtigt; bleibt der Server stehen, im Panel starten.');
  }
  if (kind === 'supervised') {
    return `${t('Der Server startet danach automatisch neu.')} ${t('Er ist dabei kurz nicht erreichbar, die Apps zeigen so lange „offline“; alle bleiben angemeldet.')}`;
  }
  return command
    ? rich('Dieser Server wird nicht automatisch neu gestartet – starte ihn danach mit: {command}', { command: <code className="break-all">{command}</code> })
    : t('Dieser Server wird nicht automatisch neu gestartet – starte ihn danach mit demselben Befehl.');
}

function waitHints(watch) {
  const hints = [];
  if (watch.mode === 'pterodactyl' || watch.restart === 'pterodactyl') {
    hints.push({ key: 'panel', line: t('In der Panel-Konsole nachsehen; bleibt der Server gestoppt, im Panel auf „Start“ drücken.') });
  }
  if (watch.supervisor === 'systemd') hints.push({ key: 'journal', line: t('Logs ansehen:'), command: 'journalctl --user -u manga-shelf -n 50' });
  if (watch.supervisor === 'launchd') hints.push({ key: 'launchd', line: t('Logs ansehen:'), command: '~/Library/Logs/manga-shelf/launchd.log' });
  if (watch.restart === 'manual') {
    hints.push(watch.command
      ? { key: 'manual', line: t('Server von Hand starten:'), command: watch.command }
      : { key: 'manual', line: t('Server mit demselben Befehl wieder starten.') });
  }
  return hints;
}

function WaitCard({ watch, waitRef, onReload }) {
  const failed = watch.phase === 'failed';
  const hints = watch.phase === 'slow' || watch.phase === 'pending_start' ? waitHints(watch) : [];
  return (
    <div ref={waitRef} tabIndex={-1} className={`${failed ? redBox : 'space-y-2 text-xs'} outline-none`} data-testid="update-wait">
      <p role="status" aria-live="polite" className={`font-semibold flex items-center gap-1.5 ${failed ? '' : 'text-white'}`}>
        {failed
          ? <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
          : <RefreshCw className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" />}
        {watchStatusText(watch)}
      </p>
      {failed ? (
        <>
          {errorText(watch.error) && <p>{errorText(watch.error)}</p>}
          <button type="button" className="btn-secondary text-xs" onClick={() => { stopUpdateWatch(); onReload(); }}>{t('Neu laden')}</button>
        </>
      ) : (
        <>
          <p className="text-slate-400">{elapsedLine(watch)}</p>
          {hints.length > 0 && (
            <ul className="space-y-1 text-slate-300">
              {hints.map((hint) => (
                <li key={hint.key}>{hint.line}{hint.command && <> <code className="break-all text-slate-200">{hint.command}</code></>}</li>
              ))}
            </ul>
          )}
          <p className="text-slate-400">{t('Die Seite lädt neu, sobald der Server wieder antwortet. Der Dialog darf geschlossen werden.')}</p>
        </>
      )}
    </div>
  );
}

function LastResult({ last }) {
  if (!last?.to || !last.result) return null;
  const at = last.at ? formatDateTime(last.at) : '';
  const backup = typeof last.backup === 'string' ? last.backup : last.backup?.file;
  const details = typeof last.error === 'string' ? last.error : (last.error ? errorText(last.error) || last.error.code || '' : '');
  if (last.result === 'ok') {
    return (
      <p className="text-xs text-slate-300 flex items-start gap-1.5" data-testid="update-last">
        <CircleCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
        <span>
          {t('Zuletzt aktualisiert: v{from} → v{to} ({at})', { from: last.from, to: last.to, at })}
          {backup ? ` · ${t('Backup davor: {file}', { file: backup })}` : ''}
        </span>
      </p>
    );
  }
  const text = last.result === 'rolled_back'
    ? t('v{to} ist nicht gestartet; v{from} läuft wieder, Code und Datenbank wurden zurückgesetzt ({at}).', { from: last.from, to: last.to, at })
    : last.result === 'failed'
      ? t('Update auf v{to} fehlgeschlagen ({at}).', { to: last.to, at })
      : t('v{version} ist installiert und wartet auf den Start von Hand', { version: last.to });
  return (
    <div className={last.result === 'pending_start' ? amberBox : redBox} data-testid="update-last">
      <p className="flex items-start gap-1.5"><TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" /> <span>{text}</span></p>
      {backup && <p>{t('Backup davor: {file}', { file: backup })}</p>}
      {details && (
        <details>
          <summary className="cursor-pointer">{t('Details')}</summary>
          <code className="block mt-1 break-all whitespace-pre-wrap">{details}</code>
        </details>
      )}
    </div>
  );
}

/** Update card of the system page: banner, version picker, download and check, confirm with password, restart wait. */
export default function UpdateSection({ update, instanceId = null, platform = '', busy = null, onReload, onBusyChange }) {
  const current = update?.current;
  const install = update?.install || null;
  const canInstall = Boolean(install?.can_install);
  const releases = Array.isArray(update?.releases) ? update.releases : null;
  const sorted = sortReleases(releases);
  const pickable = (r) => isSelectable(r, { current, canInstall });
  const newest = sorted.find(pickable) || null;

  const [status, setStatus] = useState(update?.status || null);
  const [selected, setSelected] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pwError, setPwError] = useState('');
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState(false);
  const [username, setUsername] = useState('');
  const [failedInSession, setFailedInSession] = useState(false);
  const watch = useSyncExternalStore(subscribeUpdateWatch, getUpdateWatch, getUpdateWatch);

  const latestRef = useRef(null);
  const startRef = useRef(null);
  const cancelRef = useRef(null);
  const installRef = useRef(null);
  const retryRef = useRef(null);
  const failureRef = useRef(null);
  const waitRef = useRef(null);
  const polls = useRef(0);
  const autoRetried = useRef(new Set());

  const phase = status?.phase || 'idle';
  const downloading = DOWNLOAD_PHASES.has(phase);
  const waiting = Boolean(watch) && watch.phase !== 'done';
  const flowActive = preparing || downloading || phase === 'ready' || APPLY_PHASES.has(phase) || waiting;
  const stagingId = stagingIdOf(status, update);
  const nextTry = update?.next_try_at && new Date(update.next_try_at).getTime() > Date.now() ? update.next_try_at : null;
  const loadingReleases = releases === null && !update?.releases_error && !nextTry;
  const selectable = selected && sorted.some((r) => r.version === selected && pickable(r)) ? selected : null;
  const chosen = selectable || newest?.version || (update?.available ? update.latest : null);
  const latestRelease = sorted.find((r) => r.version === update?.latest) || null;
  const canQuick = canInstall && update?.available && !flowActive && (!latestRelease || latestRelease.installable);
  const upToDate = releases !== null && !update?.available && !sorted.some((r) => compareVersions(r.version, current) > 0);

  useEffect(() => { setStatus(update?.status || null); }, [update]);
  useEffect(() => watchUpdateView(), []);
  useEffect(() => { announceUpdateOutcome(); }, []);

  const prepare = useCallback(async (version) => {
    if (!version) return;
    setNotice('');
    setPwError('');
    setConfirmOpen(false);
    setPreparing(true);
    try {
      const res = await api.post('/api/system/update/prepare', { version }, { fallback: t('Download konnte nicht gestartet werden') });
      setStatus({ phase: 'downloading', version, bytes: 0, total: 0, staging_id: res?.staging_id ?? null, expires_at: res?.expires_at ?? null });
    } catch (err) {
      setStatus({ phase: 'failed', version, error: { code: err?.code || null, text: err?.message || t('Download konnte nicht gestartet werden') } });
      setFailedInSession(true);
    } finally {
      setPreparing(false);
    }
  }, []);

  useEffect(() => {
    if (!downloading) return undefined;
    let alive = true;
    let timer = null;
    const poll = async () => {
      try {
        const next = await api.get('/api/system/update/status', { timeout: TIMEOUTS.read });
        if (!alive) return;
        if (next && typeof next === 'object') {
          setStatus(next);
          if (next.phase === 'failed') setFailedInSession(true);
        }
      } catch (_) { /* next poll */ }
      if (alive) timer = setTimeout(poll, STATUS_POLL_MS);
    };
    timer = setTimeout(poll, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [downloading]);

  const prevPhase = useRef(phase);
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    if (prev === phase) return;
    if (DOWNLOAD_PHASES.has(phase) && !DOWNLOAD_PHASES.has(prev)) cancelRef.current?.focus();
    else if (phase === 'ready') installRef.current?.focus();
    else if (phase === 'failed') (retryRef.current || failureRef.current)?.focus();
    else if (phase === 'idle' && (DOWNLOAD_PHASES.has(prev) || prev === 'ready')) (startRef.current || latestRef.current)?.focus();
  }, [phase]);

  useEffect(() => {
    if (phase !== 'failed' || !failedInSession || status?.error?.code !== 'CHECKSUM_MISMATCH' || !status.version) return;
    if (autoRetried.current.has(status.version)) return;
    autoRetried.current.add(status.version);
    prepare(status.version);
  }, [phase, failedInSession, status, prepare]);

  useEffect(() => {
    if (!APPLY_PHASES.has(phase) || getUpdateWatch() || !status?.version) return;
    startUpdateWatch({
      version: status.version, from: current, restart: phase === 'pending_start' ? 'manual' : restartKind(install),
      mode: install?.mode || null, supervisor: install?.supervisor || null, command: startCommand(install?.instructions?.argv) || null, instanceId
    });
  }, [phase, status, current, install, instanceId]);

  useEffect(() => {
    if (!loadingReleases || polls.current >= RELEASES_POLL_MAX) return undefined;
    const timer = setTimeout(() => {
      polls.current++;
      onReload({ silent: true });
    }, RELEASES_POLL_MS);
    return () => clearTimeout(timer);
  }, [loadingReleases, update, onReload]);

  const wasConfirm = useRef(false);
  useEffect(() => {
    if (!confirmOpen && wasConfirm.current) installRef.current?.focus();
    wasConfirm.current = confirmOpen;
  }, [confirmOpen]);

  const wasWaiting = useRef(waiting);
  useEffect(() => {
    if (waiting && !wasWaiting.current) waitRef.current?.focus();
    wasWaiting.current = waiting;
  }, [waiting]);

  useEffect(() => {
    if (!confirmOpen || username) return undefined;
    let alive = true;
    api.get('/api/auth/me')
      .then((data) => { if (alive && typeof data?.user?.username === 'string') setUsername(data.user.username); })
      .catch(() => {});
    return () => { alive = false; };
  }, [confirmOpen, username]);

  const discard = async () => {
    setConfirmOpen(false);
    setPwError('');
    setStatus({ phase: 'idle' });
    if (stagingId) {
      try {
        await api.del(`/api/system/update/staging/${encodeURIComponent(stagingId)}`, { fallback: t('Verwerfen fehlgeschlagen') });
      } catch (err) {
        notify.error(err, { fallback: t('Verwerfen fehlgeschlagen') });
      }
    }
    onReload({ silent: true });
  };

  const checkNow = async () => {
    setChecking(true);
    try {
      await api.post('/api/system/update/check', {}, { timeout: TIMEOUTS.read, fallback: t('Versionen konnten nicht abgefragt werden') });
    } catch (err) {
      notify.error(err, { fallback: t('Versionen konnten nicht abgefragt werden') });
    } finally {
      setChecking(false);
    }
    polls.current = 0;
    onReload({ silent: true });
  };

  const confirmInstall = async (password) => {
    setPwError('');
    onBusyChange?.('update');
    try {
      const res = await api.fetch(`/api/system/update/apply/${encodeURIComponent(stagingId || '')}`, { method: 'POST', body: { current_password: password } });
      const data = (await readJson(res)) ?? {};
      if (res.ok) {
        setConfirmOpen(false);
        startUpdateWatch({
          version: data.version || status?.version, from: current, restart: data.restart || restartKind(install),
          mode: install?.mode || null, supervisor: install?.supervisor || null, command: startCommand(install?.instructions?.argv) || null, instanceId
        });
        return;
      }
      if (data.code === 'WRONG_PASSWORD') {
        setPwError(serverText(data) || t('Das aktuelle Passwort stimmt nicht'));
        return;
      }
      if (res.status === 429) {
        const time = retryTime(res, data);
        if (data.code === 'TOO_MANY_ATTEMPTS') {
          setPwError(time
            ? t('Zu viele Fehlversuche. Erneut möglich ab {time} Uhr; so lange ist auch die Anmeldung mit diesem Konto gesperrt.', { time })
            : t('Zu viele Fehlversuche. Die Anmeldung mit diesem Konto ist vorübergehend gesperrt.'));
        } else {
          setPwError(time ? t('Zu viele Versuche. Erneut möglich ab {time} Uhr.', { time }) : (serverText(data) || t('Zu viele Anfragen – bitte kurz warten.')));
        }
        return;
      }
      if (res.status === 410 || res.status === 404) {
        setConfirmOpen(false);
        setStatus({ phase: 'idle' });
        setNotice(t('Die Prüfung ist abgelaufen. Bitte die Version erneut herunterladen und prüfen.'));
        onReload({ silent: true });
        return;
      }
      setPwError(serverText(data) || t('Installation konnte nicht gestartet werden'));
    } catch (err) {
      setPwError(err?.message || t('Installation konnte nicht gestartet werden'));
    } finally {
      onBusyChange?.(null);
    }
  };

  const busyOther = Boolean(busy);
  const failure = phase === 'failed' ? status?.error || null : null;
  const severe = SIGNATURE_CODES.has(failure?.code);
  const failureText = severe
    ? t('Nicht installiert: Die Datei stammt nicht nachweislich aus dem Release-Workflow von manga-shelf. Nichts wurde verändert, die Datei wurde gelöscht. Bitte melden.')
    : failure?.code === 'CHECKSUM_MISMATCH'
      ? t('Download beschädigt – erneut versuchen')
      : failure?.code === 'SIGSTORE_TRUST_UNAVAILABLE'
        ? rich('Signaturdienst nicht erreichbar ({host})', { host: <code className="break-all">{SIGSTORE_HOST}</code> })
        : errorText(failure) || t('Download oder Prüfung fehlgeschlagen');
  const version = status?.version;
  const expires = status?.expires_at ? formatTime(status.expires_at) : '';
  const notes = phase === 'ready' ? adminNotes(status) : [];
  const noteLinks = phase === 'ready' && version ? releasesBetween(releases, current, version).filter((r) => r.has_admin_notes && releaseUrl(r)) : [];
  const restart = restartKind(install);
  const command = startCommand(install?.instructions?.argv);
  const identity = status?.verified?.identity || '–';
  const file = status?.asset || update?.staging?.asset || install?.asset;
  const size = Number(status?.total) || Number(update?.staging?.size) || 0;
  const total = Number(status?.total) || 0;
  const pct = phase === 'downloading' ? (total > 0 ? Math.min(100, Math.round(((Number(status?.bytes) || 0) / total) * 100)) : 0) : 100;

  return (
    <Section id="system-updates-title" title={t('Updates')} Icon={Download} busy={loadingReleases || checking || preparing}>
      {update?.available && (
        <div id="system-update" className="p-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-200 flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2"><Sparkles className="w-4 h-4" aria-hidden="true" /> {t('Neue Version verfügbar: v{latest} (installiert: v{current})', { latest: update.latest, current: update.current })}</span>
          <span className="flex flex-wrap items-center gap-3">
            {update.url && (
              <a href={update.url} target="_blank" rel="noreferrer noopener" className={`${linkClass} text-emerald-100`}>
                {t('Versionshinweise')} <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
            {canQuick && (
              <button ref={latestRef} type="button" id="btn-update-latest" className="btn-primary text-xs inline-flex items-center gap-1.5" disabled={busyOther || preparing} onClick={() => prepare(update.latest)}>
                <Download className="w-3.5 h-3.5" aria-hidden="true" /> {t('Auf v{latest} aktualisieren', { latest: update.latest })}
              </button>
            )}
          </span>
        </div>
      )}

      {notice && <p role="status" className="text-xs text-amber-200">{notice}</p>}

      {waiting && <WaitCard watch={watch} waitRef={waitRef} onReload={() => onReload()} />}

      {!waiting && (preparing || downloading) && (
        <div className="space-y-2 text-xs" data-testid="update-progress">
          <p role="status" aria-live="polite" className="font-semibold text-white">
            {preparing ? t('Download wird gestartet…') : t(PHASE_TEXT[phase])}{version && !preparing ? ` (v${version})` : ''}
          </p>
          <div
            role="progressbar"
            aria-label={t('Download')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-valuetext={phase === 'downloading' ? progressText(status) : t(PHASE_TEXT[phase] || PHASE_TEXT.downloading)}
            className="h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800"
          >
            <div className="h-full bg-brand-500 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          {phase === 'downloading' && <p className="text-slate-400">{progressText(status)}</p>}
          {expires && <p className="text-slate-400">{t('Diese Prüfung gilt bis {expires} Uhr.', { expires })}</p>}
          <button ref={cancelRef} type="button" className="btn-secondary text-xs" disabled={preparing} onClick={discard}>{t('Abbrechen')}</button>
        </div>
      )}

      {!waiting && phase === 'ready' && (
        <div className="space-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-slate-300" data-testid="update-ready">
          <p role="status" aria-live="polite" className="font-semibold text-white">{t(PHASE_TEXT.ready)}{version ? ` (v${version})` : ''}</p>
          <p className="flex items-start gap-1.5 text-emerald-200">
            <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{rich('Geprüft: signiert von GitHub Actions ({identity}), SHA-256 ✓', { identity: <code className="break-all">{identity}</code> })}</span>
          </p>
          {file && <p>{t('Datei: {file} ({size})', { file, size: size ? formatMegabytes(size) : '–' })}</p>}
          <p>{t('Vorher wird ein geprüftes Backup der Datenbank angelegt.')}</p>
          {(notes.length > 0 || noteLinks.length > 0) && (
            <div className={amberBox} data-testid="update-admin-notes">
              <p className="font-semibold flex items-center gap-1.5"><TriangleAlert className="w-4 h-4" aria-hidden="true" /> {t('Vor dem Update beachten')}</p>
              {notes.map((note, i) => (
                <div key={`${note.version}-${i}`}>
                  <p className="font-semibold">v{note.version}</p>
                  <p className="whitespace-pre-wrap break-words">{note.body}</p>
                </div>
              ))}
              {noteLinks.length > 0 && (
                <p className="flex flex-wrap gap-x-3 gap-y-1">
                  {noteLinks.map((r) => (
                    <a key={r.version} href={releaseUrl(r)} target="_blank" rel="noreferrer noopener" className={linkClass}>
                      {t('Hinweise zu v{version}', { version: r.version })} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                  ))}
                </p>
              )}
            </div>
          )}
          <p>{restartText(restart, command)}</p>
          {expires && <p className="text-slate-400">{t('Diese Prüfung gilt bis {expires} Uhr.', { expires })}</p>}
          {confirmOpen ? (
            <PasswordConfirm
              username={username}
              busy={busy === 'update'}
              error={pwError}
              submitLabel={t('Installieren und neu starten')}
              onSubmit={confirmInstall}
              onCancel={() => { setConfirmOpen(false); setPwError(''); }}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <button ref={installRef} type="button" id="btn-update-install" className="btn-primary text-xs inline-flex items-center gap-1.5" disabled={busyOther} onClick={() => setConfirmOpen(true)}>
                <Download className="w-3.5 h-3.5" aria-hidden="true" /> {t('Installieren')}
              </button>
              <button type="button" className="btn-secondary text-xs" disabled={busyOther} onClick={discard}>{t('Verwerfen')}</button>
            </div>
          )}
        </div>
      )}

      {!waiting && !preparing && phase === 'failed' && (
        <div ref={failureRef} tabIndex={-1} role={failedInSession ? 'alert' : undefined} className={`${severe ? redBox : amberBox} outline-none`} data-testid="update-failure">
          <p className="flex items-start gap-1.5">
            {severe ? <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" /> : <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />}
            <span>{failureText}</span>
          </p>
          {!severe && <p>{t('Nichts wurde verändert.')}</p>}
          {severe && (
            <a href={ISSUES_URL} target="_blank" rel="noreferrer noopener" className={linkClass}>
              {t('Problem melden')} <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          )}
          {!severe && version && (
            <button ref={retryRef} type="button" className="btn-secondary text-xs" disabled={busyOther || preparing} onClick={() => prepare(version)}>{t('Erneut versuchen')}</button>
          )}
        </div>
      )}

      {!flowActive && (
        <div className="space-y-3">
          {loadingReleases && <p role="status" className="text-xs text-slate-400">{t('Versionen werden abgefragt…')}</p>}
          {(nextTry || update?.releases_error) && (
            <div className="text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
              <span>{nextTry ? t('Abfragegrenze erreicht, nächster Versuch um {time}', { time: formatTime(nextTry) }) : t('GitHub nicht erreichbar')}</span>
              <button type="button" className="btn-secondary text-xs" disabled={checking} onClick={checkNow}>{t('Erneut versuchen')}</button>
            </div>
          )}
          {upToDate && <p className="text-xs text-slate-300">{t('Du hast die neueste Version (v{version}).', { version: current })}</p>}
          {sorted.length > 0 && (
            <VersionPicker
              releases={sorted}
              current={current}
              canInstall={canInstall}
              selected={chosen}
              onSelect={setSelected}
              action={canInstall ? (
                <button ref={startRef} type="button" id="btn-update-prepare" className="btn-secondary text-xs inline-flex items-center gap-1.5" disabled={busyOther || preparing || !(selectable || newest)} onClick={() => prepare(chosen)}>
                  <Download className="w-3.5 h-3.5" aria-hidden="true" /> {t('Herunterladen und prüfen')}
                </button>
              ) : null}
            />
          )}
          {!canInstall && install && chosen && compareVersions(chosen, current) > 0 && (
            <UpdateInstructions
              install={install}
              version={chosen}
              latest={update?.latest}
              releaseUrl={releaseUrl(sorted.find((r) => r.version === chosen))}
              platform={platform}
            />
          )}
          <LastResult last={update?.last} />
        </div>
      )}
    </Section>
  );
}
