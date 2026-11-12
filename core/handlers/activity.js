// "Aktivität": GET /activity, what happened recently in the caller's shelves, read from the timestamps the rows already
// carry (no log table): reading marks (volume_reads.read_at), copies that became someone's (volume_copies.created_at),
// new volumes and series (created_at), and the last change of a volume or series (updated_at/updated_by, migration 55).
// So it shows the latest state, not every step: a volume changed twice appears once, a removed copy or a deleted series
// not at all. Entries of the same kind, person and series on the same day are one entry with all their volumes.
//   ?shelf_id=   like the other lists    ?days=   1 to 365 (default 30)
const access = require('../lib/access');
const { qstr } = require('../lib/query');
const { volumeOrderSql } = require('../lib/volumeNumber');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const LIMIT = 150;
// the request that adds a row also stamps updated_at/updated_by: within these seconds of created_at it is the creator.
// A later change (by anyone) overwrites that stamp, so the creator is no longer known and the entry has no name.
const CREATE_STEP_SECONDS = 5;
// a volume change within this many seconds of the same person's new copy of it is that step ("owned"), not another
const SAME_STEP_SECONDS = 120;

// one row per volume event: kind, at (UTC 'YYYY-MM-DD HH:MM:SS'), user_id, volume_id, manga_id
const VOLUME_EVENTS_SQL = `
    SELECT 'read' AS kind, datetime(r.read_at) AS at, r.user_id, r.volume_id
    FROM {volume_reads} r WHERE datetime(r.read_at) >= ?
    UNION ALL
    SELECT 'owned', datetime(c.created_at), c.owner_user_id, c.volume_id
    FROM {volume_copies} c WHERE c.owner_user_id IS NOT NULL AND datetime(c.created_at) >= ?
    UNION ALL
    SELECT 'added', datetime(v.created_at),
           CASE WHEN v.updated_at IS NOT NULL AND abs(strftime('%s', v.updated_at) - strftime('%s', v.created_at)) <= ${CREATE_STEP_SECONDS} THEN v.updated_by END,
           v.id
    FROM {volumes} v WHERE datetime(v.created_at) >= ?
    UNION ALL
    SELECT 'changed', datetime(v.updated_at), v.updated_by, v.id
    FROM {volumes} v WHERE v.updated_at IS NOT NULL AND datetime(v.updated_at) >= ?
      AND (v.created_at IS NULL OR strftime('%s', v.updated_at) - strftime('%s', v.created_at) > ${CREATE_STEP_SECONDS})
      AND NOT EXISTS (SELECT 1 FROM {volume_copies} c WHERE c.volume_id = v.id AND c.owner_user_id = v.updated_by
                      AND abs(strftime('%s', c.created_at) - strftime('%s', v.updated_at)) <= ${SAME_STEP_SECONDS})
`;

const SERIES_EVENTS_SQL = `
    SELECT 'series_added' AS kind, datetime(m.created_at) AS at, m.id AS manga_id,
           CASE WHEN m.updated_at IS NOT NULL AND abs(strftime('%s', m.updated_at) - strftime('%s', m.created_at)) <= ${CREATE_STEP_SECONDS} THEN m.updated_by END AS user_id
    FROM {mangas} m WHERE datetime(m.created_at) >= ?
    UNION ALL
    SELECT 'series_changed', datetime(m.updated_at), m.id, m.updated_by
    FROM {mangas} m WHERE m.updated_at IS NOT NULL AND m.updated_by IS NOT NULL AND datetime(m.updated_at) >= ?
      AND (m.created_at IS NULL OR strftime('%s', m.updated_at) - strftime('%s', m.created_at) > ${CREATE_STEP_SECONDS})
`;

const pad = (n) => String(n).padStart(2, '0');
const sqlTime = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function readDays(raw) {
    const n = Number.parseInt(qstr(raw), 10);
    if (!Number.isFinite(n)) return DEFAULT_DAYS;
    return Math.min(MAX_DAYS, Math.max(1, n));
}

function activity(realCtx, { query = {} } = {}) {
    const shelfIds = access.requestedShelfIds(realCtx, qstr(query.shelf_id));
    const ctx = access.scopedCtx(realCtx, shelfIds);
    const days = readDays(query.days);
    const since = sqlTime(new Date(realCtx.now().getTime() - days * 86400000));

    const volumeEvents = ctx.db.prepare(VOLUME_EVENTS_SQL).all(since, since, since, since);
    const seriesEvents = ctx.db.prepare(SERIES_EVENTS_SQL).all(since, since);

    const volumeIds = [...new Set(volumeEvents.map(e => e.volume_id))];
    const volumes = new Map();
    // in chunks: SQLite takes a limited number of parameters
    for (let i = 0; i < volumeIds.length; i += 500) {
        const chunk = volumeIds.slice(i, i + 500);
        const rows = ctx.db.prepare(`SELECT v.id, v.manga_id, v.volume_number FROM {volumes} v
            WHERE v.id IN (${chunk.map(() => '?').join(',')}) ORDER BY v.manga_id, ${volumeOrderSql('v')}, v.id`).all(...chunk);
        // the shelf order within a series (a chunk boundary inside a series only shifts both halves alike)
        rows.forEach((r, n) => volumes.set(r.id, { ...r, sort_key: i + n }));
    }
    const mangaIds = [...new Set([...seriesEvents.map(e => e.manga_id), ...[...volumes.values()].map(v => v.manga_id)])];
    const series = new Map();
    for (let i = 0; i < mangaIds.length; i += 500) {
        const chunk = mangaIds.slice(i, i + 500);
        const rows = ctx.db.prepare(`SELECT m.id, m.title, m.cover_image, m.shelf_id FROM {mangas} m WHERE m.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
        for (const r of rows) series.set(r.id, r);
    }
    const users = new Map(realCtx.db.prepare('SELECT id, username FROM users').all().map(u => [u.id, u.username]));
    const shelfNames = new Map(realCtx.db.prepare('SELECT id, name FROM shelves').all().map(s => [s.id, s.name]));

    const groups = new Map();
    const add = (kind, at, userId, mangaId, volume) => {
        const s = series.get(mangaId);
        if (!s || !at) return;
        const key = `${kind}|${userId ?? ''}|${mangaId}|${at.slice(0, 10)}`;
        let g = groups.get(key);
        if (!g) {
            g = {
                kind, at, user_id: userId ?? null, username: userId ? users.get(userId) ?? null : null,
                manga_id: mangaId, title: s.title, cover_image: s.cover_image, shelf_name: shelfNames.get(s.shelf_id) ?? null,
                volumes: [], sort: []
            };
            groups.set(key, g);
        }
        if (at > g.at) g.at = at;
        if (volume && !g.volumes.includes(volume.volume_number)) {
            g.volumes.push(volume.volume_number);
            g.sort.push(volume.sort_key);
        }
    };
    for (const e of volumeEvents) {
        const v = volumes.get(e.volume_id);
        if (v) add(e.kind, e.at, e.user_id, v.manga_id, v);
    }
    for (const e of seriesEvents) add(e.kind, e.at, e.user_id, e.manga_id, null);

    const items = [...groups.values()]
        .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.title.localeCompare(b.title, 'de')))
        .slice(0, LIMIT)
        .map(({ sort, volumes: list, ...g }) => {
            // volumes in shelf order ("Band 3–5"), not in the order they were marked
            const order = list.map((n, i) => [n, sort[i]]).sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)).map(x => x[0]);
            return { ...g, at: `${g.at.replace(' ', 'T')}Z`, count: order.length, volumes: order };
        });
    return { body: { days, total: groups.size, items } };
}

module.exports = { activity };
