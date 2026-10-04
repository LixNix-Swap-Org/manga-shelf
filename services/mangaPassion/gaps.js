// Server binding of core/mangaPassion/gaps.js.
const core = require('../../core/mangaPassion/gaps');
const { createCtx } = require('../../db');

const bound = (fn) => (...args) => fn(createCtx(), ...args);

module.exports = {
  GAP_IMPORT_STATUSES: core.GAP_IMPORT_STATUSES,
  reconcileMangaGaps: bound(core.reconcileMangaGaps),
  batchImportGaps: bound(core.batchImportGaps),
  syncMangaWithEdition: bound(core.syncMangaWithEdition)
};
