// Whole collection in one answer for the client's read-only offline copy (GET /offline-snapshot). A database reopened
// during the build (restore) rejects with status 503, which the error handler passes on with its message.
const snapshot = require('../snapshot');

async function offlineSnapshot(ctx) {
    return { body: await snapshot.buildOfflineSnapshot(ctx, ctx.user) };
}

module.exports = { offlineSnapshot };
