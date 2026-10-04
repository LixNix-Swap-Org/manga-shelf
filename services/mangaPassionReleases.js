// Server binding of core/mangaPassion/releases.js (calendar fetch with cache; matching is pure).
const core = require('../core/mangaPassion/releases');
const { createCtx } = require('../db');

const bound = (fn) => (...args) => fn(createCtx(), ...args);

module.exports = {
    ...core,
    getMonthlyReleases: bound(core.getMonthlyReleases),
    fetchMonthsForCheck: bound(core.fetchMonthsForCheck)
};
