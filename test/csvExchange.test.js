const test = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, parseCsv, mapCsvRows } = require('../services/csvExchange');
const { startTestServer } = require('./helpers');

test('toCsv/parseCsv Rundlauf mit Semikolon, Anführungszeichen und Umlauten', () => {
    const csv = toCsv([{ series: 'Say "Hi"; Ärger', volume_number: '1', status: 'Vorhanden', price: 7.5, type: 'volume' }]);
    assert.ok(csv.startsWith('﻿Reihe;'));
    const rows = parseCsv(csv);
    assert.equal(rows[1][0], 'Say "Hi"; Ärger');
    assert.equal(rows[1][7], '7,5');
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

test('Import-/Export-Route', async () => {
    const ctx = await startTestServer();
    try {
        const admin = ctx.client();
        const visitor = ctx.client();
        assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
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
    } finally {
        await ctx.close();
    }
});
