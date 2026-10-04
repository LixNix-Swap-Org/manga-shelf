import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, CircleCheck, Database, ExternalLink, HardDrive, KeyRound, LogOut, RefreshCw, Server, Sparkles, TriangleAlert, X } from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import api, { TIMEOUTS, rememberToken } from '../../utils/api';
import { notify } from '../../utils/notify';
import { formatCount, formatDateTime, formatNumber, formatRelative } from '../../utils/format';
import ApiKeyCard from './ApiKeyCard';
import { useApiKeys } from './AccountModal';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

/** '512 KB', '3,4 MB', '1,25 GB'; '–' when unknown. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(n)) return '–';
  if (n >= GB) return `${formatNumber(n / GB, 2, { fixed: true })} GB`;
  if (n >= MB) return `${formatNumber(n / MB, 1, { fixed: true })} MB`;
  return `${formatNumber(Math.ceil(n / 1024))} KB`;
}

/** '2 Tage, 3 Std.' / '5 Std., 12 Min.' / '4 Min.'. */
export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${formatCount(days, 'Tag', 'Tage')}, ${hours} Std.`;
  if (hours > 0) return `${hours} Std., ${minutes} Min.`;
  return `${minutes} Min.`;
}

const HEALTH_TEXT = { ok: 'In Ordnung', degraded: 'Eingeschränkt', error: 'Fehler' };
const CHECK_TEXT = {
  disk: { low: 'wenig freier Speicher', unknown: 'freier Speicher unbekannt' },
  backup: { missing: 'kein geprüfter Snapshot', stale: 'letzter geprüfter Snapshot älter als 48 Std.', pending: 'noch kein geprüfter Snapshot' },
  db: { error: 'Datenbank nicht erreichbar' },
  writable: { error: 'Datenverzeichnis nicht beschreibbar' }
};

function healthNotes(health) {
  const notes = [];
  for (const [key, texts] of Object.entries(CHECK_TEXT)) {
    const text = texts[health?.checks?.[key]];
    if (text) notes.push(text);
  }
  if (health?.checks?.restoring) notes.push('Wiederherstellung läuft');
  return notes;
}

function Section({ id, title, Icon, children, actions }) {
  return (
    <section aria-labelledby={id} className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id={id} className="text-sm font-bold text-white flex items-center gap-2">
          <Icon className="w-4 h-4 text-brand-400" aria-hidden="true" /> {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      {rows.filter(Boolean).map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 min-w-0 border-b border-slate-800/60 pb-1">
          <dt className="text-slate-400 shrink-0">{label}</dt>
          <dd className="text-slate-200 text-right min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A destructive action asks once more inline (no window.confirm). */
function ConfirmButton({ id, label, confirmLabel, question, busy, disabled, onConfirm, Icon }) {
  const [asking, setAsking] = useState(false);
  const confirmRef = useRef(null);
  const openerRef = useRef(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    if (asking) confirmRef.current?.focus();
    else if (wasAsking.current) openerRef.current?.focus();
    wasAsking.current = asking;
  }, [asking]);
  if (!asking) {
    return (
      <button ref={openerRef} type="button" id={id} className="btn-secondary text-xs inline-flex items-center gap-1.5" disabled={busy || disabled} onClick={() => setAsking(true)}>
        {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Icon className="w-3.5 h-3.5" aria-hidden="true" />} {label}
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs" role="group" aria-label={question}>
      <span className="text-amber-200">{question}</span>
      <button ref={confirmRef} type="button" className="btn-primary text-xs !bg-rose-700 hover:!bg-rose-800" onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" className="btn-secondary text-xs" onClick={() => setAsking(false)}>Abbrechen</button>
    </span>
  );
}

function poolText(state) {
  if (!state) return '–';
  if (state.enabled === false) return 'abgeschaltet';
  const parts = [`${formatNumber(state.used_last_hour || 0)} Anfragen in der letzten Stunde`, `Limit ${formatNumber(state.limit)}/Min.`];
  if (state.paused_until && state.paused_until > Date.now()) parts.push('pausiert');
  if (state.circuit && state.circuit !== 'closed') parts.push('vorübergehend abgeschaltet');
  return parts.join(' · ');
}

function SourcesSection({ info }) {
  const keys = useApiKeys({ admin: true, user: false });
  const [pool, setPool] = useState(null);
  const [poolError, setPoolError] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/api/anime/sources')
      .then((data) => { if (alive) setPool(data); })
      .catch(() => { if (alive) setPoolError(true); });
    return () => { alive = false; };
  }, []);

  const withKeys = info?.sources?.users_with_keys;
  return (
    <Section id="system-sources-title" title="Quellen" Icon={KeyRound}>
      <Facts rows={[
        ['AniList (gemeinsamer Pool)', poolError ? 'nicht verfügbar' : poolText(pool?.anilist)],
        [pool?.mal?.adapter === 'mal' ? 'MyAnimeList (Instanz)' : 'MyAnimeList (Jikan, Pool)', poolError ? 'nicht verfügbar' : poolText(pool?.mal)],
        ['Benutzer mit eigenem Schlüssel', withKeys === null || withKeys === undefined ? '–' : formatNumber(withKeys)]
      ]} />
      {keys.error && <p role="alert" className="text-xs text-rose-300">{keys.error}</p>}
      {!keys.error && keys.instanceKeys.length > 0 && (
        <div className="space-y-3" data-testid="system-instance-keys">
          <p className="text-xs text-slate-400">Instanz-Schlüssel gelten für alle Benutzer ohne eigenen Schlüssel. Eine Umgebungsvariable hat Vorrang.</p>
          {keys.instanceKeys.map((state) => {
            const guide = keys.guideOf(state.provider);
            return guide ? (
              <ApiKeyCard
                key={state.provider}
                guide={guide}
                state={state}
                scope="instance"
                busy={keys.busy === `instance:${state.provider}`}
                onSave={(secret) => keys.save('instance', state.provider, secret)}
                onRemove={() => keys.remove('instance', state.provider)}
              />
            ) : null;
          })}
        </div>
      )}
    </Section>
  );
}

/**
 * Admin system page: version and update, health, storage, backups ("Backup jetzt"), orphaned uploads
 * ("Waisen aufräumen"), sessions ("Alle Sitzungen beenden") and the sources (pool use, instance keys).
 */
export default function SystemModal({ isOpen, onClose }) {
  const dialogRef = useDialogA11y(isOpen);
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async ({ refresh = false } = {}) => {
    setLoading(true);
    setLoadError('');
    try {
      setInfo(await api.get(`/api/system${refresh ? '?refresh=1' : ''}`, { fallback: 'Systemdaten konnten nicht geladen werden' }));
    } catch (err) {
      setLoadError(err?.message || 'Systemdaten konnten nicht geladen werden');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  if (!isOpen) return null;

  const run = async (name, action) => {
    setBusy(name);
    try {
      await action();
    } catch (err) {
      notify.error(err, { fallback: 'Aktion fehlgeschlagen' });
    } finally {
      setBusy(null);
    }
  };

  const backupNow = () => run('backup', async () => {
    const result = await api.post('/api/backups/create', {}, { timeout: TIMEOUTS.long, fallback: 'Snapshot konnte nicht erstellt werden' });
    if (result?.warning) notify.error(result.warning);
    else notify.success('Snapshot erstellt und geprüft');
    await load();
  });

  const cleanOrphans = () => run('orphans', async () => {
    const result = await api.post('/api/system/orphans/clean', {}, { timeout: TIMEOUTS.long, fallback: 'Aufräumen fehlgeschlagen' });
    if (result?.skipped) notify.info('Nichts gelöscht: die Bildliste eines Sicherungs-Snapshots ist nicht lesbar (Details im Server-Log).');
    else notify.success(`${formatCount(result?.removed || 0, 'verwaiste Datei', 'verwaiste Dateien')} entfernt (${formatBytes(result?.bytes || 0)})`);
    await load();
  });

  const endSessions = () => run('sessions', async () => {
    const result = await api.post('/api/system/sessions/end-all', {}, { fallback: 'Sitzungen konnten nicht beendet werden' });
    rememberToken(result);
    notify.success(`Alle Sitzungen beendet (${formatCount(result?.users || 0, 'Benutzer', 'Benutzer')}). Du bleibst auf diesem Gerät angemeldet.`);
  });

  const requestClose = () => {
    if (!busy) onClose();
  };

  const db = info?.database;
  const storage = info?.storage;
  const backups = info?.backups;
  const orphans = info?.orphans;
  const update = info?.update;
  const notes = healthNotes(info?.health);
  const status = info?.health?.status;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="system-modal-title"
      data-busy={busy ? 'true' : undefined}
      tabIndex={-1}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        requestClose();
      }}
      className="outline-none fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-start sm:items-center justify-center p-2 sm:p-4 overflow-y-auto animate-fade-in"
    >
      <div className="glass-panel w-full max-w-2xl rounded-2xl sm:rounded-3xl p-5 sm:p-7 border border-slate-700/80 shadow-2xl my-3 sm:my-8 space-y-4">
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-500/15 border border-brand-500/40 text-brand-300 flex items-center justify-center">
              <Server className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 id="system-modal-title" className="text-xl font-bold text-white">System</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => load({ refresh: true })}
              disabled={loading}
              aria-label="Neu laden"
              title="Neu laden (zählt verwaiste Bilder neu)"
              className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={requestClose}
              disabled={Boolean(busy)}
              aria-label="Schließen"
              className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-40"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {loadError && (
          <div role="alert" className="text-sm text-rose-300 flex items-center justify-between gap-3">
            <span>{loadError}</span>
            <button type="button" className="btn-secondary text-xs" onClick={() => load()}>Erneut versuchen</button>
          </div>
        )}
        {!info && !loadError && <p role="status" className="text-sm text-slate-400">Wird geladen…</p>}

        {info && (
          <>
            {update?.available && (
              <div id="system-update" className="p-3 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-200 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2"><Sparkles className="w-4 h-4" aria-hidden="true" /> Neue Version verfügbar: v{update.latest} (installiert: v{update.current})</span>
                {update.url && (
                  <a href={update.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-emerald-100 underline">
                    Versionshinweise <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </a>
                )}
              </div>
            )}

            <Section id="system-overview-title" title="Server" Icon={Server}>
              <p className={`text-xs flex items-center gap-1.5 ${status === 'ok' ? 'text-emerald-300' : status === 'error' ? 'text-rose-300' : 'text-amber-300'}`} data-testid="system-health">
                {status === 'ok' ? <CircleCheck className="w-3.5 h-3.5" aria-hidden="true" /> : <TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" />}
                {HEALTH_TEXT[status] || 'Unbekannt'}{notes.length ? `: ${notes.join(', ')}` : ''}
              </p>
              <Facts rows={[
                ['Version', `v${info.version}${update?.checked_at && !update.available ? ' (aktuell)' : ''}`],
                ['Node.js', info.node],
                ['Läuft seit', formatUptime(info.uptime)],
                ['Arbeitsspeicher', formatBytes(info.memory_rss)],
                ['Datenverzeichnis', <code key="dir" className="break-all">{info.data_dir}</code>],
                ['Schema', db ? `v${db.schema_version}${db.schema_version !== db.latest_schema_version ? ` (erwartet v${db.latest_schema_version})` : ''}` : '–']
              ]} />
            </Section>

            <Section id="system-storage-title" title="Speicher" Icon={HardDrive}>
              <Facts rows={[
                ['Datenbank', db ? `${formatBytes(db.bytes)}${db.wal_bytes ? ` + ${formatBytes(db.wal_bytes)} WAL` : ''}` : '–'],
                ['Bilder (Uploads)', storage ? `${formatNumber(storage.uploads.count)} · ${formatBytes(storage.uploads.bytes)}` : '–'],
                ['Snapshots', backups ? `${formatNumber(backups.count)} · ${formatBytes(backups.bytes)}` : '–'],
                ['Frei auf dem Datenträger', storage ? `${formatBytes(storage.free_bytes)}${storage.total_bytes ? ` von ${formatBytes(storage.total_bytes)}` : ''}` : '–'],
                db?.counts && ['Inhalt', `${formatNumber(db.counts.mangas)} Reihen · ${formatNumber(db.counts.volumes)} Bände${db.counts.animes ? ` · ${formatNumber(db.counts.animes)} Anime` : ''} · ${formatCount(db.counts.users, 'Benutzer', 'Benutzer')}`]
              ]} />
            </Section>

            <Section
              id="system-backups-title"
              title="Backups"
              Icon={Archive}
              actions={(
                <button type="button" id="btn-system-backup" className="btn-primary text-xs inline-flex items-center gap-1.5" disabled={Boolean(busy)} onClick={backupNow}>
                  {busy === 'backup' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Database className="w-3.5 h-3.5" aria-hidden="true" />} Backup jetzt
                </button>
              )}
            >
              <Facts rows={[
                ['Letzter geprüfter Snapshot', backups?.last_verified ? `${formatDateTime(backups.last_verified.created_at)} (${formatRelative(backups.last_verified.created_at)})` : 'keiner'],
                backups?.last_failed && ['Letzter Fehlschlag', `${formatDateTime(backups.last_failed.created_at)}${backups.last_failed.verify_error ? ` – ${backups.last_failed.verify_error}` : ''}`],
                backups?.schedule && ['Automatisch', `täglich ab ${backups.schedule.hour} Uhr (${backups.schedule.time_zone})${backups.daily_due ? ' · heute noch offen' : ''}`],
                info.jobs?.running?.length > 0 && ['Läuft gerade', info.jobs.running.join(', ')]
              ]} />
            </Section>

            <Section
              id="system-orphans-title"
              title="Verwaiste Bilder"
              Icon={Sparkles}
              actions={(
                <ConfirmButton
                  id="btn-system-orphans"
                  label="Waisen aufräumen"
                  confirmLabel="Ja, löschen"
                  question={`${formatCount(orphans?.count || 0, 'Datei', 'Dateien')} endgültig löschen?`}
                  busy={busy === 'orphans'}
                  disabled={Boolean(busy) || !orphans?.count || orphans?.skipped}
                  onConfirm={cleanOrphans}
                  Icon={Sparkles}
                />
              )}
            >
              <p className="text-xs text-slate-300" data-testid="system-orphans">
                {orphans?.count === null || orphans?.count === undefined
                  ? 'Konnte nicht gezählt werden.'
                  : `${formatCount(orphans.count, 'Bild', 'Bilder')} ohne Verwendung (${formatBytes(orphans.bytes)}), älter als 7 Tage.`}
                {orphans?.skipped ? ' Aufräumen ist gesperrt: die Bildliste eines Sicherungs-Snapshots ist nicht lesbar.' : ''}
              </p>
            </Section>

            <Section
              id="system-sessions-title"
              title="Sitzungen"
              Icon={LogOut}
              actions={(
                <ConfirmButton
                  id="btn-system-sessions"
                  label="Alle Sitzungen beenden"
                  confirmLabel="Ja, beenden"
                  question="Alle Geräte aller Benutzer abmelden?"
                  busy={busy === 'sessions'}
                  disabled={Boolean(busy)}
                  onConfirm={endSessions}
                  Icon={LogOut}
                />
              )}
            >
              <p className="text-xs text-slate-400">Meldet jeden Benutzer auf allen Geräten ab (z. B. nach einem verlorenen Handy). Du bleibst auf diesem Gerät angemeldet.</p>
            </Section>

            <SourcesSection info={info} />
          </>
        )}
      </div>
    </div>
  );
}
