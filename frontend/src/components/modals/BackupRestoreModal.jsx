import { useState, useEffect, useRef } from 'react';
import {
  X, CloudUpload, Shield, Download, CircleCheck, FileArchive, RefreshCw, Plus, TriangleAlert, FileSpreadsheet, Undo2
} from 'lucide-react';
import useDialogA11y from '../../hooks/useDialogA11y';
import { clearOfflineData } from '../../utils/offlineStore';
import { apiFetch, TIMEOUTS } from '../../utils/api';
import { formatMegabytes } from '../../utils/format';
import {
  clearRestoreUndo, httpErrorMessage, passwordRefusalText, readJson, readRestoreUndo, saveRestoreUndo
} from './backup/backupHelpers';
import SnapshotList from './backup/SnapshotList';
import RestoreConfirm from './backup/RestoreConfirm';
import CsvImportPanel from './backup/CsvImportPanel';
import DownloadLink from './backup/DownloadLink';
import { useDownloadRunning } from '../../app/useDownload';
import { t as tr, tn } from '../../i18n/index.js';
import { rich } from '../../i18n/react.jsx';
import { payloadText } from '../../i18n/serverText.js';

const RELOAD_DELAY_MS = 2000;
// i18n
const RESTORE_HTTP = {
  tooLarge: 'Backup zu groß für den Server oder Proxy (Upload-Limit, z. B. client_max_body_size, prüfen).',
  timeout: 'Der Server hat nicht rechtzeitig geantwortet. Die Wiederherstellung kann trotzdem durchlaufen: kurz warten, Seite neu laden und den Stand prüfen.'
};
// i18n
const INSPECT_HTTP = {
  tooLarge: RESTORE_HTTP.tooLarge,
  timeout: 'Der Server hat nicht rechtzeitig geantwortet. Bitte die Prüfung später erneut starten.'
};
// i18n
const RESTORE_NETWORK = 'Keine Antwort vom Server. Seite neu laden und prüfen, ob die Wiederherstellung durchgelaufen ist.';
// i18n
const UPLOAD_NETWORK = 'Keine Verbindung zum Server. Bei großen Backups kann auch das Upload-Limit eines Proxys die Ursache sein.';
// i18n
const SNAPSHOT_TIMEOUT = 'Der Server braucht länger als erwartet. Der Snapshot wird eventuell noch geschrieben – die Liste wurde neu geladen. Bitte nicht erneut erstellen, sondern die Liste in ein paar Minuten prüfen.';
// i18n
const TABS = [
  { key: 'snapshots', Icon: FileArchive },
  { key: 'upload', Icon: CloudUpload, label: 'ZIP-Datei hochladen' },
  { key: 'csv', Icon: FileSpreadsheet, label: 'CSV' }
];

const PASSWORD_RESET_LINE = /Passwort-Reset/;
const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The confirmation lines about accounts the backup holds without a password (`accounts_without_password`). */
export function withPasswordWarnings(inspection) {
  const names = (Array.isArray(inspection.accounts_without_password) ? inspection.accounts_without_password : [])
    .filter((n) => typeof n === 'string' && n);
  if (!names.length) return inspection;
  const warnings = Array.isArray(inspection.warnings) ? [...inspection.warnings] : [];
  if (!warnings.some((w) => PASSWORD_RESET_LINE.test(w))) {
    warnings.push(tn(
      '{n} Konto braucht nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): {names}.',
      '{n} Konten brauchen nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): {names}.',
      names.length,
      { names: names.join(', ') }
    ));
  }
  const me = inspection.current_user?.username;
  const users = Number(inspection.counts?.users);
  if (inspection.relogin && Number.isFinite(users) && names.length >= users) {
    warnings.push(tr('Danach kann sich niemand anmelden: ein neues Passwort setzt dann nur der Konsolenbefehl „passwort-reset <name>“ auf dem Server.'));
  } else if (!inspection.relogin && me && names.some((n) => sameName(n, me))) {
    warnings.push(tr('Auch dein Konto „{name}“ hat darin kein Passwort: ein neues setzt danach nur ein anderer Admin in der Benutzerverwaltung oder der Konsolenbefehl „{command}“ auf dem Server.', { name: me, command: `passwort-reset ${me}` }));
  }
  return { ...inspection, warnings };
}

const discardStaging = (stagingId) => {
  apiFetch(`/api/backup/restore/${encodeURIComponent(stagingId)}`, { method: 'DELETE' }).catch(() => {});
};

export default function BackupRestoreModal({ isOpen, onClose, user, onRestoreSuccess }) {
  const [restoreFile, setRestoreFile] = useState(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState(null);
  const [allowNewer, setAllowNewer] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [reloadPending, setReloadPending] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [restoreSuccess, setRestoreSuccess] = useState('');
  const [warning, setWarning] = useState('');
  const [undo, setUndo] = useState(null);
  const [serverBackups, setServerBackups] = useState([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backupsLoadError, setBackupsLoadError] = useState('');
  const [backupModalTab, setBackupModalTab] = useState('snapshots');
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [csvImporting, setCsvImporting] = useState(false);

  const backupsRequestRef = useRef(0);
  const restoreRequestRef = useRef(0);
  const stagingRef = useRef(null);
  const fileInputRef = useRef(null);
  const pickerButtonRef = useRef(null);
  const focusPickerRef = useRef(false);
  const reloadTimerRef = useRef(null);
  const inspectAbortRef = useRef(null);
  const dialogRef = useDialogA11y(isOpen);
  const downloading = useDownloadRunning();

  const busy = restoring || reloadPending || csvImporting;
  const locked = busy || inspecting;
  // Escape, Back and the backdrop wait for a running download; the close buttons let it go on in the background
  const closeBlocked = busy || downloading;

  const fetchServerBackups = async () => {
    if (user?.role !== 'admin') return;
    const id = ++backupsRequestRef.current;
    setLoadingBackups(true);
    setBackupsLoadError('');
    try {
      const res = await apiFetch('/api/backups');
      const data = await readJson(res);
      if (id !== backupsRequestRef.current) return;
      if (res.ok) {
        const list = Array.isArray(data.backups) ? data.backups : [];
        const entry = readRestoreUndo();
        setServerBackups(list);
        setUndo(entry && list.some(b => b.filename === entry.filename) ? entry : null);
      } else {
        setBackupsLoadError(httpErrorMessage(res.status, data, tr('Snapshots konnten nicht geladen werden')));
      }
    } catch (_) {
      if (id === backupsRequestRef.current) setBackupsLoadError(tr('Netzwerkfehler beim Laden der Snapshots.'));
    } finally {
      if (id === backupsRequestRef.current) setLoadingBackups(false);
    }
  };

  const dropStaging = () => {
    if (stagingRef.current) discardStaging(stagingRef.current);
    stagingRef.current = null;
  };

  useEffect(() => {
    backupsRequestRef.current++;
    restoreRequestRef.current++;
    dropStaging();
    if (isOpen) {
      setRestoreFile(null);
      setInspecting(false);
      setInspection(null);
      setAllowNewer(false);
      setRestoreError('');
      setPasswordError('');
      setRestoreSuccess('');
      setWarning('');
      setUndo(null);
      setBackupModalTab('snapshots');
      setServerBackups([]);
      setBackupsLoadError('');
      setCsvImporting(false);
      fetchServerBackups();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [isOpen]);

  // The dialog is mounted only while open, so unmounting is the close: a late inspect answer must be discarded.
  useEffect(() => () => {
    backupsRequestRef.current++;
    restoreRequestRef.current++;
    inspectAbortRef.current?.abort();
    dropStaging();
  }, []);

  useEffect(() => {
    if (!restoreFile && focusPickerRef.current) {
      focusPickerRef.current = false;
      pickerButtonRef.current?.focus();
    }
  }, [restoreFile, backupModalTab]);

  const clearMessages = () => {
    setRestoreError('');
    setPasswordError('');
    setRestoreSuccess('');
    setWarning('');
  };

  const handleCreateSnapshot = async () => {
    setCreatingSnapshot(true);
    clearMessages();
    try {
      const res = await apiFetch('/api/backups/create', { method: 'POST', timeout: TIMEOUTS.long });
      const data = await readJson(res);
      if (res.ok) {
        setRestoreSuccess(tr('Neuer Server-Snapshot erfolgreich angelegt!'));
        if (typeof data.warning === 'string' && data.warning) setWarning(payloadText(data, 'warning'));
        await fetchServerBackups();
      } else {
        setRestoreError(httpErrorMessage(res.status, data, tr('Fehler beim Erstellen des Snapshots')));
      }
    } catch (e) {
      if (e?.isTimeout) {
        setRestoreError(tr(SNAPSHOT_TIMEOUT));
        fetchServerBackups();
      } else {
        setRestoreError(tr('Netzwerkfehler beim Erstellen des Snapshots.'));
      }
    } finally {
      setCreatingSnapshot(false);
    }
  };

  // The app still holds the pre-restore user (id, role) and offline copy, so every successful restore ends in a
  // reload; the offline copy is dropped first so the reload downloads the restored data. The timer is deliberately
  // not cancelled on unmount: the reload is needed even if the dialog is gone.
  const finishRestore = (data) => {
    const pre = typeof data.preRestoreSnapshot === 'string' ? data.preRestoreSnapshot : '';
    if (pre) saveRestoreUndo(pre);
    const parts = [payloadText(data, 'message') || tr('Backup erfolgreich eingespielt!')];
    if (pre) parts.push(tr('Rückgängig: Snapshot „{snapshot}“ (Vor Wiederherstellung) – in den nächsten 30 Minuten über „Rückgängig machen“ in diesem Dialog.', { snapshot: pre }));
    if (data.relogin) parts.push(tr('Du wirst abgemeldet.'));
    parts.push(tr('Die Seite wird neu geladen …'));
    setRestoreSuccess(parts.join(' '));
    setReloadPending(true);
    clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => {
      Promise.resolve()
        .then(() => clearOfflineData())
        .catch(() => {})
        .then(() => window.location.reload());
    }, RELOAD_DELAY_MS);
  };

  /** Step 1: stage and check an upload ({ file }) or a server snapshot ({ filename }). */
  const inspect = async (source) => {
    const id = ++restoreRequestRef.current;
    dropStaging();
    setInspection(null);
    setInspecting(true);
    clearMessages();
    const controller = new AbortController();
    inspectAbortRef.current = controller;
    const { signal } = controller;
    try {
      let res;
      if (source.file) {
        const formData = new FormData();
        formData.append('backup', source.file);
        res = await apiFetch('/api/backup/inspect', { method: 'POST', body: formData, timeout: TIMEOUTS.upload, signal });
      } else {
        res = await apiFetch('/api/backup/inspect', { method: 'POST', body: { filename: source.filename }, timeout: TIMEOUTS.long, signal });
      }
      const data = await readJson(res);
      if (id !== restoreRequestRef.current) {
        if (res.ok && data.staging_id) discardStaging(data.staging_id);
        return;
      }
      if (res.ok && data.staging_id) {
        stagingRef.current = data.staging_id;
        setAllowNewer(false);
        setInspection(withPasswordWarnings(data));
      } else {
        setRestoreError(httpErrorMessage(res.status, data, tr('Backup konnte nicht geprüft werden'), INSPECT_HTTP));
        if (res.status === 404 && source.filename) fetchServerBackups();
      }
    } catch (_) {
      if (id === restoreRequestRef.current) {
        setRestoreError(source.file ? tr(UPLOAD_NETWORK) : tr('Netzwerkfehler beim Prüfen des Snapshots.'));
      }
    } finally {
      if (inspectAbortRef.current === controller) inspectAbortRef.current = null;
      if (id === restoreRequestRef.current) setInspecting(false);
    }
  };

  const leaveConfirmation = () => {
    setInspection(null);
    setAllowNewer(false);
    setPasswordError('');
    dialogRef.current?.focus();
  };

  const cancelRestore = () => {
    restoreRequestRef.current++;
    dropStaging();
    leaveConfirmation();
  };

  /** Step 2: restore what step 1 staged. */
  const confirmRestore = async (password) => {
    const stagingId = stagingRef.current;
    if (!stagingId || !inspection || !password) return;
    const fromSnapshot = inspection.source?.type === 'snapshot';
    setRestoring(true);
    clearMessages();
    try {
      const res = await apiFetch(`/api/backup/restore/${encodeURIComponent(stagingId)}`, {
        method: 'POST',
        body: allowNewer ? { current_password: password, allow_newer_schema: true } : { current_password: password },
        timeout: TIMEOUTS.upload
      });
      const data = await readJson(res);
      if (res.ok) {
        stagingRef.current = null;
        setInspection(null);
        finishRestore(data);
        return;
      }
      const refused = passwordRefusalText(res, data);
      if (refused) {
        setPasswordError(refused);
        return;
      }
      const message = httpErrorMessage(res.status, data, tr('Fehler beim Wiederherstellen des Backups'), RESTORE_HTTP);
      setRestoreError(message);
      if (data.code === 'SCHEMA_NEWER') {
        setInspection(prev => (prev ? { ...prev, schema_newer: true } : prev));
      } else if (res.status === 404 || res.status === 400) {
        // the server dropped the staging (expired, snapshot gone, invalid archive): back to the selection
        stagingRef.current = null;
        leaveConfirmation();
        if (fromSnapshot) fetchServerBackups();
      }
    } catch (_) {
      setRestoreError(tr(RESTORE_NETWORK));
    } finally {
      setRestoring(false);
    }
  };

  const handleDeleteSnapshot = async (filename) => {
    if (!confirm(tr('Snapshot "{filename}" wirklich dauerhaft vom Server löschen?', { filename }))) return;
    clearMessages();
    try {
      const res = await apiFetch(`/api/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      // 404: the file is already gone (e.g. pruned meanwhile)
      if (res.ok || res.status === 404) {
        setServerBackups(prev => prev.filter(b => b.filename !== filename));
        if (undo?.filename === filename) setUndo(null);
      } else {
        setRestoreError(httpErrorMessage(res.status, await readJson(res), tr('Fehler beim Löschen des Snapshots')));
      }
    } catch (_) {
      setRestoreError(tr('Netzwerkfehler beim Löschen des Snapshots.'));
    }
  };

  const handleUploadSubmit = (e) => {
    e.preventDefault();
    if (!restoreFile) {
      setRestoreError(tr('Bitte wähle eine Backup-ZIP-Datei (.zip) aus.'));
      return;
    }
    inspect({ file: restoreFile });
  };

  const dismissUndo = () => {
    clearRestoreUndo();
    setUndo(null);
  };

  const chooseOtherFile = () => {
    setRestoreFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    focusPickerRef.current = true;
  };

  const handleTabKeyDown = (e) => {
    const index = TABS.findIndex(t => t.key === backupModalTab);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const target = TABS[(next + TABS.length) % TABS.length].key;
    setBackupModalTab(target);
    document.getElementById(`backup-tab-${target}`)?.focus();
  };

  if (!isOpen) return null;

  const snapshotCount = backupsLoadError ? '?' : serverBackups.length;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !closeBlocked) onClose(); }}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={tr('Backup und Wiederherstellung')}
      data-busy={closeBlocked ? 'true' : undefined}
      tabIndex={-1}
      className="outline-none dialog-overlay bg-black/80 backdrop-blur-sm z-50 animate-fade-in"
    >
      <div className="dialog-box glass-panel p-6 sm:p-7 short:p-4 rounded-3xl max-w-2xl max-h-[90vh] supports-[height:100dvh]:max-h-[90dvh] short:max-h-none flex flex-col border border-slate-700/80 shadow-2xl relative overflow-hidden">
        <button
          id="btn-close-restore-modal-x"
          type="button"
          onClick={() => !busy && onClose()}
          aria-label={tr('Schließen')}
          className="absolute top-3 right-3 short:top-1.5 short:right-1.5 w-11 h-11 flex items-center justify-center text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
          disabled={busy}
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>

        <div className="flex items-center gap-3 pb-4 short:pb-2 pr-10 border-b border-slate-800 shrink-0">
          <div className="w-10 h-10 short:hidden shrink-0 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-md">
            <CloudUpload className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{tr('Backups & Snapshots')}</h2>
            <p className="text-xs text-slate-400 short:hidden">{tr('Automatische Tagessicherungen und Snapshot-Wiederherstellung')}</p>
          </div>
        </div>

        <div className="bg-sky-500/10 border border-sky-500/30 text-sky-200 p-3 rounded-xl text-xs flex items-center justify-between gap-3 mt-4 shrink-0">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-sky-400 shrink-0" aria-hidden="true" />
            <span>{tr('Täglich automatischer Snapshot aktiv (die letzten 7 Tage und die letzten 10 manuellen Snapshots werden auf dem Server vorgehalten)')}</span>
          </div>
          <DownloadLink
            path="/api/backup"
            download
            className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1.5 shrink-0 bg-slate-900 border-sky-500/40 text-sky-300 hover:text-white"
            title={tr('Aktuelle Gesamtsicherung als ZIP herunterladen')}
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{tr('Direkt-ZIP')}</span>
          </DownloadLink>
        </div>

        {restoreError && (
          <div key={restoreError} role="alert" className="bg-rose-500/10 border border-rose-500/30 text-rose-400 p-3 rounded-xl text-xs flex items-center gap-2 mt-3 animate-shake shrink-0">
            <X className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{restoreError}</span>
          </div>
        )}
        {warning && (
          <div role="alert" className="bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3 rounded-xl text-xs flex items-center gap-2 mt-3 shrink-0">
            <TriangleAlert className="w-4 h-4 shrink-0 text-amber-400" aria-hidden="true" />
            <span>{warning}</span>
          </div>
        )}
        <div
          role="status"
          className={restoreSuccess ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 p-3 rounded-xl text-xs flex items-center gap-2 mt-3 shrink-0' : 'sr-only'}
        >
          {restoreSuccess && (
            <>
              <CircleCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{restoreSuccess}</span>
            </>
          )}
        </div>

        {undo && !inspection && !reloadPending && (
          <div className="bg-amber-500/10 border border-amber-500/30 text-amber-100 p-3 rounded-xl text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 mt-3 shrink-0">
            <p>
              {rich('{title} Der Stand davor liegt als Snapshot {snapshot} vor (nur Datenbank, Cover bleiben).', {
                title: <span className="font-semibold">{tr('Wiederherstellung rückgängig machen:')}</span>,
                snapshot: <span className="font-mono break-all">„{undo.filename}“</span>
              })}
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                id="btn-undo-restore"
                type="button"
                onClick={() => inspect({ filename: undo.filename })}
                disabled={locked}
                className="btn-secondary text-[11px] py-1 px-2.5 inline-flex items-center gap-1.5 border-amber-500/40 text-amber-200 hover:text-white"
              >
                <Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> {tr('Rückgängig machen')}
              </button>
              <button type="button" onClick={dismissUndo} className="text-[11px] text-slate-400 hover:text-white px-1">
                {tr('Ausblenden')}
              </button>
            </div>
          </div>
        )}

        {inspection && (
          <div className="overflow-y-auto custom-scrollbar flex-1 pr-1">
            <RestoreConfirm
              inspection={inspection}
              allowNewer={allowNewer}
              onAllowNewerChange={setAllowNewer}
              restoring={restoring}
              onConfirm={confirmRestore}
              onCancel={cancelRestore}
              username={user?.username}
              passwordError={passwordError}
            />
          </div>
        )}

        <div hidden={Boolean(inspection)} className={inspection ? undefined : 'contents'}>
          <div
            role="tablist"
            aria-label={tr('Bereiche')}
            onKeyDown={handleTabKeyDown}
            className="flex items-center gap-2 pt-4 pb-2 shrink-0 border-b border-slate-800"
          >
            {TABS.map(({ key, Icon, label }) => {
              const selected = backupModalTab === key;
              return (
                <button
                  key={key}
                  id={`backup-tab-${key}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="backup-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setBackupModalTab(key)}
                  className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
                    selected
                      ? 'bg-emerald-700 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{label ? tr(label) : tr('Server-Snapshots ({snapshotCount})', { snapshotCount })}</span>
                </button>
              );
            })}
          </div>

          <div
            id="backup-tabpanel"
            role="tabpanel"
            aria-labelledby={`backup-tab-${backupModalTab}`}
            className="overflow-y-auto custom-scrollbar flex-1 py-4 pr-1 space-y-4"
          >
            {backupModalTab === 'snapshots' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-slate-400">
                    {rich('Snapshots auf dem Server ({path})', { path: <code className="text-slate-300 font-mono">data/backups/</code> })}
                  </p>
                  <button
                    type="button"
                    onClick={handleCreateSnapshot}
                    disabled={creatingSnapshot || locked}
                    className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 !bg-brand-700 hover:!bg-brand-800 shadow-sm"
                  >
                    {creatingSnapshot ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>{tr('Neuen Snapshot erstellen')}</span>
                  </button>
                </div>

                {inspecting && (
                  <p className="text-xs text-slate-400 flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> {tr('Snapshot wird geprüft...')}
                  </p>
                )}

                {loadingBackups ? (
                  <div className="py-12 flex justify-center items-center text-slate-400 gap-2">
                    <RefreshCw className="w-5 h-5 animate-spin text-brand-400" aria-hidden="true" />
                    <span className="text-xs">{tr('Lade Snapshots...')}</span>
                  </div>
                ) : backupsLoadError ? (
                  <div role="alert" className="p-6 text-center bg-rose-500/10 rounded-2xl border border-rose-500/30 text-rose-300 text-xs space-y-3">
                    <p>{tr('Die Snapshot-Liste konnte nicht geladen werden: {backupsLoadError}', { backupsLoadError })}</p>
                    <button type="button" onClick={fetchServerBackups} className="btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {tr('Erneut laden')}
                    </button>
                  </div>
                ) : serverBackups.length === 0 ? (
                  <div className="p-8 text-center bg-slate-900/40 rounded-2xl border border-slate-800 text-slate-400 text-xs">
                    {tr('Noch keine Server-Snapshots vorhanden. Klicke auf „Neuen Snapshot erstellen“.')}
                  </div>
                ) : (
                  <SnapshotList
                    snapshots={serverBackups}
                    disabled={locked}
                    onRestore={(filename) => inspect({ filename })}
                    onDelete={handleDeleteSnapshot}
                  />
                )}
              </div>
            )}

            {backupModalTab === 'upload' && (
              <form onSubmit={handleUploadSubmit} className="space-y-4">
                <div className="bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3 rounded-xl text-xs flex gap-2.5 leading-relaxed">
                  <TriangleAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    {rich('{warning} Das Einspielen überschreibt die aktuelle SQLite-Datenbank ({file}) und Coverbilder mit dem Stand aus dem ausgewählten ZIP-Archiv. Das Backup wird zuerst geprüft; danach siehst du, was es enthält, und bestätigst die Wiederherstellung.', {
                      warning: <span className="font-semibold text-amber-300">{tr('Achtung:')}</span>,
                      file: <code className="bg-amber-500/20 px-1 py-0.5 rounded text-[11px]">manga.db</code>
                    })}
                  </div>
                </div>

                <div className="border-2 border-dashed border-slate-700 hover:border-emerald-500/50 rounded-2xl p-6 text-center transition-colors bg-slate-900/40">
                  <input
                    type="file"
                    id="backup-file-input"
                    ref={fileInputRef}
                    accept=".zip"
                    className="hidden"
                    tabIndex={-1}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setRestoreFile(file);
                        setRestoreError('');
                      }
                    }}
                    disabled={locked}
                  />

                  {restoreFile ? (
                    <div className="flex flex-col items-center">
                      <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300 mb-3">
                        <FileArchive className="w-6 h-6" aria-hidden="true" />
                      </div>
                      <span className="text-sm font-semibold text-white truncate max-w-xs">{restoreFile.name}</span>
                      <span className="text-xs text-slate-400 mt-1">
                        {formatMegabytes(restoreFile.size)}
                      </span>
                      <button
                        type="button"
                        onClick={chooseOtherFile}
                        className="mt-3 text-xs text-rose-400 hover:underline"
                        disabled={locked}
                      >
                        {tr('Andere Datei auswählen')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      ref={pickerButtonRef}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={locked}
                      className="w-full cursor-pointer flex flex-col items-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                      <span className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 mb-3 hover:text-emerald-400 transition-colors">
                        <CloudUpload className="w-6 h-6" aria-hidden="true" />
                      </span>
                      <span className="text-sm font-semibold text-slate-200">{tr('Klicke hier, um dein Backup auszuwählen')}</span>
                      <span className="text-xs text-slate-400 mt-1">{tr('Nur .zip-Dateien (z. B. manga-shelf-backup.zip)')}</span>
                    </button>
                  )}
                </div>

                <div className="flex justify-end gap-3 pt-2">
                  <button
                    id="btn-inspect-backup"
                    type="submit"
                    className="btn-primary flex items-center gap-2 text-xs !bg-emerald-700 hover:!bg-emerald-800 disabled:opacity-50"
                    disabled={locked || !restoreFile}
                  >
                    {inspecting ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" aria-hidden="true" /> {tr('Backup wird geprüft...')}
                      </>
                    ) : (
                      <>
                        <CloudUpload className="w-4 h-4" aria-hidden="true" /> {tr('Backup prüfen')}
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}

            <div hidden={backupModalTab !== 'csv'} className="space-y-4">
              <div className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800 space-y-2">
                <div className="text-sm font-semibold text-slate-200">{tr('Sammlung exportieren')}</div>
                <p className="text-xs text-slate-400">{tr('Alle Bände als CSV (Semikolon, UTF-8). Öffnet sich direkt in Excel oder LibreOffice.')}</p>
                <DownloadLink path="/api/export/csv" download className="btn-primary inline-flex items-center gap-2 text-xs !bg-emerald-700 hover:!bg-emerald-800">
                  <Download className="w-4 h-4" aria-hidden="true" /> {tr('CSV herunterladen')}
                </DownloadLink>
              </div>
              <CsvImportPanel disabled={restoring || reloadPending} onImported={onRestoreSuccess} onImportingChange={setCsvImporting} />
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-slate-800 flex justify-end shrink-0">
          <button
            id="btn-close-restore-modal"
            type="button"
            onClick={onClose}
            className="btn-secondary text-xs px-4 py-2"
            disabled={busy}
          >
            {tr('Schließen')}
          </button>
        </div>
      </div>
    </div>
  );
}
