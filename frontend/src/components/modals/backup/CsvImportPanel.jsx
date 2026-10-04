import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Upload } from 'lucide-react';
import { apiFetch, TIMEOUTS } from '../../../utils/api';
import { formatCount, formatNumber } from '../../../utils/format';
import { httpErrorMessage, readJson } from './backupHelpers';

// express.json limit of POST /api/import/csv (index.js); the limit applies to the JSON body, not to the file
const CSV_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const CSV_TOO_LARGE = 'CSV-Datei ist zu groß (max. 10 MB).';
const LIST_LIMIT = 20;

/** Decodes CSV bytes: UTF-8/UTF-16 by BOM, UTF-8 without BOM, else Windows-1252 (German Excel "CSV"). */
export function decodeCsvBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch (_) {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

const readFile = async (file) => (typeof file.arrayBuffer === 'function'
  ? decodeCsvBytes(await file.arrayBuffer())
  : { text: await file.text(), encoding: 'utf-8' });

function LineList({ label, items, className, more }) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className={`text-[11px] max-h-28 overflow-y-auto custom-scrollbar space-y-0.5 ${className}`}>
      {items.slice(0, LIST_LIMIT).map((e, i) => <li key={i}>Zeile {e.line}: {e.message}</li>)}
      {items.length > LIST_LIMIT && <li>… und {formatNumber(items.length - LIST_LIMIT)} {more}</li>}
    </ul>
  );
}

/**
 * CSV import (POST /api/import/csv): dry run first, then the previewed text. Shared by the CSV dialog and the CSV tab
 * of the backup dialog. onImportingChange(true/false) brackets the real import so the dialog can refuse to close.
 */
export default function CsvImportPanel({ disabled = false, onImported, onImportingChange }) {
  const fileInputRef = useRef(null);
  const requestRef = useRef(0);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const importingChangeRef = useRef(onImportingChange);
  importingChangeRef.current = onImportingChange;

  useEffect(() => {
    importingChangeRef.current?.(importing);
  }, [importing]);

  useEffect(() => () => {
    requestRef.current += 1;
    importingChangeRef.current?.(false);
  }, []);

  const sendCsv = async ({ text, encoding }, dryRun, id) => {
    const isLatest = () => id === requestRef.current;
    setError('');
    const body = JSON.stringify({ csv: text, dry_run: dryRun });
    if (new Blob([body]).size > CSV_MAX_BODY_BYTES) {
      setError(CSV_TOO_LARGE);
      return;
    }
    setBusy(true);
    if (!dryRun) setImporting(true);
    try {
      const res = await apiFetch('/api/import/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeout: TIMEOUTS.long
      });
      const data = await readJson(res);
      // the import happened on the server even if the dialog moved on
      if (res.ok && !dryRun) onImported?.();
      if (!isLatest()) return;
      if (!res.ok) {
        setError(httpErrorMessage(res.status, data, 'Import fehlgeschlagen', { tooLarge: CSV_TOO_LARGE }));
        return;
      }
      if (dryRun) {
        setPreview({
          ...data,
          errors: Array.isArray(data.errors) ? data.errors : [],
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
          text,
          encoding
        });
      } else {
        setPreview(null);
        setFileName('');
        setSuccess(`Import fertig: ${formatCount(data.created_volumes || 0, 'Band', 'Bände')}, ${formatCount(data.created_series || 0, 'neue Reihe', 'neue Reihen')}, ${formatNumber(data.skipped_existing || 0)} schon vorhanden.`);
      }
    } catch (e) {
      if (isLatest()) {
        setError(e?.isTimeout
          ? 'Der Server hat nicht rechtzeitig geantwortet. Der Import kann trotzdem durchgelaufen sein: Sammlung prüfen, bevor du die Datei erneut importierst.'
          : 'Netzwerkfehler: Der Server ist nicht erreichbar.');
      }
    } finally {
      if (isLatest()) {
        setBusy(false);
        setImporting(false);
      }
    }
  };

  const handleFileChosen = async (file) => {
    const id = ++requestRef.current;
    setPreview(null);
    setError('');
    setSuccess('');
    setBusy(false);
    setFileName(file ? file.name : '');
    if (!file) return;
    if (file.size > CSV_MAX_BODY_BYTES) {
      setError(CSV_TOO_LARGE);
      return;
    }
    setBusy(true);
    let decoded;
    try {
      decoded = await readFile(file);
    } catch (_) {
      if (id === requestRef.current) {
        setError('Datei konnte nicht gelesen werden.');
        setBusy(false);
      }
      return;
    }
    if (id !== requestRef.current) return;
    await sendCsv(decoded, true, id);
  };

  const volumes = preview?.created_volumes || 0;
  const series = preview?.created_series || 0;
  const errors = preview?.errors || [];
  const warnings = preview?.warnings || [];
  const importLabel = volumes > 0
    ? `${formatCount(volumes, 'Band', 'Bände')} importieren`
    : series > 0
      ? `${formatCount(series, 'Reihe', 'Reihen')} anlegen`
      : 'Nichts zu importieren';
  const locked = disabled || importing;

  return (
    <div className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800 space-y-3">
      <div className="text-sm font-semibold text-slate-200">Aus CSV importieren</div>
      <p className="text-xs text-slate-400">
        Spalten: Reihe und Bandnummer (Pflicht) sowie Reihenverlag, Verlag (nur wenn der Band abweicht), Autor, Typ („Reihe“ =
        Zeile nur für die Reihe), Status (Vorhanden, Fehlt, Vorbestellt, Erscheint bald, Bestellt; „Gelesen“ = Vorhanden + gelesen),
        ISBN, Preis, Zielpreis, Priorität (0–3), Erscheinungsdatum, Erscheinungsjahr, Kaufdatum, Zustand, Seiten, Notizen,
        Reihen-Wunsch (0–3), Reihenstatus, Sammelstatus (aktiv, pausiert, abgebrochen; leer = aktiv), Gesamtbände, Alternativtitel, Sprache, Tags, Manga-Passion-ID, Reihen-Cover,
        Reihen-Banner, Beschreibung, Band-Cover, Bilder (durch | getrennt), MP-Band-ID, Gelesen von und Besitzer
        (Benutzernamen, durch Komma oder | getrennt; Besitzer nur bei Status Vorhanden; unbekannte Namen werden ignoriert, ohne
        Treffer wirst du Besitzer). Nur Admins können andere Personen als Besitzer oder Leser eintragen; alle anderen nur sich selbst.
        Eine Zeile ohne Bandnummer oder mit Typ „Reihe“ legt nur die Reihe an bzw. setzt deren Wunsch.
        Bereits vorhandene Bände (Reihe + Typ + Nummer) werden nie verändert. Am einfachsten: erst exportieren und die Datei als Vorlage nutzen.
        In Excel die Spalten ISBN und Bandnummer als Text formatieren. Höchstens 20.000 Zeilen und 10 MB pro Datei.
        Bilddateien und Preise je Besitzer sind nicht in der CSV – dafür das ZIP-Backup nutzen.
        Zu lange Cover- oder Reihenwerte (z. B. alte data:-Cover) werden mit Hinweis übersprungen, der Band wird trotzdem angelegt.
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        aria-label="CSV-Datei auswählen"
        className="hidden"
        tabIndex={-1}
        disabled={locked}
        onChange={(e) => {
          handleFileChosen(e.target.files?.[0] || null);
          e.target.value = '';
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          id="btn-csv-choose-file"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={locked}
          className="btn-secondary text-xs inline-flex items-center gap-2 disabled:opacity-50"
        >
          <Upload className="w-4 h-4" aria-hidden="true" /> CSV-Datei auswählen
        </button>
        {fileName && <span className="text-xs text-slate-400 truncate max-w-[14rem]" title={fileName}>{fileName}</span>}
      </div>
      {error && <div role="alert" className="text-xs text-rose-400">{error}</div>}
      <div role="status" className="space-y-2 empty:hidden">
        {busy && (
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> {importing ? 'Wird importiert...' : 'Wird geprüft...'}
          </div>
        )}
        {success && <div className="text-xs text-emerald-300">{success}</div>}
      </div>
      {preview && !busy && (
        <div className="space-y-2">
          {preview.encoding === 'windows-1252' && (
            <div className="text-[11px] text-sky-300">
              Die Datei ist nicht UTF-8-kodiert und wurde als Windows-1252 (Excel) gelesen. Bitte Umlaute nach dem Import prüfen.
            </div>
          )}
          <div className="text-xs text-slate-200">
            Vorschau: {formatCount(volumes, 'neuer Band', 'neue Bände')} ({formatCount(series, 'neue Reihe', 'neue Reihen')}), {formatNumber(preview.skipped_existing || 0)} schon vorhanden, {formatCount(errors.length, 'fehlerhafte Zeile', 'fehlerhafte Zeilen')}{warnings.length > 0 && `, ${formatCount(warnings.length, 'Hinweis', 'Hinweise')}`}.
          </div>
          <LineList label="Fehlerhafte Zeilen" items={errors} className="text-amber-300" more="weitere" />
          <LineList label="Hinweise" items={warnings} className="text-amber-200/80" more="weitere Hinweise" />
          <button
            id="btn-csv-import"
            type="button"
            onClick={() => sendCsv(preview, false, ++requestRef.current)}
            disabled={busy || locked || (volumes === 0 && series === 0)}
            className="btn-primary text-xs !bg-emerald-700 hover:!bg-emerald-800 disabled:opacity-50"
          >
            {importLabel}
          </button>
        </div>
      )}
    </div>
  );
}
