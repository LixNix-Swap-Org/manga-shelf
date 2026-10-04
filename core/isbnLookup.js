// ISBN lookup: book metadata from DNB / K10plus / Google Books (ctx.http.fetchText) and the match against the user's
// collection.
const { normalizePublisher } = require('./lib/publishers');
const { normalizeIsbn } = require('./lib/isbn');
const { titleKey } = require('./mangaPassion/classify');
const { credentialsOf } = require('./sources/credentials');

const log = (ctx) => ctx.log.child('isbn-lookup');

// MARC 21 wraps a leading article that is ignored when sorting in two control characters ("Der Herr"): DNB does this
// for "Der", "Die", "Das", "The", "A" ... They must never reach a title, a comparison or the screen.
const stripMarcControls = (text) => text.replace(/[-]/g, '');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const HTML_ENTITIES = {
    ...XML_ENTITIES, nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    laquo: '«', raquo: '»', bdquo: '„', sbquo: '‚', middot: '·', bull: '•', times: '×', copy: '©', reg: '®', trade: '™'
};

// one pass only, so "&amp;lt;" becomes "&lt;" and not "<"; unknown named entities stay as they are
function decodeEntities(text, named) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
        const lower = e.toLowerCase();
        return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : m;
    });
}
const decodeXmlEntities = (text) => decodeEntities(text, XML_ENTITIES);
const decodeHtmlEntities = (text) => decodeEntities(text, HTML_ENTITIES);

/** "05" -> "5", "05.5" -> "5.5"; "0", "0.5" and anything not purely numeric stay as they are. */
function normalizeVolumeNumber(value) {
    if (value === undefined || value === null) return value;
    const s = String(value).trim();
    return /^\d+(\.\d+)?$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}

const numberIn = (text) => {
    const m = text ? text.match(/\d+(\.\d+)?/) : null;
    return m ? normalizeVolumeNumber(m[0]) : null;
};

function parsePages(raw) {
    if (!raw) return null;
    const counted = raw.match(/(\d+)\]?\s*(?:ungez(?:ählte|\.)?\s*)?(?:S\.|Seiten|p\.|pages)/i);
    if (counted) return parseInt(counted[1], 10);
    // "1 Online-Ressource", "1 Band (unpaginiert)": a count of units, not of pages
    const first = raw.match(/(\d+)\s*([^\s\d(]*)/);
    if (!first || /^(online|b[aä]nd|bd\b|bd\.)/i.test(first[2])) return null;
    return parseInt(first[1], 10);
}

function parseYear(raw) {
    if (!raw) return null;
    const m = raw.replace(/[[\]?]/g, '').match(/(?:1[5-9]|20)\d{2}/);
    return m ? parseInt(m[0], 10) : null;
}

/** "EUR 9,99", "kart. : DM 9.95, EUR 5.09", "7,00 EUR", "EUR 1.234,56" -> number. */
function parseEuroPrice(raw) {
    if (!raw) return null;
    const m = raw.match(/EUR\s*(\d[\d.,]*)/i) || raw.match(/(\d[\d.,]*)\s*(?:EUR|€)/i);
    if (!m) return null;
    let n = m[1].replace(/[.,]+$/, '');
    if (n.includes(',') && n.includes('.')) {
        const decimal = n.lastIndexOf(',') > n.lastIndexOf('.') ? ',' : '.';
        n = n.split(decimal === ',' ? '.' : ',').join('').replace(',', '.');
    } else {
        n = n.replace(',', '.');
    }
    const value = parseFloat(n);
    return Number.isFinite(value) ? value : null;
}

/**
 * Book data from a MARC21-XML answer. Only the first record is read (a search can return several, e.g. paperback and
 * e-book, and mixing their fields would give a Frankenstein book); XML entities are decoded ("&amp;" -> "&").
 */
function parseMarc21Xml(xml, cleanIsbn, sourceName) {
    if (!xml || !xml.includes('<recordData>') && !xml.includes('<record>') && !/<record\b/.test(xml)) return null;
    const record = (xml.match(/<record\b[^>]*>[\s\S]*?<\/record>/) || [xml])[0];

    const getField = (tag, code) => {
        const fieldRegex = new RegExp(`<datafield[^>]*tag="${tag}"[^>]*>[\\s\\S]*?<\\/datafield>`, 'g');
        const matches = record.match(fieldRegex) || [];
        for (const f of matches) {
            const subRegex = new RegExp(`<subfield[^>]*code="${code}"[^>]*>([^<]+)<\\/subfield>`);
            const subMatch = f.match(subRegex);
            if (subMatch) return stripMarcControls(decodeXmlEntities(subMatch[1])).trim();
        }
        return null;
    };

    // Series and volume number live in 800/830/490 ("One piece", 60) while 245$a is the volume's own title ("Mein kleiner Bruder!")
    const fieldsOf = (tag) => record.match(new RegExp(`<datafield[^>]*tag="${tag}"[^>]*>[\\s\\S]*?<\\/datafield>`, 'g')) || [];
    const subOf = (fieldXml, code) => {
        const m = fieldXml.match(new RegExp(`<subfield[^>]*code="${code}"[^>]*>([^<]+)<\\/subfield>`));
        return m ? stripMarcControls(decodeXmlEntities(m[1])).trim() : null;
    };
    const seriesFields = (tag, nameCode) => fieldsOf(tag)
        .map(f => ({ name: subOf(f, nameCode), number: numberIn(subOf(f, 'v')) }))
        .filter(c => c.name);
    const series800 = seriesFields('800', 't');
    // DNB lists story arcs ("Marine Ford") and genres ("Action") without a number next to the numbered main series:
    // the series and its number always come from the same numbered field; an unnumbered 800 is only the last resort
    const chosenSeries = [...series800, ...seriesFields('830', 'a'), ...seriesFields('490', 'a')].find(c => c.number)
        || series800[0] || null;
    const series = chosenSeries ? chosenSeries.name.replace(/\s*[/:;,.]\s*$/, '') : null;
    const seriesNumberOnly = chosenSeries ? chosenSeries.number : null;

    let title = getField('245', 'a');
    if (title) title = title.replace(/\s*[/:]\s*$/, '').trim();

    // the structured series number (800/830/490 $v) wins; 245$n is free text ("Band 12.", "2021,16" = year, volume)
    let volumeNumber = seriesNumberOnly;
    if (!volumeNumber) {
        const raw = getField('245', 'n');
        if (raw) {
            const yearAndNumber = raw.match(/^\s*(?:19|20)\d{2}\s*[,;.]\s*(\d+(?:\.\d+)?)/);
            volumeNumber = yearAndNumber ? normalizeVolumeNumber(yearAndNumber[1]) : numberIn(raw);
        }
    }

    const subtitle = getField('245', 'p');
    let author = getField('100', 'a');
    if (author) {
        const parts = author.split(',').map(s => s.trim());
        if (parts.length === 2) author = `${parts[1]} ${parts[0]}`;
    }

    let publisher = getField('264', 'b') || getField('260', 'b');
    if (publisher) publisher = normalizePublisher(publisher.replace(/\s*;\s*$/, '').trim());

    const releaseYear = parseYear(getField('264', 'c') || getField('260', 'c'));
    const pages = parsePages(getField('300', 'a'));
    const price = priceForIsbn(fieldsOf('020').map(f => ({
        isbn: subOf(f, 'a') || subOf(f, '9'),
        text: [subOf(f, 'c'), subOf(f, 'q')].filter(Boolean).join(' ')
    })), cleanIsbn);

    if (!title) return null;
    return {
        title,
        // "1" is only a placeholder for display; volume_number_known tells whether the catalogue said so
        volume_number: volumeNumber || '1',
        volume_number_known: Boolean(volumeNumber),
        series,
        subtitle,
        author,
        publisher,
        release_year: releaseYear,
        pages,
        price,
        source: sourceName,
        cover_url: `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`
    };
}

/**
 * The price of the scanned book: a record often lists a box set or the other binding in a second 020, so the field
 * whose ISBN is the scanned one wins; a field without an ISBN is used only when no field names this ISBN.
 */
function priceForIsbn(fields, cleanIsbn) {
    const wanted = normalizeIsbn(cleanIsbn);
    const isbnOf = (text) => {
        const m = text ? text.match(/\d[\d-]{8,15}[\dXx]/) : null;
        return m ? normalizeIsbn(m[0].replace(/-/g, '')) : null;
    };
    const priced = fields.map(f => ({ ...f, key: isbnOf(f.isbn), price: parseEuroPrice(f.text) })).filter(f => f.price !== null);
    const own = priced.find(f => f.key && f.key === wanted);
    if (own) return own.price;
    const generic = priced.find(f => !f.key && !/B[aä]nde|Behältnis|Schuber/i.test(f.text));
    return generic ? generic.price : null;
}

const GOOGLE_BOOKS_SOURCE = 'Google Books';
const EXPLICIT_VOLUME = /(?:^|[\s,.:(-])(?:Band|Bd\.?|Vol\.?|Volume)\s*(\d+(?:\.\d+)?)\b/i;

/** Volume number of a Google Books entry: "Band 3" / "Vol. 3" in title or subtitle, the series number, a trailing number. */
function googleVolumeNumber(vi) {
    for (const text of [vi.title, vi.subtitle]) {
        const m = (text || '').match(EXPLICIT_VOLUME);
        if (m) return normalizeVolumeNumber(m[1]);
    }
    const display = String(vi.seriesInfo?.bookDisplayNumber ?? '').trim();
    if (/^\d+(\.\d+)?$/.test(display)) return normalizeVolumeNumber(display);
    const trailing = (vi.title || '').match(/\S\s+(\d+)$/);
    return trailing ? normalizeVolumeNumber(trailing[1]) : null;
}

function bookFromGoogleBooks(gbData, cleanIsbn) {
    if (!gbData.items || gbData.items.length === 0) return null;
    const vi = gbData.items[0].volumeInfo || {};
    const number = googleVolumeNumber(vi);

    let year = null;
    if (vi.publishedDate) {
        const yMatch = vi.publishedDate.match(/\d{4}/);
        if (yMatch) year = parseInt(yMatch[0], 10);
    }

    return {
        title: vi.title || 'Unbekannter Titel',
        volume_number: number || '1',
        volume_number_known: Boolean(number),
        series: null,
        subtitle: vi.subtitle || null,
        author: vi.authors && vi.authors.length > 0 ? vi.authors.join(', ') : null,
        publisher: vi.publisher ? normalizePublisher(vi.publisher) : null,
        release_year: year,
        pages: vi.pageCount || null,
        price: null,
        source: GOOGLE_BOOKS_SOURCE,
        cover_url: vi.imageLinks?.thumbnail ? vi.imageLinks.thumbnail.replace('http://', 'https://') : `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`
    };
}

/** DNB -> K10plus -> Google Books; the first source with a result wins. `fetchText` is injectable for tests. */
async function lookupBookByIsbn(ctx, cleanIsbn, { fetchText = ctx.http.fetchText } = {}) {
    const isbn = encodeURIComponent(cleanIsbn);

    try {
        const xml = await fetchText(`https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=isbn%3D${isbn}&recordSchema=MARC21-xml&maximumRecords=1`, 6000);
        const book = parseMarc21Xml(xml, cleanIsbn, 'DNB (Deutsche Nationalbibliothek)');
        if (book) return book;
    } catch (err) {
        log(ctx).warn('DNB request failed or timed out:', err.message);
    }

    try {
        const xml = await fetchText(`https://sru.k10plus.de/opac-de-627?version=1.1&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=1&query=pica.isb%3D${isbn}`, 6000);
        const book = parseMarc21Xml(xml, cleanIsbn, 'K10plus (Gemeinsamer Bibliotheksverbund)');
        if (book) return book;
    } catch (err) {
        log(ctx).warn('K10plus request failed or timed out:', err.message);
    }

    try {
        const book = bookFromGoogleBooks(JSON.parse(await fetchGoogleBooks(ctx, fetchText, isbn)), cleanIsbn);
        if (book) return book;
    } catch (err) {
        log(ctx).warn('Google Books request failed:', err.message);
    }
    return null;
}

async function googleBooksKey(ctx) {
    try {
        const key = await credentialsOf(ctx).instance('google_books');
        return key && typeof key.secret === 'string' && key.secret ? key.secret : null;
    } catch (err) {
        log(ctx).warn('Google Books key unreadable:', err.message);
        return null;
    }
}

const httpStatusOf = (err) => Number(err && err.status) || Number((/^HTTP (\d{3})\b/.exec(err && err.message) || [])[1]) || 0;

/** The key never reaches a log line, even when a host puts the URL into its error message. */
function withoutKey(err, key) {
    if (err && typeof err.message === 'string') {
        for (const form of [encodeURIComponent(key), key]) err.message = err.message.split(form).join('***');
    }
    return err;
}

/** Tells the credential provider about the instance key's outcome; a provider failure never breaks the lookup. */
async function reportKey(ctx, ok, message) {
    try {
        const creds = credentialsOf(ctx);
        if (ok) await creds.used(null, 'google_books', true);
        else await creds.failed(null, 'google_books', message);
    } catch (err) {
        log(ctx).warn('Google Books key state not saved:', err && err.message);
    }
}

/**
 * With the instance key when one is set; a key Google refuses (400/403) is marked as failed (last_error, so it is not
 * sent again) and the request is repeated once without it.
 */
async function fetchGoogleBooks(ctx, fetchText, isbn) {
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
    const key = await googleBooksKey(ctx);
    if (!key) return fetchText(url, 6000);
    let text;
    try {
        text = await fetchText(`${url}&key=${encodeURIComponent(key)}`, 6000);
    } catch (err) {
        const status = httpStatusOf(err);
        if (status !== 400 && status !== 403) throw withoutKey(err, key);
        log(ctx).warn(`Google Books refused the instance key (HTTP ${status}); it is switched off, retrying without it`);
        await reportKey(ctx, false, `Google Books lehnt den Schlüssel ab (HTTP ${status})`);
        return fetchText(url, 6000);
    }
    await reportKey(ctx, true);
    return text;
}

/**
 * How well a catalogue title (or the catalogue's series name, e.g. "One piece" for the volume "Mein kleiner Bruder!") fits a
 * series (0 - 100): 100 = same words, otherwise the shorter title must appear in the
 * longer one on word boundaries (and be at least 4 letters), weighted by how much of the longer title it covers; as a
 * weaker fallback all (at least two) words of the shorter title appear somewhere in the longer one.
 * "Berserk" fits "Berserk Deluxe", "One" does not fit "One Piece" by accident.
 */
function titleMatchScore(bookTitles, manga) {
    let best = 0;
    for (const bookTitle of [].concat(bookTitles)) {
        const book = titleKey(bookTitle);
        if (!book) continue;
        for (const raw of [manga.title, manga.alt_title]) {
            const key = titleKey(raw);
            if (!key) continue;
            if (key === book) return 100;
            const [short, long] = key.length <= book.length ? [key, book] : [book, key];
            if (short.length >= 4 && (` ${long} `).includes(` ${short} `)) {
                best = Math.max(best, Math.round(80 * short.length / long.length));
            } else {
                // own short names ("Behemoth Kätzchen" for a long German title): at least two words, all of them in the title
                const shortWords = short.split(' ').filter(w => w.length >= 4);
                const longWords = new Set(long.split(' '));
                if (shortWords.length >= 2 && shortWords.length === short.split(' ').length && shortWords.every(w => longWords.has(w))) {
                    best = Math.max(best, Math.round(50 * short.length / long.length));
                }
            }
        }
    }
    return best;
}

/**
 * Which kind of exact hit a series is (higher = closer): the book title is the series title (4), the catalogue series is
 * the series title (3), the book title (2) or the catalogue series (1) is its alternative title, no exact hit (0).
 */
function exactMatchRank(book, manga) {
    const bookTitle = titleKey(book.title);
    const bookSeries = titleKey(book.series);
    const title = titleKey(manga.title);
    const alt = titleKey(manga.alt_title);
    if (title && title === bookTitle) return 4;
    if (title && title === bookSeries) return 3;
    if (alt && alt === bookTitle) return 2;
    if (alt && alt === bookSeries) return 1;
    return 0;
}

const MIN_LEAD = 15;
const VOLUME_COLUMNS = 'id, manga_id, volume_number, status, isbn, price, publisher, pages, release_year';

/**
 * Finds the series / volume of the collection a book belongs to.
 *  1. the same ISBN on a stored volume (certain),
 *  2. otherwise the best title match, only if it clearly stands out; exact hits are ranked (own title before alternative
 *     title, then the publisher) and a remaining tie gives candidates instead of a guess; then the volume by number,
 *     but only when the catalogue really knew the number (a placeholder "1" must not report "you already own volume 1").
 * Returns { manga, volume, reason: 'isbn' | 'title' | null, candidates, number_in_title }; number_in_title = the
 * Google Books number is part of the series name ("Eyeshield 21"), so the volume number is in fact unknown.
 */
function matchCollection(db, book, isbn13) {
    const byIsbn = isbn13 ? db.prepare(`SELECT ${VOLUME_COLUMNS} FROM volumes WHERE isbn = ? ORDER BY id LIMIT 1`).get(isbn13) : null;
    if (byIsbn) {
        const manga = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas WHERE id = ?').get(byIsbn.manga_id);
        return { manga: manga || null, volume: byIsbn, reason: 'isbn', candidates: [], number_in_title: false };
    }

    const bookPublisher = normalizePublisher(book.publisher);
    const scored = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas ORDER BY id').all()
        .map(m => ({
            manga: m,
            score: titleMatchScore([book.series, book.title], m),
            rank: exactMatchRank(book, m),
            samePublisher: bookPublisher && normalizePublisher(m.publisher) === bookPublisher ? 1 : 0
        }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score || b.rank - a.rank || b.samePublisher - a.samePublisher);
    const [top, second] = scored;
    const unclear = top && second && (top.score < 100
        ? top.score - second.score < MIN_LEAD
        : second.score === 100 && second.rank === top.rank && second.samePublisher === top.samePublisher);
    if (!top || unclear) {
        return { manga: null, volume: null, reason: null, candidates: scored.slice(0, 3).map(s => s.manga), number_in_title: false };
    }

    const numberInTitle = book.source === GOOGLE_BOOKS_SOURCE && book.volume_number_known &&
        [top.manga.title, top.manga.alt_title].some(t => {
            const key = titleKey(t);
            return key && key === titleKey(book.title) && normalizeVolumeNumber(key.split(' ').pop()) === normalizeVolumeNumber(book.volume_number);
        });

    let volume = null;
    if (book.volume_number_known && !numberInTitle) {
        // "05" and "5" are the same volume, also for numbers stored before the catalogue numbers were normalised
        const wanted = String(normalizeVolumeNumber(book.volume_number)).toLowerCase();
        volume = db.prepare(`
            SELECT ${VOLUME_COLUMNS} FROM volumes
            WHERE manga_id = ? AND COALESCE(type, 'volume') = 'volume'
            ORDER BY id
        `).all(top.manga.id).find(v => String(normalizeVolumeNumber(v.volume_number ?? '')).toLowerCase() === wanted) || null;
    }
    return { manga: top.manga, volume, reason: 'title', candidates: [], number_in_title: numberInTitle };
}

module.exports = {
    stripMarcControls, parseMarc21Xml, lookupBookByIsbn, matchCollection, titleMatchScore,
    decodeXmlEntities, decodeHtmlEntities, normalizeVolumeNumber
};
