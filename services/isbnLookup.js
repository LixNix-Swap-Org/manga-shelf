// ISBN lookup: book metadata from DNB / K10plus / Google Books and the match against the user's collection.
const https = require('https');
const { normalizePublisher } = require('../utils/publishers');
const { titleKey } = require('./mangaPassion/classify');
const log = require('../utils/logger').child('isbn-lookup');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** GET a text document over HTTPS (timeout, size limit, HTTP errors rejected). */
function fetchTextHttps(url, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'MangaShelf/2.0' } }, (res) => {
            if (res.statusCode >= 300) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                data += chunk;
                if (data.length > MAX_BODY_BYTES) {
                    req.destroy();
                    reject(new Error('Antwort zu groß'));
                }
            });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error('Timeout'));
        });
    });
}

// MARC 21 wraps a leading article that is ignored when sorting in two control characters ("Der Herr"): DNB does this
// for "Der", "Die", "Das", "The", "A" ... They must never reach a title, a comparison or the screen.
const stripMarcControls = (text) => text.replace(/[-]/g, '');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return XML_ENTITIES[e.toLowerCase()];
    });
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

    // Series and volume number live in 800/490 ("One piece", 60) while 245$a is the volume's own title ("Mein kleiner Bruder!")
    const fieldsOf = (tag) => record.match(new RegExp(`<datafield[^>]*tag="${tag}"[^>]*>[\\s\\S]*?<\\/datafield>`, 'g')) || [];
    const subOf = (fieldXml, code) => {
        const m = fieldXml.match(new RegExp(`<subfield[^>]*code="${code}"[^>]*>([^<]+)<\\/subfield>`));
        return m ? stripMarcControls(decodeXmlEntities(m[1])).trim() : null;
    };
    let series = null;
    let seriesNumber = null;
    for (const f of fieldsOf('800')) {
        const t = subOf(f, 't');
        if (t) { series = t.replace(/\s*[/:;,.]\s*$/, ''); seriesNumber = subOf(f, 'v'); break; }
    }
    if (!series) {
        for (const f of fieldsOf('490')) {
            const a = subOf(f, 'a');
            const v = subOf(f, 'v');
            if (a && v) { series = a.replace(/\s*[/:;,.]\s*$/, ''); seriesNumber = v; break; }
        }
    }
    const seriesNumberOnly = seriesNumber ? (seriesNumber.match(/\d+(\.\d+)?/) || [null])[0] : null;

    let title = getField('245', 'a');
    if (title) title = title.replace(/\s*[/:]\s*$/, '').trim();

    // the structured series number (800/490 $v) wins; 245$n is free text ("Band 12.", "2021,16" = year, volume)
    let volumeNumber = seriesNumberOnly;
    if (!volumeNumber) {
        const raw = getField('245', 'n');
        if (raw) {
            const yearAndNumber = raw.match(/^\s*(?:19|20)\d{2}\s*[,;.]\s*(\d+(?:\.\d+)?)/);
            const firstNumber = raw.match(/\d+(\.\d+)?/);
            if (yearAndNumber) volumeNumber = yearAndNumber[1];
            else if (firstNumber) volumeNumber = firstNumber[0];
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

    const releaseYearRaw = getField('264', 'c') || getField('260', 'c');
    let releaseYear = null;
    if (releaseYearRaw) {
        const yMatch = releaseYearRaw.match(/\d{4}/);
        if (yMatch) releaseYear = parseInt(yMatch[0], 10);
    }

    const pagesRaw = getField('300', 'a');
    let pages = null;
    if (pagesRaw) {
        const pMatch = pagesRaw.match(/(\d+)/);
        if (pMatch) pages = parseInt(pMatch[1], 10);
    }

    const priceRaw = getField('020', 'c');
    let price = null;
    if (priceRaw) {
        const eurMatch = priceRaw.match(/EUR\s*([\d,.]+)/i);
        if (eurMatch) price = parseFloat(eurMatch[1].replace(',', '.'));
    }

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

function bookFromGoogleBooks(gbData, cleanIsbn) {
    if (!gbData.items || gbData.items.length === 0) return null;
    const vi = gbData.items[0].volumeInfo || {};
    const numMatch = (vi.title || '').match(/(\d+)$/);

    let year = null;
    if (vi.publishedDate) {
        const yMatch = vi.publishedDate.match(/\d{4}/);
        if (yMatch) year = parseInt(yMatch[0], 10);
    }

    return {
        title: vi.title || 'Unbekannter Titel',
        volume_number: numMatch ? numMatch[1] : '1',
        volume_number_known: Boolean(numMatch),
        series: null,
        subtitle: vi.subtitle || null,
        author: vi.authors && vi.authors.length > 0 ? vi.authors.join(', ') : null,
        publisher: vi.publisher ? normalizePublisher(vi.publisher) : null,
        release_year: year,
        pages: vi.pageCount || null,
        price: null,
        source: 'Google Books',
        cover_url: vi.imageLinks?.thumbnail ? vi.imageLinks.thumbnail.replace('http://', 'https://') : `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`
    };
}

/** DNB -> K10plus -> Google Books; the first source with a result wins. `fetchText` is injectable for tests. */
async function lookupBookByIsbn(cleanIsbn, { fetchText = fetchTextHttps } = {}) {
    const isbn = encodeURIComponent(cleanIsbn);

    try {
        const xml = await fetchText(`https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=isbn%3D${isbn}&recordSchema=MARC21-xml&maximumRecords=1`, 6000);
        const book = parseMarc21Xml(xml, cleanIsbn, 'DNB (Deutsche Nationalbibliothek)');
        if (book) return book;
    } catch (err) {
        log.warn('DNB request failed or timed out:', err.message);
    }

    try {
        const xml = await fetchText(`https://sru.k10plus.de/opac-de-627?version=1.1&operation=searchRetrieve&recordSchema=marcxml&maximumRecords=1&query=pica.isb%3D${isbn}`, 6000);
        const book = parseMarc21Xml(xml, cleanIsbn, 'K10plus (Gemeinsamer Bibliotheksverbund)');
        if (book) return book;
    } catch (err) {
        log.warn('K10plus request failed or timed out:', err.message);
    }

    try {
        const text = await fetchText(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`, 6000);
        const book = bookFromGoogleBooks(JSON.parse(text), cleanIsbn);
        if (book) return book;
    } catch (err) {
        log.warn('Google Books request failed:', err.message);
    }
    return null;
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

const MIN_LEAD = 15;
const VOLUME_COLUMNS = 'id, manga_id, volume_number, status, isbn, price, publisher, pages, release_year';

/**
 * Finds the series / volume of the collection a book belongs to.
 *  1. the same ISBN on a stored volume (certain),
 *  2. otherwise the best title match, only if it clearly stands out; then the volume by number, but only when the
 *     catalogue really knew the number (a placeholder "1" must not report "you already own volume 1").
 * Returns { manga, volume, reason: 'isbn' | 'title' | null, candidates }.
 */
function matchCollection(db, book, isbn13) {
    const byIsbn = isbn13 ? db.prepare(`SELECT ${VOLUME_COLUMNS} FROM volumes WHERE isbn = ? ORDER BY id LIMIT 1`).get(isbn13) : null;
    if (byIsbn) {
        const manga = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas WHERE id = ?').get(byIsbn.manga_id);
        return { manga: manga || null, volume: byIsbn, reason: 'isbn', candidates: [] };
    }

    const scored = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas').all()
        .map(m => ({ manga: m, score: titleMatchScore([book.series, book.title], m) }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);
    const [top, second] = scored;
    if (!top || (top.score < 100 && second && top.score - second.score < MIN_LEAD)) {
        return { manga: null, volume: null, reason: null, candidates: scored.slice(0, 3).map(s => s.manga) };
    }

    let volume = null;
    if (book.volume_number_known) {
        volume = db.prepare(`
            SELECT ${VOLUME_COLUMNS} FROM volumes
            WHERE manga_id = ? AND LOWER(TRIM(volume_number)) = LOWER(?) AND COALESCE(type, 'volume') = 'volume'
            ORDER BY id LIMIT 1
        `).get(top.manga.id, String(book.volume_number).trim()) || null;
    }
    return { manga: top.manga, volume, reason: 'title', candidates: [] };
}

module.exports = { stripMarcControls, fetchTextHttps, parseMarc21Xml, lookupBookByIsbn, matchCollection, titleMatchScore, decodeXmlEntities };
