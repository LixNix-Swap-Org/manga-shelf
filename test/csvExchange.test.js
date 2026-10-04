const test = require('node:test');
const assert = require('node:assert/strict');
const {
    toCsv, parseCsv, mapCsvRows, normalizeDate, parseAmount, CsvFormatError, guardFormulas, unescapeCell, COLUMNS,
    MAX_NOTES_LENGTH, MAX_CELL_LENGTH
} = require('../services/csvExchange');
const { SERIES_DETAIL_KEYS, COLLECTING_STATUSES } = require('../core/csvExchange');
const { startTestServer } = require('./helpers');

const roundTrip = (rows) => mapCsvRows(parseCsv(toCsv(rows)));

test('toCsv/parseCsv Rundlauf mit Semikolon, Anführungszeichen und Umlauten', () => {
    const csv = toCsv([{ series: 'Say "Hi"; Ärger', volume_number: '1', status: 'Vorhanden', price: 7.5, type: 'volume' }]);
    assert.ok(csv.startsWith('﻿Reihe;'));
    const rows = parseCsv(csv);
    assert.equal(rows[1][0], 'Say "Hi"; Ärger');
    assert.equal(rows[1][8], '7,5');
});

test('Formelzeichen werden im Export entschärft', () => {
    assert.ok(toCsv([{ series: '=SUM(A1)', volume_number: '1' }]).includes("'=SUM(A1)"));
});

test('mapCsvRows prüft Pflichtfelder, Status, Preis und Datum', () => {
    const rows = parseCsv('Reihe;Bandnummer;Status;Preis;Erscheinungsdatum\nOne Piece;1;Vorhanden;"6,95 €";05.03.2021\n;2;Vorhanden;;\nX;1;Kaputt;;\nY;1;;abc;');
    const { records, errors } = mapCsvRows(rows);
    assert.equal(records.length, 1);
    assert.equal(records[0].price, 6.95);
    assert.equal(records[0].release_date, '2021-03-05');
    assert.deepEqual(errors.map(e => e.line), [3, 4, 5]);
});

test('Formel-Apostroph wird beim Import genau einmal entfernt', () => {
    const { records, errors } = roundTrip([
        { series: '+Anima', volume_number: '1', notes: '-Leseprobe', condition: '@home', owners: '@bob' },
        { series: '=SUM(A1)', volume_number: '-', notes: '- Knick im Rücken' },
        { series: "'=x", volume_number: '-1', notes: "'nur Apostroph" }
    ]);
    assert.deepEqual(errors, []);
    assert.equal(records[0].series, '+Anima');
    assert.equal(records[0].notes, '-Leseprobe');
    assert.equal(records[0].condition, '@home');
    assert.deepEqual(records[0].owners, ['@bob']);
    assert.equal(records[1].series, '=SUM(A1)');
    assert.equal(records[1].volume_number, '-');
    assert.equal(records[1].notes, '- Knick im Rücken');
    assert.equal(records[2].series, "'=x");
    assert.equal(records[2].volume_number, '-1');
    assert.equal(records[2].notes, "'nur Apostroph");
});

test('Formelschutz deckt führendes Tab und CR ab, negative Zahlen bleiben unverändert', () => {
    const csv = toCsv([{ series: 'x', author: '\t=1+1', notes: '\r=1+1', volume_number: '-1', pages: '-5' }]);
    assert.ok(csv.includes("'\t=1+1"));
    assert.ok(csv.includes('"\'\r=1+1"'));
    const line = csv.split('\r\n')[1].split(';');
    assert.equal(line[5], '-1');
    assert.equal(line[15], '-5');
});

test('ISBN wird Excel-sicher exportiert, Exponentialschreibweise abgelehnt', () => {
    const csv = toCsv([{ series: 'A', volume_number: '1', isbn: '9783551745811' }]);
    assert.ok(csv.includes(';978-3551745811;'));
    assert.equal(mapCsvRows(parseCsv(csv)).records[0].isbn, '9783551745811');

    const { records, errors } = mapCsvRows(parseCsv('Reihe;Bandnummer;ISBN\nA;1;9,78355E+12\nA;2;9.78355E+12\nA;3;978-3-551-74581-1\nA;4;123'));
    assert.deepEqual(errors.map(e => e.line), [2, 3]);
    assert.match(errors[0].message, /Excel/);
    assert.equal(records[0].isbn, '9783551745811');
    assert.equal(records[1].isbn, '123');
});

test('Datumsformate wie in der Volume-API, mit Bereichsprüfung', () => {
    for (const [input, expected] of [
        ['2025', '2025'], ['2025-03', '2025-03'], ['2025-3', '2025-03'], ['2024-02-29', '2024-02-29'],
        ['29.02.2024', '2024-02-29'], ['5.3.2021', '2021-03-05'], ['03.2025', '2025-03'], ['3/2025', '2025-03'],
        ['Mrz 25', '2025-03'], ['März 2025', '2025-03'], ['Dez. 24', '2024-12'], ['', null]
    ]) assert.deepEqual(normalizeDate(input), { value: expected }, input);
    for (const input of ['2024-13-01', '2024-02-31', '2023-02-29', '31.02.2024', '45.13.2024', '0000-00', '2024-00', '0000', 'gestern']) {
        assert.ok(normalizeDate(input).error, input);
    }

    const { records, errors } = roundTrip([
        { series: 'A', volume_number: '1', release_date: '2025', purchase_date: '2023' },
        { series: 'A', volume_number: '2', release_date: '2024-05', purchase_date: '2024-05-17' }
    ]);
    assert.deepEqual(errors, []);
    assert.deepEqual(records.map(r => [r.release_date, r.purchase_date]), [['2025', '2023'], ['2024-05', '2024-05-17']]);

    const bad = mapCsvRows(parseCsv('Reihe;Bandnummer;Kaufdatum;Erscheinungsdatum\nA;1;2024-13-45;31.02.2024\nA;2;45.13.2024;0000-00\nA;3;29.02.2023;\nA;4;;29.02.2024'));
    assert.deepEqual(bad.errors.map(e => e.line), [2, 3, 4]);
    assert.equal(bad.records[0].release_date, '2024-02-29');
});

test('Preis, Zielpreis und Seiten werden streng geprüft', () => {
    for (const [input, expected] of [['6,95', 6.95], ['6.95 €', 6.95], ['€ 7', 7], ['7', 7], ['', null], ['99999', 99999]]) {
        assert.deepEqual(parseAmount(input), { value: expected }, input);
    }
    for (const input of ['0x10', '1e9', '1e308', '7.999', '1.234', '100000', '-1', 'abc']) assert.ok(parseAmount(input).error, input);

    const { records, errors } = mapCsvRows(parseCsv('Reihe;Bandnummer;Preis;Seiten;Zielpreis;Priorität\nA;1;1e9;;;\nA;2;;12abc;;\nA;3;;1e5;;\nA;4;;100000;;\nA;5;;;0x10;\nA;6;;;;7\nA;7;6,95;192;5,5;2'));
    assert.deepEqual(errors.map(e => e.line), [2, 3, 4, 5, 6, 7]);
    assert.deepEqual(records.map(r => [r.price, r.pages, r.target_price, r.priority]), [[6.95, 192, 5.5, 2]]);
});

test('Typ wird ohne Typ-Spalte aus Nummer und Notizen abgeleitet', () => {
    const { records } = mapCsvRows(parseCsv('Reihe;Bandnummer;Notizen\nA;Schuber 1;\nA;Special Edition 3;\nA;Extra;\nA;Sonderband;\nA;5;\nA;4;Limited Edition'));
    assert.deepEqual(records.map(r => r.type), ['schuber', 'special_edition', 'special', 'special', 'volume', 'special_edition']);
    const explicit = mapCsvRows(parseCsv('Reihe;Bandnummer;Typ\nA;Schuber 1;volume\nA;Schuber 2;Band'));
    assert.deepEqual(explicit.records.map(r => r.type), ['volume', 'volume']);
});

test('Status Gelesen wird zu Vorhanden mit Lese-Markierung', () => {
    const { records, errors } = mapCsvRows(parseCsv('Reihe;Bandnummer;Status\nA;1;gelesen\nA;2;Vorhanden'));
    assert.deepEqual(errors, []);
    assert.deepEqual(records.map(r => [r.status, r.mark_read]), [['Vorhanden', true], ['Vorhanden', false]]);
});

test('Nicht geschlossenes Anführungszeichen bricht mit Zeilennummer ab', () => {
    assert.throws(() => parseCsv('Reihe;Bandnummer;Notizen\nA;1;"kaputt\nA;2;ok\n'),
        (err) => err instanceof CsvFormatError && err.line === 2 && /Zeile 2/.test(err.message));
    const rows = parseCsv('Reihe;Notiz\n"a\nb";"x""y"\n');
    assert.deepEqual(rows[1], ['a\nb', 'x"y']);
});

test('Kopfzeilen-Aliasse nach Vorrang, jede Spalte nur einmal', () => {
    let r = mapCsvRows(parseCsv('Titel;Reihe;Band\nVol Title;Naruto;1')).records[0];
    assert.equal(r.series, 'Naruto');
    assert.equal(r.volume_number, '1');
    r = mapCsvRows(parseCsv('Band;Reihe;Bandnummer\nx;Naruto;3')).records[0];
    assert.equal(r.volume_number, '3');
    r = mapCsvRows(parseCsv('Series;Volume;Volume Number\nNaruto;x;7')).records[0];
    assert.equal(r.volume_number, '7');
    r = mapCsvRows(parseCsv('Titel;Band\nNaruto;2')).records[0];
    assert.deepEqual([r.series, r.volume_number], ['Naruto', '2']);
});

test('Fehlerzeilen zählen Leerzeilen und mehrzeilige Zellen mit', () => {
    let { errors } = mapCsvRows(parseCsv('Reihe;Bandnummer;Status\n\n\nA;1;Vorhanden\n\nB;2;Kaputt\n'));
    assert.deepEqual(errors.map(e => e.line), [6]);
    ({ errors } = mapCsvRows(parseCsv('Reihe;Bandnummer;Notizen;Status\nA;1;"zwei\nZeilen";Vorhanden\nB;2;;Kaputt\n')));
    assert.deepEqual(errors.map(e => e.line), [4]);
    ({ errors } = mapCsvRows(parseCsv('Reihe;Bandnummer;Notizen;Status\r\nA;1;"zwei\r\nZeilen";Vorhanden\r\n;;;\r\nB;2;;Kaputt\r\n')));
    assert.deepEqual(errors.map(e => e.line), [5]);
    ({ errors } = mapCsvRows(parseCsv('\n\nReihe;Status\nA;1\n')));
    assert.deepEqual(errors.map(e => e.line), [3]);
});

test('Zeile ohne Bandnummer und ohne Banddaten legt nur die Reihe an', () => {
    const { records, errors } = mapCsvRows(parseCsv('Reihe;Reihenverlag;Bandnummer;Status\nLeer;Carlsen;;\nA;;;Vorhanden'));
    assert.deepEqual(records.map(r => [r.series, r.series_only]), [['Leer', true]]);
    assert.deepEqual(errors.map(e => e.line), [3]);
});

test('Formelschutz nach Kommas (Excel mit Komma als Listentrenner), Rundlauf bleibt verlustfrei', () => {
    const csv = toCsv([{ series: 'a,=1+1', volume_number: '1', notes: 'x, @y,-z, -5, 1,+2' }]);
    assert.ok(csv.includes("a,'=1+1"));
    assert.ok(csv.includes("x, '@y,'-z, -5, 1,'+2"));
    const { records, errors } = roundTrip([{ series: 'a,=1+1', volume_number: '1', notes: "x, @y,-z, -5, 1,+2,'=q" }]);
    assert.deepEqual(errors, []);
    assert.equal(records[0].series, 'a,=1+1');
    assert.equal(records[0].notes, "x, @y,-z, -5, 1,+2,'=q");

    // jede Kombination aus Komma, Leerraum, Apostroph und Formelzeichen übersteht guardFormulas + unescapeCell
    const alphabet = [',', ' ', '\t', "'", '=', '-', '+', '@', '1', '.', 'a'];
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 3000; i++) {
        let v = '';
        for (let k = rnd(8); k >= 0; k--) v += alphabet[rnd(alphabet.length)];
        const guarded = guardFormulas(v);
        assert.equal(unescapeCell(guarded), v, JSON.stringify(v));
        for (const segment of guarded.split(',')) assert.doesNotMatch(segment.trimStart(), /^(?:[=+@]|-(?![\d.]+$))/, JSON.stringify(v));
    }
});

test('parseCsv bricht bei zu vielen Zeilen, Spalten oder zu langen Zellen früh ab', () => {
    const limits = { maxRows: 3, maxCells: 4, maxCellLength: 10 };
    assert.equal(parseCsv('Reihe;Bandnummer\na;1\nb;2\nc;3\n\n\n', limits).length, 4);
    assert.throws(() => parseCsv('Reihe;Bandnummer\na;1\nb;2\nc;3\nd;4', limits), (err) => err instanceof CsvFormatError && /Zu viele Zeilen \(maximal 3\)/.test(err.message) && err.line === 5);
    assert.throws(() => parseCsv('a;b;c;d;e', limits), (err) => err instanceof CsvFormatError && /zu viele Spalten/.test(err.message));
    assert.throws(() => parseCsv('Reihe;Bandnummer\n"' + 'x'.repeat(11) + '";1', limits), (err) => err instanceof CsvFormatError && err.line === 2);
    // das Trennzeichen kommt aus der ersten nicht leeren Zeile
    assert.deepEqual(parseCsv('\n\n  \nReihe,Bandnummer\nA,1')[1], ['A', '1']);
    assert.deepEqual(parseCsv('\r\nReihe;Bandnummer,x\r\nA;1,5')[1], ['A', '1,5']);
});

test('Notizen bis 10000 Zeichen überstehen den Rundlauf auch mit Formelschutz; längere Zellen sind ein Fehler der Zeile', () => {
    assert.equal(MAX_CELL_LENGTH, 2 * MAX_NOTES_LENGTH + 2);
    const worst = ',='.repeat(MAX_NOTES_LENGTH / 2);
    const csv = toCsv([{ series: 'T', type: 'volume', volume_number: '2', status: 'Fehlt', notes: worst }]);
    const parsed = parseCsv(csv, { maxCellLength: 200000 });
    assert.ok(Math.max(...parsed[1].map(c => c.length)) <= MAX_CELL_LENGTH);
    const { records, errors } = mapCsvRows(parsed);
    assert.deepEqual(errors, []);
    assert.equal(records[0].notes, worst);

    const long = mapCsvRows(parseCsv(`Reihe;Bandnummer;Notizen\nA;1;${'n'.repeat(MAX_NOTES_LENGTH + 1)}\nA;2;ok\nA;3;${'z'.repeat(MAX_CELL_LENGTH + 1)}`));
    assert.deepEqual(long.records.map(r => r.volume_number), ['2']);
    assert.deepEqual(long.errors.map(e => e.line), [2, 4]);
    assert.match(long.errors[0].message, /Notizen sind zu lang \(maximal 10000 Zeichen\)/);
    assert.match(long.errors[1].message, /Zelle ist zu lang/);
});

test('Band-Cover, Bilder und Reihenspalten: zu lange Werte werden mit Hinweis ignoriert, die Zeile bleibt', () => {
    const dataCover = 'data:image/png;base64,' + 'A'.repeat(30000);
    const longUrl = 'https://img.example.org/' + 'x'.repeat(2100);
    const description = 'd'.repeat(25000);
    const header = 'Reihe;Bandnummer;Gesamtbände;Beschreibung;Band-Cover;Bilder;Notizen';
    const csv = `${header}\nA;1;7;${description};"${dataCover}";"${dataCover} | /uploads/b.jpg";kurz\nA;2;;;${longUrl};;\n`;
    const { records, errors, warnings } = mapCsvRows(parseCsv(csv, { maxCellLength: 200000 }));
    assert.deepEqual(errors, []);
    assert.deepEqual(records.map(r => [r.volume_number, r.cover_image, r.images, r.notes]), [
        ['1', null, JSON.stringify(['/uploads/b.jpg']), 'kurz'],
        ['2', null, null, null]
    ]);
    assert.deepEqual(records[0].series_meta, { total_volumes: 7 });
    assert.deepEqual(warnings.map(w => w.line), [2, 2, 2, 3]);
    assert.match(warnings[0].message, /„Beschreibung“ \(maximal 10000 Zeichen\) wird ignoriert/);
    assert.match(warnings[1].message, /^Ungültiger Wert „data:image\/png;base6…“ in „Band-Cover“ \(maximal 2048 Zeichen\) wird ignoriert$/);
    assert.match(warnings[2].message, /„Bilder“ \(maximal 2048 Zeichen je Bild\)/);
    assert.match(warnings[3].message, /„Band-Cover“/);

    const many = Array.from({ length: 51 }, (_, i) => `/uploads/${i}.jpg`).join(' | ');
    const tooMany = mapCsvRows(parseCsv(`Reihe;Bandnummer;Bilder\nB;1;${many}`));
    assert.deepEqual([tooMany.errors, tooMany.records[0].images], [[], null]);
    assert.match(tooMany.warnings[0].message, /„51 Bilder“ in „Bilder“ \(maximal 50\)/);

    const junk = mapCsvRows(parseCsv(`Reihe;Bandnummer;Extra\nC;1;${'z'.repeat(MAX_CELL_LENGTH + 1)}`));
    assert.match(junk.errors[0].message, /Zelle ist zu lang/, 'other columns keep the whole-row limit');
});

test('Verworfene Zeilen tragen ihre Reihenfelder in series_source', () => {
    const csv = 'Reihe;Reihenverlag;Bandnummer;Preis;Typ;Reihenstatus;Gesamtbände;Manga-Passion-ID\n'
        + 'A;Carlsen;1;teuer;;Abgeschlossen;7;42\nA;Carlsen;2;;;;;\nB;;1;;Unsinn;Pausiert;;\nC;;;5;;Laufend;3;\n';
    const { records, errors } = mapCsvRows(parseCsv(csv));
    assert.deepEqual(records.map(r => [r.series, r.volume_number]), [['A', '2']]);
    assert.deepEqual(errors.map(e => e.line), [2, 4, 5]);
    assert.deepEqual(errors[0].series_source, {
        line: 2, series: 'A', series_publisher: 'Carlsen', series_meta: { status: 'Abgeschlossen', total_volumes: 7, manga_passion_id: 42 }
    });
    assert.equal(errors[0].record.volume_number, '1');
    assert.deepEqual([errors[1].series_source.series_meta, errors[1].record], [{ status: 'Pausiert' }, undefined]);
    assert.deepEqual(errors[2].series_source.series_meta, { status: 'Laufend', total_volumes: 3 });
    assert.deepEqual(Object.keys(errors[0]), ['line', 'message'], 'the response shape of an error stays { line, message }');
});

test('Bandnummer "Band 5" wird beim Import wie bei POST /volumes zu "5"', () => {
    const { records } = mapCsvRows(parseCsv('Reihe;Bandnummer;Typ\nA;Band 5;\nA;Bd. 6;\nA;Band 7;Schuber\nA;Bandit;'));
    assert.deepEqual(records.map(r => [r.volume_number, r.type]), [['5', 'volume'], ['6', 'volume'], ['Band 7', 'schuber'], ['Bandit', 'volume']]);
});

test('Besitzer- und Leser-Zellen sind begrenzt; "Gelesen von" wird gelesen und exportiert', () => {
    const many = Array.from({ length: 51 }, (_, i) => `n${i}`).join(',');
    const { records, errors } = mapCsvRows(parseCsv(`Reihe;Bandnummer;Gelesen von;Besitzer\nA;1;;"${many}"\nA;2;"${'x'.repeat(1001)}";\nA;3;"bob, ann";ann`));
    assert.deepEqual(errors.map(e => e.line), [2, 3]);
    assert.match(errors[0].message, /Besitzer/);
    assert.match(errors[1].message, /Gelesen von/);
    assert.equal(records[0].readers_raw, 'bob, ann');
    assert.deepEqual(COLUMNS.slice(-2).map(c => c[1]), ['Gelesen von', 'Besitzer']);
    assert.ok(COLUMNS.some(c => c[1] === 'Reihen-Wunsch'));
});

test('Sammelstatus: nach Reihenstatus, nur auf der ersten Zeile; Import ohne Rücksicht auf Groß-/Kleinschreibung, sonst Hinweis', () => {
    const keys = COLUMNS.map(c => c[0]);
    assert.equal(keys.indexOf('series_collecting'), keys.indexOf('series_status') + 1);
    assert.ok(SERIES_DETAIL_KEYS.includes('series_collecting'));
    assert.deepEqual(COLLECTING_STATUSES, require('../core/handlers/mangas').COLLECTING_STATUSES);
    const { records, warnings, errors } = mapCsvRows(parseCsv('Reihe;Bandnummer;Sammelstatus\nA;1;Pausiert\nB;1;ABGEBROCHEN\nC;1;vielleicht\nD;1;\n'));
    assert.deepEqual(errors, []);
    assert.deepEqual(records.map(r => r.series_meta.collecting), ['pausiert', 'abgebrochen', undefined, undefined]);
    assert.deepEqual(warnings, [{ line: 4, message: 'Ungültiger Wert „vielleicht“ in „Sammelstatus“ (aktiv, pausiert, abgebrochen) wird ignoriert' }]);
});

test('Import-/Export-Route: Rundläufe, Unicode, Besitzer, Probelauf', async (t) => {
    const ctx = await startTestServer();
    const { db } = require('../db');
    const admin = ctx.client();
    const exportCsv = async () => (await fetch(ctx.base + '/export/csv', { headers: { Cookie: admin.cookie } })).text();
    const titles = async () => (await admin('GET', '/mangas')).body.map(m => m.title).sort();
    const wipe = () => db.exec('DELETE FROM mangas;');
    try {
        assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);

        await t.test('Grundablauf: Rechte, Probelauf, Doppelte, Export', async () => {
            const visitor = ctx.client();
            await admin('POST', '/users', { username: 'vis', password: 'password123', role: 'visitor' });
            await visitor('POST', '/auth/login', { username: 'vis', password: 'password123' });
            const csv = 'Reihe;Verlag;Bandnummer;Status;Preis\nNaruto;Carlsen;1;Vorhanden;6,95\nNaruto;Carlsen;2;Fehlt;6,95\nNaruto;Carlsen;1;Vorhanden;6,95\n';

            assert.equal((await visitor('POST', '/import/csv', { csv })).status, 403);
            const dry = await admin('POST', '/import/csv', { csv, dry_run: true });
            assert.equal(dry.body.created_volumes, 2);
            assert.equal((await admin('GET', '/mangas')).body.length, 0);

            const real = await admin('POST', '/import/csv', { csv });
            assert.equal(real.body.created_series, 1);
            assert.equal(real.body.created_volumes, 2);
            assert.equal(real.body.skipped_existing, 1);
            const again = await admin('POST', '/import/csv', { csv });
            assert.equal(again.body.created_volumes, 0);
            const list = (await admin('GET', '/mangas')).body;
            assert.equal(list[0].owned_volumes, 1);

            const res = await fetch(ctx.base + '/export/csv', { headers: { Cookie: admin.cookie } });
            assert.equal(res.status, 200);
            assert.match(res.headers.get('content-type'), /text\/csv/);
            assert.ok((await res.text()).includes('Naruto;Carlsen'));
        });

        const addSeries = async (title, extra = {}) => (await admin('POST', '/mangas', { title, ...extra })).body.id;
        const addVolume = async (mangaId, volume) => {
            const res = await admin('POST', '/volumes', { manga_id: mangaId, ...volume });
            assert.equal(res.status, 200, JSON.stringify(res.body));
        };

        await t.test('Umlaut-Titel werden beim erneuten Import wiedererkannt', async () => {
            wipe();
            await addVolume(await addSeries('Übel Blatt'), { volume_number: '1' });
            await addVolume(await addSeries('Ōoku'), { volume_number: '1' });
            const csv = await exportCsv();
            for (const dry_run of [true, false]) {
                const res = (await admin('POST', '/import/csv', { csv, dry_run })).body;
                assert.deepEqual([res.created_series, res.created_volumes, res.skipped_existing, res.errors], [0, 0, 2, []]);
            }
            const lower = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nübel blatt;1\nÜbel Blatt;1\n  ŌOKU ;1' })).body;
            assert.deepEqual([lower.created_series, lower.created_volumes, lower.skipped_existing], [0, 0, 3]);
            assert.deepEqual(await titles(), ['Ōoku', 'Übel Blatt'].sort());
        });

        await t.test('Gleich normalisierte Titel: Bände gehen an die ältere Reihe', async () => {
            wipe();
            const first = await addSeries('Ärger');
            await addSeries('  ärger ');
            const res = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nÄRGER;1' })).body;
            assert.equal(res.created_series, 0);
            assert.equal(db.prepare('SELECT manga_id FROM volumes').get().manga_id, first);
        });

        await t.test('Formelzeichen-Titel überstehen Export und Import', async () => {
            wipe();
            await addVolume(await addSeries('+Anima'), { volume_number: '1', notes: '-Leseprobe' });
            await addVolume(await addSeries('=SUM(A1)'), { volume_number: '1' });
            const csv = await exportCsv();
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual([res.created_series, res.created_volumes, res.skipped_existing], [0, 0, 2]);
            wipe();
            await admin('POST', '/import/csv', { csv });
            assert.deepEqual(await titles(), ['+Anima', '=SUM(A1)']);
            assert.equal(db.prepare('SELECT notes FROM volumes WHERE notes IS NOT NULL').get().notes, '-Leseprobe');
        });

        await t.test('Jahres-Datum, ISBN, Wunschliste und leere Reihen überstehen den Rundlauf', async () => {
            wipe();
            const id = await addSeries('Rundlauf', { publisher: 'Carlsen Manga' });
            await addVolume(id, {
                volume_number: '1', release_date: '2025', purchase_date: '2023', isbn: '9783551745811',
                status: 'Fehlt', priority: 2, target_price: 5.5, release_year: 2025, price: 7.999
            });
            await addVolume(id, { volume_number: '2', publisher: 'Egmont Manga' });
            await addSeries('Leere Reihe', { publisher: 'Hayabusa' });
            const csv = await exportCsv();
            assert.ok(csv.includes('978-3551745811'));
            wipe();
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual(res.errors, []);
            assert.deepEqual([res.created_series, res.created_volumes], [2, 2]);
            const vols = db.prepare('SELECT * FROM volumes ORDER BY volume_number').all();
            assert.deepEqual(
                [vols[0].release_date, vols[0].purchase_date, vols[0].isbn, vols[0].priority, vols[0].target_price, vols[0].release_year, vols[0].price, vols[0].publisher],
                ['2025', '2023', '9783551745811', 2, 5.5, 2025, 8, null]
            );
            assert.equal(vols[1].publisher, 'Egmont Manga');
            const series = db.prepare('SELECT title, publisher FROM mangas ORDER BY title').all();
            assert.deepEqual(series.map(s => [s.title, s.publisher]), [['Leere Reihe', 'Hayabusa'], ['Rundlauf', 'Carlsen Manga']]);
            const again = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual([again.created_series, again.created_volumes, again.skipped_existing], [0, 0, 3]);
        });

        await t.test('Gleichnamige Reihen werden über den Reihenverlag unterschieden', async () => {
            wipe();
            await addVolume(await addSeries('Naruto', { publisher: 'Carlsen' }), { volume_number: '1' });
            await addVolume(await addSeries('Naruto', { publisher: 'Carlsen Massiv' }), { volume_number: '1' });
            const csv = await exportCsv();
            wipe();
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual([res.created_series, res.created_volumes, res.skipped_existing], [2, 2, 0]);
            const again = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual([again.created_series, again.created_volumes, again.skipped_existing], [0, 0, 2]);
        });

        await t.test('dry_run als Text', async () => {
            wipe();
            for (const dry_run of ['true', true, '1']) {
                const res = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nDry;1', dry_run })).body;
                assert.equal(res.dry_run, true);
            }
            assert.deepEqual(await titles(), []);
            for (const [i, dry_run] of [['false', 'false'], ['0', '0'], ['ohne', undefined]]) {
                const res = (await admin('POST', '/import/csv', { csv: `Reihe;Bandnummer\nDry ${i};1`, dry_run })).body;
                assert.equal(res.dry_run, false);
                assert.equal(res.created_volumes, 1);
            }
        });

        await t.test('Gelesen: Besitzer aus der Spalte, Lese-Eintrag, zählt als vorhanden', async () => {
            wipe();
            const before = (await admin('GET', '/stats')).body.summary.total_owned_volumes;
            const csv = 'Reihe;Bandnummer;Status;Preis;Besitzer\nGelesenReihe;1;Gelesen;8;admin\n';
            await admin('POST', '/import/csv', { csv, dry_run: true });
            assert.equal(db.prepare('SELECT count(*) AS c FROM volume_reads').get().c, 0);
            await admin('POST', '/import/csv', { csv });
            const vol = db.prepare('SELECT id, status FROM volumes').get();
            assert.equal(vol.status, 'Vorhanden');
            const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
            assert.deepEqual(db.prepare('SELECT user_id FROM volume_owners WHERE volume_id = ?').all(vol.id).map(r => r.user_id), [adminId]);
            assert.deepEqual(db.prepare('SELECT user_id FROM volume_reads WHERE volume_id = ?').all(vol.id).map(r => r.user_id), [adminId]);
            assert.equal((await admin('GET', '/stats')).body.summary.total_owned_volumes, before + 1);
        });

        await t.test('Probelauf schreibt auch in vorhandene Reihen nichts', async () => {
            wipe();
            await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Status;Besitzer\nProbe;1;Vorhanden;admin\n' });
            const counts = () => ({
                volumes: db.prepare('SELECT count(*) AS c FROM volumes').get().c,
                owners: db.prepare('SELECT count(*) AS c FROM volume_owners').get().c,
                reads: db.prepare('SELECT count(*) AS c FROM volume_reads').get().c,
                mangas: db.prepare('SELECT count(*) AS c FROM mangas').get().c
            });
            const before = counts();
            const dry = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Status;Besitzer\nProbe;2;Gelesen;admin\nNeu;1;Vorhanden;admin\n', dry_run: true })).body;
            assert.equal(dry.dry_run, true);
            assert.equal(dry.created_volumes, 2);
            assert.deepEqual(counts(), before);
        });

        await t.test('Typ-Erkennung beim Import und Altdaten ohne Typ', async () => {
            wipe();
            const res = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Notizen\nTypen;4;\nTypen;4;Limited Edition\nTypen;Schuber 1;' })).body;
            assert.deepEqual([res.created_volumes, res.skipped_existing], [3, 0]);
            assert.equal(db.prepare("SELECT type FROM volumes WHERE volume_number = 'Schuber 1'").get().type, 'schuber');
            const again = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nTypen;Schuber 1' })).body;
            assert.equal(again.skipped_existing, 1);
            const id = db.prepare("SELECT id FROM mangas WHERE title = 'Typen'").get().id;
            db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, 'Schuber 2', 'Fehlt', 'volume')").run(id);
            const legacy = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nTypen;Schuber 2' })).body;
            assert.deepEqual([legacy.created_volumes, legacy.skipped_existing], [0, 1]);
        });

        await t.test('Besitzer mit Komma im Namen und unbekannte Besitzer', async () => {
            wipe();
            const insertUser = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'editor')");
            const anna = Number(insertUser.run('Anna').lastInsertRowid);
            insertUser.run('Ben');
            const annaBen = Number(insertUser.run('Anna, Ben').lastInsertRowid);
            const res = (await admin('POST', '/import/csv', {
                csv: 'Reihe;Bandnummer;Besitzer\nKomma;1;"Anna, Ben"\nKomma;2;"Anna, Ben| anna |Niemand"\n'
            })).body;
            assert.deepEqual(res.warnings, [{ line: 3, message: 'Unbekannter Besitzer „Niemand“ (ignoriert)' }]);
            const owners = (num) => db.prepare(`SELECT vo.user_id FROM volume_owners vo JOIN volumes v ON v.id = vo.volume_id
                WHERE v.volume_number = ? ORDER BY vo.user_id`).all(num).map(r => r.user_id);
            assert.deepEqual(owners('1'), [annaBen]);
            assert.deepEqual(owners('2'), [anna, annaBen]);

            const csv = await exportCsv();
            wipe();
            await admin('POST', '/import/csv', { csv });
            assert.deepEqual(owners('1'), [annaBen]);
        });

        await t.test('Fehlerhafte Zeilen vorhandener Bände zählen als übersprungen', async () => {
            wipe();
            const id = await addSeries('Alt');
            db.prepare("INSERT INTO volumes (manga_id, volume_number, status, release_date, type) VALUES (?, '1', 'Fehlt', '2024-13-45', 'volume')").run(id);
            const res = (await admin('POST', '/import/csv', { csv: await exportCsv(), dry_run: true })).body;
            assert.deepEqual([res.skipped_existing, res.errors], [1, []]);
            const fresh = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Kaufdatum\nNeu;1;2024-13-45' })).body;
            assert.deepEqual(fresh.errors.map(e => e.line), [2]);
            assert.deepEqual(Object.keys(fresh.errors[0]), ['line', 'message']);
        });

        await t.test('Nicht geschlossenes Anführungszeichen: 400, nichts importiert', async () => {
            wipe();
            for (const dry_run of [true, false]) {
                const res = await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Notizen\nA;1;"kaputt\nA;2;ok\n', dry_run });
                assert.equal(res.status, 400);
                assert.match(res.body.error, /Zeile 2/);
            }
            assert.deepEqual(await titles(), []);
        });

        await t.test('Ungültiger Preis ändert den Sammlungswert nicht', async () => {
            wipe();
            const res = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Preis\nTeuer;1;1e9' })).body;
            assert.equal(res.created_volumes, 0);
            assert.equal(res.errors.length, 1);
            assert.ok((await admin('GET', '/stats')).body.owner_stats.every(o => o.total_value < 1e6));
        });

        await t.test('Besitzer-Zelle mit vielen unbekannten Namen blockiert den Server nicht', async () => {
            wipe();
            const names = Array.from({ length: 49 }, (_, i) => `x${i}`).join(',');
            const rows = Array.from({ length: 400 }, (_, i) => `Viele;${i + 1};"${names}"`);
            const started = Date.now();
            const res = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Besitzer\n' + rows.join('\n'), dry_run: true })).body;
            assert.ok(Date.now() - started < 1500, `Import dauerte ${Date.now() - started} ms`);
            assert.equal(res.created_volumes, 400);
            // je Zeile höchstens fünf Hinweise plus eine Zusammenfassung
            assert.equal(res.warnings.filter(w => w.line === 2).length, 6);
            assert.match(res.warnings.filter(w => w.line === 2)[5].message, /und 44 weitere/);
            const tooMany = Array.from({ length: 1600 }, () => 'x').join(',');
            const big = (await admin('POST', '/import/csv', { csv: `Reihe;Bandnummer;Besitzer\nViele;1;"${tooMany}"` })).body;
            assert.equal(big.created_volumes, 0);
            assert.match(big.errors[0].message, /Besitzer/);
        });

        await t.test('Zu viele Zeilen oder Spalten: 400, bevor alles eingelesen ist', async () => {
            wipe();
            const rows = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\n' + 'a;1\n'.repeat(20001), dry_run: true }));
            assert.equal(rows.status, 400);
            assert.match(rows.body.error, /Zu viele Zeilen \(maximal 20000\)/);
            const cells = await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nA;1' + ';'.repeat(200000), dry_run: true });
            assert.equal(cells.status, 400);
            assert.match(cells.body.error, /zu viele Spalten/);
            assert.deepEqual(await titles(), []);
        });

        await t.test('"Band 5" neben vorhandenem "5" ist kein neuer Band', async () => {
            wipe();
            await addVolume(await addSeries('Kanon'), { volume_number: '5' });
            const res = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Status\nKanon;Band 5;Fehlt\nKanon;Bd. 6;Fehlt\nKanon;Band 6;Fehlt' })).body;
            assert.deepEqual([res.created_volumes, res.skipped_existing], [1, 2]);
            assert.deepEqual(db.prepare('SELECT volume_number FROM volumes ORDER BY volume_number').all().map(v => v.volume_number), ['5', '6']);
        });

        await t.test('Editoren tragen nur sich selbst als Besitzer und Leser ein', async () => {
            wipe();
            if (!db.prepare("SELECT 1 FROM users WHERE username = 'csved'").get()) {
                assert.equal((await admin('POST', '/users', { username: 'csved', password: 'password123', role: 'editor' })).status, 200);
            }
            const editor = ctx.client();
            assert.equal((await editor('POST', '/auth/login', { username: 'csved', password: 'password123' })).status, 200);
            const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
            const edId = db.prepare("SELECT id FROM users WHERE username = 'csved'").get().id;
            const res = (await editor('POST', '/import/csv', {
                csv: 'Reihe;Bandnummer;Status;Gelesen von;Besitzer\nRechte;1;Gelesen;;admin\nRechte;2;Vorhanden;admin;"admin, csved"\n'
            })).body;
            // Zeile 2 nennt nur einen anderen Besitzer: Fehler der Zeile statt den Editor einzusetzen
            assert.equal(res.created_volumes, 1);
            assert.deepEqual(res.errors, [{ line: 2, message: 'Besitz anderer Benutzer kann nur ein Admin importieren' }]);
            assert.ok(res.warnings.some(w => w.line === 3 && /nur ein Admin/.test(w.message)));
            const usersOf = (table, num) => db.prepare(`SELECT t.user_id FROM ${table} t JOIN volumes v ON v.id = t.volume_id
                WHERE v.volume_number = ? ORDER BY t.user_id`).all(num).map(r => r.user_id);
            assert.equal(db.prepare("SELECT count(*) AS c FROM volumes WHERE volume_number = '1'").get().c, 0);
            assert.deepEqual(usersOf('volume_owners', '2'), [edId]);
            assert.deepEqual(usersOf('volume_reads', '2'), []);
            assert.ok(!usersOf('volume_owners', '1').includes(adminId));

            const asAdmin = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Gelesen von;Besitzer\nRechte;3;csved;admin\n' })).body;
            assert.deepEqual(asAdmin.warnings, []);
            assert.deepEqual(usersOf('volume_owners', '3'), [adminId]);
            assert.deepEqual(usersOf('volume_reads', '3'), [edId]);
        });

        await t.test('Lese-Einträge überstehen Export und Import', async () => {
            wipe();
            const id = await addSeries('Gelesen Rundlauf');
            await addVolume(id, { volume_number: '1' });
            await addVolume(id, { volume_number: '2', status: 'Fehlt' });
            const [v1, v2] = db.prepare('SELECT id FROM volumes WHERE manga_id = ? ORDER BY volume_number').all(id).map(v => v.id);
            assert.equal((await admin('POST', `/volumes/${v1}/read`, { read: true })).status, 200);
            const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
            db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)').run(v2, adminId);
            const csv = await exportCsv();
            assert.ok(csv.split('\r\n')[0].endsWith(';Gelesen von;Besitzer'));
            wipe();
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual(res.errors, []);
            const reads = db.prepare(`SELECT v.volume_number, vr.user_id FROM volume_reads vr JOIN volumes v ON v.id = vr.volume_id
                ORDER BY v.volume_number`).all();
            assert.deepEqual(reads.map(r => [r.volume_number, r.user_id]), [['1', adminId], ['2', adminId]]);
        });

        await t.test('Export sortiert Bände nach Nummer wie bisher; Import hält mangas.owned_volumes ohne eigenes Nachzählen', async () => {
            wipe();
            const id = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Sortierung')").run().lastInsertRowid);
            for (const n of ['10', 'Schuber 1', '2', '12.5', '0', 'Band 3']) {
                db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, ?, 'Fehlt', ?)").run(id, n, n.startsWith('Schuber') ? 'schuber' : 'volume');
            }
            const rows = (await exportCsv()).split('\r\n').slice(1).filter(Boolean).map(line => parseCsv(line)[0]);
            const header = parseCsv((await exportCsv()).split('\r\n')[0])[0];
            const numberCol = header.findIndex(h => /Bandnummer/i.test(h));
            assert.deepEqual(rows.map(r => r[numberCol]), ['0', 'Schuber 1', '2', 'Band 3', '10', '12.5']);

            const csv = 'Reihe;Bandnummer;Status\nZähler;1;Vorhanden\nZähler;2;Vorhanden\nZähler;3;Fehlt\n';
            assert.equal((await admin('POST', '/import/csv', { csv })).body.created_volumes, 3);
            const stored = db.prepare("SELECT owned_volumes FROM mangas WHERE title = 'Zähler'").get().owned_volumes;
            assert.equal(stored, 2);
            assert.equal((await admin('GET', '/mangas')).body.find(m => m.title === 'Zähler').owned_volumes, stored);
        });

        await t.test('Lange Notizen: Schreiben begrenzt, Export und Import einer maximalen Notiz klappen, zu lange Zellen nur als Zeilenfehler', async () => {
            wipe();
            const id = await addSeries('Notizen Rundlauf');
            const tooLong = await admin('POST', '/volumes', { manga_id: id, volume_number: '1', notes: 'x'.repeat(MAX_NOTES_LENGTH + 1) });
            assert.equal(tooLong.status, 400);
            assert.equal(tooLong.body.error, 'Notizen sind zu lang (maximal 10000 Zeichen)');
            const maxNote = ',='.repeat(MAX_NOTES_LENGTH / 2);
            await addVolume(id, { volume_number: '1', notes: maxNote });
            const volId = db.prepare('SELECT id FROM volumes WHERE manga_id = ?').get(id).id;
            assert.equal((await admin('PUT', `/volumes/${volId}`, { notes: 'y'.repeat(MAX_NOTES_LENGTH + 1) })).status, 400);
            assert.equal((await admin('PUT', `/volumes/${volId}`, { notes: maxNote, price: 7 })).status, 200);

            const csv = await exportCsv();
            wipe();
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual(res.errors, []);
            assert.equal(res.created_volumes, 1);
            assert.equal(db.prepare('SELECT notes FROM volumes').get().notes, maxNote);

            wipe();
            const mixed = await admin('POST', '/import/csv', { csv: `Reihe;Bandnummer;Notizen\nLang;1;${'n'.repeat(MAX_NOTES_LENGTH + 5)}\nLang;2;kurz\n` });
            assert.equal(mixed.status, 200);
            assert.equal(mixed.body.created_volumes, 1);
            assert.deepEqual(mixed.body.errors.map(e => e.line), [2]);
        });

        await t.test('Große Datei mit vielen Reihen bleibt schnell', async () => {
            wipe();
            const insertManga = db.prepare('INSERT INTO mangas (title, description) VALUES (?, ?)');
            const insertVol = db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, ?, 'Fehlt', 'volume')");
            db.exec('BEGIN');
            for (let i = 0; i < 1500; i++) {
                const id = Number(insertManga.run(`Reihe ${i}`, 'x'.repeat(500)).lastInsertRowid);
                for (let n = 1; n <= 4; n++) insertVol.run(id, String(n));
            }
            db.exec('COMMIT');
            const lines = ['Reihe;Bandnummer'];
            for (let i = 0; i < 5000; i++) lines.push(`Reihe ${i % 1500};${(i % 4) + 1}`);
            const started = Date.now();
            const res = (await admin('POST', '/import/csv', { csv: lines.join('\n'), dry_run: true })).body;
            assert.equal(res.skipped_existing, 5000);
            assert.ok(Date.now() - started < 1500, `Import dauerte ${Date.now() - started} ms`);
        });

        await t.test('Verlustfreier Rundlauf: Reihenfelder, Wunschreihe, Bandpriorität, Zielpreis, Cover, Bilder, MP-IDs', async () => {
            wipe();
            await addSeries('Wunschreihe', {
                publisher: 'Carlsen Manga', wish_priority: 3, status: 'Geplant', total_volumes: 12, alt_title: 'Wish',
                tags: 'Action, Drama', description: 'Zeile 1\nZeile 2; mit Semikolon', cover_image: '/uploads/w.jpg',
                manga_passion_id: 4711, language: 'Englisch', collecting: 'pausiert'
            });
            const full = await addSeries('Vollreihe', { publisher: 'Egmont Manga', wish_priority: 1, total_volumes: 3 });
            await addVolume(full, { volume_number: '1', status: 'Fehlt', priority: 2, target_price: '4,50', price: 7 });
            await addVolume(full, { volume_number: '2', status: 'Vorhanden', cover_image: '/uploads/c2.jpg', images: ['/uploads/c2.jpg', '/uploads/b.jpg'] });
            db.prepare('UPDATE volumes SET manga_passion_volume_id = 99 WHERE manga_id = ? AND volume_number = ?').run(full, '1');
            await addSeries('Ohne Wunsch');

            const snapshot = () => ({
                series: db.prepare(`SELECT title, publisher, language, status, alt_title, tags, total_volumes, description, cover_image,
                    banner_image, manga_passion_id, wish_priority, collecting FROM mangas ORDER BY title`).all(),
                volumes: db.prepare(`SELECT m.title, v.volume_number, v.type, v.status, v.price, v.priority, v.target_price, v.cover_image,
                    v.images, v.manga_passion_volume_id FROM volumes v JOIN mangas m ON m.id = v.manga_id ORDER BY m.title, v.volume_number`).all()
            });
            const before = snapshot();
            const csv = await exportCsv();
            const lines = csv.split('\r\n');
            assert.ok(lines[0].includes(';Reihen-Wunsch;Reihenstatus;Sammelstatus;Gesamtbände;'));
            assert.ok(lines[0].endsWith(';Gelesen von;Besitzer'));
            const header = parseCsv(lines[0])[0];
            const rows = parseCsv(csv).slice(1);
            const col = (name) => header.indexOf(name);
            const wishRow = rows.find(r => r[0] === 'Wunschreihe');
            assert.deepEqual([wishRow[col('Typ')], wishRow[col('Bandnummer')], wishRow[col('Status')], wishRow[col('Reihen-Wunsch')]], ['Reihe', '', '', '3']);
            const fullRows = rows.filter(r => r[0] === 'Vollreihe');
            assert.deepEqual(fullRows.map(r => r[col('Reihen-Wunsch')]), ['1', '1'], 'the wish is repeated on every row of the series');
            assert.deepEqual(fullRows.map(r => r[col('Gesamtbände')]), ['3', ''], 'other series fields only on the first row');
            assert.equal(wishRow[col('Sammelstatus')], 'pausiert');
            assert.deepEqual(fullRows.map(r => r[col('Sammelstatus')]), ['', ''], 'aktiv is exported empty');
            assert.equal(fullRows[1][col('Bilder')], '/uploads/c2.jpg | /uploads/b.jpg');

            wipe();
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual(res.errors, []);
            assert.deepEqual(res.warnings, []);
            assert.deepEqual([res.created_series, res.created_volumes], [3, 2]);
            assert.deepEqual(snapshot(), before);
            const list = (await admin('GET', '/mangas')).body;
            // Vollreihe keeps its wish_priority but owns a volume, so it is no wished series any more
            assert.deepEqual(list.filter(m => m.wished).map(m => m.title), ['Wunschreihe']);
        });

        await t.test('Reihen-Zeile setzt den Wunsch einer vorhandenen Reihe; alte CSVs ohne neue Spalten bleiben gültig', async () => {
            wipe();
            const id = await addSeries('Vorhanden', { status: 'Laufend' });
            const dry = (await admin('POST', '/import/csv', { csv: 'Reihe;Typ;Bandnummer;Reihen-Wunsch;Reihenstatus\nVorhanden;Reihe;;2;Abgeschlossen\n', dry_run: true })).body;
            assert.deepEqual([dry.updated_series, dry.created_series], [1, 0]);
            assert.equal(db.prepare('SELECT wish_priority FROM mangas WHERE id = ?').get(id).wish_priority, null);
            const real = (await admin('POST', '/import/csv', { csv: 'Reihe;Typ;Bandnummer;Reihen-Wunsch;Reihenstatus\nVorhanden;Reihe;;2;Abgeschlossen\n' })).body;
            assert.equal(real.updated_series, 1);
            const row = db.prepare('SELECT wish_priority, status FROM mangas WHERE id = ?').get(id);
            assert.deepEqual([row.wish_priority, row.status], [2, 'Laufend'], 'only the wish of an existing series changes');
            const same = (await admin('POST', '/import/csv', { csv: 'Reihe;Typ;Bandnummer;Reihen-Wunsch\nVorhanden;Reihe;7;2\n' })).body;
            assert.deepEqual([same.updated_series, same.skipped_existing, same.created_volumes], [0, 1, 0]);
            assert.deepEqual(same.warnings.map(w => w.line), [2], 'a volume number in a series row is ignored with a hint');

            const old = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Status;Priorität;Zielpreis\nAlt;1;Fehlt;3;5\n' })).body;
            assert.deepEqual([old.created_series, old.created_volumes, old.errors], [1, 1, []]);
            const alt = db.prepare("SELECT m.wish_priority, v.priority, v.target_price FROM mangas m JOIN volumes v ON v.manga_id = m.id WHERE m.title = 'Alt'").get();
            assert.deepEqual([alt.wish_priority, alt.priority, alt.target_price], [null, 3, 5]);

            const bad = (await admin('POST', '/import/csv', { csv: 'Reihe;Bandnummer;Reihen-Wunsch;Reihenstatus;Gesamtbände\nFalsch;1;9;Irgendwas;x\n' })).body;
            assert.deepEqual([bad.created_volumes, bad.errors], [1, []]);
            assert.equal(bad.warnings.length, 3);
            const falsch = db.prepare("SELECT wish_priority, status, total_volumes FROM mangas WHERE title = 'Falsch'").get();
            assert.deepEqual([falsch.wish_priority, falsch.status, falsch.total_volumes], [null, 'Laufend', null]);
        });

        await t.test('Rundlauf mit langem data:-Cover, langer Cover-URL und 20-kB-Beschreibung: Bände und Reihenfelder bleiben', async () => {
            wipe();
            const a = await addSeries('Lange Felder', { total_volumes: 7, status: 'Abgeschlossen', manga_passion_id: 42, tags: 'Drama' });
            db.prepare('UPDATE mangas SET description = ?, cover_image = ? WHERE id = ?')
                .run('Beschreibung '.repeat(1600), 'data:image/jpeg;base64,' + 'B'.repeat(40000), a);
            const dataCover = 'data:image/png;base64,' + 'A'.repeat(30000);
            await addVolume(a, { volume_number: '1', status: 'Vorhanden', cover_image: dataCover });
            await addVolume(a, { volume_number: '2', status: 'Fehlt' });
            const b = await addSeries('Lange URL', { total_volumes: 3, status: 'Abgeschlossen', manga_passion_id: 43 });
            await addVolume(b, { volume_number: '1', status: 'Vorhanden', cover_image: 'https://img.example.org/' + 'x'.repeat(2100) });
            await addVolume(b, { volume_number: '2', status: 'Vorhanden', cover_image: '/uploads/b2.jpg' });
            assert.ok(db.prepare('SELECT length(description) AS n FROM mangas WHERE id = ?').get(a).n > 20000);

            const csv = await exportCsv();
            wipe();
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual(res.errors, []);
            assert.deepEqual([res.created_series, res.created_volumes], [2, 4]);
            const series = db.prepare('SELECT title, status, total_volumes, manga_passion_id, tags, description, cover_image FROM mangas ORDER BY title').all();
            assert.deepEqual(series.map(m => ({ ...m })), [
                { title: 'Lange Felder', status: 'Abgeschlossen', total_volumes: 7, manga_passion_id: 42, tags: 'Drama', description: null, cover_image: null },
                { title: 'Lange URL', status: 'Abgeschlossen', total_volumes: 3, manga_passion_id: 43, tags: null, description: null, cover_image: null }
            ]);
            const volumes = db.prepare('SELECT m.title, v.volume_number, v.cover_image, v.images FROM volumes v JOIN mangas m ON m.id = v.manga_id ORDER BY m.title, v.volume_number').all();
            assert.deepEqual(volumes.map(v => [v.title, v.volume_number, v.cover_image, v.images]), [
                ['Lange Felder', '1', null, null], ['Lange Felder', '2', null, null],
                ['Lange URL', '1', null, null], ['Lange URL', '2', '/uploads/b2.jpg', JSON.stringify(['/uploads/b2.jpg'])]
            ]);
            const ignored = res.warnings.map(w => w.message.match(/in „([^“]+)“/)[1]);
            assert.deepEqual(ignored.sort(), ['Band-Cover', 'Band-Cover', 'Beschreibung', 'Bilder', 'Bilder', 'Reihen-Cover']);
        });

        await t.test('Reihenfelder einer verworfenen ersten Zeile gehen nicht verloren', async () => {
            wipe();
            const csv = 'Reihe;Bandnummer;Preis;Reihenstatus;Gesamtbände;Manga-Passion-ID\nErste kaputt;1;viel;Abgeschlossen;5;77\nErste kaputt;2;;;;\n';
            const res = (await admin('POST', '/import/csv', { csv })).body;
            assert.deepEqual(res.errors.map(e => e.line), [2]);
            assert.equal(res.created_volumes, 1);
            const m = db.prepare("SELECT status, total_volumes, manga_passion_id FROM mangas WHERE title = 'Erste kaputt'").get();
            assert.deepEqual({ ...m }, { status: 'Abgeschlossen', total_volumes: 5, manga_passion_id: 77 });
        });
    } finally {
        await ctx.close();
    }
});
