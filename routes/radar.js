const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAuth, requireEditor } = require('../middleware/auth');
const { normalizePublisher } = require('../utils/publishers');
const { searchMangaPassionEditions } = require('../mangaPassion');

// --- SHOPPING LIST / WISHLIST API ---
router.get('/shopping-list', requireAuth, (req, res) => {
    try {
        const missingVols = db.prepare(`
            SELECT 
                v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
                v.release_year, v.condition, v.publisher as vol_publisher, 
                v.notes, v.status,
                m.title as manga_title, 
                m.cover_image as manga_cover,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status = 'Fehlt'
            ORDER BY 
                effective_publisher ASC,
                m.title ASC,
                CASE 
                    WHEN COALESCE(v.type, 'volume') = 'volume' AND (v.volume_number = '0' OR CAST(v.volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' AND (v.volume_number = '0' OR CAST(v.volume_number AS REAL) > 0) THEN 1 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' THEN 1.5
                    WHEN COALESCE(v.type, 'volume') = 'schuber' THEN 2 
                    WHEN COALESCE(v.type, 'volume') = 'special' THEN 3 
                    ELSE 2 
                END ASC, 
                CASE 
                    WHEN CAST(v.volume_number AS REAL) > 0 THEN CAST(v.volume_number AS REAL) 
                    WHEN v.volume_number = '0' THEN 0 
                    ELSE 999999 
                END ASC, 
                CASE 
                    WHEN COALESCE(v.type, 'volume') = 'volume' THEN 0 
                    WHEN COALESCE(v.type, 'volume') = 'special_edition' THEN 1 
                    ELSE 2 
                END ASC,
                v.volume_number ASC
        `).all();

        const totalCost = missingVols.reduce((sum, v) => sum + (v.price || 0), 0);
        
        // Group by publisher for fast filter chips
        const publisherMap = new Map();
        missingVols.forEach(v => {
            const pub = normalizePublisher(v.effective_publisher) || 'Unbekannt';
            if (!publisherMap.has(pub)) {
                publisherMap.set(pub, { publisher: pub, count: 0, total_price: 0 });
            }
            const pStat = publisherMap.get(pub);
            pStat.count++;
            pStat.total_price += (v.price || 0);
        });

        const publishers = Array.from(publisherMap.values()).map(p => ({
            ...p,
            total_price: Math.round(p.total_price * 100) / 100
        }));

        res.json({
            total_missing: missingVols.length,
            total_cost: Math.round(totalCost * 100) / 100,
            publishers,
            items: missingVols
        });
    } catch (err) {
        console.error('Error fetching shopping list:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Einkaufsliste' });
    }
});

// --- RELEASE RADAR / ERSCHEINUNGSKALENDER API ---
router.get('/release-radar', requireAuth, (req, res) => {
    try {
        const radarVols = db.prepare(`
            SELECT 
                v.id, v.manga_id, v.volume_number, v.isbn, v.price, 
                v.release_date, v.release_year, v.condition, v.publisher as vol_publisher, 
                v.notes, v.status, v.type, v.cover_image as vol_cover, v.images as vol_images,
                m.title as manga_title, 
                m.cover_image as manga_cover,
                m.publisher as manga_publisher,
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as effective_publisher
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status IN ('Vorbestellt', 'Erscheint bald', 'Bestellt')
               OR (v.release_date IS NOT NULL AND TRIM(v.release_date) != '' AND v.status NOT IN ('Vorhanden', 'Gelesen'))
            ORDER BY 
                CASE WHEN v.release_date IS NOT NULL AND TRIM(v.release_date) != '' THEN 0 ELSE 1 END ASC,
                CASE 
                    WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' THEN TRIM(v.release_date) || '-01'
                    WHEN TRIM(v.release_date) GLOB '[0-9][0-9][0-9][0-9]-[0-9]' THEN SUBSTR(TRIM(v.release_date), 1, 5) || '0' || SUBSTR(TRIM(v.release_date), 6) || '-01'
                    ELSE TRIM(v.release_date)
                END ASC,
                m.title ASC,
                CASE 
                    WHEN CAST(v.volume_number AS REAL) > 0 THEN CAST(v.volume_number AS REAL) 
                    WHEN v.volume_number = '0' THEN 0 
                    ELSE 999999 
                END ASC,
                v.volume_number ASC
        `).all();

        const totalReleases = radarVols.length;
        const preorderedVols = radarVols.filter(v => ['Vorbestellt', 'Bestellt'].includes(v.status));
        const preorderedCount = preorderedVols.length;
        const preorderedBudget = preorderedVols.reduce((sum, v) => sum + (v.price || 0), 0);
        const totalBudget = radarVols.reduce((sum, v) => sum + (v.price || 0), 0);

        const MONTH_NAMES = [
            'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
            'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
        ];

        const today = new Date();

        const formattedItems = radarVols.map(v => {
            let daysUntil = null;
            let countdownLabel = null;

            if (v.release_date) {
                const parts = v.release_date.split('-');
                let targetDate = null;
                if (parts.length >= 3) {
                    targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
                } else if (parts.length === 2) {
                    targetDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
                }

                if (targetDate && !isNaN(targetDate.getTime())) {
                    const diffMs = targetDate.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
                    daysUntil = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                    if (daysUntil < 0) {
                        countdownLabel = `Vor ${Math.abs(daysUntil)} Tag${Math.abs(daysUntil) === 1 ? '' : 'en'}`;
                    } else if (daysUntil === 0) {
                        countdownLabel = 'Erscheint heute!';
                    } else if (daysUntil === 1) {
                        countdownLabel = 'Morgen!';
                    } else if (daysUntil <= 30) {
                        countdownLabel = `In ${daysUntil} Tagen`;
                    } else {
                        const targetMonth = targetDate.getMonth();
                        const thisMonth = today.getMonth();
                        if (targetDate.getFullYear() === today.getFullYear() && targetMonth === thisMonth + 1) {
                            countdownLabel = 'Nächsten Monat';
                        } else {
                            countdownLabel = `In ${Math.round(daysUntil / 30)} Monaten`;
                        }
                    }
                }
            }

            return {
                ...v,
                effective_publisher: normalizePublisher(v.effective_publisher) || 'Unbekannt',
                days_until: daysUntil,
                countdown_label: countdownLabel
            };
        });

        // Group by Year-Month
        const groupMap = new Map();

        formattedItems.forEach(item => {
            let groupKey = 'Ohne konkretes Datum';
            let sortKey = '9999-99';

            if (item.release_date) {
                const parts = item.release_date.split('-');
                if (parts.length >= 2) {
                    const y = parseInt(parts[0], 10);
                    const m = parseInt(parts[1], 10);
                    if (!isNaN(y) && !isNaN(m) && m >= 1 && m <= 12) {
                        groupKey = `${MONTH_NAMES[m - 1]} ${y}`;
                        sortKey = `${y}-${String(m).padStart(2, '0')}`;
                    }
                }
            } else if (item.release_year) {
                groupKey = `Im Jahr ${item.release_year}`;
                sortKey = `${item.release_year}-13`;
            }

            if (!groupMap.has(sortKey)) {
                groupMap.set(sortKey, {
                    key: sortKey,
                    label: groupKey,
                    count: 0,
                    total_price: 0,
                    preordered_count: 0,
                    items: []
                });
            }

            const grp = groupMap.get(sortKey);
            grp.count++;
            grp.total_price += (item.price || 0);
            if (['Vorbestellt', 'Bestellt'].includes(item.status)) {
                grp.preordered_count++;
            }
            grp.items.push(item);
        });

        const groups = Array.from(groupMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([_, grp]) => ({
                ...grp,
                total_price: Math.round(grp.total_price * 100) / 100
            }));

        const publisherMap = new Map();
        formattedItems.forEach(v => {
            const pub = v.effective_publisher;
            if (!publisherMap.has(pub)) {
                publisherMap.set(pub, { publisher: pub, count: 0 });
            }
            publisherMap.get(pub).count++;
        });

        const publishers = Array.from(publisherMap.values());

        res.json({
            total_releases: totalReleases,
            preordered_count: preorderedCount,
            preordered_budget: Math.round(preorderedBudget * 100) / 100,
            total_budget: Math.round(totalBudget * 100) / 100,
            groups,
            items: formattedItems,
            publishers
        });
    } catch (err) {
        console.error('Error fetching release radar:', err);
        res.status(500).json({ error: 'Fehler beim Laden des Release-Radars' });
    }
});

// --- MANGA PASSION GERMAN RELEASE CALENDAR API ---
router.get('/manga-passion/releases', requireAuth, async (req, res) => {
    try {
        const now = new Date();
        const year = parseInt(req.query.year, 10) || now.getFullYear();
        const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
        const forceRefresh = req.query.force_refresh === 'true';

        if (month < 1 || month > 12 || year < 2000 || year > 2100) {
            return res.status(400).json({ error: 'Ungültiges Jahr oder Monat' });
        }

        const cacheKey = `mp_releases_${year}_${month}`;
        let cachedRow = null;

        if (!forceRefresh) {
            try {
                cachedRow = db.prepare('SELECT json_data, created_at FROM manga_passion_cache WHERE cache_key = ?').get(cacheKey);
            } catch (_) {}
        }

        let rawItems = null;
        const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

        if (cachedRow && cachedRow.json_data && (Date.now() - cachedRow.created_at < CACHE_TTL_MS)) {
            try {
                rawItems = JSON.parse(cachedRow.json_data);
            } catch (_) {}
        }

        if (!rawItems) {
            const baseUrl = `https://api.manga-passion.de/volumes?year=${year}&month=${month}&itemsPerPage=100&order[date]=asc`;
            const headers = { 'User-Agent': 'MangaShelf/2.6.0', 'Accept': 'application/ld+json' };

            let allVolumes = [];
            let page = 1;
            let totalItems = 0;

            while (page <= 5) {
                try {
                    const response = await fetch(`${baseUrl}&page=${page}`, { 
                        headers, 
                        signal: AbortSignal.timeout(8000) 
                    });
                    if (!response.ok) {
                        if (page === 1) throw new Error(`Manga Passion API Fehler (Status ${response.status})`);
                        break;
                    }
                    const data = await response.json();
                    const members = data['hydra:member'] || (Array.isArray(data) ? data : []);
                    if (members.length === 0) break;

                    allVolumes = allVolumes.concat(members);
                    totalItems = data['hydra:totalItems'] || allVolumes.length;
                    if (allVolumes.length >= totalItems || members.length < 100) break;
                    page++;
                } catch (fetchErr) {
                    console.warn(`[Manga Passion Releases] Error on page ${page}:`, fetchErr.message);
                    if (allVolumes.length === 0) throw fetchErr;
                    break;
                }
            }

            rawItems = allVolumes.map(v => {
                const rawTitle = v.edition?.title || '';
                const isDigital = Boolean(v.edition?.digital || rawTitle.includes('(eBook)'));
                const cleanTitle = rawTitle.replace(/\s*\(eBook\)/i, '').trim();
                const rawPub = v.edition?.publishers?.[0]?.name ? normalizePublisher(v.edition.publishers[0].name) : 'Unbekannt';
                
                return {
                    id: v.id,
                    edition_id: v.edition?.id || null,
                    title: cleanTitle,
                    raw_title: rawTitle,
                    volume_number: v.numberDisplay || (v.number !== null && v.number !== undefined ? String(v.number) : 'Special'),
                    publisher: rawPub,
                    date: v.date ? v.date.slice(0, 10) : null,
                    year: v.year,
                    month: v.month,
                    day: v.day,
                    price: v.price ? Math.round(v.price) / 100 : null,
                    cover_image: v.cover || null,
                    pages: v.pages || null,
                    is_digital: isDigital,
                    format: v.format ?? 0
                };
            });

            try {
                db.prepare(`
                    INSERT INTO manga_passion_cache (cache_key, json_data, created_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(cache_key) DO UPDATE SET json_data = excluded.json_data, created_at = excluded.created_at
                `).run(cacheKey, JSON.stringify(rawItems), Date.now());
            } catch (cacheErr) {
                console.warn('Cache write failed:', cacheErr);
            }
        }

        // Live reconciliation with user's collection in SQLite
        const userMangas = db.prepare('SELECT id, title, alt_title, publisher, cover_image FROM mangas').all();
        const userVolumes = db.prepare('SELECT id, manga_id, volume_number, status, price, release_date FROM volumes').all();

        const cleanStr = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        const mangaMap = new Map();
        userMangas.forEach(m => {
            mangaMap.set(cleanStr(m.title), m);
            if (m.alt_title) mangaMap.set(cleanStr(m.alt_title), m);
        });

        const matchSeries = (title) => {
            const norm = cleanStr(title);
            if (mangaMap.has(norm)) return mangaMap.get(norm);

            const lower = title.toLowerCase();
            for (const m of userMangas) {
                if (m.title.toLowerCase() === lower) return m;
                if (m.alt_title && m.alt_title.toLowerCase() === lower) return m;
            }

            const prefix = title.split(/[–\-:]/)[0].trim();
            const normPre = cleanStr(prefix);
            if (normPre.length >= 4 && mangaMap.has(normPre)) {
                return mangaMap.get(normPre);
            }
            return null;
        };

        const enrichedItems = rawItems.map(item => {
            const matchedManga = matchSeries(item.title);
            let inCollection = false;
            let userMangaId = null;
            let userVolumeStatus = null;
            let userVolumeId = null;

            if (matchedManga) {
                inCollection = true;
                userMangaId = matchedManga.id;
                const volNum = String(item.volume_number || '').trim();
                const existingVol = userVolumes.find(uv => uv.manga_id === matchedManga.id && String(uv.volume_number).trim() === volNum);
                if (existingVol) {
                    userVolumeStatus = existingVol.status;
                    userVolumeId = existingVol.id;
                }
            }

            return {
                ...item,
                in_collection: inCollection,
                user_manga_id: userMangaId,
                user_manga_title: matchedManga ? matchedManga.title : null,
                user_volume_status: userVolumeStatus,
                user_volume_id: userVolumeId
            };
        });

        // Publisher list
        const pubMap = new Map();
        enrichedItems.forEach(it => {
            if (it.publisher && it.publisher !== 'Unbekannt') {
                pubMap.set(it.publisher, (pubMap.get(it.publisher) || 0) + 1);
            }
        });

        const publishers = Array.from(pubMap.entries())
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count);

        res.json({
            year,
            month,
            total_items: enrichedItems.length,
            print_count: enrichedItems.filter(i => !i.is_digital).length,
            user_series_count: enrichedItems.filter(i => i.in_collection).length,
            publishers,
            items: enrichedItems
        });
    } catch (err) {
        console.error('Manga Passion releases error:', err);
        res.status(500).json({ error: 'Fehler beim Abrufen der Manga-Passion-Neuerscheinungen: ' + err.message });
    }
});

router.post('/manga-passion/import', requireEditor, (req, res) => {
    try {
        const {
            manga_id,
            title,
            volume_number,
            publisher,
            release_date,
            price,
            cover_image,
            target_status
        } = req.body;

        let effMangaId = manga_id;

        // If manga doesn't exist yet, create it
        if (!effMangaId) {
            const cleanTitle = (title || '').replace(/\s*\(eBook\)/i, '').trim();
            const insManga = db.prepare(`
                INSERT INTO mangas (title, publisher, cover_image, status, created_at, updated_at)
                VALUES (?, ?, ?, 'Laufend', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(cleanTitle, publisher || null, cover_image || null);
            effMangaId = Number(insManga.lastInsertRowid);
        }

        const volNumStr = String(volume_number || '1').trim();
        const existingVol = db.prepare('SELECT id, status FROM volumes WHERE manga_id = ? AND volume_number = ?').get(effMangaId, volNumStr);

        let volumeId;
        const effStatus = target_status || 'Vorbestellt';

        if (existingVol) {
            db.prepare(`
                UPDATE volumes 
                SET status = ?, 
                    price = COALESCE(?, price),
                    release_date = COALESCE(?, release_date),
                    publisher = COALESCE(?, publisher),
                    cover_image = COALESCE(cover_image, ?)
                WHERE id = ?
            `).run(effStatus, price || null, release_date || null, publisher || null, cover_image || null, existingVol.id);
            volumeId = existingVol.id;
        } else {
            const insVol = db.prepare(`
                INSERT INTO volumes (manga_id, volume_number, status, price, release_date, publisher, cover_image, type, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'volume', CURRENT_TIMESTAMP)
            `).run(effMangaId, volNumStr, effStatus, price || null, release_date || null, publisher || null, cover_image || null);
            volumeId = Number(insVol.lastInsertRowid);
        }

        res.json({
            success: true,
            manga_id: effMangaId,
            volume_id: volumeId,
            status: effStatus
        });
    } catch (err) {
        console.error('Import error:', err);
        res.status(500).json({ error: 'Fehler beim Übernehmen des Bands: ' + err.message });
    }
});

// --- MANGA PASSION EDITION SEARCH ---
router.get('/manga-passion/editions', requireAuth, async (req, res) => {
    try {
        const title = req.query.title || '';
        const publisher = req.query.publisher || '';
        const totalVolumes = parseInt(req.query.total_volumes, 10) || null;
        if (!title.trim()) {
            return res.status(400).json({ error: 'Titel-Parameter ist erforderlich' });
        }
        const result = await searchMangaPassionEditions(title, publisher, totalVolumes);
        res.json(result);
    } catch (err) {
        console.error('Manga Passion edition search error:', err);
        res.status(500).json({ error: 'Fehler bei der Editionssuche: ' + err.message });
    }
});

module.exports = router;
