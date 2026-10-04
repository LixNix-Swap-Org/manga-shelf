// Texts inside 2xx payloads (contract 22 addendum): the German field stays byte for byte, `<field>_msg` carries
// { msg, params } for the client's catalog (parallel arrays for lists whose entry shape is pinned).
const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { startTestServer } = require('./helpers');
const errors = require('../core/errors');
const { mapCsvRows, parseCsv } = require('../core/csvExchange');
const { MANGA_STATUSES } = require('../core/lib/validate');

let ctx;
let admin;
let editor;
let dbm;
let mp;
const realFetch = global.fetch;

test.before(async () => {
    ctx = await startTestServer();
    admin = ctx.client();
    assert.equal((await admin('POST', '/setup', { username: 'admin', password: 'password123' })).status, 200);
    assert.equal((await admin('POST', '/users', { username: 'redakteur', password: 'password123', role: 'editor' })).status, 200);
    editor = ctx.client();
    assert.equal((await editor('POST', '/auth/login', { username: 'redakteur', password: 'password123' })).status, 200);
    dbm = require('../db');
    mp = require('../mangaPassion');
    // catalogues and Manga Passion find nothing; the test server itself stays reachable
    global.fetch = async (url, opts) => (String(url).startsWith(ctx.base) ? realFetch(url, opts) : new Response('', { status: 404 }));
});

test.after(async () => {
    global.fetch = realFetch;
    await ctx.close();
});

const plain = (value) => JSON.parse(JSON.stringify(value));

test('payloadMsg/msgData: German text plus plain { msg, params }, nested messages included', () => {
    const m = errors.msg('Ungültiger Wert „{raw}“ ({hint})', { raw: 'x', hint: errors.msg('{min} bis {max}', { min: 0, max: 3 }) });
    assert.deepEqual(errors.payloadMsg('message', m), {
        message: 'Ungültiger Wert „x“ (0 bis 3)',
        message_msg: { msg: 'Ungültiger Wert „{raw}“ ({hint})', params: { raw: 'x', hint: { msg: '{min} bis {max}', params: { min: 0, max: 3 } } } }
    });
    assert.equal(Object.getPrototypeOf(errors.msgData(m).params.hint), Object.prototype, 'no Msg instance left inside');
    assert.equal(errors.msgData('plain text'), null);
});

test('CSV rows: the German texts stay as before, each row note carries its msg() unseen', () => {
    const header = 'Reihe;Bandnummer;Status;Preis;ISBN;Reihen-Wunsch;Reihenstatus;Bilder';
    const images = Array.from({ length: 60 }, (_, i) => `https://x.example/${i}.jpg`).join('|');
    const { errors: rowErrors, warnings } = mapCsvRows(parseCsv([
        header,
        'A;1;Kaputt;;;;;',
        'A;2;;abc;;;;',
        'A;3;;;9783161484101;7;Irgendwie;',
        `A;4;;;;;;${images}`,
        ';5;;;;;;'
    ].join('\n')));
    assert.deepEqual(rowErrors.map(e => e.message), [
        'Unbekannter Status „Kaputt“', 'Ungültiger Preis „abc“', 'Reihe und Bandnummer sind Pflicht'
    ]);
    assert.deepEqual(warnings.map(w => w.message), [
        'Ungültiger Wert „7“ in „Reihen-Wunsch“ (0 bis 3) wird ignoriert',
        `Ungültiger Wert „Irgendwie“ in „Reihenstatus“ (${MANGA_STATUSES.join(', ')}) wird ignoriert`,
        'ISBN „9783161484101“ ist keine gültige ISBN (wird trotzdem übernommen)',
        'Ungültiger Wert „60 Bilder“ in „Bilder“ (maximal 50) wird ignoriert'
    ]);
    for (const note of [...rowErrors, ...warnings]) {
        assert.deepEqual(Object.keys(note), ['line', 'message']);
        assert.equal(errors.fill(note.message_msg.msg, plainParams(note.message_msg.params)), note.message, 'template and params give the same text');
    }
    assert.deepEqual(warnings[0].message_msg.params, { raw: '7', label: 'Reihen-Wunsch', hint: { msg: '{min} bis {max}', params: { min: 0, max: 3 } } });
    assert.equal(typeof warnings[1].message_msg.params.hint, 'string', 'stored values in a hint stay verbatim: the file must use them');
    assert.deepEqual(warnings[3].message_msg.params.raw, { msg: '{count} Bilder', params: { count: 60 } });
});

// German text of nested { msg, params } params, like the server's fill()
function plainParams(params) {
    const out = {};
    for (const [k, v] of Object.entries(params)) out[k] = v && typeof v === 'object' ? errors.fill(v.msg, plainParams(v.params)) : v;
    return out;
}

test('POST /import/csv: errors_msg and warnings_msg run parallel to errors and warnings after sorting', async () => {
    const csv = [
        'Reihe;Bandnummer;Status;Besitzer;Gelesen von',
        'Payload;2;Kaputt;;',
        'Payload;1;Vorhanden;Niemand;Keiner',
        'Payload;3;Vorhanden;admin;'
    ].join('\n');
    const res = await editor('POST', '/import/csv', { csv, dry_run: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { errors: rowErrors, warnings, errors_msg: errorsMsg, warnings_msg: warningsMsg } = res.body;
    assert.deepEqual(rowErrors, [
        { line: 2, message: 'Unbekannter Status „Kaputt“' },
        { line: 4, message: 'Besitz anderer Benutzer kann nur ein Admin importieren' }
    ]);
    assert.deepEqual(errorsMsg, [
        { msg: 'Unbekannter Status „{status}“', params: { status: 'Kaputt' } },
        { msg: 'Besitz anderer Benutzer kann nur ein Admin importieren', params: {} }
    ]);
    assert.deepEqual(warnings, [
        { line: 3, message: 'Unbekannter Besitzer „Niemand“ (ignoriert)' },
        { line: 3, message: 'Unbekannter Leser „Keiner“ (ignoriert)' }
    ]);
    assert.deepEqual(warningsMsg, [
        { msg: 'Unbekannter Besitzer „{name}“ (ignoriert)', params: { name: 'Niemand' } },
        { msg: 'Unbekannter Leser „{name}“ (ignoriert)', params: { name: 'Keiner' } }
    ]);
});

test('POST /import/csv: the summary of many unknown names keeps its text and count', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `Fremd${i}`).join(', ');
    const res = await admin('POST', '/import/csv', { csv: `Reihe;Bandnummer;Gelesen von\nViele;1;${names}`, dry_run: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.warnings.length, 6);
    assert.deepEqual(res.body.warnings[5], { line: 2, message: '… und 3 weitere Hinweise zu dieser Zeile' });
    assert.deepEqual(res.body.warnings_msg[5], { msg: '… und {count} weitere Hinweise zu dieser Zeile', params: { count: 3 } });
});

test('GET /lookup/isbn without a hit: message unchanged plus message_msg', async () => {
    const { lookupIsbn } = require('../core/handlers/lookup');
    const quiet = { warn() {}, info() {}, error() {}, debug() {} };
    const fake = {
        db: { prepare: () => ({ get: () => undefined }) },
        limit: async () => {},
        http: { fetchText: async () => { throw new Error('offline'); } },
        log: { child: () => quiet },
        user: { id: 1, role: 'admin' }
    };
    const { body } = await lookupIsbn(fake, { query: { isbn: '9783161484100' } });
    assert.equal(body.found, false);
    assert.equal(body.message, 'Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.');
    assert.deepEqual(plain(body.message_msg), { msg: body.message, params: {} });
});

test('Manga Passion payloads: the gap check, the volume count discrepancy and the autofill misses carry message_msg', async () => {
    const { MP_PAYLOAD } = require('../core/mangaPassion/gaps');
    const classify = require('../core/mangaPassion/classify');
    assert.equal(MP_PAYLOAD.unreachable.text, classify.MP_UNREACHABLE_MESSAGE);
    assert.equal(MP_PAYLOAD.editionNotFound.text, classify.MP_EDITION_NOT_FOUND_MESSAGE);

    const edition = 4711;
    const volumes = ['1', '2', '3'].map(n => ({ id: Number(n), num: Number(n), volume_number: n, title: '', price: 8, is_released: true }));
    dbm.db.prepare('INSERT INTO manga_passion_cache (cache_key, json_data, created_at) VALUES (?, ?, ?)')
        .run(`mp_edition_vols_${edition}`, JSON.stringify({ edition: { title: 'Payload-Reihe', publisher: 'Carlsen Manga', total_volumes: 3, author: 'X' }, volumes }), Date.now());
    const id = Number(dbm.db.prepare('INSERT INTO mangas (title, publisher, total_volumes, manga_passion_id) VALUES (?, ?, ?, ?)')
        .run('Payload-Reihe', 'Carlsen Manga', 6, edition).lastInsertRowid);
    const gaps = plain(await mp.reconcileMangaGaps(id));
    assert.equal(gaps.discrepancy.message, 'Deine Sammlung gibt 6 Bände an (oft AniList-Originalzählung). Die deutsche Edition umfasst 3 Bände.');
    assert.deepEqual(gaps.discrepancy.message_msg.params, { db_total: 6, official_total: 3 });

    const missing = plain(await mp.reconcileMangaGaps(id, { edition_id: 999999 }));
    assert.equal(missing.matched, false);
    assert.deepEqual(missing.message_msg, { msg: 'Manga-Passion Edition nicht gefunden oder nicht verfügbar.', params: {} });

    const miss = plain(await mp.lookupVolumeMetadata(null, ''));
    assert.equal(miss.message, 'Keine Daten für "diesen Band" auf Manga Passion gefunden.');
    assert.deepEqual(miss.message_msg, { msg: 'Keine Daten für "{query}" auf Manga Passion gefunden.', params: { query: { msg: 'diesen Band', params: {} } } });
    const missNumber = plain(await mp.lookupVolumeMetadata(null, ' 5 '));
    assert.equal(missNumber.message, 'Keine Daten für "5" auf Manga Passion gefunden.');
    assert.deepEqual(missNumber.message_msg.params, { query: '5' });

    const empty = Number(dbm.db.prepare('INSERT INTO mangas (title, manga_passion_id) VALUES (?, ?)').run('Ohne Bände', 999998).lastInsertRowid);
    const filled = plain(await mp.autofillMangaVolumes(empty));
    assert.equal(filled.success, false);
    assert.equal(typeof filled.message, 'string');
    assert.equal(filled.message, errors.fill(filled.message_msg.msg, filled.message_msg.params));
});

async function uploadZip(buffer, url) {
    const fd = new FormData();
    fd.append('backup', new Blob([buffer], { type: 'application/zip' }), 'backup.zip');
    const res = await realFetch(ctx.base + url, { method: 'POST', headers: { Cookie: admin.cookie }, body: fd });
    const set = res.headers.get('set-cookie');
    if (set && set.startsWith('token=') && !set.startsWith('token=;')) admin.cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
}

test('backups: inspect warnings_msg runs parallel to warnings; restore, delete and a failed check carry their _msg', async (t) => {
    const created = await admin('POST', '/backups/create');
    assert.equal(created.status, 200);
    const name = created.body.snapshot.filename;
    const zip = new AdmZip(require('path').join(ctx.dataDir, 'backups', name));
    const zipped = new AdmZip();
    zipped.addFile('manga.db', zip.getEntry('manga.db').getData());

    const inspected = await uploadZip(zipped.toBuffer(), '/backup/inspect');
    assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
    const { warnings, warnings_msg: warningsMsg } = inspected.body;
    assert.ok(warnings.includes('Alle anderen Sitzungen (andere Geräte und Benutzer) werden beendet.'));
    assert.equal(warningsMsg.length, warnings.length);
    warnings.forEach((w, i) => assert.equal(errors.fill(warningsMsg[i].msg, warningsMsg[i].params), w));

    const done = await admin('POST', `/backup/restore/${inspected.body.staging_id}`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.match(done.body.message, /^Backup erfolgreich eingespielt! \(\d+ Manga-Reihen und 0 Bilddateien wiederhergestellt\)$/);
    assert.deepEqual(done.body.message_msg, {
        msg: 'Backup erfolgreich eingespielt! ({mangas} Manga-Reihen und {images} Bilddateien wiederhergestellt)',
        params: { mangas: done.body.mangaCount, images: 0 }
    });

    const snap = await admin('POST', `/backups/${name}/restore`);
    assert.equal(snap.status, 200, JSON.stringify(snap.body));
    assert.equal(snap.body.message, errors.fill(snap.body.message_msg.msg, snap.body.message_msg.params));
    assert.equal(snap.body.message_msg.params.filename, name);

    const deleted = await admin('DELETE', `/backups/${name}`);
    assert.deepEqual(deleted.body, { success: true, message: 'Snapshot gelöscht', message_msg: { msg: 'Snapshot gelöscht', params: {} } });

    const archive = require('../services/backupArchive');
    t.mock.method(archive, 'verifyArchive', async () => ({ verified: false, error: 'quick_check: kaputt', verified_at: new Date().toISOString() }));
    const failed = await admin('POST', '/backups/create');
    assert.equal(failed.body.warning, 'Der Snapshot wurde erstellt, hat aber die Prüfung nicht bestanden: quick_check: kaputt');
    assert.deepEqual(failed.body.warning_msg, { msg: 'Der Snapshot wurde erstellt, hat aber die Prüfung nicht bestanden: {reason}', params: { reason: 'quick_check: kaputt' } });
});

test('backup inspect: the role is a nested message, more than ten accounts without a password keep the "und N weitere" text', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('fs');
    const path = require('path');
    const created = await admin('POST', '/backups/create');
    const tmp = path.join(ctx.dataDir, 'temp', `payload-${Date.now()}.db`);
    fs.writeFileSync(tmp, new AdmZip(path.join(ctx.dataDir, 'backups', created.body.snapshot.filename)).getEntry('manga.db').getData());
    const d = new DatabaseSync(tmp);
    d.exec("UPDATE users SET role = 'editor' WHERE username = 'admin'");
    d.prepare("INSERT INTO users (username, password_hash, role) VALUES ('chef', ?, 'admin')").run('$2b$10$abcdefghijklmnopqrstuuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0');
    const add = d.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, '!local-profile', 'visitor')");
    for (let i = 0; i < 12; i++) add.run(`ohne${String(i).padStart(2, '0')}`);
    d.close();
    const zipped = new AdmZip();
    zipped.addFile('manga.db', fs.readFileSync(tmp));
    fs.unlinkSync(tmp);

    const res = await uploadZip(zipped.toBuffer(), '/backup/inspect');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { warnings, warnings_msg: warningsMsg } = res.body;
    const role = warnings.findIndex(w => w.includes('kein Administrator'));
    assert.equal(warnings[role], 'Dein Benutzer „admin“ ist im Backup kein Administrator (Rolle: Bearbeiter): Die Backup-Verwaltung ist danach nicht mehr erreichbar.');
    assert.deepEqual(warningsMsg[role].params, { username: 'admin', role: { msg: 'Bearbeiter', params: {} } });
    const names = Array.from({ length: 10 }, (_, i) => `ohne${String(i).padStart(2, '0')}`).join(', ');
    const reset = warnings.findIndex(w => w.includes('Passwort-Reset'));
    assert.equal(warnings[reset], `12 Konten brauchen nach der Wiederherstellung einen Passwort-Reset (kein Passwort in der Sicherung): ${names} und 2 weitere.`);
    assert.deepEqual(warningsMsg[reset].params, { count: 12, names, more: 2 });
    assert.equal((await admin('DELETE', `/backup/restore/${res.body.staging_id}`)).status, 200);
});
