// Answer cache in api_cache (search results, adaptations, "not found") with a TTL per kind. Errors are never stored.
const MINUTE = 60 * 1000;

const TTL = {
    search: 60 * MINUTE,
    // answered by only one source: kept briefly, so the other one is asked again soon
    partial: 5 * MINUTE,
    notFound: 10 * MINUTE,
    adaptations: 24 * 60 * MINUTE
};

const MAX_ROWS = 2000;

/** { value, expired, created_at } or null. Expired rows are only returned with allowStale (fallback when every source is down). */
function read(ctx, key, { allowStale = false } = {}) {
    const row = ctx.db.prepare('SELECT json_data, created_at, expires_at FROM api_cache WHERE cache_key = ?').get(key);
    if (!row) return null;
    const expired = row.expires_at <= ctx.now().getTime();
    if (expired && !allowStale) return null;
    try {
        return { value: JSON.parse(row.json_data), expired, created_at: row.created_at };
    } catch (_) {
        return null;
    }
}

function write(ctx, key, value, ttlMs) {
    const now = ctx.now().getTime();
    ctx.db.prepare('INSERT OR REPLACE INTO api_cache (cache_key, json_data, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(key, JSON.stringify(value), now, now + ttlMs);
}

function remove(ctx, key) {
    ctx.db.prepare('DELETE FROM api_cache WHERE cache_key = ?').run(key);
}

/** Drops rows that expired more than a day ago and keeps the table below MAX_ROWS (oldest first). */
function prune(ctx) {
    const now = ctx.now().getTime();
    ctx.db.prepare('DELETE FROM api_cache WHERE expires_at < ?').run(now - 24 * 60 * MINUTE);
    const count = ctx.db.prepare('SELECT count(*) AS n FROM api_cache').get().n;
    if (count > MAX_ROWS) {
        ctx.db.prepare('DELETE FROM api_cache WHERE cache_key IN (SELECT cache_key FROM api_cache ORDER BY created_at ASC LIMIT ?)').run(count - MAX_ROWS);
    }
}

module.exports = { read, write, remove, prune, TTL };
