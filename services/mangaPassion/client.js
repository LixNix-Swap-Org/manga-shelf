// Server binding of core/mangaPassion/client.js: same functions without the ctx argument.
const core = require('../../core/mangaPassion/client');
const { createCtx } = require('../../db');
const pkg = require('../../package.json');

const bound = (fn) => (...args) => fn(createCtx(), ...args);

module.exports = {
  API_BASE: core.API_BASE,
  HEADERS: { 'User-Agent': `MangaShelf/${pkg.version || '2.11.0'}`, 'Accept': 'application/ld+json' },
  UNKNOWN: core.UNKNOWN,
  MAX_VOLUME_PAGES: core.MAX_VOLUME_PAGES,
  toEditionId: core.toEditionId,
  mapEditionStatus: core.mapEditionStatus,
  fetchWithTimeout: bound(core.fetchWithTimeout),
  downloadRemoteImageToUploads: bound(core.downloadRemoteImageToUploads),
  searchMangaPassionEditions: bound(core.searchMangaPassionEditions),
  getEditionDetailsAndVolumes: bound(core.getEditionDetailsAndVolumes),
  getEditionInfo: bound(core.getEditionInfo),
  searchMangaPassionForLookup: bound(core.searchMangaPassionForLookup),
  saveEditionLink: bound(core.saveEditionLink),
  linkRecommendedEdition: bound(core.linkRecommendedEdition),
  readCache: bound(core.readCache),
  writeCache: bound(core.writeCache)
};
