// Deterministic demo collection for benchmarks and local development, written through db.js.
//   npm run seed -- [--series 1500] [--volumes 45000] [--seed 42] [--data-dir <dir>]
// Without --data-dir (and without DATA_DIR) a fresh temp folder is used. Only an empty database is filled.
// The demo users get random passwords, written to <data-dir>/seed-users.json.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { manualWorkKey } = require('../core/lib/language');

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

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === '--data-dir') { opts.dataDir = value; i++; continue; }
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

/** Sets DATA_DIR, loads db.js, fills the database and writes the demo logins. Call once per process. */
function seedDataDir(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-seed-')));
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'warn';
  const bcrypt = require('bcryptjs');
  const dbModule = require('../db');
  const passwords = Object.fromEntries(DEMO_USERS.map(([name]) => [name, crypto.randomBytes(12).toString('base64url')]));
  const passwordHashes = Object.fromEntries(Object.entries(passwords).map(([name, pw]) => [name, bcrypt.hashSync(pw, 10)]));
  const started = Date.now();
  const stats = seedDatabase(dbModule, { ...DEFAULTS, ...opts, passwordHashes });
  stats.ms = Date.now() - started;
  const usersFile = path.join(dataDir, USERS_FILE);
  const logins = DEMO_USERS.map(([username, role]) => ({ username, role, password: passwords[username] }));
  fs.writeFileSync(usersFile, `${JSON.stringify({ seed: opts.seed ?? DEFAULTS.seed, users: logins }, null, 2)}\n`, { mode: 0o600 });
  dbModule.closeDb();
  return { dataDir, usersFile, stats };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { dataDir, usersFile, stats } = seedDataDir(opts);
    console.log(JSON.stringify({ dataDir, usersFile, ...stats }));
  } catch (err) {
    console.error(`Seed fehlgeschlagen: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { mulberry32, parseArgs, seriesSizes, seedDatabase, seedDataDir, DEFAULTS, USERS_FILE, DEMO_USERS };
