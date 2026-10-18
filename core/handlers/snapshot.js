// Whole collection in one answer for the client's read-only offline copy (GET /offline-snapshot[?shelf_id=]). A database
// reopened during the build (restore) rejects with status 503, which the error handler passes on with its message.
const snapshot = require('../snapshot');
const access = require('../lib/access');
const { qstr } = require('../lib/query');

async function offlineSnapshot(ctx, { query } = {}) {
    const shelfIds = access.requestedShelfIds(ctx, qstr(query && query.shelf_id));
    return { body: await snapshot.buildOfflineSnapshot(ctx, ctx.user, shelfIds) };
}

module.exports = { offlineSnapshot };
