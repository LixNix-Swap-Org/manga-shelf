const https = require('https');
const http = require('http');

const REMOTE_HOST = '159.195.49.57';
const REMOTE_PORT = 25502;
const USERNAME = 'Moltres';
const PASSWORD = 'Start1234!';

function request(method, path, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const isJson = data && typeof data === 'object' && !Buffer.isBuffer(data);
    const body = isJson ? JSON.stringify(data) : data;
    const reqHeaders = { ...headers };
    if (isJson) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    } else if (Buffer.isBuffer(data)) {
      reqHeaders['Content-Length'] = data.length;
    }

    const req = http.request({
      hostname: REMOTE_HOST,
      port: REMOTE_PORT,
      path: path,
      method: method,
      headers: reqHeaders
    }, res => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(resBody);
          resolve({ status: res.statusCode, headers: res.headers, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, text: resBody });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`Failed to download ${url}: status ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function uploadImage(cookie, buffer, filename) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
    `Content-Type: image/jpeg\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([header, buffer, footer]);

  const res = await request('POST', '/api/upload', payload, {
    'Cookie': cookie,
    'Content-Type': `multipart/form-data; boundary=${boundary}`
  });

  if (res.data && (res.data.url || res.data.imageUrl)) {
    return res.data.url || res.data.imageUrl;
  }
  throw new Error(`Upload failed: ${JSON.stringify(res.data || res.text)}`);
}

async function main() {
  console.log('--- Connecting to remote instance http://' + REMOTE_HOST + ':' + REMOTE_PORT + ' ---');

  // 1. Login
  const loginRes = await request('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
  if (loginRes.status !== 200 || !loginRes.headers['set-cookie']) {
    throw new Error('Login failed: ' + JSON.stringify(loginRes.data || loginRes.text));
  }
  const cookie = loginRes.headers['set-cookie'][0];
  console.log('✓ Successfully logged in as', USERNAME);

  // Manga definitions
  const mangasToCreate = [
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

  // Check existing mangas and clean them up so we don't have duplicates
  const existingRes = await request('GET', '/api/mangas', null, { 'Cookie': cookie });
  if (Array.isArray(existingRes.data) && existingRes.data.length > 0) {
    console.log(`Found ${existingRes.data.length} existing mangas. Cleaning up for clean seed...`);
    for (const em of existingRes.data) {
      await request('DELETE', `/api/mangas/${em.id}`, null, { 'Cookie': cookie });
      console.log(`  - Deleted existing manga ID ${em.id} (${em.title})`);
    }
  }

  for (const m of mangasToCreate) {
    console.log(`\n▶ Processing "${m.title}"...`);

    // 2. Download and upload cover
    let coverUrl = null;
    try {
      console.log(`  Downloading cover from ${m.coverSourceUrl}...`);
      const imgBuf = await downloadImage(m.coverSourceUrl);
      console.log(`  Uploading cover to remote /api/upload (${imgBuf.length} bytes)...`);
      coverUrl = await uploadImage(cookie, imgBuf, m.coverFilename);
      console.log(`  ✓ Cover uploaded as: ${coverUrl}`);
    } catch (err) {
      console.warn(`  ⚠ Cover upload failed: ${err.message}. Continuing without custom cover.`);
    }

    // 3. Create Manga series
    console.log(`  Creating Manga "${m.title}" via POST /api/mangas...`);
    const createRes = await request('POST', '/api/mangas', {
      title: m.title,
      author: m.author,
      publisher: m.publisher,
      status: m.status,
      total_volumes: m.total_volumes,
      description: m.description,
      cover_image: coverUrl || ''
    }, { 'Cookie': cookie });

    if (createRes.status !== 201 && createRes.status !== 200) {
      console.error(`  ✗ Failed to create manga "${m.title}":`, createRes.data || createRes.text);
      continue;
    }

    const mangaId = createRes.data.id;
    console.log(`  ✓ Manga created with ID ${mangaId}!`);

    // 4. Create individual volumes
    console.log(`  Adding ${m.volumes.length} volumes for "${m.title}"...`);
    for (const v of m.volumes) {
      const volRes = await request('POST', '/api/volumes', {
        manga_id: mangaId,
        volume_number: v.volume_number,
        title: v.title,
        price: v.price,
        condition: v.condition,
        release_year: v.release_year,
        isbn: v.isbn,
        notes: v.notes,
        status: v.status
      }, { 'Cookie': cookie });

      if (volRes.status !== 201 && volRes.status !== 200) {
        console.warn(`    ⚠ Failed to add Band ${v.volume_number}:`, volRes.data || volRes.text);
      }
    }
    console.log(`  ✓ Volumes successfully added!`);
  }

  // 5. Verification
  console.log('\n--- Verifying Mangas on Remote Instance ---');
  const verifyRes = await request('GET', '/api/mangas', null, { 'Cookie': cookie });
  if (Array.isArray(verifyRes.data)) {
    console.log(`Total series in library: ${verifyRes.data.length}`);
    for (const item of verifyRes.data) {
      console.log(`- ${item.title} | Verlag: ${item.publisher} | Bände: ${item.owned_volumes}/${item.total_volumes || '?'} | Gesamtwert: ${item.total_value ? Number(item.total_value).toFixed(2) + ' €' : '0.00 €'} | Cover: ${item.cover_image}`);
    }
  }

  console.log('\n🎉 ALL 3 MANGA SERIES & VOLUMES SUCCESSFULLY CREATED ON http://159.195.49.57:25502 🎉');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
