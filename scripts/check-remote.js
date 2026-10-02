const http = require('http');
require('dotenv').config();

const REMOTE_HOST = process.env.REMOTE_HOST || process.argv[2] || 'localhost';
const REMOTE_PORT = parseInt(process.env.REMOTE_PORT || process.argv[3] || '3000', 10);
const USERNAME = process.env.ADMIN_USER || process.env.REMOTE_USER || 'admin';
const PASSWORD = process.env.ADMIN_PASS || process.env.REMOTE_PASS || '';

if (!PASSWORD) {
  console.warn('Hinweis: Kein Passwort angegeben. Setze ADMIN_PASS oder REMOTE_PASS in der .env oder als Umgebungsvariable.');
}

async function check() {
  const baseUrl = `http://${REMOTE_HOST}:${REMOTE_PORT}`;
  console.log(`Verbinde mit ${baseUrl} als Benutzer "${USERNAME}"...`);

  const loginRes = await new Promise(resolve => {
    const req = http.request(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie'] ? res.headers['set-cookie'][0] : null, body }));
    });
    req.on('error', err => {
      console.error(`Verbindungsfehler zu ${baseUrl}:`, err.message);
      resolve({ status: 500, cookie: null });
    });
    req.write(JSON.stringify({ username: USERNAME, password: PASSWORD }));
    req.end();
  });

  if (!loginRes.cookie) {
    console.error('Login fehlgeschlagen! Status:', loginRes.status, loginRes.body || '');
    return;
  }

  const mangas = await new Promise(resolve => {
    http.get(`${baseUrl}/api/mangas`, { headers: { Cookie: loginRes.cookie } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve([]); }
      });
    }).on('error', err => {
      console.error('Fehler beim Abrufen der Mangas:', err.message);
      resolve([]);
    });
  });

  console.log('Total Mangas:', mangas.length);
  for (const m of mangas) {
    console.log(`\n========================================`);
    console.log(`ID: ${m.id} | Titel: ${m.title}`);
    console.log(`Autor: ${m.author || '-'} | Verlag: ${m.publisher || '-'} | Status: ${m.status || '-'}`);
    console.log(`Fortschritt: ${m.owned_volumes} von ${m.total_volumes || '?'} Bänden | Gesamtwert: ${Number(m.total_value || 0).toFixed(2)} €`);
    console.log(`Cover: ${m.cover_image || '-'}`);

    // fetch manga details with volumes
    const detail = await new Promise(resolve => {
      http.get(`${baseUrl}/api/mangas/${m.id}`, { headers: { Cookie: loginRes.cookie } }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
        });
      }).on('error', () => resolve({}));
    });

    const vols = detail.volumes || [];
    console.log(`Bände in Datenbank (${vols.length} Bände):`);
    vols.forEach(v => {
      console.log(`  Band ${v.volume_number}: "${v.title || ''}" | Preis: ${Number(v.price || 0).toFixed(2)} € | Zustand: ${v.condition || '-'} | Jahr: ${v.release_year || '-'} | ISBN: ${v.isbn || '-'} | Status: ${v.status} ${v.notes ? '(' + v.notes + ')' : ''}`);
    });
  }
}

check().catch(console.error);
