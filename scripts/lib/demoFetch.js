// Live lookups for the demo fixtures (node scripts/seed.js --refresh-fixtures): AniList (manga, anime adaptation),
// Manga Passion (German print edition, per volume cover/date/pages) and, with TMDB_API_KEY, TMDb. The result goes into
// scripts/demo-data.json; the normal seed never calls the network.
const anilist = require('../../core/anime/anilist');
const { mapAniListMedia } = require('../../core/anilist');
const { SERIES } = require('./demoSpec');

const MP = 'https://api.manga-passion.de';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ctx = { http: { fetch: (url, init) => globalThis.fetch(url, init) }, now: () => new Date(), config: { appVersion: 'demo-fixtures' } };
const fold = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === 4) { console.warn(`  ! ${label}: ${err.message}`); return null; }
      await sleep(err.retryAfterSec ? err.retryAfterSec * 1000 : 2500 * attempt);
    }
  }
  return null;
}

const MANGA_QUERY = `query ($s: String) { Page(page: 1, perPage: 6) { media(search: $s, type: MANGA, sort: SEARCH_MATCH, isAdult: false) {
  id idMal title { romaji english native } description(asHtml: false) coverImage { extraLarge large medium } bannerImage format status volumes chapters countryOfOrigin genres
  staff(perPage: 5) { edges { role node { name { full } } } }
  relations { edges { relationType(version: 2) node { id type format startDate { year } } } } } } }`;

async function fetchManga(spec) {
  const term = spec.al || spec.t;
  const res = await withRetry(async () => {
    const r = await globalThis.fetch('https://graphql.anilist.co/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: MANGA_QUERY, variables: { s: term } }) });
    if (r.status === 429) throw Object.assign(new Error('429'), { retryAfterSec: Number(r.headers.get('retry-after')) || 30 });
    const j = await r.json();
    return j.data.Page.media;
  }, `AniList ${term}`);
  if (!res || !res.length) return null;
  const wantKorean = spec.web;
  const hit = res.find(m => m.format === 'MANGA' && (wantKorean ? m.countryOfOrigin === 'KR' : m.countryOfOrigin === 'JP')) || res.find(m => m.format === 'MANGA') || res[0];
  const mapped = mapAniListMedia(hit);
  const adaptations = (hit.relations.edges || []).filter(e => e.relationType === 'ADAPTATION' && e.node.type === 'ANIME' && e.node.format === 'TV')
    .map(e => ({ id: e.node.id, year: e.node.startDate && e.node.startDate.year })).sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.id - b.id);
  return {
    anilist_id: hit.id, mal_id: hit.idMal || null, title: mapped.title, alt_title: mapped.alt_title, author: mapped.author, description: mapped.description,
    cover_image: mapped.cover_image, banner_image: mapped.banner_image,
    tags: (hit.genres || []).join(', ') || null, total_chapters: hit.chapters || null, volumes: hit.volumes || null, adaptations: adaptations.map(a => a.id)
  };
}

async function mpJson(path) {
  const res = await globalThis.fetch(`${MP}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Manga Passion ${res.status}`);
  return res.json();
}

async function fetchMp(spec) {
  const term = spec.mp || spec.t;
  const editions = await withRetry(() => mpJson(`/editions?title=${encodeURIComponent(term)}&itemsPerPage=40`), `MP ${term}`);
  if (!Array.isArray(editions)) return null;
  const want = fold(term);
  const scored = editions.filter(e => e.format !== 5 && (e.language === 0 || e.language == null)).map(e => {
    const title = fold(e.title);
    let score = title === want ? 100 : title.startsWith(want) ? 70 : title.includes(want) ? 40 : 0;
    const pubs = (e.publishers || []).map(p => fold(p.name)).join(' ');
    if (pubs.includes(fold(spec.pub).split(' ')[0])) score += 30;
    if (/(max|ultimate|ultimative|box|perfect|deluxe|collector)/i.test(e.title) && !/max/i.test(spec.t)) score -= 15;
    return { e, score };
  }).filter(x => x.score >= 70).sort((a, b) => b.score - a.score || (b.e.numVolumes || 0) - (a.e.numVolumes || 0));
  if (!scored.length) return null;
  const edition = scored[0].e;
  const volumes = {};
  for (let page = 1; page <= 4; page++) {
    const list = await withRetry(() => mpJson(`/editions/${edition.id}/volumes?itemsPerPage=100&page=${page}`), `MP volumes ${edition.id}`);
    if (!Array.isArray(list)) break;
    for (const v of list) {
      if (!Number.isInteger(v.number) || (v.type && v.type !== 0) || v.specialType) continue;
      volumes[v.number] = { release_date: v.date ? v.date.slice(0, 10) : null, cover_image: v.cover || null, pages: v.pages || null, price: v.price ? v.price / 100 : null };
    }
    if (list.length < 100) break;
    await sleep(300);
  }
  const src = edition.sources && edition.sources[0];
  return {
    id: edition.id, title: edition.title, total_volumes: edition.numVolumes || null, cover_image: edition.cover || null, description: edition.description || null,
    author: src && src.contributors ? [...new Set(src.contributors.map(c => c.contributor && c.contributor.name).filter(Boolean))].join(', ') || null : null,
    volumes
  };
}

/** The TMDb series of an AniList anime: Japanese original, first air year within a year of the anime's, title like the anime's. */
async function fetchTmdb(meta) {
  const key = process.env.TMDB_API_KEY;
  if (!key || !meta) return {};
  const headers = key.length > 40 ? { Authorization: `Bearer ${key}` } : {};
  const year = meta.season_year || Number(String(meta.start_date || '').slice(0, 4)) || null;
  const names = [meta.title.english, meta.title.romaji, meta.title.native].filter(Boolean).map(fold);
  const similarity = name => {
    const n = fold(name);
    return Math.max(0, ...names.map(t => (t === n ? 1 : t.startsWith(n) || n.startsWith(t) ? 0.8 : t.includes(n) || n.includes(t) ? 0.6 : 0)));
  };
  let best = null;
  for (const term of [meta.title.english, meta.title.romaji].filter(Boolean)) {
    const url = `https://api.themoviedb.org/3/search/tv?query=${encodeURIComponent(term)}&language=en-US${key.length > 40 ? '' : `&api_key=${key}`}`;
    const j = await withRetry(async () => (await globalThis.fetch(url, { headers })).json(), `TMDb ${term}`);
    for (const r of (j && j.results) || []) {
      const y = Number(String(r.first_air_date || '').slice(0, 4));
      if (r.original_language !== 'ja' || !y || (year && Math.abs(y - year) > 1)) continue;
      const score = similarity(r.name) + similarity(r.original_name) * 0.5;
      if (score >= 0.8 && (!best || score > best.score)) best = { score, id: r.id, name: r.name, year: y };
    }
    if (best) break;
    await sleep(300);
  }
  if (!best) { console.warn(`  ! kein TMDb-Treffer für ${meta.title.english || meta.title.romaji}`); return {}; }
  console.log(`  TMDb: ${best.name} (${best.year}) -> ${best.id}`);
  return { tmdb_id: best.id, tmdb_kind: 'tv' };
}

const SEASON_FORMATS = ['TV', 'ONA'];
const BRIDGE_FORMATS = ['OVA', 'SPECIAL']; // like the app's season chain: an OVA between two seasons is walked through
const MAX_SEASONS = 4;

/** The aired TV seasons of a franchise from `first` on (SEQUEL chain, at most MAX_SEASONS entries), as AnimeMeta. */
async function seasonsOf(first) {
  const out = [first];
  const seen = new Set([first.anilist_id]);
  const step = (rels, type) => (rels || []).find(x => x && x.kind === 'ANIME' && x.relation === type && SEASON_FORMATS.includes(x.format) && x.status !== 'NOT_YET_RELEASED' && x.anilist_id);
  const detail = async id => ((await withRetry(() => anilist.byIdsDetail(ctx, [id]), `anime ${id}`)) || { metas: [] }).metas[0] || null;
  let current = first;
  while (out.length < MAX_SEASONS) {
    let next = step(current.relations, 'SEQUEL');
    if (!next) {
      const bridge = (current.relations || []).find(x => x && x.kind === 'ANIME' && x.relation === 'SEQUEL' && BRIDGE_FORMATS.includes(x.format) && x.anilist_id);
      const via = bridge && !seen.has(bridge.anilist_id) ? await detail(bridge.anilist_id) : null;
      if (bridge) seen.add(bridge.anilist_id);
      if (via) next = step(via.relations, 'SEQUEL');
      await sleep(700);
    }
    if (!next || seen.has(next.anilist_id)) break;
    seen.add(next.anilist_id);
    const meta = await detail(next.anilist_id);
    await sleep(700);
    if (!meta) break;
    out.push(meta);
    current = meta;
  }
  return out;
}

function crunchyrollOf(meta) {
  const link = (meta.external_links || []).find(l => /crunchyroll/i.test(l.site || '') && /\/series\/([A-Z0-9]+)/i.test(l.url));
  if (!link) return null;
  const id = /\/series\/([A-Z0-9]+)/i.exec(link.url)[1].toUpperCase();
  return { external_id: id, url: `https://www.crunchyroll.com/series/${id}` };
}

async function fetchAll(log = console.log) {
  const out = {};
  for (const spec of SERIES) {
    log(`- ${spec.t}`);
    const entry = { manga: await fetchManga(spec) };
    await sleep(900);
    entry.mp = await fetchMp(spec); // webtoons are often in the German print catalogue as well
    await sleep(300);
    if (spec.anime) {
      let ids = entry.manga ? entry.manga.adaptations : [];
      let metas = [];
      if (ids.length) metas = (await withRetry(() => anilist.byIdsDetail(ctx, [ids[0]]), `anime ${spec.t}`) || { metas: [] }).metas;
      if (!metas.length) { // no adaptation relation: search the anime by title
        const found = await withRetry(() => anilist.search(ctx, [spec.al || spec.t], { type: 'ANIME', perPage: 3 }), `anime search ${spec.t}`);
        const first = found && found.metas[0] && found.metas[0][0];
        if (first) metas = (await withRetry(() => anilist.byIdsDetail(ctx, [first.anilist_id]), `anime ${spec.t}`) || { metas: [] }).metas;
      }
      if (metas[0]) {
        entry.anime = { meta: metas[0], crunchyroll: crunchyrollOf(metas[0]), ...(await fetchTmdb(metas[0])) };
        entry.anime.seasons = await seasonsOf(metas[0]);
        console.log(`  ${entry.anime.seasons.length} Staffel(n): ${entry.anime.seasons.map(m => m.season_year).join(', ')}`);
      }
      else console.warn(`  ! kein Anime für ${spec.t} gefunden`);
      await sleep(900);
    }
    if (!entry.manga) console.warn(`  ! kein AniList-Manga für ${spec.t}`);
    if (!entry.mp) console.warn(`  ! keine Manga-Passion-Ausgabe für ${spec.t}`);
    out[spec.k] = entry;
  }
  return out;
}

module.exports = { fetchAll, crunchyrollOf };
