import { useState, useEffect } from 'react';
import { 
  X, UploadCloud, Shield, Download, CheckCircle2, 
  FileArchive, RefreshCw, Plus, Trash2, AlertTriangle 
} from 'lucide-react';

export default function BackupRestoreModal({ isOpen, onClose, user, onRestoreSuccess }) {
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreSuccess, setRestoreSuccess] = useState('');
  const [serverBackups, setServerBackups] = useState([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [backupModalTab, setBackupModalTab] = useState('snapshots'); // 'snapshots' | 'upload'
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);

  const fetchServerBackups = async () => {
    if (user?.role !== 'admin') return;
    try {
      setLoadingBackups(true);
      const res = await fetch('/api/backups');
      if (res.ok) {
        const data = await res.json();
        setServerBackups(data.backups || []);
      }
    } catch (e) {
      console.error('Failed to fetch server backups:', e);
    } finally {
      setLoadingBackups(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setRestoreFile(null);
      setRestoreError('');
      setRestoreSuccess('');
      setBackupModalTab('snapshots');
      fetchServerBackups();
    }
  }, [isOpen]);

  const handleCreateSnapshot = async () => {
    setCreatingSnapshot(true);
    setRestoreError('');
    setRestoreSuccess('');
    try {
      const res = await fetch('/api/backups/create', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setRestoreSuccess('Neuer Server-Snapshot erfolgreich angelegt!');
        await fetchServerBackups();
      } else {
        setRestoreError(data.error || 'Fehler beim Erstellen des Snapshots');
      }
    } catch (e) {
      setRestoreError('Netzwerkfehler beim Erstellen');
    } finally {
      setCreatingSnapshot(false);
    }
  };

  const handleRestoreSnapshot = async (filename) => {
    if (!confirm(`Möchtest du den Snapshot "${filename}" wirklich wiederherstellen? Dies überschreibt die aktuelle Datenbank und Bilder mit diesem Stand.`)) {
      return;
    }
    setRestoring(true);
    setRestoreError('');
    setRestoreSuccess('');
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(filename)}/restore`, { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setRestoreSuccess(data.message || 'Snapshot erfolgreich wiederhergestellt!');
        if (onRestoreSuccess) onRestoreSuccess();
        setTimeout(() => {
          onClose();
          setRestoreSuccess('');
        }, 2000);
      } else {
        setRestoreError(data.error || 'Fehler beim Wiederherstellen des Snapshots');
      }
    } catch (e) {
      setRestoreError('Netzwerkfehler');
    } finally {
      setRestoring(false);
    }
  };

  const handleDeleteSnapshot = async (filename) => {
    if (!confirm(`Snapshot "${filename}" wirklich dauerhaft vom Server löschen?`)) return;
    try {
      const res = await fetch(`/api/backups/${encodeURIComponent(filename)}`, { method: 'DELETE' });
      if (res.ok) {
        setServerBackups(prev => prev.filter(b => b.filename !== filename));
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Löschen');
      }
    } catch (e) {
      alert('Netzwerkfehler');
    }
  };

  const handleRestoreSubmit = async (e) => {
    e.preventDefault();
    if (!restoreFile) {
      setRestoreError('Bitte wähle eine Backup-ZIP-Datei (.zip) aus.');
      return;
    }
    setRestoring(true);
    setRestoreError('');
    setRestoreSuccess('');

    try {
      const formData = new FormData();
      formData.append('backup', restoreFile);

      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Fehler beim Wiederherstellen des Backups');
      }

      setRestoreSuccess(data.message || 'Backup erfolgreich eingespielt!');
      if (onRestoreSuccess) onRestoreSuccess();
      setTimeout(() => {
        onClose();
        setRestoreSuccess('');
        setRestoreFile(null);
      }, 2000);
    } catch (err) {
      setRestoreError(err.message || 'Netzwerkfehler beim Wiederherstellen');
    } finally {
      setRestoring(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div 
      onClick={(e) => { if (e.target === e.currentTarget && !restoring) onClose(); }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 z-50 animate-fade-in overflow-y-auto"
    >
      <div className="glass-panel p-6 sm:p-7 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-slate-700/80 shadow-2xl relative overflow-hidden">
        <button 
          id="btn-close-restore-modal-x"
          onClick={() => !restoring && onClose()}
          className="absolute top-5 right-5 text-slate-400 hover:text-white p-1 rounded-xl hover:bg-slate-800 transition-colors"
          disabled={restoring}
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 pb-4 border-b border-slate-800 shrink-0">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-md">
            <UploadCloud className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Backups & Snapshots</h2>
            <p className="text-xs text-slate-400">Automatische Tagessicherungen und Snapshot-Wiederherstellung</p>
          </div>
        </div>

        {/* Notice Callout */}
        <div className="bg-sky-500/10 border border-sky-500/30 text-sky-200 p-3 rounded-xl text-xs flex items-center justify-between gap-3 mt-4 shrink-0">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-sky-400 shrink-0" />
            <span>Täglich automatischer Snapshot aktiv (die letzten 7 Tage werden auf dem Server vorgehalten)</span>
          </div>
          <a
            href="/api/backup"
            download
            className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1.5 shrink-0 bg-slate-900 border-sky-500/40 text-sky-300 hover:text-white"
            title="Aktuelle Gesamtsicherung als ZIP herunterladen"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Direkt-ZIP</span>
          </a>
        </div>

        {/* Notifications */}
        {restoreError && (
          <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 p-3 rounded-xl text-xs flex items-center gap-2 mt-3 animate-shake shrink-0">
            <X className="w-4 h-4 shrink-0" />
            <span>{restoreError}</span>
          </div>
        )}
        {restoreSuccess && (
          <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 p-3 rounded-xl text-xs flex items-center gap-2 mt-3 shrink-0">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{restoreSuccess}</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-2 pt-4 pb-2 shrink-0 border-b border-slate-800">
          <button
            onClick={() => setBackupModalTab('snapshots')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
              backupModalTab === 'snapshots'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <FileArchive className="w-3.5 h-3.5" />
            <span>Server-Snapshots ({serverBackups.length})</span>
          </button>
          <button
            onClick={() => setBackupModalTab('upload')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
              backupModalTab === 'upload'
                ? 'bg-emerald-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <UploadCloud className="w-3.5 h-3.5" />
            <span>ZIP-Datei hochladen</span>
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto custom-scrollbar flex-1 py-4 pr-1 space-y-4">
          {/* TAB 1: SERVER SNAPSHOTS */}
          {backupModalTab === 'snapshots' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400">
                  Snapshots auf dem Pterodactyl-Server (<code className="text-slate-300 font-mono">data/backups/</code>)
                </p>
                <button
                  type="button"
                  onClick={handleCreateSnapshot}
                  disabled={creatingSnapshot || restoring}
                  className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 !bg-brand-600 hover:!bg-brand-500 shadow-sm"
                >
                  {creatingSnapshot ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Plus className="w-3.5 h-3.5" />
                  )}
                  <span>Neuen Snapshot erstellen</span>
                </button>
              </div>

              {loadingBackups ? (
                <div className="py-12 flex justify-center items-center text-slate-400 gap-2">
                  <RefreshCw className="w-5 h-5 animate-spin text-brand-400" />
                  <span className="text-xs">Lade Snapshots...</span>
                </div>
              ) : serverBackups.length === 0 ? (
                <div className="p-8 text-center bg-slate-900/40 rounded-2xl border border-slate-800 text-slate-400 text-xs">
                  Noch keine Server-Snapshots vorhanden. Klicke auf „Neuen Snapshot erstellen“.
                </div>
              ) : (
                <div className="space-y-2">
                  {serverBackups.map(b => {
                    const isAuto = b.filename.includes('auto');
                    const sizeMb = (b.size / (1024 * 1024)).toFixed(2);
                    const dateFormatted = new Date(b.created_at).toLocaleString('de-DE');

                    return (
                      <div
                        key={b.filename}
                        className="glass-card rounded-2xl p-3 border border-slate-800 bg-slate-900/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 hover:border-slate-700 transition-all"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                            isAuto ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30' : 'bg-purple-500/15 text-purple-400 border border-purple-500/30'
                          }`}>
                            <FileArchive className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-white truncate max-w-xs font-mono" title={b.filename}>
                                {b.filename}
                              </span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                isAuto ? 'bg-sky-500/20 text-sky-300' : 'bg-purple-500/20 text-purple-300'
                              }`}>
                                {isAuto ? 'Auto-Tagessicherung' : 'Manuell'}
                              </span>
                            </div>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {dateFormatted} • <strong className="font-mono text-slate-300">{sizeMb} MB</strong>
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 w-full sm:w-auto justify-end shrink-0">
                          <button
                            type="button"
                            onClick={() => handleRestoreSnapshot(b.filename)}
                            disabled={restoring}
                            className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 text-emerald-300 hover:text-white border-emerald-500/30 hover:bg-emerald-600 transition-all"
                            title="Diesen Snapshot wiederherstellen"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Wiederherstellen</span>
                          </button>
                          <a
                            href={`/api/backups/${encodeURIComponent(b.filename)}/download`}
                            className="btn-secondary text-[11px] py-1 px-2 flex items-center gap-1 text-sky-300 hover:text-white border-slate-700"
                            title="Herunterladen"
                          >
                            <Download className="w-3 h-3" />
                          </a>
                          <button
                            type="button"
                            onClick={() => handleDeleteSnapshot(b.filename)}
                            disabled={restoring}
                            className="btn-secondary text-[11px] py-1 px-2 text-rose-400 hover:text-white hover:bg-rose-600/50 border-slate-700"
                            title="Löschen"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: UPLOAD ZIP */}
          {backupModalTab === 'upload' && (
            <form onSubmit={handleRestoreSubmit} className="space-y-4">
              <div className="bg-amber-500/10 border border-amber-500/30 text-amber-200 p-3 rounded-xl text-xs flex gap-2.5 leading-relaxed">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-amber-300">Achtung:</span> Das Einspielen überschreibt die aktuelle SQLite-Datenbank (<code className="bg-amber-500/20 px-1 py-0.5 rounded text-[11px]">manga.db</code>) und Coverbilder mit dem Stand aus dem ausgewählten ZIP-Archiv.
                </div>
              </div>

              <div className="border-2 border-dashed border-slate-700 hover:border-emerald-500/50 rounded-2xl p-6 text-center transition-colors bg-slate-900/40">
                <input
                  type="file"
                  id="backup-file-input"
                  accept=".zip"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setRestoreFile(file);
                      setRestoreError('');
                    }
                  }}
                  disabled={restoring}
                />
                
                {restoreFile ? (
                  <div className="flex flex-col items-center">
                    <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300 mb-3">
                      <FileArchive className="w-6 h-6" />
                    </div>
                    <span className="text-sm font-semibold text-white truncate max-w-xs">{restoreFile.name}</span>
                    <span className="text-xs text-slate-400 mt-1">
                      {(restoreFile.size / (1024 * 1024)).toFixed(2)} MB
                    </span>
                    <button
                      type="button"
                      onClick={() => setRestoreFile(null)}
                      className="mt-3 text-xs text-rose-400 hover:underline"
                      disabled={restoring}
                    >
                      Andere Datei auswählen
                    </button>
                  </div>
                ) : (
                  <label htmlFor="backup-file-input" className="cursor-pointer flex flex-col items-center">
                    <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center text-slate-400 mb-3 hover:text-emerald-400 transition-colors">
                      <UploadCloud className="w-6 h-6" />
                    </div>
                    <span className="text-sm font-semibold text-slate-200">Klicke hier, um dein Backup auszuwählen</span>
                    <span className="text-xs text-slate-500 mt-1">Nur .zip-Dateien (z. B. manga-shelf-backup.zip)</span>
                  </label>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="submit"
                  className="btn-primary flex items-center gap-2 text-xs !bg-emerald-600 hover:!bg-emerald-500 disabled:opacity-50"
                  disabled={restoring || !restoreFile}
                >
                  {restoring ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" /> Backup wird eingespielt...
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-4 h-4" /> Backup jetzt einspielen
                    </>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex justify-end shrink-0">
          <button
            id="btn-close-restore-modal"
            type="button"
            onClick={onClose}
            className="btn-secondary text-xs px-4 py-2"
            disabled={restoring}
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
