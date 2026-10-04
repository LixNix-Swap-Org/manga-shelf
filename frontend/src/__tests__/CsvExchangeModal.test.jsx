import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import CsvExchangeModal from '../components/dashboard/CsvExchangeModal';
import { decodeCsvBytes } from '../components/modals/backup/CsvImportPanel';
import { fakeResponse, htmlResponse } from './fakeResponse';

const json = (status, body) => fakeResponse(status, body);
const preview = (n) => ({ created_volumes: n, created_series: 1, skipped_existing: 0, errors: [], warnings: [] });
const csvFile = (text, name = 'a.csv') => new File([text], name, { type: 'text/csv' });
const chooseFile = (file) => {
  const input = document.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [file] } });
};
const bodies = (fetchMock) => fetchMock.mock.calls.map(([, opts]) => JSON.parse(opts.body));

describe('CsvExchangeModal', () => {
  it('visitors only get the export link', () => {
    render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit={false} />);
    expect(document.getElementById('btn-export-csv').getAttribute('href')).toBe('/api/export/csv');
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
  });

  it('editors preview first and import exactly the previewed file', async () => {
    const fetchMock = vi.fn(async (url, opts) => json(200, JSON.parse(opts.body).dry_run ? preview(2) : preview(2)));
    vi.stubGlobal('fetch', fetchMock);
    const onImported = vi.fn();
    render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit onImported={onImported} />);
    expect(screen.getByRole('button', { name: 'CSV-Datei auswählen' })).toBeTruthy();

    chooseFile(csvFile('Reihe;Bandnummer\nBerserk;1\nBerserk;2'));
    const importButton = await screen.findByRole('button', { name: '2 Bände importieren' });
    fireEvent.click(importButton);
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    const [dry, real] = bodies(fetchMock);
    expect(dry).toEqual({ csv: 'Reihe;Bandnummer\nBerserk;1\nBerserk;2', dry_run: true });
    expect(real).toEqual({ csv: dry.csv, dry_run: false });
  });

  it('ignores the preview of an earlier file that answers late', async () => {
    let releaseFirst;
    const fetchMock = vi.fn((url, opts) => {
      const { csv } = JSON.parse(opts.body);
      if (csv.includes('Alt')) return new Promise((resolve) => { releaseFirst = () => resolve(json(200, preview(9))); });
      return Promise.resolve(json(200, preview(1)));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit />);

    chooseFile(csvFile('Reihe;Bandnummer\nAlt;1', 'alt.csv'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    chooseFile(csvFile('Reihe;Bandnummer\nNeu;1', 'neu.csv'));
    await screen.findByRole('button', { name: '1 Band importieren' });
    await act(async () => { releaseFirst(); });
    expect(screen.queryByRole('button', { name: '9 Bände importieren' })).toBeNull();
    expect(screen.getByRole('button', { name: '1 Band importieren' })).toBeTruthy();
  });

  it('series-only files can be imported and a gateway 413 is explained in German', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { ...preview(0), created_series: 2 })));
    const { unmount } = render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit />);
    chooseFile(csvFile('Reihe\nA\nB'));
    expect((await screen.findByRole('button', { name: '2 Reihen anlegen' })).disabled).toBe(false);
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(413)));
    render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit />);
    chooseFile(csvFile('Reihe;Bandnummer\nA;1'));
    expect((await screen.findByRole('alert')).textContent).toBe('CSV-Datei ist zu groß (max. 10 MB).');
  });

  it('decodes Windows-1252 files from German Excel and says so in the preview', async () => {
    const latin = new Uint8Array([0x4d, 0xe4, 0x64, 0x63, 0x68, 0x65, 0x6e]); // "Mädchen" in cp1252
    expect(decodeCsvBytes(latin.buffer)).toEqual({ text: 'Mädchen', encoding: 'windows-1252' });
    expect(decodeCsvBytes(new TextEncoder().encode('Mädchen').buffer).text).toBe('Mädchen');

    const fetchMock = vi.fn(async () => json(200, preview(1)));
    vi.stubGlobal('fetch', fetchMock);
    render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit />);
    chooseFile(new File([new Uint8Array([0x52, 0x3b, 0x31, 0x0a, ...latin, 0x3b, 0x31])], 'excel.csv'));
    expect(await screen.findByText(/als Windows-1252 \(Excel\) gelesen/)).toBeTruthy();
    expect(bodies(fetchMock)[0].csv).toBe('R;1\nMädchen;1');
  });

  it('the help names every column including "Gelesen von" and the owner rule for non-admins', () => {
    render(<CsvExchangeModal isOpen onClose={vi.fn()} canEdit />);
    const help = screen.getByText(/Spalten: Reihe und Bandnummer/);
    expect(help.textContent).toMatch(/Gelesen von und Besitzer/);
    expect(help.textContent).toMatch(/Nur Admins können andere Personen als Besitzer oder Leser eintragen; alle anderen nur sich selbst/);
    expect(help.textContent).toMatch(/20\.000 Zeilen/);
  });

  it('cannot be closed while the import runs', async () => {
    let finish;
    vi.stubGlobal('fetch', vi.fn((url, opts) => (JSON.parse(opts.body).dry_run
      ? Promise.resolve(json(200, preview(1)))
      : new Promise((resolve) => { finish = () => resolve(json(200, preview(1))); }))));
    const onClose = vi.fn();
    const onImported = vi.fn();
    render(<CsvExchangeModal isOpen onClose={onClose} canEdit onImported={onImported} />);
    chooseFile(csvFile('Reihe;Bandnummer\nA;1'));
    fireEvent.click(await screen.findByRole('button', { name: '1 Band importieren' }));
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('data-busy')).toBe('true'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Schließen' })[0]);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    expect(await screen.findByText(/Import fertig: 1 Band, 1 neue Reihe, 0 schon vorhanden/)).toBeTruthy();
    expect(screen.getByRole('dialog').getAttribute('data-busy')).toBeNull();
    expect(onImported).toHaveBeenCalledTimes(1);
  });
});
