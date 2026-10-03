const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// the match code takes a database: keep it away from the real data folder
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-isbn-lookup-test-'));
process.env.DATA_DIR = dataDir;

const { db, closeDb } = require('../db');
const { parseMarc21Xml, stripMarcControls, lookupBookByIsbn, matchCollection, titleMatchScore, decodeXmlEntities } = require('../services/isbnLookup');
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
