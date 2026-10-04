import { useId, useState } from 'react';
import { Download, FileArchive, TriangleAlert, Upload } from 'lucide-react';
import ToolDialog from './ToolDialog';
import FilePickerButton from '../common/FilePickerButton';
import { notify } from '../../utils/notify';
import { formatCount, formatDateTime, formatMegabytes } from '../../utils/format';
import { getLocalRuntime } from '../../local/localTransport';
import { buildBackupZip, readBackupZip } from '../../local/backupZip';

const appVersion = () => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '');

export function backupFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `manga-shelf-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

function saveFile(bytes, name, doc = globalThis.document) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = doc.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const readFile = (file) => (typeof file.arrayBuffer === 'function'
  ? file.arrayBuffer()
  : new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  }));

/**
 * Standalone mode: "Sicherung exportieren/importieren" as a ZIP in the server's backup layout, so the same file
 * restores on a server and in the app. Replaces the server's snapshot management, which needs a server.
 */
export default function BackupExportModal({ onClose, onReplaced }) {
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [staged, setStaged] = useState(null);
  const [confirmed, setConfirmed] = useState(false);

  const exportZip = async () => {
    setError('');
    setBusy(true);
    try {
      const rt = await getLocalRuntime();
      const bytes = await buildBackupZip(rt, { appVersion: appVersion() });
      saveFile(bytes, backupFileName());
      notify.success(`Sicherung erstellt (${formatMegabytes(bytes.length)})`);
    } catch (err) {
      setError(err.message || 'Sicherung fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setConfirmed(false);
    setBusy(true);
    try {
      const archive = readBackupZip(new Uint8Array(await readFile(file)));
      setStaged({ ...archive, name: file.name, size: file.size });
    } catch (err) {
      setStaged(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setError('');
    setBusy(true);
    try {
      const rt = await getLocalRuntime();
      const profile = await rt.replaceDatabase(staged.dbBytes, { uploads: staged.uploads, profileName: rt.getProfile().username });
      const { counts } = rt.facts();
      notify.success(`Sicherung eingespielt: ${formatCount(counts.mangas, 'Reihe', 'Reihen')}, ${formatCount(staged.uploads.size, 'Bild', 'Bilder')} (Profil „${profile.username}“)`);
      setStaged(null);
      onReplaced?.(profile);
    } catch (err) {
      setError(err.message || 'Einspielen fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const manifest = staged?.manifest;
  return (
    <ToolDialog id="backup-export-modal" title="Sicherung" subtitle="Sammlung dieses Geräts als ZIP sichern oder aus einer Sicherung wiederherstellen" Icon={FileArchive} onClose={onClose} busy={busy}>
      <div className="space-y-5">
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <section className="space-y-2" aria-labelledby={`${ids}-export`}>
          <h3 id={`${ids}-export`} className="text-sm font-bold text-white">Sicherung exportieren</h3>
          <p className="text-xs text-slate-400">Datenbank und alle Bilder in einer ZIP-Datei – dasselbe Format wie die Backups eines Servers. Ein Server übernimmt sie unter Backups → „ZIP-Datei hochladen“.</p>
          <p className="text-xs text-slate-400">Auf diesem Gerät liegen keine Passwörter: Konten, die von einem Server stammen, brauchen nach der Wiederherstellung auf einem Server einen Passwort-Reset. In eine bestehende Server-Sammlung führt „Zusammenführen“ ohne Passwortverlust.</p>
          <button type="button" className="btn-primary text-sm inline-flex items-center gap-1.5" onClick={exportZip} disabled={busy}>
            <Download className="w-4 h-4" aria-hidden="true" /> Sicherung exportieren
          </button>
        </section>
        <section className="space-y-2 border-t border-slate-800 pt-4" aria-labelledby={`${ids}-import`}>
          <h3 id={`${ids}-import`} className="text-sm font-bold text-white">Sicherung importieren</h3>
          <p className="text-xs text-slate-400">Eine Sicherung dieser App oder ein Backup-ZIP eines Servers. Die Sammlung auf diesem Gerät wird dabei ersetzt.</p>
          <FilePickerButton id={`${ids}-file`} accept=".zip,application/zip" onChange={pick} disabled={busy} className="btn-secondary text-sm inline-flex items-center gap-1.5">
            <Upload className="w-4 h-4" aria-hidden="true" /> ZIP-Datei auswählen
          </FilePickerButton>
          {staged && (
            <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-2 text-sm" aria-label="Inhalt der Sicherung">
              <p className="text-slate-200 font-semibold break-all">{staged.name} · {formatMegabytes(staged.size)}</p>
              <p className="text-slate-300">
                {manifest?.counts ? `${formatCount(manifest.counts.mangas ?? 0, 'Reihe', 'Reihen')}, ${formatCount(manifest.counts.volumes ?? 0, 'Band', 'Bände')}, ` : ''}
                {formatCount(staged.uploads.size, 'Bild', 'Bilder')}
                {manifest?.created_at ? ` · erstellt ${formatDateTime(new Date(manifest.created_at))}` : ''}
              </p>
              <p className="flex gap-2 text-amber-200"><TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />Ersetzt alle Reihen, Bände und Bilder auf diesem Gerät.</p>
              <label className="flex items-center gap-2 text-slate-200">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Sammlung auf diesem Gerät ersetzen
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary text-xs px-3 py-1.5" onClick={() => setStaged(null)} disabled={busy}>Verwerfen</button>
                <button type="button" className="btn-primary text-xs px-3 py-1.5" onClick={restore} disabled={busy || !confirmed} aria-busy={busy || undefined}>Einspielen</button>
              </div>
            </div>
          )}
        </section>
      </div>
    </ToolDialog>
  );
}
