// Server-side MangaPassion API: re-exports the client, gap reconciliation and autofill bindings.
const client = require('./client');
const classify = require('./classify');
const gaps = require('./gaps');
const autofill = require('./autofill');

module.exports = {
  searchMangaPassionEditions: client.searchMangaPassionEditions,
  getEditionDetailsAndVolumes: client.getEditionDetailsAndVolumes,
  getEditionInfo: client.getEditionInfo,
  toEditionId: client.toEditionId,
  searchMangaPassionForLookup: client.searchMangaPassionForLookup,
  reconcileMangaGaps: gaps.reconcileMangaGaps,
  batchImportGaps: gaps.batchImportGaps,
  syncMangaWithEdition: gaps.syncMangaWithEdition,
  lookupVolumeMetadata: autofill.lookupVolumeMetadata,
  autofillMangaVolumes: autofill.autofillMangaVolumes,
  applyAutofillUpdates: autofill.applyAutofillUpdates,
  scoreEdition: classify.scoreEdition,
  matchSchuberVolume: classify.matchSchuberVolume,
  cleanOfficialDate: classify.cleanOfficialDate
};
