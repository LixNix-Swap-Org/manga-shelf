const http = require('http');

async function check() {
  const loginRes = await new Promise(resolve => {
    const req = http.request('http://159.195.49.57:25502/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ cookie: res.headers['set-cookie'] ? res.headers['set-cookie'][0] : null }));
    });
    req.write(JSON.stringify({ username: 'Moltres', password: 'Start1234!' }));
    req.end();
  });

  if (!loginRes.cookie) {
    console.error('Failed to log in!');
    return;
  }

  const mangas = await new Promise(resolve => {
    http.get('http://159.195.49.57:25502/api/mangas', { headers: { Cookie: loginRes.cookie } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve([]); }
      });
    });
  });

  console.log('Total Mangas on Remote:', mangas.length);
  for (const m of mangas) {
    console.log(`\n========================================`);
    console.log(`ID: ${m.id} | Titel: ${m.title}`);
    console.log(`Autor: ${m.author} | Verlag: ${m.publisher} | Status: ${m.status}`);
    console.log(`Fortschritt: ${m.owned_volumes} von ${m.total_volumes || '?'} Bänden | Gesamtwert: ${Number(m.total_value || 0).toFixed(2)} €`);
    console.log(`Cover: ${m.cover_image}`);

    // fetch manga details with volumes
    const detail = await new Promise(resolve => {
      http.get('http://159.195.49.57:25502/api/mangas/' + m.id, { headers: { Cookie: loginRes.cookie } }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
        });
      });
    });

    const vols = detail.volumes || [];
    console.log(`Bände in Datenbank (${vols.length} Bände):`);
    vols.forEach(v => {
      console.log(`  Band ${v.volume_number}: "${v.title || ''}" | Preis: ${Number(v.price || 0).toFixed(2)} € | Zustand: ${v.condition || '-'} | Jahr: ${v.release_year || '-'} | ISBN: ${v.isbn || '-'} | Status: ${v.status} ${v.notes ? '(' + v.notes + ')' : ''}`);
    });
  }
}

check().catch(console.error);
