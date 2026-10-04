// The lookup endpoints live in core/handlers/lookup.js (mounted through routes/core.js); this keeps the old exports.
const coreRouter = require('./core');
const { remoteImageError, lookupTimings } = require('../core/handlers/lookup');

module.exports = coreRouter;
module.exports.remoteImageError = remoteImageError;
module.exports.lookupTimings = lookupTimings;
