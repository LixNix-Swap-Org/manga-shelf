// Android backup and device-transfer rules: what is excluded from or kept in backups.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MOBILE = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(MOBILE, rel), 'utf-8');
const XML = 'android/app/src/main/res/xml';

const excludes = (xml) => [...xml.matchAll(/<exclude domain="([^"]+)" path="([^"]+)" \/>/g)].map(([, domain, file]) => `${domain}:${file}`);
const sections = (xml) => [...xml.matchAll(/<(full-backup-content|cloud-backup|device-transfer)>([\s\S]*?)<\/\1>/g)].map(([, name, body]) => [name, body]);

// what the apps store in Directory.Data (frontend/src/local/capacitor.js, runtime.js): the database, its save copies,
// the save counter and the uploads folder
function collectionFiles() {
  const runtime = read('../frontend/src/local/runtime.js');
  const capacitor = read('../frontend/src/local/capacitor.js');
  const db = runtime.match(/export const DB_KEY = '([^']+)'/)[1];
  const seq = runtime.match(/export const SAVE_SEQ_KEY = '([^']+)'/)[1];
  const uploads = capacitor.match(/export const UPLOAD_DIR = '([^']+)'/)[1];
  const suffixes = [...new Set([...capacitor.matchAll(/\$\{name\}(\.[a-z]+)`/g)].map((m) => m[1]))];
  assert.deepEqual(suffixes.sort(), ['.new', '.old', '.tmp']);
  return [db, ...suffixes.map((s) => db + s), seq, uploads].map((f) => `file:${f}`);
}

describe('Android backup rules', () => {
  it('the manifest uses both rule files', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
    assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  });

  it('cloud backup, device transfer and the old backup keep the secure storage, manga.db and the uploads out', () => {
    const expected = ['sharedpref:WSSecureStorageSharedPreferences.xml', ...collectionFiles()];
    const found = [...sections(read(`${XML}/backup_rules.xml`)), ...sections(read(`${XML}/data_extraction_rules.xml`))];
    assert.deepEqual(found.map(([name]) => name), ['full-backup-content', 'cloud-backup', 'device-transfer']);
    for (const [name, body] of found) {
      assert.deepEqual(excludes(body).sort(), [...expected].sort(), name);
      assert.doesNotMatch(body, /<include /, `${name}: an include would turn the rules into an allow list`);
    }
  });
});
