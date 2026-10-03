const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const { db, uploadsDir } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { fetchRemoteImage } = require('../utils/safeFetch');
const { qstr } = require('../utils/query');
const { normalizeIsbn, isValidIsbn } = require('../utils/isbn');
const { searchMangaPassionForLookup } = require('../mangaPassion');
const { lookupBookByIsbn, matchCollection } = require('../services/isbnLookup');
const log = require('../utils/logger').child('lookup');

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
        const queryTerm = qstr(req.query.q);
        if (!queryTerm || !queryTerm.trim()) {
            return res.status(400).json({ error: 'Suchbegriff erforderlich' });
        }

        const trimmed = queryTerm.trim();

        // Manga Passion (official German editions) and AniList run at the same time; one failing never blocks the other
        const [mpResults, aniListResults] = await Promise.all([
            searchMangaPassionForLookup(trimmed).catch(err => { log.warn('Manga Passion lookup error:', err.message); return []; }),
            searchAniList(trimmed).catch(err => { log.warn('AniList lookup error:', err.message); return []; })
        ]);

        // Manga Passion hat Vorrang (deutsche Verlage, korrekte deutsche Bandzahlen & Cover)
        const combined = [...mpResults, ...aniListResults];
        res.json(combined);
    } catch (err) {
        log.error('Lookup endpoint error:', err);
        res.status(500).json({ error: 'Interner Serverfehler beim Metadaten-Lookup' });
    }
});

// 2. Download remote image (e.g. from AniList) and save locally to data/uploads
// SSRF-protected: public hosts only, size-capped, verified by magic bytes.
router.post('/upload-remote', requireEditor, async (req, res) => {
    try {
        const { url } = req.body || {};
        if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
            return res.status(400).json({ error: 'Ungültige Bild-URL' });
        }
        const { buffer, ext } = await fetchRemoteImage(url);
        const filename = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
        await fs.promises.writeFile(path.join(uploadsDir, filename), buffer);
        res.json({ url: '/uploads/' + filename });
    } catch (e) {
        log.warn('Remote upload failed:', e.message);
        if (res.headersSent) return;
        res.status(400).json({ error: 'Bild konnte nicht geladen werden: ' + e.message });
    }
});

// 3. RESILIENT GERMAN MANGA ISBN LOOKUP (DNB -> K10plus -> Google Books)
router.get('/lookup/isbn', requireAuth, async (req, res) => {
    try {
        const rawIsbn = qstr(req.query.isbn);
        if (!rawIsbn || !rawIsbn.trim()) {
            return res.status(400).json({ error: 'ISBN erforderlich' });
        }

        const cleanIsbn = rawIsbn.replace(/[^0-9X]/gi, '').toUpperCase();
        if (cleanIsbn.length !== 10 && cleanIsbn.length !== 13) {
            return res.status(400).json({ error: 'Ungültiges ISBN-Format (muss 10 oder 13 Zeichen lang sein)' });
        }
        // a wrong check digit means a misread barcode (or no book at all): say so instead of three failing lookups
        if (!isValidIsbn(cleanIsbn)) {
            return res.status(400).json({ error: 'Das ist keine gültige ISBN (Prüfziffer stimmt nicht). Bitte den Barcode erneut scannen.' });
        }

        const isbn13 = normalizeIsbn(cleanIsbn);

        // a volume of the collection with this ISBN is certain and needs no catalogue (also works without internet)
        const known = db.prepare('SELECT 1 FROM volumes WHERE isbn = ? LIMIT 1').get(isbn13);
        const book = known ? null : await lookupBookByIsbn(cleanIsbn);
        if (!book && !known) {
            return res.json({
                isbn: cleanIsbn,
                found: false,
                message: 'Keine Metadaten für diese ISBN in DNB, K10plus oder Google Books gefunden.'
            });
        }

        const bookData = book || { title: '', volume_number: '1', volume_number_known: false, source: 'Sammlung' };
        const match = matchCollection(db, bookData, isbn13);
        if (!book && match.volume) {
            // no catalogue entry: describe the book from our own volume
            bookData.title = match.manga ? match.manga.title : '';
            bookData.volume_number = match.volume.volume_number;
            bookData.volume_number_known = true;
        }

        res.json({
            isbn: cleanIsbn,
            found: true,
            book: bookData,
            matched_manga: match.manga,
            matched_volume: match.volume,
            match_reason: match.reason,
            matched_candidates: match.candidates
        });
    } catch (err) {
        log.error('Error during ISBN lookup:', err);
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
