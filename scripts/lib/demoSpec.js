// The editorial part of the demo collection: users, shelves and the 37 series (+ 2 wishlist series) with their rules.
// buildDemoData(fetched) turns it, plus what scripts/lib/demoFetch.js got from AniList and Manga Passion, into the
// self-contained scripts/demo-data.json that scripts/seed.js reads (offline, deterministic).
const { mulberry32 } = require('./rng');

const ANCHOR = '2026-10-01'; // "today" of the demo data; read dates and purchases are relative to it
const PASSWORD = 'demo1234';

const USERS = [
  { username: 'max', role: 'admin', color: '#6366f1', note: 'Hauptsammler & Server-Admin' },
  { username: 'lena', role: 'editor', color: '#ec4899', note: 'Partnerin, Co-Verwalterin der Hauptregale' },
  { username: 'lukas', role: 'editor', color: '#64748b', note: 'Seinen & Dark Fantasy' },
  { username: 'sarah', role: 'editor', color: '#f59e0b', note: 'Slice of Life, Romance & Fantasy' },
  { username: 'felix', role: 'editor', color: '#ef4444', note: 'Shonen & Sport' },
  { username: 'nina', role: 'editor', color: '#10b981', note: 'Webtoons, Deluxe & Farbschnitt' },
  { username: 'jonas', role: 'editor', color: '#0ea5e9', note: 'Gelegenheitsleser' },
  { username: 'tim', role: 'guest', color: '#a855f7', note: 'Reiner Viewer, keine Schreibrechte' }
];

// shelf 1 is the household shelf every database has; it is renamed, the others are created
const SHELVES = [
  { key: 'living', id: 1, name: 'Wohnzimmer-Hauptregal (Geteilt)', color: '#6366f1', owner: 'max',
    members: { max: 'owner', lena: 'editor', lukas: 'editor', felix: 'viewer', sarah: 'viewer', nina: 'viewer', jonas: 'viewer', tim: 'viewer' } },
  { key: 'study', name: "Max' Arbeitszimmer (Privat)", color: '#0ea5e9', owner: 'max', members: { max: 'owner' } },
  { key: 'cosy', name: "Lenas & Sarahs Wohlfühlecke (Geteilt)", color: '#ec4899', owner: 'lena', members: { lena: 'owner', sarah: 'editor', max: 'viewer', tim: 'viewer' } },
  { key: 'vault', name: "Lukas' Dark & Seinen Vault (Geteilt)", color: '#475569', owner: 'lukas', members: { lukas: 'owner', max: 'editor', felix: 'viewer', tim: 'viewer' } },
  { key: 'lounge', name: 'Ninas Webtoon & Deluxe Lounge (Geteilt)', color: '#10b981', owner: 'nina', members: { nina: 'owner', lena: 'viewer', sarah: 'viewer', tim: 'viewer' } },
  { key: 'locker', name: "Felix' Shonen Locker (Privat)", color: '#ef4444', owner: 'felix', members: { felix: 'owner' } },
  { key: 'stack', name: "Jonas' kleiner Lesestapel (Privat)", color: '#f59e0b', owner: 'jonas', members: { jonas: 'owner' } }
];

// tier ranges from the brief, euro: std 7-8.5, large 10-12, web 16, max 12-14, deluxe 20-25
// n = volumes 1..n, absent = numbers with no row at all (real gaps for the gap finder), fehlt = rows with status Fehlt,
// pre = ordered/announced rows, notes = { number: text | { note, price, type? } }, anime = has an anime entry
const SERIES = [
  // A: manga with anime
  { k: 'dandadan', t: 'Dandadan', pub: 'Crunchyroll', shelf: 'living', p: 7.0, n: 10, anime: true, st: 'Laufend', notes: { 1: '1. Auflage mit exklusivem Lesezeichen & Metallic-Folie' } },
  { k: 'eyeshield', t: 'Eyeshield 21', pub: 'Egmont Manga', shelf: 'locker', p: 7.0, n: 8, anime: true, st: 'Abgeschlossen' },
  { k: 'frieren', t: 'Frieren – Nach dem Ende der Reise', mp: 'Frieren', al: 'Sousou no Frieren', pub: 'Altraverse', shelf: 'living', p: 8.0, n: 11, anime: true, st: 'Laufend',
    notes: { 1: 'Erstauflage mit Farbpostkarte' }, wish: [{ n: '12', type: 'special_edition', note: 'Special Edition', price: 14.0, prio: 3 }] },
  { k: 'chainsaw', t: 'Chainsaw Man', pub: 'Egmont Manga', shelf: 'living', p: 7.0, n: 11, anime: true, st: 'Abgeschlossen',
    notes: { 1: '1. Auflage mit Mini-Print', 11: { note: 'Im gefüllten Sammelschuber mit Part 1', price: 22.0 } } },
  { k: 'jjk', t: 'Jujutsu Kaisen', pub: 'Crunchyroll', shelf: 'living', p: 7.0, n: 15, anime: true, st: 'Abgeschlossen', fehlt: [9, 12] },
  { k: 'spy', t: 'Spy × Family', al: 'Spy x Family', mp: 'Spy x Family', pub: 'Crunchyroll', shelf: 'living', p: 7.0, n: 11, anime: true, st: 'Laufend' },
  { k: 'dungeon', t: 'Delicious in Dungeon', mp: 'Delicious in Dungeon', al: 'Dungeon Meshi', pub: 'Egmont Manga', shelf: 'stack', p: 8.5, n: 10, anime: true, st: 'Abgeschlossen' },
  { k: 'onepiece', t: 'One Piece', pub: 'Carlsen Manga', shelf: 'living', p: 7.0, n: 12, anime: true, st: 'Laufend' },
  { k: 'berserk', t: 'Berserk', mp: 'Berserk Max', pub: 'Panini Manga', shelf: 'study', p: 14.0, n: 6, anime: true, st: 'Laufend',
    se: [{ n: '1', note: 'Berserk Ultimative Edition (Hardcover)', price: 25.0 }] },
  { k: 'vinland', t: 'Vinland Saga', pub: 'Carlsen Manga', shelf: 'vault', p: 11.0, n: 8, anime: true, st: 'Laufend', absent: [3] },
  { k: 'haikyu', t: 'Haikyu!!', pub: 'Crunchyroll', shelf: 'locker', p: 7.0, n: 10, anime: true, st: 'Abgeschlossen', absent: [5, 7] },
  { k: 'bluelock', t: 'Blue Lock', pub: 'Crunchyroll', shelf: 'locker', p: 7.5, n: 9, anime: true, st: 'Laufend', absent: [4] },
  { k: 'apothekerin', t: 'Die Tagebücher der Apothekerin', mp: 'Apothekerin', al: 'Kusuriya no Hitorigoto', pub: 'Manga Cult', shelf: 'cosy', p: 10.5, n: 7, anime: true, st: 'Laufend' },
  { k: 'demonslayer', t: 'Demon Slayer', al: 'Kimetsu no Yaiba', pub: 'Manga Cult', shelf: 'stack', p: 7.5, n: 8, anime: true, st: 'Abgeschlossen', absent: [5],
    notes: { 8: { note: 'Mit Leerschuber', price: 20.0 } } },
  { k: 'slime', t: 'Meine Wiedergeburt als Schleim in einer anderen Welt', mp: 'Meine Wiedergeburt als Schleim in einer anderen Welt', al: 'Tensei Shitara Slime datta Ken', pub: 'Altraverse', shelf: 'living', p: 7.5, n: 10, anime: true, st: 'Laufend' },
  // B: manga without anime
  { k: 'vagabond', t: 'Vagabond', pub: 'Egmont Manga', shelf: 'vault', p: 12.0, n: 10, st: 'Laufend', fehlt: [11], fehltNote: 'Neuerscheinung' },
  { k: 'punpun', t: 'Gute Nacht, Punpun', al: 'Oyasumi Punpun', mp: 'Punpun', pub: 'Tokyopop', shelf: 'study', p: 10.0, n: 7, st: 'Abgeschlossen' },
  { k: '20cb', t: '20th Century Boys', pub: 'Panini Manga', shelf: 'vault', p: 12.0, n: 6, st: 'Abgeschlossen' },
  { k: 'billybat', t: 'Billy Bat', pub: 'Carlsen Manga', shelf: 'vault', p: 8.0, n: 6, st: 'Abgeschlossen' },
  { k: 'real', t: 'Real', pub: 'Carlsen Manga', shelf: 'study', p: 8.5, n: 5, st: 'Laufend', notes: { 1: 'Signiert von Takehiko Inoue auf der Connichi 2024' } },
  { k: 'choujinx', t: 'Choujin X', pub: 'Tokyopop', shelf: 'vault', p: 7.5, n: 6, st: 'Laufend' },
  { k: 'akane', t: 'Akane-banashi', pub: 'Carlsen Manga', shelf: 'cosy', p: 7.0, n: 4, st: 'Laufend' },
  { k: 'firepunch', t: 'Fire Punch', pub: 'Crunchyroll', shelf: 'vault', p: 7.5, n: 8, st: 'Abgeschlossen' },
  { k: 'homunculus', t: 'Homunculus', pub: 'Panini Manga', shelf: 'study', p: 12.0, n: 5, st: 'Abgeschlossen' },
  { k: 'innocent', t: 'Innocent', pub: 'Tokyopop', shelf: 'vault', p: 10.0, n: 6, st: 'Abgeschlossen' },
  { k: 'climber', t: 'The Climber', al: 'Kokou no Hito', mp: 'Climber', pub: 'Manga Cult', shelf: 'study', p: 10.0, n: 4, st: 'Abgeschlossen' },
  { k: 'takopi', t: 'Takopis ursprüngliche Sünde', al: 'Takopii no Genzai', pub: 'Carlsen Manga', shelf: 'cosy', p: 8.0, n: 2, st: 'Abgeschlossen' },
  { k: 'iamhero', t: 'I am a Hero', pub: 'Carlsen Manga', shelf: 'vault', p: 8.0, n: 6, st: 'Abgeschlossen' },
  // C: webtoons / manhwa, full colour
  { k: 'sololeveling', t: 'Solo Leveling', pub: 'Altraverse', shelf: 'lounge', p: 16.0, n: 8, web: true, anime: true, st: 'Abgeschlossen', notes: { 1: 'Erstauflage mit limitiertem Farbschnitt' } },
  { k: 'orv', t: "Omniscient Reader's Viewpoint", al: "Omniscient Reader's Viewpoint", mp: 'Omniscient Reader', pub: 'Carlsen Manga', shelf: 'lounge', p: 16.0, n: 5, web: true, st: 'Laufend' },
  { k: 'eleceed', t: 'Eleceed', pub: 'Papertoons', shelf: 'lounge', p: 16.0, n: 4, web: true, st: 'Laufend', pre: [{ n: 5, date: '2026-12-10' }] },
  { k: 'boxer', t: 'The Boxer', pub: 'Altraverse', shelf: 'lounge', p: 16.0, n: 5, web: true, st: 'Abgeschlossen' },
  { k: 'villains', t: 'Villains Are Destined to Die', pub: 'Altraverse', shelf: 'lounge', p: 16.0, n: 4, web: true, st: 'Laufend', notes: { 1: 'Mit speziellem Farbschnitt' } },
  { k: 'tog', t: 'Tower of God', mp: 'Tower of God', al: 'Tower of God', pub: 'K-Toons', shelf: 'lounge', p: 16.0, n: 4, web: true, anime: true, st: 'Laufend' },
  { k: 'bastard', t: 'Bastard', pub: 'Altraverse', shelf: 'lounge', p: 16.0, n: 5, web: true, st: 'Abgeschlossen' },
  { k: 'sweethome', t: 'Sweet Home', pub: 'Altraverse', shelf: 'lounge', p: 16.0, n: 6, web: true, st: 'Abgeschlossen' },
  { k: 'princess', t: 'Plötzlich Prinzessin', al: 'Who Made Me a Princess', mp: 'Plötzlich Prinzessin', pub: 'Altraverse', shelf: 'lounge', p: 16.0, n: 5, web: true, st: 'Abgeschlossen' },
  { k: 'returner', t: "A Returner's Magic Should Be Special", al: "A Returner's Magic Should Be Special", pub: 'Altraverse', shelf: 'lounge', p: 16.0, n: 4, web: true, anime: true, st: 'Laufend' },
  // wishlist-only series (no volume owned)
  { k: 'signofaffection', t: 'Ein Zeichen der Zuneigung', al: 'Yubisaki to Renren', mp: 'Zeichen der Zuneigung', pub: 'Carlsen Manga', shelf: 'cosy', p: 8.0, n: 0, wishlist: 3, st: 'Laufend',
    wish: [1, 2, 3].map(n => ({ n: String(n), type: 'volume', price: 8.0, prio: 3 })) },
  { k: 'slamdunk', t: 'Slam Dunk', pub: 'Carlsen Manga', shelf: 'locker', p: 8.0, n: 0, wishlist: 3, st: 'Abgeschlossen',
    wish: [{ n: 'Gesamtausgabe', type: 'special', note: 'Gesamtausgabe', price: 25.0, prio: 3 }] }
];

// who reads/watches how much is decided once here with a fixed seed and stored explicitly in the JSON
const pad = n => String(n).padStart(2, '0');
function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const CONDITIONS = ['Neuwertig', 'Neuwertig', 'Sehr gut', 'Gut'];

function buildSeries(spec, f, rand, shelfByKey) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = list => list[Math.floor(rand() * list.length)];
  const manga = f.manga || {};
  const mp = spec.wishlist ? null : (f.mp || null); // wishlist series keep no Manga Passion data (nothing is owned)
  const shelf = shelfByKey[spec.shelf];
  const writers = Object.entries(shelf.members).filter(([, r]) => r !== 'viewer').map(([u]) => u);
  const everyone = Object.keys(shelf.members);
  const series = {
    key: spec.k, title: spec.t, alt_title: manga.alt_title || null, author: manga.author || (mp && mp.author) || null, publisher: spec.pub, shelf: spec.shelf,
    format: spec.web ? 'webtoon' : 'print', language: 'de', status: spec.st, collecting: 'aktiv',
    tags: manga.tags || (mp && mp.tags) || null,
    total_volumes: spec.wishlist ? null : (mp && !spec.web && mp.total_volumes && mp.total_volumes >= spec.n ? mp.total_volumes : (spec.st === 'Abgeschlossen' ? spec.n : null)),
    total_chapters: spec.web ? (manga.total_chapters || null) : null,
    description: manga.description || (mp && mp.description) || null,
    cover_image: (mp && mp.cover_image) || manga.cover_image || null,
    banner_image: manga.banner_image || null,
    manga_passion_id: !spec.web && mp ? mp.id : null,
    anilist_id: manga.anilist_id || null, mal_id: manga.mal_id || null,
    wish_priority: spec.wishlist || null,
    anime: spec.anime ? spec.k : null,
    volumes: [], chapters: []
  };
  const mpVol = number => (mp && mp.volumes && mp.volumes[number]) || {};
  const purchaseFor = number => {
    const rel = mpVol(number).release_date;
    const base = rel && /^\d{4}-\d{2}-\d{2}$/.test(rel) && rel >= '2021-03-01' && rel < ANCHOR ? rel : addDays('2021-03-01', int(0, 1700)); // the collection starts in 2021
    // a quarter of the purchases are recent, so the spending charts of the last 12 months are not empty
    const recent = rand() < 0.25 && !(rel && rel > '2025-11-05') ? addDays('2025-11-05', int(0, 320)) : null;
    const day = recent || addDays(base, int(0, 60));
    return day > ANCHOR ? ANCHOR : day;
  };
  const baseVolume = (number, type, status, price) => {
    const m = type === 'volume' ? mpVol(number) : {};
    const rd = m.release_date || null;
    return {
      number: String(number), type, status, price, release_date: rd, release_year: rd ? Number(rd.slice(0, 4)) : null,
      pages: m.pages || null, cover_image: m.cover_image || null, notes: null, priority: 0, target_price: null,
      purchase_date: null, condition: null, owners: [], reads: []
    };
  };
  const rows = [];
  const absent = new Set(spec.absent || []);
  const fehlt = new Set(spec.fehlt || []);
  for (let i = 1; i <= spec.n; i++) {
    if (absent.has(i)) continue;
    const note = spec.notes && spec.notes[i];
    const price = note && typeof note === 'object' && note.price ? note.price : spec.p;
    const v = baseVolume(i, 'volume', fehlt.has(i) ? 'Fehlt' : 'Vorhanden', price);
    if (note) v.notes = typeof note === 'object' ? note.note : note;
    if (fehlt.has(i)) { v.priority = 2; if (spec.fehltNote) v.notes = spec.fehltNote; }
    rows.push(v);
  }
  for (const n of fehlt) if (n > spec.n) { // a volume after the last owned one (new release)
    const v = baseVolume(n, 'volume', 'Fehlt', spec.p); v.priority = 2; v.notes = spec.fehltNote || null; v.release_date = '2026-09-25'; v.release_year = 2026; rows.push(v);
  }
  for (const p of spec.pre || []) {
    const v = baseVolume(p.n, 'volume', 'Vorbestellt', spec.p);
    v.release_date = p.date; v.release_year = Number(p.date.slice(0, 4)); v.cover_image = null; rows.push(v);
  }
  for (const s of spec.se || []) {
    const v = baseVolume(s.n, 'special_edition', 'Vorhanden', s.price); v.notes = s.note; rows.push(v);
  }
  for (const w of spec.wish || []) {
    const v = baseVolume(w.n, w.type, 'Fehlt', w.price);
    v.priority = w.prio; v.target_price = w.price; v.notes = w.note || null; rows.push(v);
  }

  const seriesPurchases = {};
  for (const v of rows) {
    if (v.status !== 'Vorhanden') continue;
    const pool = writers.filter(u => u !== 'tim');
    const owners = pool.length > 1 && v.type === 'volume' && rand() < 0.35 ? [pool[0], pool[1]] : [pick(pool)];
    v.purchase_date = seriesPurchases[v.number] = purchaseFor(v.number);
    v.condition = pick(CONDITIONS);
    v.owners = owners.map(user => ({ user, price: v.price, purchase_date: v.purchase_date, condition: v.condition }));
  }
  // reading: every member reads a prefix of the owned volumes (or nothing); the viewers and tim read too
  const owned = rows.filter(v => v.status === 'Vorhanden' && v.type === 'volume').sort((a, b) => Number(a.number) - Number(b.number));
  for (const user of everyone) {
    const isOwner = owned.some(v => v.owners.some(o => o.user === user));
    const roll = rand();
    const frac = roll < (isOwner ? 0.1 : 0.5) ? 0 : roll < (isOwner ? 0.4 : 0.75) ? 0.4 : roll < (isOwner ? 0.65 : 0.9) ? 0.7 : 1;
    const upTo = Math.ceil(owned.length * frac);
    owned.slice(0, upTo).forEach((v, idx) => {
      const sincePurchase = Math.max(1, Math.floor((Date.parse(ANCHOR) - Date.parse(v.purchase_date)) / 86400000));
      const days = Math.min(sincePurchase, Math.max(5, (owned.length - idx) * int(12, 40) + int(0, 60)));
      v.reads.push({ user, read_at: `${addDays(ANCHOR, -days)} ${pad(int(7, 22))}:${pad(int(0, 59))}:00` });
    });
  }
  for (const user of spec.web ? everyone : []) {
    const roll = rand();
    if (roll < 0.25) continue;
    const total = series.total_chapters || spec.n * 40;
    series.chapters.push({ user, chapters_read: Math.max(1, Math.round(total * (user === 'tim' ? 0.2 : [0.35, 0.6, 0.85, 1][int(0, 3)]))) });
  }
  series.volumes = rows;
  return series;
}

// running seasons: the seeder turns in_days into a real air time, so the anime radar always has something coming up
const AIRING = { dandadan: { episode: 13, in_days: 2 }, spy: { episode: 13, in_days: 4 }, bluelock: { episode: 25, in_days: 6 } };

// one anime entry per aired TV season, like the app keeps them (a later season only after the earlier one was finished)
const crunchyrollOf = meta => {
  const link = (meta.external_links || []).find(l => /crunchyroll/i.test(l.site || '') && /\/series\/([A-Z0-9]+)/i.test(l.url));
  if (!link) return null;
  const id = /\/series\/([A-Z0-9]+)/i.exec(link.url)[1].toUpperCase();
  return { external_id: id, url: `https://www.crunchyroll.com/series/${id}` };
};

const STATUS_MAP = { WATCHING: 'Schaue', COMPLETED: 'Gesehen', PLANNING: 'Geplant', DROPPED: 'Abgebrochen' };
const WEIGHTS = [['COMPLETED', 0.36], ['WATCHING', 0.26], ['PLANNING', 0.2], ['DROPPED', 0.18]];
const COMMENTS = ['Starke Animation, gern mehr davon.', 'Der Manga ist besser.', 'Perfekt für den Feierabend.', 'Opening läuft bei uns in Dauerschleife.', null, null, null];

function buildAnime(animeSeries, fetchedAnime, rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const users = USERS.map(u => u.username);
  const perAnime = animeSeries.map(() => new Set());
  // every account gets at least two entries (tim, the viewer, planning/tracking only), the rest is random
  users.forEach((u, i) => { perAnime[i % animeSeries.length].add(u); perAnime[(i * 3 + 5) % animeSeries.length].add(u); });
  animeSeries.forEach((_, i) => { while (perAnime[i].size < 3) perAnime[i].add(users[int(0, 6)]); });
  const progressOf = (user, kind, total, running) => {
    if (running && kind === 'COMPLETED') kind = 'WATCHING'; // a running anime cannot be finished
    const done = kind === 'COMPLETED' ? total : kind === 'WATCHING' ? (running ? total - int(0, 3) : int(1, Math.max(1, total - 1))) : kind === 'DROPPED' ? int(1, Math.min(total, 6)) : 0;
    const score = kind === 'PLANNING' ? null : kind === 'DROPPED' ? int(3, 6) : int(6, 10);
    const finished = kind === 'COMPLETED' ? addDays(ANCHOR, -int(14, 420)) : null;
    const started = kind === 'PLANNING' ? null : addDays(finished || ANCHOR, -int(10, 90));
    return {
      user, anilist_status: kind, status: STATUS_MAP[kind], episodes_watched: done, score, started_at: started, finished_at: finished,
      visibility: kind === 'DROPPED' ? 'anonymous' : 'public', comment: score && score >= 8 ? COMMENTS[int(0, COMMENTS.length - 1)] : null
    };
  };
  const entries = [];
  animeSeries.forEach((s, i) => {
    const f = fetchedAnime[s.k];
    if (!f) return;
    const metas = f.seasons && f.seasons.length ? f.seasons : [f.meta];
    let previous = null;
    metas.forEach((meta, n) => {
      const last = n === metas.length - 1;
      const running = Boolean(AIRING[s.k]) && last;
      const total = meta.episodes || 12;
      let progress;
      if (n === 0) {
        progress = [...perAnime[i]].map(user => {
          let r = rand();
          let kind = WEIGHTS.find(([, w]) => (r -= w) < 0)?.[0] || 'COMPLETED';
          if (user === 'tim' && kind === 'DROPPED') kind = 'PLANNING';
          return progressOf(user, kind, total, running);
        });
      } else { // a later season only for people who finished the one before (or planned it)
        progress = previous.flatMap(p => {
          if (p.anilist_status === 'COMPLETED') {
            const r = rand();
            return r < 0.15 ? [] : [progressOf(p.user, running || r > 0.7 ? 'WATCHING' : 'COMPLETED', total, running)];
          }
          return p.anilist_status === 'PLANNING' && rand() < 0.5 ? [progressOf(p.user, 'PLANNING', total, false)] : [];
        });
      }
      previous = progress;
      entries.push({
        key: n === 0 ? s.k : `${s.k}-s${n + 1}`, series: s.k, season: n + 1,
        tmdb_id: n === 0 ? f.tmdb_id || null : null, tmdb_kind: n === 0 ? f.tmdb_kind || null : null, // one TMDb series, one entry
        meta, crunchyroll: crunchyrollOf(meta) || (n === 0 ? f.crunchyroll || null : null), airing: running ? AIRING[s.k] : null, progress
      });
    });
  });
  return entries;
}

/** fetched = { <key>: { manga, mp, anime } } from demoFetch.fetchAll(); returns the whole demo-data.json object. */
function buildDemoData(fetched) {
  const rand = mulberry32(2026);
  const shelfByKey = Object.fromEntries(SHELVES.map(s => [s.key, s]));
  const series = SPEC_ORDER().map(spec => buildSeries(spec, fetched[spec.k] || {}, rand, shelfByKey));
  const animeFetched = Object.fromEntries(Object.entries(fetched).filter(([, v]) => v.anime).map(([k, v]) => [k, v.anime]));
  const anime = buildAnime(SERIES.filter(s => s.anime), animeFetched, rand);
  const missing = SERIES.filter(s => s.anime && !animeFetched[s.k]).map(s => s.k);
  return {
    format: 1, anchor: ANCHOR, password: PASSWORD, fetched_at: new Date().toISOString().slice(0, 10),
    note: 'Erzeugt von node scripts/seed.js --refresh-fixtures (AniList + Manga Passion). Nicht von Hand pflegen: Redaktion in scripts/lib/demoSpec.js.',
    users: USERS, shelves: SHELVES, series, anime, missing_anime: missing
  };
}
const SPEC_ORDER = () => SERIES;

module.exports = { ANCHOR, PASSWORD, USERS, SHELVES, SERIES, buildDemoData };
