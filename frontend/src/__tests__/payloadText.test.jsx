// Texts inside 2xx payloads (contract 22 addendum): German unchanged, other languages through `<field>_msg`.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __setCatalogForTests, resetI18nForTests } from '../i18n/index.js';
import { payloadText } from '../i18n/serverText.js';
import { scanDashboardAction } from '../components/dashboard/dashboardShell';
import { detailScanAction } from '../components/detail/DetailBottomBar';
import RestoreConfirm from '../components/modals/backup/RestoreConfirm';
import CsvImportPanel from '../components/modals/backup/CsvImportPanel';
import GapNotices from '../components/detail/GapNotices';
import { fakeResponse } from './fakeResponse';

const EN = {
  'Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.': 'No metadata for this ISBN in DNB, K10plus or Google Books.',
  'Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.': 'All other sessions (other devices and users) will be ended.',
  'Backup stammt aus einer neueren Version (Schema v{version} > v{current}) – erst Manga Shelf aktualisieren.': 'Backup comes from a newer version (schema v{version} > v{current}) – update Manga Shelf first.',
  'Dein Benutzer „{username}“ ist im Backup nicht vorhanden: Du wirst danach abgemeldet.': 'Your user “{username}” is not in the backup: you will be signed out afterwards.',
  'Ungültiger Wert „{raw}“ in „{label}“ ({hint}) wird ignoriert': 'Invalid value “{raw}” in “{label}” ({hint}) is ignored',
  '{min} bis {max}': '{min} to {max}',
  'Unbekannter Status „{status}“': 'Unknown status “{status}”',
  'Zeile {line}: {message}': 'Line {line}: {message}',
  'Deine Sammlung gibt {db_total} Bände an (oft AniList-Originalzählung). Die deutsche Edition umfasst {official_total} Bände.':
    'Your collection says {db_total} volumes (often the AniList count). The German edition has {official_total} volumes.'
};
const english = () => __setCatalogForTests('en', EN, { languages: ['en-GB'] });

afterEach(() => {
  resetI18nForTests();
  vi.unstubAllGlobals();
});

const notFound = {
  found: false,
  message: 'Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.',
  message_msg: { msg: 'Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.', params: {} }
};

describe('payloadText', () => {
  it('German: always the server text, byte for byte', () => {
    expect(payloadText({ message: 'Snapshot gelöscht', message_msg: { msg: 'anders', params: {} } }, 'message')).toBe('Snapshot gelöscht');
    expect(payloadText({ warnings: ['a', 'b'] }, 'warnings', 1)).toBe('b');
    expect(payloadText({ errors: [{ line: 2, message: 'x' }] }, 'errors', 0)).toBe('x');
    expect(payloadText({ message: 42 }, 'message')).toBe('');
    expect(payloadText(null, 'message')).toBe('');
    expect(payloadText({ warnings: 'x' }, 'warnings', 0)).toBe('');
  });

  it('other languages: the template with its params (nested messages translated, plain strings verbatim)', () => {
    english();
    const body = {
      warnings: [{ line: 3, message: 'Ungültiger Wert „7“ in „Reihen-Wunsch“ (0 bis 3) wird ignoriert' }],
      warnings_msg: [{
        msg: 'Ungültiger Wert „{raw}“ in „{label}“ ({hint}) wird ignoriert',
        params: { raw: '7', label: 'Reihen-Wunsch', hint: { msg: '{min} bis {max}', params: { min: 0, max: 3 } } }
      }]
    };
    expect(payloadText(body, 'warnings', 0)).toBe('Invalid value “7” in “Reihen-Wunsch” (0 to 3) is ignored');
    expect(payloadText(notFound, 'message')).toBe('No metadata for this ISBN in DNB, K10plus or Google Books.');
  });

  it('without `<field>_msg` the exact German text is looked up; unknown texts stay as sent', () => {
    english();
    expect(payloadText({ message: notFound.message }, 'message')).toBe(EN[notFound.message]);
    expect(payloadText({ message: 'Unbekannter Text' }, 'message')).toBe('Unbekannter Text');
  });

  it('list entries beyond the sent `<field>_msg` array are client lines and stay as they are', () => {
    english();
    const body = { warnings: ['Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.', 'Client line'], warnings_msg: [null] };
    expect(payloadText(body, 'warnings', 0)).toBe(EN[body.warnings[0]]);
    expect(payloadText(body, 'warnings', 1)).toBe('Client line');
  });
});

describe('payload text readers', () => {
  it('ISBN scan actions show the not-found message in the UI language', () => {
    expect(scanDashboardAction({ ok: true, data: notFound, canEdit: true }).message).toBe(notFound.message);
    english();
    expect(scanDashboardAction({ ok: true, data: notFound, canEdit: true }).message).toBe(EN[notFound.message]);
    expect(detailScanAction({ ok: true, data: notFound }).message).toBe(EN[notFound.message]);
  });

  it('RestoreConfirm picks the user and schema lines by the German text and shows them translated', () => {
    english();
    const warnings = [
      'Dein Benutzer „admin“ ist im Backup nicht vorhanden: Du wirst danach abgemeldet.',
      'Backup stammt aus einer neueren Version (Schema v30 > v27) – erst Manga Shelf aktualisieren.',
      'Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.'
    ];
    const inspection = {
      source: { type: 'upload', filename: 'b.zip', size: 10 }, counts: {}, current_counts: {}, schema_newer: true, relogin: true,
      current_user: { username: 'admin' }, warnings,
      warnings_msg: [
        { msg: 'Dein Benutzer „{username}“ ist im Backup nicht vorhanden: Du wirst danach abgemeldet.', params: { username: 'admin' } },
        { msg: 'Backup stammt aus einer neueren Version (Schema v{version} > v{current}) – erst Manga Shelf aktualisieren.', params: { version: 30, current: 27 } },
        { msg: 'Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.', params: {} }
      ]
    };
    render(<RestoreConfirm inspection={inspection} allowNewer={false} onAllowNewerChange={vi.fn()} restoring={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Your user “admin” is not in the backup: you will be signed out afterwards.')).toBeTruthy();
    expect(screen.getByText('Backup comes from a newer version (schema v30 > v27) – update Manga Shelf first.')).toBeTruthy();
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([EN[warnings[2]]]);
  });

  it('CsvImportPanel lists row errors and warnings in the UI language', async () => {
    english();
    const answer = {
      success: true, dry_run: true, created_volumes: 1, created_series: 1, skipped_existing: 0,
      errors: [{ line: 2, message: 'Unbekannter Status „Kaputt“' }],
      warnings: [{ line: 3, message: 'Ungültiger Wert „7“ in „Reihen-Wunsch“ (0 bis 3) wird ignoriert' }],
      errors_msg: [{ msg: 'Unbekannter Status „{status}“', params: { status: 'Kaputt' } }],
      warnings_msg: [{
        msg: 'Ungültiger Wert „{raw}“ in „{label}“ ({hint}) wird ignoriert',
        params: { raw: '7', label: 'Reihen-Wunsch', hint: { msg: '{min} bis {max}', params: { min: 0, max: 3 } } }
      }]
    };
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, answer)));
    render(<CsvImportPanel />);
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(['Reihe;Bandnummer\nA;1'], 'a.csv', { type: 'text/csv' })] } });
    expect(await screen.findByText('Line 2: Unknown status “Kaputt”')).toBeTruthy();
    expect(screen.getByText('Line 3: Invalid value “7” in “Reihen-Wunsch” (0 to 3) is ignored')).toBeTruthy();
  });

  it('the CSV help names the edition columns in export order', () => {
    render(<CsvImportPanel />);
    const help = screen.getByText(/Spalten: Reihe und Bandnummer/).textContent;
    const at = (name) => help.indexOf(name);
    expect(at('Sprache (')).toBeGreaterThan(at('Alternativtitel'));
    expect(at('Region (')).toBeGreaterThan(at('Sprache ('));
    expect(at('Währung (')).toBeGreaterThan(at('Region ('));
    expect(at('Werk (')).toBeGreaterThan(at('Währung ('));
    expect(at('Bandsprache (')).toBeGreaterThan(at('MP-Band-ID'));
    expect(at('Gelesen von und Besitzer')).toBeGreaterThan(at('Bandsprache ('));
  });

  it('GapNotices shows the volume count discrepancy in the UI language', () => {
    english();
    const mpGapData = {
      matched: true, link_confirmed: true, edition: { id: 1, title: 'X' },
      discrepancy: {
        has_discrepancy: true, db_total: 6, official_total: 3,
        message: 'Deine Sammlung gibt 6 Bände an (oft AniList-Originalzählung). Die deutsche Edition umfasst 3 Bände.',
        message_msg: {
          msg: 'Deine Sammlung gibt {db_total} Bände an (oft AniList-Originalzählung). Die deutsche Edition umfasst {official_total} Bände.',
          params: { db_total: 6, official_total: 3 }
        }
      }
    };
    render(<GapNotices canEdit canSyncVolumeCount mpGapData={mpGapData} handleSyncTotalVolumes={vi.fn()} />);
    expect(screen.getByText('Your collection says 6 volumes (often the AniList count). The German edition has 3 volumes.')).toBeTruthy();
  });
});
