// Lists every series with its volumes from a running instance (read only).
//   node scripts/check-remote.js https://manga.example.com
//   node scripts/check-remote.js <host> [port]          (plain http, only for this machine unless REMOTE_ALLOW_HTTP=1)
// Without arguments: REMOTE_URL, then REMOTE_HOST/REMOTE_PORT. Credentials: REMOTE_USER/REMOTE_PASS (or ADMIN_USER/ADMIN_PASS).
require('dotenv').config({ quiet: true });
const { resolveTarget, assertSecureTarget, credentials, RemoteClient } = require('./lib/remote');

async function check() {
  const target = resolveTarget();
  const { username, password } = credentials();
  console.log(`Ziel: ${target.baseUrl} (aus ${target.source}), Benutzer "${username}"`);
  assertSecureTarget(target);
  if (!password) console.warn('Hinweis: Kein Passwort angegeben. Setze REMOTE_PASS (oder ADMIN_PASS).');

  const client = new RemoteClient(target.baseUrl);
  await client.login(username, password);

  const list = await client.request('GET', '/api/mangas');
  if (!list.ok || !Array.isArray(list.data)) {
    throw new Error(`GET /api/mangas lieferte Status ${list.status}: ${list.data?.error || list.text.slice(0, 200)}`);
  }

  let failures = 0;
  console.log('Total Mangas:', list.data.length);
  for (const m of list.data) {
    console.log(`\n========================================`);
    console.log(`ID: ${m.id} | Titel: ${m.title}`);
    console.log(`Autor: ${m.author || '-'} | Verlag: ${m.publisher || '-'} | Status: ${m.status || '-'}`);
    console.log(`Fortschritt: ${m.owned_volumes} von ${m.total_volumes || '?'} Bänden | Gesamtwert: ${Number(m.total_value || 0).toFixed(2)} €`);
    console.log(`Cover: ${m.cover_image || '-'}`);

    const detail = await client.request('GET', `/api/mangas/${m.id}`);
    if (!detail.ok || !detail.data) {
      failures++;
      console.error(`  Details nicht lesbar (Status ${detail.status})`);
      continue;
    }
    const vols = detail.data.volumes || [];
    console.log(`Bände in Datenbank (${vols.length} Bände):`);
    vols.forEach(v => {
      console.log(`  Band ${v.volume_number}: "${v.title || ''}" | Preis: ${Number(v.price || 0).toFixed(2)} € | Zustand: ${v.condition || '-'} | Jahr: ${v.release_year || '-'} | ISBN: ${v.isbn || '-'} | Status: ${v.status} ${v.notes ? '(' + v.notes + ')' : ''}`);
    });
  }
  if (failures) throw new Error(`${failures} Reihe(n) konnten nicht gelesen werden`);
}

check().catch(err => {
  console.error(`Fehler: ${err.cause ? `${err.message} (${err.cause.code || err.cause.message})` : err.message}`);
  process.exitCode = 1;
});
