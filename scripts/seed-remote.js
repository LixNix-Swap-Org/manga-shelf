// Seeds three demo series (with covers and volumes) into a running instance; existing titles are skipped.
//   node scripts/seed-remote.js <url | host [port]> [--wipe] [--yes]   (--wipe recreates only the demo series)
// Target and credentials as in scripts/lib/remote.js (REMOTE_*, ADMIN_USER/ADMIN_PASS); SEED_SKIP_COVERS=1 skips covers.
require('dotenv').config({ quiet: true });
const readline = require('readline');
const { resolveTarget, assertSecureTarget, credentials, RemoteClient } = require('./lib/remote');

const DEMO_SERIES = [
  {
    title: 'One Piece',
    author: 'Eiichiro Oda',
    publisher: 'Carlsen Manga',
    status: 'Laufend',
    total_volumes: 108,
    description: 'Monkey D. Ruffy hat nur ein Ziel: Er will König der Piraten werden! Um dieses Ziel zu erreichen, begibt er sich auf die Suche nach dem legendären Schatz "One Piece", den der frühere Piratenkönig Gol D. Roger hinterlassen hat. Zusammen mit seiner treuen Strohhut-Bande bereist er die gefährliche Grandline.',
    coverSourceUrl: 'https://cdn.myanimelist.net/images/manga/2/253146.jpg',
    coverFilename: 'one_piece.jpg',
    volumes: [
      { volume_number: 1, title: 'Das Abenteuer beginnt', price: 7.00, condition: 'Sehr gut', release_year: 2001, isbn: '978-3-551-74861-4', notes: 'Erstauflage Carlsen', status: 'Vorhanden' },
      { volume_number: 2, title: 'Ruffy versus Buggy der Clown', price: 7.00, condition: 'Sehr gut', release_year: 2001, isbn: '978-3-551-74862-1', notes: '', status: 'Vorhanden' },
      { volume_number: 3, title: 'Die Geheimnisse der Meere', price: 7.00, condition: 'Gut', release_year: 2001, isbn: '978-3-551-74863-8', notes: 'Leichte Gebrauchsspuren am Buchrücken', status: 'Vorhanden' },
      { volume_number: 4, title: 'Der Wolf im Schafspelz', price: 7.00, condition: 'Sehr gut', release_year: 2002, isbn: '978-3-551-74864-5', notes: '', status: 'Vorhanden' },
      { volume_number: 5, title: 'Wem schlägt die Stunde?', price: 7.00, condition: 'Neuwertig', release_year: 2002, isbn: '978-3-551-74865-2', notes: '', status: 'Vorhanden' },
      { volume_number: 6, title: 'Gerechter Zorn', price: 7.00, condition: 'Sehr gut', release_year: 2002, isbn: '978-3-551-74866-9', notes: '', status: 'Vorhanden' },
      { volume_number: 7, title: 'Der alte Mann', price: 7.00, condition: 'Sehr gut', release_year: 2002, isbn: '978-3-551-74867-6', notes: '', status: 'Vorhanden' },
      { volume_number: 8, title: 'Ich sterbe nicht!', price: 7.00, condition: 'Gut', release_year: 2002, isbn: '978-3-551-74868-3', notes: '', status: 'Vorhanden' },
      { volume_number: 9, title: 'Tränen', price: 7.00, condition: 'Neuwertig', release_year: 2002, isbn: '978-3-551-74869-0', notes: '', status: 'Vorhanden' },
      { volume_number: 10, title: 'Okay, let\'s stand up!', price: 7.00, condition: 'Neuwertig', release_year: 2003, isbn: '978-3-551-74870-6', notes: 'Ungelesen', status: 'Vorhanden' },
      { volume_number: 11, title: 'Der größte Schurke des Ostmeers', price: 7.00, condition: 'Neuwertig', release_year: 2003, isbn: '978-3-551-74871-3', notes: 'Auf der Wunschliste', status: 'Fehlt' },
      { volume_number: 12, title: 'Die Legende hat begonnen', price: 7.00, condition: 'Neuwertig', release_year: 2003, isbn: '978-3-551-74872-0', notes: 'Auf der Wunschliste', status: 'Fehlt' },
    ]
  },
  {
    title: 'Spy × Family',
    author: 'Tatsuya Endo',
    publisher: 'Crunchyroll',
    status: 'Laufend',
    total_volumes: 13,
    description: 'Meisterspion Twilight muss für seine bisher heikelste Mission eine Schein-Familie gründen: Die Operation Strix! Ohne es zu wissen, adoptiert er mit Anya eine telepathisch begabte Tochter und heiratet mit Yor eine tödliche Auftragskillerin. Keiner kennt die wahre Identität des anderen – das Chaos ist vorprogrammiert!',
    coverSourceUrl: 'https://cdn.myanimelist.net/images/manga/3/219741.jpg',
    coverFilename: 'spy_x_family.jpg',
    volumes: [
      { volume_number: 1, title: 'Mission 1', price: 8.50, condition: 'Neuwertig', release_year: 2020, isbn: '978-2-88951-344-4', notes: 'Erstauflage inkl. Extra Lesezeichen', status: 'Vorhanden' },
      { volume_number: 2, title: 'Mission 2', price: 8.50, condition: 'Neuwertig', release_year: 2020, isbn: '978-2-88951-345-1', notes: '', status: 'Vorhanden' },
      { volume_number: 3, title: 'Mission 3', price: 8.50, condition: 'Sehr gut', release_year: 2021, isbn: '978-2-88951-346-8', notes: '', status: 'Vorhanden' },
      { volume_number: 4, title: 'Mission 4', price: 8.50, condition: 'Neuwertig', release_year: 2021, isbn: '978-2-88951-347-5', notes: '', status: 'Vorhanden' },
      { volume_number: 5, title: 'Mission 5', price: 8.50, condition: 'Sehr gut', release_year: 2021, isbn: '978-2-88951-348-2', notes: '', status: 'Vorhanden' },
      { volume_number: 6, title: 'Mission 6', price: 8.50, condition: 'Neuwertig', release_year: 2022, isbn: '978-2-88951-349-9', notes: '', status: 'Vorhanden' },
      { volume_number: 7, title: 'Mission 7', price: 8.50, condition: 'Neuwertig', release_year: 2022, isbn: '978-2-88951-350-5', notes: '', status: 'Vorhanden' },
      { volume_number: 8, title: 'Mission 8', price: 8.50, condition: 'Sehr gut', release_year: 2023, isbn: '978-2-88951-351-2', notes: '', status: 'Vorhanden' },
      { volume_number: 9, title: 'Mission 9', price: 8.50, condition: 'Neuwertig', release_year: 2023, isbn: '978-2-88951-352-9', notes: '', status: 'Fehlt' },
      { volume_number: 10, title: 'Mission 10', price: 8.50, condition: 'Neuwertig', release_year: 2024, isbn: '978-2-88951-353-6', notes: '', status: 'Fehlt' },
    ]
  },
  {
    title: 'Demon Slayer: Kimetsu no Yaiba',
    author: 'Koyoharu Gotouge',
    publisher: 'Manga Cult',
    status: 'Abgeschlossen',
    total_volumes: 23,
    description: 'Japan zur Zeit der Taisho-Ära. Tanjiro Kamado lebt friedlich als ältester Sohn einer Köhlerfamilie, bis eines Tages ein Dämon seine Familie ermordet. Einzig seine Schwester Nezuko überlebt – doch sie wurde selbst in einen Dämon verwandelt. Tanjiro schließt sich den Dämonenjägern an, um ein Heilmittel für Nezuko zu finden.',
    coverSourceUrl: 'https://cdn.myanimelist.net/images/manga/3/179023.jpg',
    coverFilename: 'demon_slayer.jpg',
    volumes: [
      { volume_number: 1, title: 'Grausamkeit', price: 10.00, condition: 'Neuwertig', release_year: 2020, isbn: '978-3-96433-280-6', notes: 'Manga Cult Großformat', status: 'Vorhanden' },
      { volume_number: 2, title: 'Du warst es', price: 10.00, condition: 'Neuwertig', release_year: 2020, isbn: '978-3-96433-281-3', notes: '', status: 'Vorhanden' },
      { volume_number: 3, title: 'Zusammen sein', price: 10.00, condition: 'Sehr gut', release_year: 2020, isbn: '978-3-96433-282-0', notes: '', status: 'Vorhanden' },
      { volume_number: 4, title: 'Stark bleiben', price: 10.00, condition: 'Neuwertig', release_year: 2020, isbn: '978-3-96433-283-7', notes: '', status: 'Vorhanden' },
      { volume_number: 5, title: 'Zu Hölle fahren', price: 10.00, condition: 'Neuwertig', release_year: 2021, isbn: '978-3-96433-284-4', notes: '', status: 'Vorhanden' },
      { volume_number: 6, title: 'Das Treffen der Säulen', price: 10.00, condition: 'Sehr gut', release_year: 2021, isbn: '978-3-96433-285-1', notes: '', status: 'Vorhanden' },
      { volume_number: 7, title: 'Kämpfe um dein Leben', price: 10.00, condition: 'Neuwertig', release_year: 2021, isbn: '978-3-96433-286-8', notes: '', status: 'Vorhanden' },
      { volume_number: 8, title: 'Der Mugen-Zug', price: 10.00, condition: 'Neuwertig', release_year: 2021, isbn: '978-3-96433-287-5', notes: '', status: 'Fehlt' },
    ]
  }
];

const normTitle = t => String(t || '').trim().toLowerCase();

function parseFlags(argv) {
  return { wipe: argv.includes('--wipe'), yes: argv.includes('--yes') };
}

/** Which demo series to create and which existing series to delete; never anything but demo titles. */
function planSeed(existing, flags, demo = DEMO_SERIES) {
  const demoTitles = new Set(demo.map(m => normTitle(m.title)));
  const matching = existing.filter(m => demoTitles.has(normTitle(m.title)));
  if (flags.wipe) return { toDelete: matching, toCreate: demo, skipped: [] };
  const present = new Set(matching.map(m => normTitle(m.title)));
  return {
    toDelete: [],
    toCreate: demo.filter(m => !present.has(normTitle(m.title))),
    skipped: demo.filter(m => present.has(normTitle(m.title)))
  };
}

async function confirmWipe(target, count) {
  const host = new URL(target.baseUrl).hostname;
  if (!process.stdin.isTTY) throw new Error('--wipe ohne Terminal braucht zusätzlich --yes');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(`${count} Demo-Reihe(n) auf ${target.baseUrl} löschen und neu anlegen? Zum Bestätigen "${host}" eingeben: `, resolve));
  rl.close();
  if (answer.trim() !== host) throw new Error('Abgebrochen');
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (manga-shelf seed script)' } });
  if (!res.ok) throw new Error(`Download ${url}: Status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function uploadCover(client, buffer, filename) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: 'image/jpeg' }), filename);
  const res = await client.request('POST', '/api/upload', form);
  if (res.ok && res.data?.url) return res.data.url;
  throw new Error(`Upload fehlgeschlagen (Status ${res.status}): ${res.data?.error || res.text.slice(0, 200)}`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const flags = parseFlags(argv);
  const target = resolveTarget(argv, env);
  const { username, password } = credentials(env);
  console.log(`--- Ziel: ${target.baseUrl} (aus ${target.source}), Benutzer "${username}" ---`);
  assertSecureTarget(target, env);

  const client = new RemoteClient(target.baseUrl);
  await client.login(username, password);
  console.log('✓ Angemeldet als', username);

  const existingRes = await client.request('GET', '/api/mangas');
  if (!existingRes.ok || !Array.isArray(existingRes.data)) {
    throw new Error(`GET /api/mangas lieferte Status ${existingRes.status}`);
  }
  const plan = planSeed(existingRes.data, flags);
  for (const m of plan.skipped) console.log(`↷ "${m.title}" existiert bereits, übersprungen (--wipe legt Demo-Reihen neu an)`);
  if (plan.toDelete.length && !flags.yes) await confirmWipe(target, plan.toDelete.length);

  let failures = 0;
  for (const em of plan.toDelete) {
    const del = await client.request('DELETE', `/api/mangas/${em.id}`);
    if (del.ok) console.log(`  - Demo-Reihe ID ${em.id} (${em.title}) gelöscht`);
    else { failures++; console.error(`  ✗ Löschen von ID ${em.id} fehlgeschlagen (Status ${del.status})`); }
  }

  for (const m of plan.toCreate) {
    console.log(`\n▶ "${m.title}"...`);
    let coverUrl = '';
    if (!/^(1|true|yes)$/i.test(String(env.SEED_SKIP_COVERS || ''))) {
      try {
        coverUrl = await uploadCover(client, await downloadImage(m.coverSourceUrl), m.coverFilename);
        console.log(`  ✓ Cover: ${coverUrl}`);
      } catch (err) {
        console.warn(`  ⚠ Cover übersprungen: ${err.message}`);
      }
    }

    const createRes = await client.request('POST', '/api/mangas', {
      title: m.title,
      author: m.author,
      publisher: m.publisher,
      status: m.status,
      total_volumes: m.total_volumes,
      description: m.description,
      cover_image: coverUrl
    });
    if (!createRes.ok || !createRes.data?.id) {
      failures++;
      console.error(`  ✗ Anlegen fehlgeschlagen (Status ${createRes.status}):`, createRes.data?.error || createRes.text.slice(0, 200));
      continue;
    }
    const mangaId = createRes.data.id;
    console.log(`  ✓ Reihe angelegt (ID ${mangaId})`);

    for (const v of m.volumes) {
      const volRes = await client.request('POST', '/api/volumes', { manga_id: mangaId, ...v });
      if (!volRes.ok) {
        failures++;
        console.error(`    ✗ Band ${v.volume_number} fehlgeschlagen (Status ${volRes.status}):`, volRes.data?.error || '');
      }
    }
    console.log(`  ✓ ${m.volumes.length} Bände verarbeitet`);
  }

  if (failures) throw new Error(`${failures} Schritt(e) fehlgeschlagen`);
  console.log(`\n🎉 Fertig: ${plan.toCreate.length} Demo-Reihe(n) auf ${target.baseUrl} angelegt, ${plan.skipped.length} übersprungen.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`Fehler: ${err.cause ? `${err.message} (${err.cause.code || err.cause.message})` : err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { planSeed, parseFlags, DEMO_SERIES };
