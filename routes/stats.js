const express = require('express');
const router = express.Router();
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/stats', requireAuth, (req, res) => {
    try {
        const totalSeriesRow = db.prepare('SELECT count(*) as count FROM mangas').get();
        const totalSeries = totalSeriesRow ? totalSeriesRow.count : 0;

        const ownedRow = db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as total_value FROM volumes WHERE status = 'Vorhanden'").get();
        const totalOwnedVolumes = ownedRow ? ownedRow.count : 0;
        const totalOwnedValue = ownedRow ? Math.round((ownedRow.total_value || 0) * 100) / 100 : 0;

        const missingRow = db.prepare("SELECT count(*) as count, sum(COALESCE(price, 0)) as missing_value FROM volumes WHERE status = 'Fehlt'").get();
        const totalMissingVolumes = missingRow ? missingRow.count : 0;
        const totalMissingValue = missingRow ? Math.round((missingRow.missing_value || 0) * 100) / 100 : 0;

        const allVolsRow = db.prepare('SELECT count(*) as count, sum(COALESCE(price, 0)) as full_value FROM volumes').get();
        const totalPossibleValue = allVolsRow ? Math.round((allVolsRow.full_value || 0) * 100) / 100 : 0;

        const completedRow = db.prepare(`
            SELECT count(*) as count FROM mangas 
            WHERE status = 'Abgeschlossen' 
               OR (total_volumes IS NOT NULL AND total_volumes > 0 AND owned_volumes >= total_volumes)
        `).get();
        const completedSeries = completedRow ? completedRow.count : 0;

        // Settings / Start Date
        const settingRow = db.prepare("SELECT value FROM app_settings WHERE key = 'collection_start_date'").get();
        const startDateStr = settingRow?.value || '2021-04-09';
        let startDate = new Date(startDateStr);
        if (isNaN(startDate.getTime())) startDate = new Date('2021-04-09');
        const now = new Date();
        const diffMs = Math.max(1, now.getTime() - startDate.getTime());
        const totalDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        const totalMonths = Math.max(1, Math.round(totalDays / 30.4375));
        const totalYears = (totalDays / 365.25).toFixed(2);
        const avgMonthlySpending = totalMonths > 0 ? Math.round((totalOwnedValue / totalMonths) * 100) / 100 : 0;
        const avgPricePerVolume = totalOwnedVolumes > 0 ? Math.round((totalOwnedValue / totalOwnedVolumes) * 100) / 100 : 0;

        // Publisher breakdown
        const pubRows = db.prepare(`
            SELECT 
                COALESCE(NULLIF(TRIM(v.publisher), ''), NULLIF(TRIM(m.publisher), ''), 'Unbekannt') as pub_name,
                count(DISTINCT m.id) as series_count,
                count(v.id) as volume_count,
                sum(CASE WHEN v.status = 'Vorhanden' THEN COALESCE(v.price, 0) ELSE 0 END) as total_value
            FROM volumes v
            JOIN mangas m ON v.manga_id = m.id
            WHERE v.status = 'Vorhanden'
            GROUP BY pub_name
            ORDER BY volume_count DESC
        `).all();

        const publishers = pubRows.map(p => ({
            publisher: p.pub_name,
            series_count: p.series_count,
            volume_count: p.volume_count,
            volumes_count: p.volume_count,
            total_value: Math.round((p.total_value || 0) * 100) / 100,
            percentage: totalOwnedVolumes > 0 ? Math.round((p.volume_count / totalOwnedVolumes) * 1000) / 10 : 0
        }));

        // User Reading Stats (Multi-User)
        const allUsers = db.prepare('SELECT id, username, role FROM users').all();
        const userReadingStats = allUsers.map(u => {
            const readRow = db.prepare(`
                SELECT count(vr.volume_id) as count
                FROM volume_reads vr
                JOIN volumes v ON vr.volume_id = v.id
                WHERE vr.user_id = ? AND v.status = 'Vorhanden'
            `).get(u.id);
            const readCount = readRow ? readRow.count : 0;
            const pct = totalOwnedVolumes > 0 ? Math.round((readCount / totalOwnedVolumes) * 1000) / 10 : 0;
            return {
                user_id: u.id,
                username: u.username,
                display_name: u.username,
                role: u.role,
                read_count: readCount,
                unread_count: Math.max(0, totalOwnedVolumes - readCount),
                total_owned: totalOwnedVolumes,
                read_pct: pct,
                percentage: pct
            };
        });

        // Top 5 Valuable series
        const topSeries = db.prepare(`
            SELECT 
                m.id, m.title, m.cover_image, m.publisher,
                count(v.id) as owned_volumes,
                sum(COALESCE(v.price, 0)) as total_value
            FROM mangas m
            JOIN volumes v ON m.id = v.manga_id AND v.status = 'Vorhanden'
            GROUP BY m.id
            ORDER BY total_value DESC
            LIMIT 5
        `).all().map(s => ({
            id: s.id,
            title: s.title,
            cover_image: s.cover_image,
            publisher: s.publisher,
            owned_volumes: s.owned_volumes,
            total_value: Math.round((s.total_value || 0) * 100) / 100
        }));

        const summary = {
            total_series: totalSeries,
            completed_series: completedSeries,
            total_owned_volumes: totalOwnedVolumes,
            total_missing_volumes: totalMissingVolumes,
            total_volumes_recorded: totalOwnedVolumes + totalMissingVolumes,
            total_owned_value: totalOwnedValue,
            total_missing_value: totalMissingValue,
            total_possible_value: totalPossibleValue,
            avg_price_per_volume: avgPricePerVolume,
            collection_start_date: startDateStr,
            collection_days: totalDays,
            collection_months: totalMonths,
            collection_years: parseFloat(totalYears),
            avg_monthly_spending: avgMonthlySpending
        };

        res.json({
            summary,
            ...summary,
            total_series: totalSeries,
            total_owned_volumes: totalOwnedVolumes,
            total_missing_volumes: totalMissingVolumes,
            completed_series: completedSeries,
            total_owned_value: totalOwnedValue,
            total_missing_value: totalMissingValue,
            total_possible_value: totalPossibleValue,
            avg_price_per_volume: avgPricePerVolume,
            start_date: startDateStr,
            duration: {
                days: totalDays,
                months: totalMonths,
                years: parseFloat(totalYears)
            },
            settings: {
                collection_start_date: startDateStr
            },
            avg_monthly_spending: avgMonthlySpending,
            publishers,
            user_reading_stats: userReadingStats,
            top_series: topSeries
        });
    } catch (err) {
        console.error('Error calculating stats:', err);
        res.status(500).json({ error: 'Fehler beim Laden der Statistiken' });
    }
});

router.put('/stats/settings', requireAdmin, (req, res) => {
    try {
        const dateVal = (req.body || {}).collection_start_date || (req.body || {}).start_date;
        if (dateVal) {
            const dateStr = String(dateVal).trim();
            const parsed = new Date(dateStr);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateStr) {
                return res.status(400).json({ error: 'Ungültiges Datum (erwartet: YYYY-MM-DD)' });
            }
            if (parsed.getTime() > Date.now()) {
                return res.status(400).json({ error: 'Das Startdatum darf nicht in der Zukunft liegen' });
            }
            db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('collection_start_date', ?)").run(dateStr);
        }
        res.json({ success: true });
    } catch (e) {
        console.error('Error saving stats settings:', e);
        res.status(500).json({ error: 'Fehler beim Speichern der Einstellungen' });
    }
});

module.exports = router;
