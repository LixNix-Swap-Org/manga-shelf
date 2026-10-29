// Demo collections, written through db.js. Only an empty database is filled; without --data-dir (and DATA_DIR) a fresh
// temp folder is used.
//   npm run seed -- [--data-dir <dir>]                       the lively demo library from scripts/demo-data.json (offline):
//                                                             8 accounts (password demo1234), 7 shelves, 37 series + 2 wishlist series
//   npm run seed -- --refresh-fixtures [--data-dir <dir>]    first rebuild scripts/demo-data.json from AniList + Manga Passion
//   npm run seed -- --series 1500 --volumes 45000 [--seed 42] [--data-dir <dir>]
//                                                             deterministic synthetic bulk data for benchmarks (random passwords)
// The logins are written to <data-dir>/seed-users.json.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { manualWorkKey } = require('../core/lib/language');
const { mulberry32 } = require('./lib/rng');

const DEFAULTS = { series: 1500, volumes: 45000, seed: 42 };
const USERS_FILE = 'seed-users.json';
const DEMO_USERS = [['admin', 'admin'], ['anna', 'editor'], ['ben', 'editor']];

const PUBLISHERS = ['Carlsen Manga', 'Egmont Manga', 'Tokyopop', 'Altraverse', 'Manga Cult', 'Hayabusa', 'Kazé Manga', 'Panini Manga', 'Crunchyroll', 'Papertoons'];
const WORDS = ['Blade', 'Shadow', 'Dragon', 'Ninja', 'Hero', 'Academy', 'Ghost', 'Moon', 'Sun', 'Kaiser', 'Titan', 'Hunter', 'Spirit', 'Sword', 'Hearts', 'Kingdom', 'Chainsaw', 'Detektiv', 'Attack', 'Saga', 'Magic', 'Returner', 'Witch', 'Akira', 'Berserk', 'Fullmetal', 'one', 'my', 'a'];
const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
const CONDITIONS = ['Neuwertig', 'Sehr gut', 'Gut'];
// every 12th series from the 6th on is the English edition of the one before, from the 11th on a Japanese one of its own;
// chosen by position, not by rand(), so a seed keeps its collection
const OTHER_EDITIONS = { 5: { language: 'en', region: 'US', currency: 'USD', linked: true }, 10: { language: 'ja', region: 'JP', currency: 'JPY', linked: false } };

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === '--data-dir') { opts.dataDir = value; i++; continue; }
    if (name === '--refresh-fixtures') { opts.refreshFixtures = true; continue; }
    if (['--series', '--volumes', '--seed'].includes(name)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`${name} braucht eine ganze Zahl >= 1`);
      opts[name.slice(2)] = n;
      i++;
      continue;
    }
    throw new Error(`Unbekanntes Argument: ${name}`);
  }
  return opts;
}

/** Series sizes: a few giants (~125 entries), some large (40-90), the rest 8-50, scaled to the exact total. */
function seriesSizes(rand, series, volumes) {
  if (volumes < series) throw new Error('--volumes muss mindestens so groß wie --series sein');
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const giants = Math.min(5, Math.floor(series / 300));
  const large = Math.floor(series * 0.04);
  const raw = Array.from({ length: series }, (_, i) => (i < giants ? int(118, 130) : i < giants + large ? int(40, 90) : int(8, 50)));
  const sum = raw.reduce((a, b) => a + b, 0);
  const sizes = raw.map(n => Math.max(1, Math.round((n * volumes) / sum)));
  let diff = volumes - sizes.reduce((a, b) => a + b, 0);
  while (diff !== 0) {
    const i = Math.floor(rand() * series);
    if (diff > 0) { sizes[i]++; diff--; } else if (sizes[i] > 1) { sizes[i]--; diff++; }
  }
  return sizes;
}

function seedDatabase({ db, runTransaction }, { series = DEFAULTS.series, volumes = DEFAULTS.volumes, seed = DEFAULTS.seed, passwordHashes } = {}) {
  const existing = db.prepare('SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM mangas) AS mangas').get();
  if (existing.users || existing.mangas) {
    throw new Error(`Die Datenbank ist nicht leer (${existing.users} Benutzer, ${existing.mangas} Reihen); der Seeder füllt nur eine leere`);
  }
  const rand = mulberry32(seed);
  const pick = list => list[Math.floor(rand() * list.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const date = (fromYear, toYear) => `${int(fromYear, toYear)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
  const sizes = seriesSizes(rand, series, volumes);
  const stats = { series: 0, volumes: 0, owners: 0, reads: 0 };

  runTransaction(() => {
    const insUser = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    const users = DEMO_USERS.map(([name, role]) => Number(insUser.run(name, passwordHashes[name], role).lastInsertRowid));
    // every demo account belongs to the household shelf (shelf 1), the admin as its owner, as /setup and POST /users do
    const insMember = db.prepare('INSERT OR IGNORE INTO shelf_members (shelf_id, user_id, role) VALUES (1, ?, ?)');
    users.forEach((id, i) => insMember.run(id, DEMO_USERS[i][1] === 'admin' ? 'owner' : 'editor'));
    db.prepare('UPDATE shelves SET owner_user_id = ? WHERE id = 1').run(users[DEMO_USERS.findIndex(([, role]) => role === 'admin')]);
    const insManga = db.prepare(`INSERT INTO mangas (title, alt_title, author, publisher, language, region, currency, work_key, status, tags, total_volumes, description, cover_image, manga_passion_id, manga_passion_edition_data, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const setWorkKey = db.prepare('UPDATE mangas SET work_key = ? WHERE id = ?');
    let previous = null;
    const insVolume = db.prepare(`INSERT INTO volumes (manga_id, volume_number, isbn, price, release_date, release_year, condition, pages, publisher, purchase_date, status, notes, cover_image, images, type, priority, target_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insOwner = db.prepare('INSERT INTO volume_owners (volume_id, user_id, price, purchase_date, condition) VALUES (?, ?, ?, ?, ?)');
    const insRead = db.prepare('INSERT INTO volume_reads (volume_id, user_id) VALUES (?, ?)');

    for (let s = 0; s < series; s++) {
      const size = sizes[s];
      const publisher = pick(PUBLISHERS);
      const generated = `${pick(WORDS)} ${pick(WORDS)} ${String(s + 1).padStart(4, '0')}`;
      const other = OTHER_EDITIONS[s % 12] || null;
      const linkedTo = other && other.linked && previous ? previous : null;
      const title = linkedTo ? linkedTo.title : generated;
      // a manual key like the API's, derived from seed and position so the collection stays reproducible
      const workKey = linkedTo ? manualWorkKey(crypto.createHash('sha256').update(`${seed}:${s}`).digest('hex')) : null;
      const linked = rand() < 0.4;
      const mangaStatus = rand() < 0.3 ? 'Abgeschlossen' : 'Laufend';
      const edition = linked ? JSON.stringify({
        id: 10000 + s, title, publisher, total_volumes: size, status: mangaStatus,
        volumes: Array.from({ length: Math.min(6, size) }, (_, k) => ({ number: k + 1, date: '2024-01-01', price: 7.5 }))
      }) : null;
      const mangaId = Number(insManga.run(title, rand() < 0.5 ? title.toUpperCase() : null, `Autor ${int(1, 400)}`, publisher,
        other ? other.language : 'de', other ? other.region : null, other ? other.currency : 'EUR', workKey, mangaStatus,
        'Action, Fantasy', size, LOREM.repeat(int(1, 4)), `/uploads/cover-${s}.jpg`, linked && !other ? 10000 + s : null, linked && !other ? edition : null,
        users[0]).lastInsertRowid);
      if (workKey) setWorkKey.run(workKey, linkedTo.id);
      previous = { id: mangaId, title };
      stats.series++;

      const giant = size >= 100;
      let schuber = giant ? 8 : rand() < 0.05 ? int(1, 5) : 0;
      let specials = giant ? 4 : rand() < 0.1 ? 1 : 0;
      let specialEditions = rand() < 0.1 ? int(1, 3) : 0;
      while (schuber + specials + specialEditions > size - 1) {
        if (schuber) schuber--; else if (specials) specials--; else specialEditions--;
      }
      const regular = size - schuber - specials - specialEditions;
      specialEditions = Math.min(specialEditions, regular);
      const ownedUpTo = rand() < 0.6 ? regular : Math.floor(regular * (0.3 + rand() * 0.6));
      const r = rand();
      const collectors = r < 0.7 ? [users[0]] : r < 0.85 ? [users[1]] : r < 0.9 ? [users[2]] : [users[0], users[1]];

      const entries = [];
      for (let i = 1; i <= regular; i++) entries.push({ type: 'volume', num: String(i), owned: i <= ownedUpTo && rand() < 0.97, tail: regular - i });
      const seNumbers = new Set();
      while (seNumbers.size < specialEditions) seNumbers.add(int(1, regular));
      for (const n of [...seNumbers].sort((a, b) => a - b)) entries.push({ type: 'special_edition', num: String(n), owned: rand() < 0.6, tail: 5 });
      for (let i = 1; i <= schuber; i++) entries.push({ type: 'schuber', num: `Schuber ${i}`, owned: rand() < 0.7, tail: 5 });
      for (let i = 1; i <= specials; i++) entries.push({ type: 'special', num: i === 1 ? 'Fanbook' : `Special ${i}`, owned: rand() < 0.5, tail: 5 });

      for (const e of entries) {
        let status = e.owned ? 'Vorhanden' : 'Fehlt';
        if (!e.owned && e.tail < 2 && mangaStatus === 'Laufend') status = pick(['Vorbestellt', 'Erscheint bald', 'Bestellt']);
        const price = Math.round((6.5 + rand() * 8.5) * 2) / 2;
        const year = int(2015, 2026);
        const releaseDate = rand() < 0.6 ? (status === 'Vorhanden' || status === 'Fehlt' ? date(year, year) : date(2027, 2027)) : null;
        const purchase = status === 'Vorhanden' && rand() < 0.85 ? date(2021, 2026) : null;
        const cover = rand() < 0.5 ? `/uploads/vol-${s}-${e.num.replace(/\s+/g, '-')}.jpg` : null;
        const images = rand() < 0.05 ? JSON.stringify([cover || '/uploads/x.jpg', '/uploads/y.jpg']) : null;
        const condition = status === 'Vorhanden' ? pick(CONDITIONS) : null;
        const volumeId = Number(insVolume.run(mangaId, e.num, rand() < 0.8 ? `978${String(int(0, 999999999)).padStart(10, '0')}` : null, price,
          releaseDate, year, condition, int(160, 240), rand() < 0.3 ? publisher : null, purchase, status,
          rand() < 0.1 ? 'Erstauflage mit Farbseiten' : null, cover, images, e.type, status === 'Fehlt' ? int(0, 3) : 0,
          rand() < 0.02 ? 5 : null).lastInsertRowid);
        stats.volumes++;
        if (status !== 'Vorhanden') continue;
        let owners = collectors;
        if (collectors.length === 2) {
          const x = rand();
          owners = x < 0.4 ? collectors : x < 0.7 ? [collectors[0]] : [collectors[1]];
        }
        for (const userId of owners) { insOwner.run(volumeId, userId, price, purchase, condition); stats.owners++; }
        const readShare = [0.7, 0.4, 0.15];
        for (let k = 0; k < users.length; k++) if (rand() < readShare[k]) { insRead.run(volumeId, users[k]); stats.reads++; }
      }
    }
    db.exec("UPDATE mangas SET owned_volumes = (SELECT count(*) FROM volumes v WHERE v.manga_id = mangas.id AND v.status = 'Vorhanden')");
  });
  return stats;
}

const DEMO_FILE = path.join(__dirname, 'demo-data.json');
const readDemoData = () => JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8'));

/** The demo library from scripts/demo-data.json: accounts, shelves with roles, series, volumes, owners, reads, chapters, anime. */
function seedDemo({ db, runTransaction }, data, passwordHash) {
  const existing = db.prepare('SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM mangas) AS mangas').get();
  if (existing.users || existing.mangas) {
    throw new Error(`Die Datenbank ist nicht leer (${existing.users} Benutzer, ${existing.mangas} Reihen); der Seeder füllt nur eine leere`);
  }
  const { snapshotColumns } = require('../core/anime/store');
  const nowMs = Date.now();
  const stats = { users: 0, shelves: 0, series: 0, volumes: 0, owners: 0, reads: 0, chapters: 0, anime: 0, progress: 0 };
  runTransaction(() => {
    const userId = {};
    const insUser = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
    for (const u of data.users) { userId[u.username] = Number(insUser.run(u.username, passwordHash, u.role).lastInsertRowid); stats.users++; }
    const shelfId = {};
    db.exec('DELETE FROM shelf_members');
    const insShelf = db.prepare('INSERT INTO shelves (name, description, color, owner_user_id, is_default) VALUES (?, ?, ?, ?, 0)');
    const insMember = db.prepare('INSERT INTO shelf_members (shelf_id, user_id, role) VALUES (?, ?, ?)');
    for (const sh of data.shelves) {
      if (sh.id === 1) db.prepare('UPDATE shelves SET name = ?, color = ?, owner_user_id = ? WHERE id = 1').run(sh.name, sh.color, userId[sh.owner]);
      shelfId[sh.key] = sh.id === 1 ? 1 : Number(insShelf.run(sh.name, null, sh.color, userId[sh.owner]).lastInsertRowid);
      for (const [user, role] of Object.entries(sh.members)) insMember.run(shelfId[sh.key], userId[user], role);
      stats.shelves++;
    }
    const insManga = db.prepare(`INSERT INTO mangas (title, alt_title, author, publisher, language, currency, status, tags, total_volumes, description, cover_image, banner_image,
      manga_passion_id, wish_priority, collecting, format, total_chapters, shelf_id, updated_by) VALUES (?, ?, ?, ?, 'de', 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, 'aktiv', ?, ?, ?, ?)`);
    const insVolume = db.prepare(`INSERT INTO volumes (manga_id, volume_number, price, release_date, release_year, condition, pages, purchase_date, status, notes, cover_image, type, priority, target_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insOwner = db.prepare('INSERT INTO volume_owners (volume_id, user_id, price, purchase_date, condition) VALUES (?, ?, ?, ?, ?)');
    const insRead = db.prepare('INSERT INTO volume_reads (volume_id, user_id, read_at) VALUES (?, ?, ?)');
    const insChapter = db.prepare('INSERT INTO chapter_progress (manga_id, user_id, chapters_read) VALUES (?, ?, ?)');
    const mangaId = {};
    for (const s of data.series) {
      mangaId[s.key] = Number(insManga.run(s.title, s.alt_title, s.author, s.publisher, s.status, s.tags, s.total_volumes, s.description, s.cover_image, s.banner_image,
        s.manga_passion_id, s.wish_priority, s.format, s.total_chapters, shelfId[s.shelf], userId.max).lastInsertRowid);
      stats.series++;
      for (const v of s.volumes) {
        const volumeId = Number(insVolume.run(mangaId[s.key], v.number, v.price, v.release_date, v.release_year, v.condition, v.pages, v.purchase_date, v.status, v.notes,
          v.cover_image, v.type, v.priority, v.target_price).lastInsertRowid);
        stats.volumes++;
        for (const o of v.owners) { insOwner.run(volumeId, userId[o.user], o.price, o.purchase_date, o.condition); stats.owners++; }
        for (const r of v.reads) { insRead.run(volumeId, userId[r.user], r.read_at); stats.reads++; }
      }
      for (const c of s.chapters) { insChapter.run(mangaId[s.key], userId[c.user], c.chapters_read); stats.chapters++; }
    }
    db.exec("UPDATE mangas SET owned_volumes = (SELECT count(*) FROM volumes v WHERE v.manga_id = mangas.id AND v.status = 'Vorhanden')");

    const insLink = db.prepare('INSERT INTO anime_links (anime_id, service, external_id, url) VALUES (?, ?, ?, ?)');
    const insProgress = db.prepare(`INSERT INTO anime_progress (anime_id, user_id, status, episodes_watched, score, started_at, finished_at, rating_visibility, public_comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const a of data.anime) {
      let meta = a.meta;
      if (a.tmdb_id) meta = { ...meta, urls: { ...meta.urls, tmdb: `https://www.themoviedb.org/${a.tmdb_kind}/${a.tmdb_id}` } };
      if (a.airing) { // a running season: next episode relative to the seeding day, total unknown like AniList has it for running shows
        meta = { ...meta, status: 'RELEASING', episodes: null, next_airing: { episode: a.airing.episode, at: Math.floor(nowMs / 1000) + a.airing.in_days * 86400 }, next_airing_estimated: false };
      }
      const columns = {
        ...snapshotColumns(meta, nowMs), anilist_id: meta.anilist_id, mal_id: meta.mal_id, kind: 'anime', tmdb_id: a.tmdb_id, tmdb_kind: a.tmdb_kind,
        title: meta.title.preferred || meta.title.romaji, manga_id: mangaId[a.series], updated_by: userId.max,
        cover_image: meta.cover_url, cover_source: meta.cover_url, banner_image: meta.banner_url, banner_source: meta.banner_url
      };
      const keys = Object.keys(columns);
      const animeId = Number(db.prepare(`INSERT INTO animes (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => columns[k])).lastInsertRowid);
      stats.anime++;
      if (a.crunchyroll) insLink.run(animeId, 'crunchyroll', a.crunchyroll.external_id, a.crunchyroll.url);
      for (const p of a.progress) {
        insProgress.run(animeId, userId[p.user], p.status, p.episodes_watched, p.score, p.started_at, p.finished_at, p.visibility, p.comment);
        stats.progress++;
      }
    }
  });
  return stats;
}

/** Sets DATA_DIR, loads db.js, fills the database and writes the demo logins. Call once per process. */
function seedDataDir(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-seed-')));
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';
  const bcrypt = require('bcryptjs');
  const dbModule = require('../db');
  const bulk = isBulk(opts);
  const started = Date.now();
  let stats;
  let logins;
  if (bulk) {
    const passwords = Object.fromEntries(DEMO_USERS.map(([name]) => [name, crypto.randomBytes(12).toString('base64url')]));
    const passwordHashes = Object.fromEntries(Object.entries(passwords).map(([name, pw]) => [name, bcrypt.hashSync(pw, 10)]));
    stats = seedDatabase(dbModule, { ...DEFAULTS, ...opts, passwordHashes });
    logins = DEMO_USERS.map(([username, role]) => ({ username, role, password: passwords[username] }));
  } else {
    const data = readDemoData();
    stats = seedDemo(dbModule, data, bcrypt.hashSync(data.password, 10));
    logins = data.users.map(u => ({ username: u.username, role: u.role, password: data.password }));
  }
  stats.ms = Date.now() - started;
  const usersFile = path.join(dataDir, USERS_FILE);
  fs.writeFileSync(usersFile, `${JSON.stringify({ seed: bulk ? (opts.seed ?? DEFAULTS.seed) : 'demo', users: logins }, null, 2)}\n`, { mode: 0o600 });
  dbModule.closeDb();
  return { dataDir, usersFile, stats };
}

/** Summary of a seeded demo database, printed after the run. */
function demoSummary(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'manga.db'), { readOnly: true });
  try {
    const n = sql => db.prepare(sql).get().n;
    const eur = sql => Math.round(db.prepare(sql).get().n * 100) / 100;
    return {
      series: n('SELECT count(*) AS n FROM mangas'),
      collectionSeries: n('SELECT count(*) AS n FROM mangas WHERE wish_priority IS NULL'),
      wishlistSeries: n('SELECT count(*) AS n FROM mangas WHERE wish_priority IS NOT NULL'),
      volumes: n('SELECT count(*) AS n FROM volumes'),
      ownedVolumes: n("SELECT count(*) AS n FROM volumes WHERE status = 'Vorhanden'"),
      collectionValueEur: eur("SELECT sum(price) AS n FROM volumes WHERE status = 'Vorhanden'"),
      priceSumOfAllRowsEur: eur('SELECT sum(price) AS n FROM volumes'),
      mangaWithoutAnime: n("SELECT count(*) AS n FROM mangas m WHERE m.format = 'print' AND m.wish_priority IS NULL AND NOT EXISTS (SELECT 1 FROM animes a WHERE a.manga_id = m.id)"),
      mangaWithAnime: n('SELECT count(DISTINCT manga_id) AS n FROM animes WHERE manga_id IS NOT NULL'),
      webtoons: n("SELECT count(*) AS n FROM mangas WHERE format = 'webtoon'"),
      shoppingListVolumes: n("SELECT count(*) AS n FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE v.status IN ('Fehlt', 'Vorbestellt') AND m.wish_priority IS NULL"),
      wishlistVolumes: n("SELECT count(*) AS n FROM volumes v JOIN mangas m ON m.id = v.manga_id WHERE v.status = 'Fehlt' AND m.wish_priority IS NOT NULL"),
      anime: n('SELECT count(*) AS n FROM animes'),
      animeStatusRows: n('SELECT count(*) AS n FROM anime_progress'),
      users: db.prepare(`SELECT u.username, u.role,
        (SELECT group_concat(sm.shelf_id || ':' || sm.role, ' ') FROM shelf_members sm WHERE sm.user_id = u.id) AS shelves,
        (SELECT count(*) FROM volume_owners o WHERE o.user_id = u.id) AS owns,
        (SELECT count(*) FROM volume_reads r WHERE r.user_id = u.id) AS reads,
        (SELECT count(*) FROM anime_progress p WHERE p.user_id = u.id) AS animeEntries FROM users u ORDER BY u.id`).all()
    };
  } finally {
    db.close();
  }
}

const isBulk = opts => ['series', 'volumes', 'seed'].some(k => opts[k] !== undefined);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.refreshFixtures) {
    const { fetchAll } = require('./lib/demoFetch');
    const { buildDemoData } = require('./lib/demoSpec');
    console.error('Hole Fixtures von AniList und Manga Passion …');
    const data = buildDemoData(await fetchAll(msg => console.error(msg)));
    fs.writeFileSync(DEMO_FILE, `${JSON.stringify(data, null, 1)}\n`);
    console.error(`scripts/demo-data.json geschrieben (${data.series.length} Reihen, ${data.anime.length} Anime${data.missing_anime.length ? `, ohne Anime-Treffer: ${data.missing_anime.join(', ')}` : ''})`);
    if (!opts.dataDir && !process.env.DATA_DIR) return;
  }
  const { dataDir, usersFile, stats } = seedDataDir(opts);
  console.log(JSON.stringify({ dataDir, usersFile, ...stats }));
  if (!isBulk(opts)) console.error(JSON.stringify(demoSummary(dataDir), null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Seed fehlgeschlagen: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { mulberry32, parseArgs, seriesSizes, seedDatabase, seedDemo, seedDataDir, demoSummary, DEFAULTS, USERS_FILE, DEMO_USERS, DEMO_FILE };
