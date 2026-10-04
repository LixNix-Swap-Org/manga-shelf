// Limits and enabled sources of the anime gateway. Defaults here; the host configures them once (the server from
// ANIME_ANILIST_RPM, ANIME_JIKAN_RPM, ANIME_SOURCES), ctx.config.anime overrides per ctx (tests, apps).
const DEFAULTS = { anilistRpm: 30, jikanRpm: 60, sources: ['anilist', 'jikan'] };

let configured = {};

function configure(options = {}) {
    configured = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function settings(ctx) {
    const merged = { ...DEFAULTS, ...configured, ...((ctx && ctx.config && ctx.config.anime) || {}) };
    const sources = (Array.isArray(merged.sources) ? merged.sources : String(merged.sources || '').split(','))
        .map((s) => String(s).trim().toLowerCase()).filter((s) => s === 'anilist' || s === 'jikan' || s === 'mal');
    return {
        anilistRpm: Number(merged.anilistRpm) > 0 ? Number(merged.anilistRpm) : DEFAULTS.anilistRpm,
        jikanRpm: Number(merged.jikanRpm) > 0 ? Number(merged.jikanRpm) : DEFAULTS.jikanRpm,
        anilist: sources.includes('anilist'),
        // "mal" and "jikan" both enable the MyAnimeList side (official API with a client id, Jikan without)
        mal: sources.includes('jikan') || sources.includes('mal')
    };
}

module.exports = { configure, settings, DEFAULTS };
