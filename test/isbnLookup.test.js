// ISBN lookup chain: catalogue clients, title matching and series matching.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// the match code takes a database: keep it away from the real data folder
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-isbn-lookup-test-'));
process.env.DATA_DIR = dataDir;

const { db, closeDb } = require('../db');
const {
    parseMarc21Xml, stripMarcControls, lookupBookByIsbn, matchCollection, titleMatchScore, decodeXmlEntities, decodeHtmlEntities,
    fetchTextHttps, normalizeVolumeNumber, googleKeyVerdict
} = require('../services/isbnLookup');
const { isValidIsbn } = require('../utils/isbn');

test.after(() => {
    closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

const marc = (fields) => `<searchRetrieveResponse><records><record><recordData><record>${fields}</record></recordData></record></records></searchRetrieveResponse>`;
const field = (tag, subs) => `<datafield tag="${tag}" ind1=" " ind2=" ">${Object.entries(subs).map(([c, v]) => `<subfield code="${c}">${v}</subfield>`).join('')}</datafield>`;

test('isValidIsbn: real ISBN-13 / ISBN-10 pass, wrong check digits and non-book EANs fail', () => {
    assert.equal(isValidIsbn('978-3-551-74581-1'), true);
    assert.equal(isValidIsbn('9783551745811'), true);
    assert.equal(isValidIsbn('3551745811'), true);
    assert.equal(isValidIsbn('080442957X'), true);
    assert.equal(isValidIsbn('9783551745812'), false);   // misread last digit
    assert.equal(isValidIsbn('4901234567894'), false);   // EAN without 978/979
    assert.equal(isValidIsbn('3551745812'), false);
    assert.equal(isValidIsbn(''), false);
    assert.equal(isValidIsbn(null), false);
});

test('decodeXmlEntities: named and numeric entities', () => {
    assert.equal(decodeXmlEntities('Dragon Ball &amp; Co &#39;Z&#39; &#x41; &quot;x&quot; &lt;3'), 'Dragon Ball & Co \'Z\' A "x" <3');
});

test('parseMarc21Xml: reads the fields, decodes entities and marks an unknown volume number', () => {
    const xml = marc(
        field('245', { a: 'Berserk &amp; Friends /', n: 'Band 12.', p: 'Der Titel' }) +
        field('100', { a: 'Miura, Kentaro' }) + field('264', { b: 'Panini Manga ;', c: '2021' }) +
        field('300', { a: '224 Seiten' }) + field('020', { c: 'EUR 9,99' }));
    const book = parseMarc21Xml(xml, '9783551745811', 'DNB');
    assert.equal(book.title, 'Berserk & Friends');
    assert.equal(book.volume_number, '12');
    assert.equal(book.volume_number_known, true);
    assert.equal(book.subtitle, 'Der Titel');
    assert.equal(book.author, 'Kentaro Miura');
    assert.equal(book.publisher, 'Panini Verlags GmbH');
    assert.equal(book.release_year, 2021);
    assert.equal(book.pages, 224);
    assert.equal(book.price, 9.99);

    const noNumber = parseMarc21Xml(marc(field('245', { a: 'Berserk' })), '9783551745811', 'DNB');
    assert.equal(noNumber.volume_number, '1');           // display placeholder only
    assert.equal(noNumber.volume_number_known, false);
    assert.equal(parseMarc21Xml('<x/>', '1', 'DNB'), null);
    assert.equal(parseMarc21Xml(marc(field('100', { a: 'Nur, Autor' })), '1', 'DNB'), null);
});

test('parseMarc21Xml: only the first record is read (no fields mixed in from a second record)', () => {
    const xml = '<searchRetrieveResponse><records>' +
        '<record><recordData><record>' + field('245', { a: 'Erster Titel' }) + '</record></recordData></record>' +
        '<record><recordData><record>' + field('245', { a: 'Zweiter Titel', n: '9' }) + field('264', { b: 'Carlsen' }) + '</record></recordData></record>' +
        '</records></searchRetrieveResponse>';
    const book = parseMarc21Xml(xml, '1', 'DNB');
    assert.equal(book.title, 'Erster Titel');
    assert.equal(book.volume_number_known, false);
    assert.equal(book.publisher, null);
});

test('lookupBookByIsbn: DNB first, then K10plus, then Google Books; null when nobody knows the book', async () => {
    const dnb = marc(field('245', { a: 'Aus DNB', n: '3' }));
    const urls = [];
    const book = await lookupBookByIsbn('9783551745811', { fetchText: async (u) => { urls.push(u); return dnb; } });
    assert.equal(book.title, 'Aus DNB');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /maximumRecords=1/);

    const k10 = await lookupBookByIsbn('9783551745811', { fetchText: async (u) => { if (u.includes('dnb.de')) throw new Error('Timeout'); return marc(field('245', { a: 'Aus K10plus' })); } });
    assert.match(k10.source, /K10plus/);

    const google = await lookupBookByIsbn('9783551745811', {
        fetchText: async (u) => {
            if (u.includes('googleapis')) return JSON.stringify({ items: [{ volumeInfo: { title: 'Berserk 7', authors: ['Kentaro Miura'], publishedDate: '2020-05-01', publisher: 'Panini Manga' } }] });
            return '<empty/>';
        }
    });
    assert.equal(google.source, 'Google Books');
    assert.equal(google.volume_number, '7');
    assert.equal(google.volume_number_known, true);
    assert.equal(google.release_year, 2020);

    assert.equal(await lookupBookByIsbn('9783551745811', { fetchText: async () => { throw new Error('offline'); } }), null);
});

test('titleMatchScore: same words, word-boundary containment, no accidental matches', () => {
    assert.equal(titleMatchScore('Hell\'s Paradise', { title: 'Hells Paradise' }), 100);
    assert.equal(titleMatchScore('ONE-PUNCH MAN', { title: 'One Punch Man' }), 100);
    assert.equal(titleMatchScore('Wan Pīsu', { title: 'One Piece', alt_title: 'Wan Pīsu' }), 100);
    assert.ok(titleMatchScore('Berserk', { title: 'Berserk Deluxe' }) > 0);
    assert.equal(titleMatchScore('One', { title: 'One Piece' }), 0);          // shorter than 4 letters
    assert.equal(titleMatchScore('Magi', { title: 'Magilumiere Inc.' }), 0);  // not on a word boundary
    assert.equal(titleMatchScore('Gantz', { title: 'Dandadan' }), 0);
    assert.equal(titleMatchScore('', { title: 'Dandadan' }), 0);
});

test('matchCollection: the ISBN of a stored volume decides, even when the titles differ', () => {
    const a = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Berserk Deluxe')").run().lastInsertRowid);
    const b = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Berserk')").run().lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status, isbn) VALUES (?, '4', 'Vorhanden', '9783551745811')").run(a);
    const match = matchCollection(db, { title: 'Berserk', volume_number: '12', volume_number_known: true }, '9783551745811');
    assert.equal(match.reason, 'isbn');
    assert.equal(match.manga.id, a);
    assert.equal(match.volume.volume_number, '4');
    assert.notEqual(match.manga.id, b);
});

test('matchCollection: best title wins, ambiguous titles give candidates instead of a guess', () => {
    db.prepare("INSERT INTO mangas (title) VALUES ('Dandadan'), ('Vinland Saga'), ('Vinland Saga Deluxe'), ('Tokyo Ghoul'), ('Tokyo Revengers')").run();
    const exact = matchCollection(db, { title: 'Dandadan', volume_number: '5', volume_number_known: false }, '9780000000001');
    assert.equal(exact.reason, 'title');
    assert.equal(exact.manga.title, 'Dandadan');

    const exactAmongSimilar = matchCollection(db, { title: 'Vinland Saga', volume_number: '5', volume_number_known: false }, '9780000000001');
    assert.equal(exactAmongSimilar.manga.title, 'Vinland Saga');

    // the plain series is the closest fit for a shorter catalogue title ...
    assert.equal(matchCollection(db, { title: 'Vinland', volume_number: '1', volume_number_known: false }, '9780000000001').manga.title, 'Vinland Saga');

    // ... but "Tokyo" fits two series about equally: no guess
    const ambiguous = matchCollection(db, { title: 'Tokyo', volume_number: '1', volume_number_known: false }, '9780000000001');
    assert.equal(ambiguous.manga, null);
    assert.equal(ambiguous.reason, null);
    assert.ok(ambiguous.candidates.length >= 2);

    assert.equal(matchCollection(db, { title: 'Völlig unbekannt', volume_number: '1', volume_number_known: false }, '9780000000001').manga, null);
});

test('matchCollection: the volume is only matched when the catalogue knew the number', () => {
    const id = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Frieren')").run().lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '1', 'Vorhanden')").run(id);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status, type) VALUES (?, '2', 'Vorhanden', 'schuber')").run(id);

    // no number in the catalogue: "you own volume 1" must not be claimed
    const unknown = matchCollection(db, { title: 'Frieren', volume_number: '1', volume_number_known: false }, '9780000000002');
    assert.equal(unknown.manga.id, id);
    assert.equal(unknown.volume, null);

    const known = matchCollection(db, { title: 'Frieren', volume_number: '1', volume_number_known: true }, '9780000000002');
    assert.equal(known.volume.status, 'Vorhanden');

    // a Schuber with the same number is not the volume
    assert.equal(matchCollection(db, { title: 'Frieren', volume_number: '2', volume_number_known: true }, '9780000000002').volume, null);
});

test('parseMarc21Xml: series name and number come from 800 / 490 (the 245 title is the volume title)', () => {
    const xml = marc(
        field('245', { a: 'Mein kleiner Bruder!' }) +
        field('490', { a: 'Marine Ford' }) + field('490', { a: 'One piece', v: '60' }) + field('490', { a: 'Action' }) +
        field('800', { a: 'Oda, Eiichirō', t: 'Marine Ford' }) +
        field('800', { a: 'Oda, Eiichirō', t: 'One piece', v: '60' }));
    const book = parseMarc21Xml(xml, '9783551759863', 'DNB');
    assert.equal(book.title, 'Mein kleiner Bruder!');
    assert.equal(book.series, 'One piece');
    assert.equal(book.volume_number, '60');
    assert.equal(book.volume_number_known, true);

    // only 490 with a volume number counts as the series, "Action" (a genre) does not
    const only490 = parseMarc21Xml(marc(field('245', { a: 'Titel' }) + field('490', { a: 'Action' }) + field('490', { a: 'Reihe X', v: 'Bd. 4' })), '1', 'DNB');
    assert.equal(only490.series, 'Reihe X');
    assert.equal(only490.volume_number, '4');
    assert.equal(parseMarc21Xml(marc(field('245', { a: 'Titel' })), '1', 'DNB').series, null);
});

test('matchCollection: a volume with its own title is found through the catalogue series', () => {
    const id = Number(db.prepare("INSERT INTO mangas (title) VALUES ('One Piece Serientest')").run().lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '60', 'Fehlt')").run(id);
    const match = matchCollection(db, { title: 'Mein kleiner Bruder!', series: 'One Piece Serientest', volume_number: '60', volume_number_known: true }, '9780000000003');
    assert.equal(match.manga.id, id);
    assert.equal(match.volume.status, 'Fehlt');
    assert.equal(titleMatchScore(['One piece', 'Mein kleiner Bruder!'], { title: 'One Piece' }), 100);
});

test('parseMarc21Xml: the non-sorting markers of a leading article are removed (title, series and matching)', () => {
    const NSB = '';
    const NSE = '';
    assert.equal(stripMarcControls(`${NSB}Die${NSE} Tagebücher`), 'Die Tagebücher');
    const book = parseMarc21Xml(marc(field('245', { a: `${NSB}A${NSE} returner's magic should be special` }) + field('800', { t: `${NSB}Der${NSE} Titel`, v: '2' })), '1', 'DNB');
    assert.equal(book.title, "A returner's magic should be special");
    assert.equal(book.series, 'Der Titel');
    assert.ok(titleMatchScore([book.title], { title: "A Returner's Magic" }) > 0);
});

test('parseMarc21Xml: volume number from free text 245$n ("2021,16" = year and volume) and the series number wins over it', () => {
    const num = (n) => parseMarc21Xml(marc(field('245', { a: 'Ajin', n })), '1', 'DNB').volume_number;
    assert.equal(num('2021,16'), '16');
    assert.equal(num('Band 12.'), '12');
    assert.equal(num('3'), '3');
    assert.equal(num('1-3'), '1');
    assert.equal(parseMarc21Xml(marc(field('245', { a: 'Ajin', n: '99' }) + field('800', { t: 'Ajin', v: '16' })), '1', 'DNB').volume_number, '16');
});

test('titleMatchScore: an own short name matches when all its words are in the catalogue title, but weaker', () => {
    const long = 'Ich bin ein mächtiger Behemoth und lebe als Kätzchen bei einer Elfe';
    const loose = titleMatchScore([long], { title: 'Behemoth Kätzchen' });
    assert.ok(loose > 0 && loose < 40, String(loose));
    assert.equal(titleMatchScore([long], { title: 'Behemoth Hund' }), 0);          // not all words
    assert.ok(titleMatchScore([long], { title: 'Elfe' }) < 10);                     // a single word only counts by containment, barely
});

test('parseMarc21Xml: a numbered series field wins over an unnumbered story arc (real One Piece 60 record order)', () => {
    const onePiece = marc(
        field('245', { a: 'Mein kleiner Bruder!' }) +
        field('800', { a: 'Oda, Eiichirō', t: 'Marine Ford' }) +
        field('800', { a: 'Oda, Eiichirō', t: 'One piece', v: '60' }));
    const book = parseMarc21Xml(onePiece, '9783551759863', 'DNB');
    assert.equal(book.series, 'One piece');
    assert.equal(book.volume_number, '60');
    assert.equal(book.volume_number_known, true);

    const id = Number(db.prepare("INSERT INTO mangas (title) VALUES ('One Piece')").run().lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '60', 'Vorhanden')").run(id);
    const match = matchCollection(db, book, '9783551759863');
    assert.equal(match.reason, 'title');
    assert.equal(match.manga.id, id);
    assert.equal(match.volume.volume_number, '60');

    const viaSeries490 = parseMarc21Xml(marc(field('245', { a: 'T' }) + field('800', { t: 'Arc' }) + field('490', { a: 'X', v: '3' })), '1', 'DNB');
    assert.equal(viaSeries490.series, 'X');
    assert.equal(viaSeries490.volume_number, '3');

    const via830 = parseMarc21Xml(marc(field('245', { a: 'T' }) + field('830', { a: 'Uniform series.', v: 'Band 9' })), '1', 'DNB');
    assert.equal(via830.series, 'Uniform series');
    assert.equal(via830.volume_number, '9');

    const onlyArc = parseMarc21Xml(marc(field('245', { a: 'T' }) + field('800', { t: 'Arc' })), '1', 'DNB');
    assert.equal(onlyArc.series, 'Arc');
    assert.equal(onlyArc.volume_number_known, false);

    const arcAnd245n = parseMarc21Xml(marc(field('245', { a: 'T', n: 'Band 7' }) + field('800', { t: 'Arc' })), '1', 'DNB');
    assert.equal(arcAnd245n.volume_number, '7');
    assert.equal(arcAnd245n.volume_number_known, true);
});

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
    });
}
const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

test('fetchTextHttps: a dropped connection, a slow drip and a normal answer all settle', async (t) => {
    const timers = [];
    const { server, url } = await startServer((req, res) => {
        if (req.url === '/drop') {
            res.writeHead(200, { 'Content-Length': '100000' });
            res.write('<partial');
            setTimeout(() => req.socket.destroy(), 20);
        } else if (req.url === '/drip') {
            res.writeHead(200, { 'Content-Length': '100000' });
            timers.push(setInterval(() => res.write('x'), 100));
        } else {
            res.end('<ok/>');
        }
    });
    t.after(async () => { timers.forEach(clearInterval); await closeServer(server); });

    const started = Date.now();
    await assert.rejects(fetchTextHttps(url + 'drop', 5000, { get: http.get }), /abgebrochen|aborted|socket hang up/i);
    assert.ok(Date.now() - started < 2000);

    const dripStart = Date.now();
    await assert.rejects(fetchTextHttps(url + 'drip', 600, { get: http.get }), /Timeout/);
    assert.ok(Date.now() - dripStart < 2000);

    assert.equal(await fetchTextHttps(url, 2000, { get: http.get }), '<ok/>');

    // a catalogue that drops the connection must not stop the chain: K10plus answers
    const book = await lookupBookByIsbn('9783551745811', {
        fetchText: (u, ms) => (u.includes('dnb.de') ? fetchTextHttps(url + 'drop', ms, { get: http.get }) : Promise.resolve(marc(field('245', { a: 'Aus K10plus' }))))
    });
    assert.match(book.source, /K10plus/);
});

test('fetchTextHttps: an error answer keeps "HTTP <status>" and carries the first 4 KB of its body as err.body', async (t) => {
    const reason = JSON.stringify({ error: { code: 403, errors: [{ reason: 'ipRefererBlocked' }], status: 'PERMISSION_DENIED' } });
    const { server, url } = await startServer((req, res) => {
        if (req.url === '/big') {
            res.writeHead(429, { 'Content-Type': 'text/plain' });
            res.end('q'.repeat(20000));
        } else if (req.url === '/empty') {
            res.writeHead(400);
            res.end();
        } else {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(reason);
        }
    });
    t.after(() => closeServer(server));

    const errorOf = (path) => fetchTextHttps(url + path, 2000, { get: http.get }).then(() => assert.fail('resolved'), (err) => err);
    let err = await errorOf('key');
    assert.deepEqual([err.message, err.status, err.body], ['HTTP 403', 403, reason]);
    assert.equal(googleKeyVerdict(err.status, err.body), 'other', 'a referrer block is neither an invalid key nor a quota');
    err = await errorOf('big');
    assert.deepEqual([err.message, err.body.length], ['HTTP 429', 4096]);
    err = await errorOf('empty');
    assert.deepEqual([err.message, err.body], ['HTTP 400', '']);
});

test('parseMarc21Xml: pages, year and price from the common catalogue forms', () => {
    const parse = (fields, isbn = '9783551745811') => parseMarc21Xml(marc(field('245', { a: 'T' }) + fields), isbn, 'DNB');
    const pages = (a) => parse(field('300', { a })).pages;
    assert.equal(pages('1 Online-Ressource (178 S.)'), 178);
    assert.equal(pages('201 Seiten'), 201);
    assert.equal(pages('[96] Seiten'), 96);
    assert.equal(pages('[ca. 200] S.'), 200);
    assert.equal(pages('XII, 190 S.'), 190);
    assert.equal(pages('1 Band (unpaginiert)'), null);
    assert.equal(pages('205'), 205);

    const year = (c) => parse(field('264', { c })).release_year;
    assert.equal(year('[20]23'), 2023);
    assert.equal(year('2021?'), 2021);
    assert.equal(year('[2023]'), 2023);
    assert.equal(year('2023 [erschienen 2022]'), 2023);
    assert.equal(year('©2019'), 2019);

    // the box set is listed first; the scanned ISBN's own field gives the price ($c or K10plus' $q, ISBN-10 or -13)
    const twoFields = (code) =>
        field('020', { a: '9783551745804', [code]: '(Bände 1-12 in Behältnis) Broschur : EUR 85.00 EUR' }) +
        field('020', { a: '978-3-551-74581-1', [code]: 'Broschur : EUR 7.00' });
    assert.equal(parse(twoFields('c')).price, 7);
    assert.equal(parse(twoFields('q')).price, 7);
    assert.equal(parse(twoFields('q'), '3551745811').price, 7);
    assert.equal(parse(field('020', { a: '9783551745804', c: 'EUR 85.00' })).price, null);
    assert.equal(parse(field('020', { a: '9783551745811 (kart.)', c: '7,00 EUR' })).price, 7);
    assert.equal(parse(field('020', { c: 'kart. : DM 9.95, EUR 5.09' })).price, 5.09);
    assert.equal(parse(field('020', { c: 'EUR 1.234,56' })).price, 1234.56);
});

test('Google Books: the volume number is not taken from a series name that ends in a number', async () => {
    const google = (volumeInfo) => lookupBookByIsbn('9783551745811', {
        fetchText: async (u) => (u.includes('googleapis') ? JSON.stringify({ items: [{ volumeInfo }] }) : '<empty/>')
    });
    assert.equal((await google({ title: 'Eyeshield 21, Band 3' })).volume_number, '3');
    assert.equal((await google({ title: 'Eyeshield 21 3' })).volume_number, '3');
    assert.equal((await google({ title: 'Naruto 05' })).volume_number, '5');
    assert.equal((await google({ title: 'Eyeshield 21', subtitle: 'Vol. 4' })).volume_number, '4');
    assert.equal((await google({ title: 'Eyeshield 21', seriesInfo: { bookDisplayNumber: '6' } })).volume_number, '6');

    const id = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Eyeshield 21')").run().lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '21', 'Vorhanden'), (?, '3', 'Fehlt')").run(id, id);
    const bare = await google({ title: 'Eyeshield 21' });
    const bareMatch = matchCollection(db, bare, null);
    assert.equal(bareMatch.manga.id, id);
    assert.equal(bareMatch.volume, null);
    assert.equal(bareMatch.number_in_title, true);

    const third = matchCollection(db, await google({ title: 'Eyeshield 21 3' }), null);
    assert.equal(third.volume.volume_number, '3');
    assert.equal(third.number_in_title, false);

    const kaiju = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Kaiju No. 8')").run().lastInsertRowid);
    const kaijuMatch = matchCollection(db, await google({ title: 'Kaiju No. 8' }), null);
    assert.equal(kaijuMatch.manga.id, kaiju);
    assert.equal(kaijuMatch.number_in_title, true);
});

test('matchCollection: exact ties are ranked (own title, then publisher) and a real tie gives candidates', () => {
    const insert = (title, alt = null, publisher = null) =>
        Number(db.prepare('INSERT INTO mangas (title, alt_title, publisher) VALUES (?, ?, ?)').run(title, alt, publisher).lastInsertRowid);

    const naruto = insert('Naruto');
    const massiv = insert('Naruto Massiv', 'Naruto');
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '5', 'Vorhanden'), (?, '5', 'Fehlt')").run(naruto, massiv);
    const m = matchCollection(db, { title: 'Naruto Massiv', series: 'Naruto', volume_number: '5', volume_number_known: true }, null);
    assert.equal(m.manga.id, massiv);
    assert.equal(m.volume.status, 'Fehlt');

    const deluxe = insert('Gintama Deluxe', 'Gintama');
    const plain = insert('Gintama');
    assert.ok(deluxe < plain);
    assert.equal(matchCollection(db, { title: 'Gintama', volume_number: '1', volume_number_known: false }, null).manga.id, plain);

    insert('Doppeltitel', null, 'Carlsen');
    const panini = insert('Doppeltitel', null, 'Panini Manga');
    const byPublisher = matchCollection(db, { title: 'Doppeltitel', publisher: 'Panini Manga', volume_number: '1', volume_number_known: false }, null);
    assert.equal(byPublisher.manga.id, panini);

    const tie = matchCollection(db, { title: 'Doppeltitel', publisher: 'Egmont', volume_number: '1', volume_number_known: false }, null);
    assert.equal(tie.manga, null);
    assert.equal(tie.reason, null);
    assert.ok(tie.candidates.length >= 2);

    const unique = insert('Einzigartiger Titel');
    const single = matchCollection(db, { title: 'Einzigartiger Titel', volume_number: '1', volume_number_known: false }, null);
    assert.equal(single.manga.id, unique);
    assert.deepEqual(single.candidates, []);
});

test('volume numbers with leading zeros match the stored number', () => {
    assert.equal(normalizeVolumeNumber('05'), '5');
    assert.equal(normalizeVolumeNumber('007'), '7');
    assert.equal(normalizeVolumeNumber('05.5'), '5.5');
    assert.equal(normalizeVolumeNumber('0'), '0');
    assert.equal(normalizeVolumeNumber('0.5'), '0.5');
    assert.equal(normalizeVolumeNumber('5.10'), '5.10');
    assert.equal(normalizeVolumeNumber('Extra'), 'Extra');

    const num = (fields) => parseMarc21Xml(marc(field('245', { a: 'T' }) + fields), '1', 'DNB').volume_number;
    assert.equal(num(field('245', { a: 'T', n: 'Band 05' })), '5');
    assert.equal(num(field('490', { a: 'Reihe', v: '05' })), '5');
    assert.equal(num(field('800', { t: 'Reihe', v: '0' })), '0');

    const padded = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Nullen Reihe')").run().lastInsertRowid);
    const plain = Number(db.prepare("INSERT INTO mangas (title) VALUES ('Ohne Nullen')").run().lastInsertRowid);
    db.prepare("INSERT INTO volumes (manga_id, volume_number, status) VALUES (?, '05', 'Vorhanden'), (?, '5', 'Fehlt')").run(padded, plain);
    assert.equal(matchCollection(db, { title: 'Nullen Reihe', volume_number: '5', volume_number_known: true }, null).volume.volume_number, '05');
    assert.equal(matchCollection(db, { title: 'Ohne Nullen', volume_number: '05', volume_number_known: true }, null).volume.volume_number, '5');
});

test('decodeHtmlEntities: HTML named entities, one pass only, unknown entities kept', () => {
    assert.equal(decodeHtmlEntities('a&mdash;b &hellip; &rsquo;x&rsquo; &amp;lt; &unknown; &#8217;'), 'a—b … ’x’ &lt; &unknown; ’');
    assert.equal(decodeXmlEntities('&mdash;'), '&mdash;');
});

test('Google Books: the instance key goes along, a refused key is switched off and gets one retry without it, the key is never logged', async () => {
    const core = require('../core/isbnLookup');
    const { createCtx } = require('../db');
    const answer = JSON.stringify({ items: [{ volumeInfo: { title: 'Berserk 7', publisher: 'Panini Manga' } }] });
    const lines = [];
    const log = { debug() {}, info() {}, warn: (...args) => lines.push(args.map(String).join(' ')), error() {} };
    log.child = () => log;
    let reports = [];
    const lookup = async (key, google) => {
        const urls = [];
        reports = [];
        const credentials = {
            instance: (provider) => (provider === 'google_books' && key ? { secret: key, fromEnv: true } : null),
            failed: (...args) => reports.push(['failed', ...args]),
            used: (...args) => reports.push(['used', ...args])
        };
        const ctx = createCtx({ log, credentials });
        const book = await core.lookupBookByIsbn(ctx, '9783551745811', {
            fetchText: async (url) => {
                if (!url.includes('googleapis')) return '<empty/>';
                urls.push(url);
                return google(url);
            }
        });
        return { book, urls };
    };

    const keyed = await lookup('geheim+1', async () => answer);
    assert.equal(keyed.book.source, 'Google Books');
    assert.deepEqual(keyed.urls, ['https://www.googleapis.com/books/v1/volumes?q=isbn:9783551745811&key=geheim%2B1']);
    assert.deepEqual(reports, [['used', null, 'google_books', true]]);

    const invalidBody = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } });
    for (const [status, body] of [[400, null], [400, invalidBody], [403, JSON.stringify({ error: { errors: [{ reason: 'keyInvalid' }] } })]]) {
        const refused = await lookup('geheim+1', async (url) => {
            if (url.includes('key=')) throw Object.assign(new Error(`HTTP ${status}`), body ? { body } : {});
            return answer;
        });
        assert.equal(refused.book.title, 'Berserk 7', `HTTP ${status}`);
        assert.equal(refused.urls.length, 2);
        assert.ok(!refused.urls[1].includes('key='));
        assert.deepEqual(reports, [['failed', null, 'google_books', `Google Books lehnt den Schlüssel ab (HTTP ${status})`]], 'the instance key is switched off');
    }

    const down = await lookup('geheim+1', async (url) => { throw new Error(`HTTP 500 for ${url}`); });
    assert.equal(down.book, null);
    assert.equal(down.urls.length, 1, 'only a refused key is retried');
    assert.deepEqual(reports, [], 'a server error says nothing about the key');

    const none = await lookup(null, async () => answer);
    assert.deepEqual(none.urls, ['https://www.googleapis.com/books/v1/volumes?q=isbn:9783551745811']);
    assert.ok(lines.length > 0 && lines.every(line => !line.includes('geheim')), lines.join('\n'));
});

test('Google Books: a quota or rate answer skips the instance key until the daily reset without switching it off', async () => {
    const core = require('../core/isbnLookup');
    const { createCtx } = require('../db');
    const answer = JSON.stringify({ items: [{ volumeInfo: { title: 'Berserk 7' } }] });
    const quota = (reason) => JSON.stringify({ error: { code: 403, message: 'Quota exceeded', errors: [{ reason, domain: 'usageLimits' }] } });
    let reports = [];
    const lookup = async (key, now, google) => {
        const urls = [];
        reports = [];
        const credentials = {
            instance: (provider) => (provider === 'google_books' ? { secret: key } : null),
            failed: (...args) => reports.push(['failed', ...args]),
            used: (...args) => reports.push(['used', ...args])
        };
        const ctx = { ...createCtx({ credentials }), now: () => new Date(now) };
        const book = await core.lookupBookByIsbn(ctx, '9783551745811', {
            fetchText: async (url) => {
                if (!url.includes('googleapis')) return '<empty/>';
                urls.push(url);
                return google(url);
            }
        });
        return { book, urls };
    };
    const keyedOnce = (status, body) => async (url) => {
        if (url.includes('key=')) throw Object.assign(new Error(`HTTP ${status}`), body ? { body } : {});
        return answer;
    };

    let n = 0;
    for (const [status, body] of [[403, quota('dailyLimitExceeded')], [403, quota('userRateLimitExceeded')], [429, quota('rateLimitExceeded')], [403, null]]) {
        const key = `quota-key-${n++}`;
        const start = Date.parse('2026-10-04T12:00:00Z');
        const first = await lookup(key, start, keyedOnce(status, body));
        assert.equal(first.book.title, 'Berserk 7');
        assert.equal(first.urls.length, 2, 'one retry without the key');
        assert.deepEqual(reports, [], `${status} ${body}: the key is not switched off`);
        const later = await lookup(key, start + 60 * 60 * 1000, keyedOnce(status, body));
        assert.deepEqual(later.urls, ['https://www.googleapis.com/books/v1/volumes?q=isbn:9783551745811'], 'skipped for the rest of the day');
        // 2026-10-04 12:00 UTC is 05:00 in California; the quota resets at 07:00 UTC the next day
        const nextDay = await lookup(key, Date.parse('2026-10-05T07:00:01Z'), async () => answer);
        assert.equal(nextDay.urls.length, 1);
        assert.ok(nextDay.urls[0].includes('key='), 'back after the reset');
        assert.deepEqual(reports, [['used', null, 'google_books', true]]);
    }

    assert.equal(core.googleKeyVerdict(400, JSON.stringify({ error: { message: 'Invalid value at q', errors: [{ reason: 'invalid' }] } })), 'other');
    assert.equal(core.googleKeyVerdict(403, JSON.stringify({ error: { errors: [{ reason: 'forbidden' }] } })), 'other');
    assert.equal(core.googleKeyVerdict(403, '<html>blocked</html>'), 'quota');
});

test('Google Books end to end: the real fetchTextHttps hands the error body of a stubbed https.get to the key verdict', async (t) => {
    const https = require('https');
    const { PassThrough } = require('stream');
    const { EventEmitter } = require('events');
    const core = require('../core/isbnLookup');
    const { createCtx } = require('../db');
    const answer = JSON.stringify({ items: [{ volumeInfo: { title: 'Berserk 7' } }] });
    let keyed = null;
    const realGet = https.get;
    https.get = (url, options, callback) => {
        const req = new EventEmitter();
        req.setTimeout = () => req;
        req.destroy = () => {};
        setImmediate(() => {
            const res = new PassThrough();
            const refused = String(url).includes('key=') ? keyed : null;
            res.statusCode = refused ? refused.status : 200;
            if (!String(url).includes('googleapis')) res.statusCode = 404;
            res.complete = true;
            callback(res);
            res.end(refused ? refused.body : String(url).includes('googleapis') ? answer : '');
        });
        return req;
    };
    t.after(() => { https.get = realGet; });

    const run = async (key, status, body) => {
        keyed = { status, body };
        const reports = [];
        const urls = [];
        const credentials = {
            instance: (provider) => (provider === 'google_books' ? { secret: key } : null),
            failed: (...args) => reports.push(['failed', ...args]),
            used: (...args) => reports.push(['used', ...args])
        };
        const ctx = { ...createCtx({ credentials }), now: () => new Date('2026-10-04T12:00:00Z') };
        const book = await core.lookupBookByIsbn(ctx, '9783551745811', {
            fetchText: (url, ms) => { if (url.includes('googleapis')) urls.push(url); return fetchTextHttps(url, ms); }
        });
        return { book, reports, urls };
    };

    const invalid = await run('e2e-invalid', 403, JSON.stringify({ error: { code: 403, errors: [{ reason: 'keyInvalid' }] } }));
    assert.equal(invalid.book.title, 'Berserk 7');
    assert.deepEqual(invalid.reports, [['failed', null, 'google_books', 'Google Books lehnt den Schlüssel ab (HTTP 403)']], 'the body, not the status, switches the key off');

    const quota = await run('e2e-quota', 403, JSON.stringify({ error: { code: 403, errors: [{ reason: 'dailyLimitExceeded' }] } }));
    assert.deepEqual(quota.reports, []);
    const again = await run('e2e-quota', 200, answer);
    assert.deepEqual(again.urls, ['https://www.googleapis.com/books/v1/volumes?q=isbn:9783551745811'], 'a quota answer skips the key for the day');

    const blocked = await run('e2e-blocked', 403, JSON.stringify({ error: { code: 403, errors: [{ reason: 'ipRefererBlocked' }], status: 'PERMISSION_DENIED' } }));
    assert.deepEqual(blocked.reports, []);
    const next = await run('e2e-blocked', 200, answer);
    assert.ok(next.urls[0].includes('key='), 'a refusal that is neither invalid nor quota does not skip the key');
});
