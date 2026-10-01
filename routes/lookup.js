const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { db, uploadsDir } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { upload, ALLOWED_IMAGE_EXTS } = require('../middleware/upload');
const { normalizePublisher } = require('../utils/publishers');
const { searchMangaPassionForLookup } = require('../mangaPassion');

// AniList GraphQL Search Helper
function searchAniList(queryTerm) {
    return new Promise((resolve) => {
        const graphqlQuery = {
            query: `
                query ($search: String) {
                    Page(page: 1, perPage: 5) {
                        media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
                            id
                            title { romaji english native }
                            description(asHtml: false)
                            coverImage { extraLarge large medium }
                            bannerImage
                            status
                            volumes
                            genres
                            staff(perPage: 5) {
                                edges {
                                    role
                                    node { name { full } }
                                }
                            }
                        }
                    }
                }
            `,
            variables: { search: queryTerm.trim() }
        };

        const postData = JSON.stringify(graphqlQuery);
        const options = {
            hostname: 'graphql.anilist.co',
            port: 443,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'MangaShelf/2.8.0'
            }
        };

        const apiReq = https.request(options, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => { data += chunk; });
            apiRes.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const list = parsed.data?.Page?.media || [];
                    const results = list.map(m => {
                        let author = null;
                        if (m.staff?.edges) {
                            const storyOrArt = m.staff.edges.find(e => 
                                e.role?.toLowerCase().includes('story') || 
                                e.role?.toLowerCase().includes('art') || 
                                e.role?.toLowerCase().includes('original creator')
                            );
                            author = storyOrArt ? storyOrArt.node?.name?.full : m.staff.edges[0]?.node?.name?.full;
                        }

                        let status = 'Laufend';
                        if (m.status === 'FINISHED') status = 'Abgeschlossen';
                        else if (m.status === 'HIATUS') status = 'Pausiert';
                        else if (m.status === 'CANCELLED') status = 'Abgebrochen';

                        let cleanDesc = m.description || '';
                        cleanDesc = cleanDesc.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'").trim();

                        return {
                            id: 'al_' + m.id,
                            manga_passion_id: null,
                            source: 'anilist',
                            source_label: '🌐 AniList',
                            title: m.title.english || m.title.romaji,
                            alt_title: m.title.native || m.title.romaji,
                            author: author || null,
                            publisher: null,
                            description: cleanDesc || null,
                            cover_image: m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || null,
                            banner_image: m.bannerImage || null,
                            tags: Array.isArray(m.genres) ? m.genres.join(', ') : null,
                            total_volumes: m.volumes || null,
                            status: status
                        };
                    });
                    resolve(results);
                } catch (e) {
                    resolve([]);
                }
            });
        });

        apiReq.on('error', () => resolve([]));
        apiReq.setTimeout(6000, () => {
            apiReq.destroy();
            resolve([]);
        });
        apiReq.write(postData);
        apiReq.end();
    });
}

// 1. MANGA METADATA LOOKUP (Manga Passion First, AniList Fallback)
router.get('/lookup/manga', requireAuth, async (req, res) => {
    try {
        const queryTerm = req.query.q;
        if (!queryTerm || !queryTerm.trim()) {
            return res.status(400).json({ error: 'Suchbegriff erforderlich' });
        }

        const trimmed = queryTerm.trim();

        // 1. ZUERST: Deutsche Manga Passion API nach offiziellen deutschen Ausgaben durchsuchen
        let mpResults = [];
        try {
            mpResults = await searchMangaPassionForLookup(trimmed);
        } catch (mpErr) {
            console.warn('Manga Passion lookup error:', mpErr.message);
        }

        // 2. AniList als Ergänzung und Fallback
        let aniListResults = [];
        try {
            aniListResults = await searchAniList(trimmed);
        } catch (alErr) {
            console.warn('AniList lookup error:', alErr.message);
        }

        // Manga Passion hat Vorrang (deutsche Verlage, korrekte deutsche Bandzahlen & Cover)
        const combined = [...mpResults, ...aniListResults];
        res.json(combined);
    } catch (err) {
        console.error('Lookup endpoint error:', err);
        res.status(500).json({ error: 'Interner Serverfehler beim Metadaten-Lookup' });
    }
});

// 2. Download remote image (e.g. from AniList) and save locally to data/uploads
router.post('/upload-remote', requireEditor, async (req, res) => {
    try {
        const { url } = req.body;
        if (!url || !url.startsWith('http')) {
            return res.status(400).json({ error: 'Ungültige Bild-URL' });
        }
        const parsedUrl = new URL(url);
        const ext = path.extname(parsedUrl.pathname).toLowerCase() || '.jpg';
        const cleanExt = ALLOWED_IMAGE_EXTS.has(ext) ? ext : '.jpg';
        const filename = Date.now() + '-' + Math.round(Math.random() * 1E9) + cleanExt;
        const targetPath = path.join(uploadsDir, filename);

        const client = parsedUrl.protocol === 'https:' ? https : http;
        const fileStream = fs.createWriteStream(targetPath);

        const fetchReq = client.get(url, { headers: { 'User-Agent': 'MangaShelf/2.0' } }, (imgRes) => {
            if (imgRes.statusCode !== 200) {
                fileStream.close();
                try { fs.unlinkSync(targetPath); } catch (e) {}
                return res.status(400).json({ error: 'Bild konnte nicht geladen werden (Status ' + imgRes.statusCode + ')' });
            }
            imgRes.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                res.json({ url: '/uploads/' + filename });
            });
        });

        fetchReq.on('error', (err) => {
            fileStream.close();
            try { fs.unlinkSync(targetPath); } catch (e) {}
            res.status(500).json({ error: 'Fehler beim Herunterladen des Bildes: ' + err.message });
        });

        fetchReq.setTimeout(10000, () => {
            fetchReq.destroy();
            fileStream.close();
            try { fs.unlinkSync(targetPath); } catch (e) {}
            res.status(504).json({ error: 'Download-Zeitüberschreitung' });
        });
    } catch (e) {
        console.error('Remote upload error:', e);
        res.status(500).json({ error: 'Fehler beim Speichern des externen Bildes' });
    }
});

// 3. GERMAN MANGA ISBN LOOKUP (Deutsche Nationalbibliothek DNB & OpenLibrary Cover)
router.get('/lookup/isbn', requireAuth, async (req, res) => {
    try {
        const rawIsbn = req.query.isbn;
        if (!rawIsbn) {
            return res.status(400).json({ error: 'ISBN erforderlich' });
        }

        const cleanIsbn = String(rawIsbn).replace(/[^0-9X]/gi, '');
        if (!cleanIsbn || (cleanIsbn.length !== 10 && cleanIsbn.length !== 13)) {
            return res.status(400).json({ error: 'Ungültiges ISBN-Format (muss 10 oder 13 Zeichen lang sein)' });
        }

        // Fetch MARC21 XML from Deutsche Nationalbibliothek (DNB) SRU API
        const dnbUrl = `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=isbn%3D${encodeURIComponent(cleanIsbn)}&recordSchema=MARC21-xml`;

        let xml = '';
        try {
            xml = await new Promise((resolve, reject) => {
                const apiReq = https.get(dnbUrl, { headers: { 'User-Agent': 'MangaShelf/2.0' } }, (apiRes) => {
                    let data = '';
                    apiRes.on('data', chunk => data += chunk);
                    apiRes.on('end', () => resolve(data));
                });
                apiReq.on('error', reject);
                apiReq.setTimeout(8000, () => {
                    apiReq.destroy();
                    reject(new Error('DNB Timeout'));
                });
            });
        } catch (e) {
            console.error('DNB request failed:', e.message);
        }

        let book = null;
        if (xml && xml.includes('<recordData>')) {
            const getField = (tag, code) => {
                const fieldRegex = new RegExp(`<datafield[^>]*tag="${tag}"[^>]*>[\\s\\S]*?<\\/datafield>`, 'g');
                const matches = xml.match(fieldRegex) || [];
                for (const f of matches) {
                    const subRegex = new RegExp(`<subfield[^>]*code="${code}"[^>]*>([^<]+)<\\/subfield>`);
                    const subMatch = f.match(subRegex);
                    if (subMatch) return subMatch[1].trim();
                }
                return null;
            };

            let title = getField('245', 'a');
            if (title) title = title.replace(/\s*[\/:]\s*$/, '').trim();

            let volumeNumber = getField('245', 'n');
            if (volumeNumber) {
                volumeNumber = volumeNumber.replace(/\.$/, '').trim();
                const numOnly = volumeNumber.match(/\d+(\.\d+)?/);
                if (numOnly) volumeNumber = numOnly[0];
            }

            let subtitle = getField('245', 'p');
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

            if (title) {
                book = {
                    title,
                    volume_number: volumeNumber || '1',
                    subtitle,
                    author,
                    publisher,
                    release_year: releaseYear,
                    pages,
                    price,
                    cover_url: `https://covers.openlibrary.org/b/isbn/${cleanIsbn}-L.jpg`
                };
            }
        }

        if (!book) {
            return res.json({
                isbn: cleanIsbn,
                found: false,
                message: 'Keine Metadaten für diese ISBN in der Deutschen Nationalbibliothek gefunden.'
            });
        }

        // Cross reference existing mangas in SQLite
        const mangas = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas').all();
        let matchedManga = null;
        const normTitle = book.title.toLowerCase().trim();

        for (const m of mangas) {
            const mNorm = m.title.toLowerCase().trim();
            const altNorm = m.alt_title ? m.alt_title.toLowerCase().trim() : '';
            if (normTitle === mNorm || normTitle.includes(mNorm) || mNorm.includes(normTitle) || (altNorm && (normTitle.includes(altNorm) || altNorm.includes(normTitle)))) {
                matchedManga = m;
                break;
            }
        }

        let matchedVolume = null;
        if (matchedManga) {
            const vol = db.prepare(`
                SELECT id, manga_id, volume_number, status, isbn, price, publisher, pages, release_year
                FROM volumes 
                WHERE manga_id = ? AND (volume_number = ? OR isbn = ?)
            `).get(matchedManga.id, book.volume_number, cleanIsbn);
            if (vol) matchedVolume = vol;
        }

        res.json({
            isbn: cleanIsbn,
            found: true,
            book,
            matched_manga: matchedManga,
            matched_volume: matchedVolume
        });
    } catch (err) {
        console.error('Error during ISBN lookup:', err);
        res.status(500).json({ error: 'Fehler beim ISBN-Lookup' });
    }
});

// 4. File uploads (single and multiple)
router.post('/upload', requireEditor, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Keine Datei hochgeladen' });
    res.json({ url: '/uploads/' + req.file.filename });
});

router.post('/upload/multiple', requireEditor, upload.array('images', 10), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Keine Dateien hochgeladen' });
    const urls = req.files.map(f => '/uploads/' + f.filename);
    res.json({ urls });
});

module.exports = router;
