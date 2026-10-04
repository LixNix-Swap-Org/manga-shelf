// Server binding of core/mangaPassion/autofill.js.
const core = require('../../core/mangaPassion/autofill');
const { createCtx } = require('../../db');

const bound = (fn) => (...args) => fn(createCtx(), ...args);

module.exports = {
  lookupVolumeMetadata: bound(core.lookupVolumeMetadata),
  autofillMangaVolumes: bound(core.autofillMangaVolumes),
  applyAutofillUpdates: bound(core.applyAutofillUpdates)
};
