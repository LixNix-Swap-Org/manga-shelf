// Server binding of core/snapshot.js; `options` is the same object (tests lower chunkSize).
const core = require('../core/snapshot');
const { createCtx } = require('../db');

module.exports = {
    options: core.options,
    buildMangaDetail: core.buildMangaDetail,
    listMangas: (userId) => core.listMangas(createCtx(), userId),
    loadMangaDetail: (mangaId, userId) => core.loadMangaDetail(createCtx(), mangaId, userId),
    buildOfflineSnapshot: (user) => core.buildOfflineSnapshot(createCtx({ user }), user)
};
