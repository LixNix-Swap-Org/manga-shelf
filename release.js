const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function run(cmd, options = {}) {
  console.log(`\n> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...options });
}

function runOutput(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

async function main() {
  console.log('🚀 Starte Release-Prozess für Manga Shelf...');

  // 1. Version bestimmen
  const rootPkgPath = path.join(__dirname, 'package.json');
  const frontendPkgPath = path.join(__dirname, 'frontend', 'package.json');

  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const frontendPkg = JSON.parse(fs.readFileSync(frontendPkgPath, 'utf8'));

  let targetVersion = process.argv[2];

  if (!targetVersion) {
    targetVersion = rootPkg.version;
  } else if (targetVersion.startsWith('v')) {
    targetVersion = targetVersion.slice(1);
  } else if (targetVersion === 'patch' || targetVersion === 'minor' || targetVersion === 'major') {
    const parts = rootPkg.version.split('.').map(Number);
    if (targetVersion === 'patch') parts[2]++;
    if (targetVersion === 'minor') { parts[1]++; parts[2] = 0; }
    if (targetVersion === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
    targetVersion = parts.join('.');
  }

  const tag = `v${targetVersion}`;
  console.log(`📌 Ziel-Version: ${tag} (Package Version: ${targetVersion})`);

  // 2. Versionen in package.json und frontend/package.json synchronisieren
  rootPkg.version = targetVersion;
  frontendPkg.version = targetVersion;

  fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n');
  fs.writeFileSync(frontendPkgPath, JSON.stringify(frontendPkg, null, 2) + '\n');
  console.log('✅ package.json & frontend/package.json aktualisiert.');

  // 3. Frontend bauen & ZIP-Paket erzeugen
  console.log('📦 Erzeuge pterodactyl-manga-shelf.zip...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(`${npmCmd} run package`);

  const zipPath = path.join(__dirname, 'pterodactyl-manga-shelf.zip');
  if (!fs.existsSync(zipPath)) {
    throw new Error(`ZIP-Datei wurde nicht gefunden: ${zipPath}`);
  }
  const zipStats = fs.statSync(zipPath);
  console.log(`✅ ZIP erfolgreich erstellt (${(zipStats.size / 1024).toFixed(1)} KB)`);

  // 4. Git Status prüfen & Änderungen committen
  const status = runOutput('git status --porcelain');
  if (status) {
    console.log('📝 Committe Änderungen vor dem Release...');
    run('git add .');
    try {
      run(`git commit -m "chore(release): bump version to ${tag}"`);
    } catch (e) {
      console.log('Keine neuen Commits nötig oder bereits committed.');
    }
  }

  // 5. Änderungen zu GitHub pushen
  console.log('⬆️ Pushe main zu GitHub...');
  run('git push origin main');

  // 6. Prüfen ob Tag lokal oder remote existiert
  const existingTags = runOutput('git tag -l').split('\n').map(t => t.trim());
  if (existingTags.includes(tag)) {
    console.log(`⚠️ Tag ${tag} existiert bereits. Erneuere Tag...`);
    run(`git tag -d ${tag}`);
    try { run(`git push origin :refs/tags/${tag}`); } catch (_) {}
  }

  console.log(`🏷️ Erstelle Git Tag ${tag}...`);
  run(`git tag -a ${tag} -m "Release ${tag}"`);
  run(`git push origin ${tag}`);

  // 7. GitHub Release erstellen & ZIP hochladen via gh CLI
  console.log(`🌐 Erstelle GitHub Release für ${tag} und lade ZIP hoch...`);
  try {
    // Falls Release bereits existiert, überschreiben / anpassen
    const releaseTitle = `Manga Shelf ${tag}`;
    const releaseNotes = `### Manga Shelf ${tag} 🚀

#### Neu & Verbesserungen in dieser Version:
- 📱 **Mobile UI Fixes für Band-Bearbeiten & Modals:**
  - **Negativer Viewport-Offset behoben:** Durch Umstellung des Modal-Containers von starrem \`items-center\` auf \`items-start sm:items-center\` wird der Modal-Kopf bei langen Formularen nicht mehr nach oben aus dem Bildschirm geschoben (bisher bei Bildschirmhöhen < 900px unscrollbar abgeschnitten).
  - **Sticky Header & Close-Button:** Der Header mit Titel ("Band bearbeiten" / "Neuen Band anlegen") und Schließen-Button \`[X]\` bleibt beim Scrollen permanent am oberen Displayrand sichtbar und erreichbar.
  - **Sticky Footer mit Daumen-Bedienung:** "Abbrechen" und "Speichern" sind mobil stets unten angeheftet und nutzen die volle Breite, der Lösch-Button ist sicher darunter platziert.
  - **Touch-optimierte Fotoverwaltung:** Bisherige reine Desktop-Hover-Controls (\`group-hover:opacity-100\`) bei Zusatzbildern durch immer zugängliche Touch-Buttons (Cover festlegen, Löschen, Reihenfolge per Pfeiltasten anpassen) ersetzt.
  - **Responsive Sammler-Status-Pills:** Flexible Status-Buttons mit optimiertem Padding und Truncate-Schutz verhindern Umbrüche und horizontales Verzerren auf schmalen Smartphone-Displays (360px–390px).
  - **Systemweite Modal-Absicherung:** Auch Batch-Generierung, Lese-Status-Batch, Lücken-Füllen und Manga-Erstellung gegen Abschneiden auf Mobilgeräten gehärtet.
- 🖥️ **Full-HD (1920x1080) & Display-Scaling Optimierung:**
  - Viewport- & Layout-Container von starren 1280px (\`max-w-7xl\`) auf bis zu 1840px (\`max-w-[1720px] 2xl:max-w-[1840px]\`) erweitert – eliminiert ungenutzte Trauerränder auf Full-HD- und 2K/1440p-Monitoren.
  - Manga-Grid skaliert jetzt responsiv mit 6–8 Spalten (\`xl:grid-cols-6 2xl:grid-cols-7 min-[1800px]:grid-cols-8\`) mit konsistenten 2:3 Cover-Proportionen.
- 🔍 **Windows DPI Scaling (100 %, 125 %, 150 %) Support:**
  - Horizontale Navbar-Überläufe bei 150 % Windows-Skalierung vollständig behoben durch dynamisches Padding und \`flex-nowrap\`.
  - Null horizontale Scrollbalken auf allen Breakpoints.
- 🖼️ **Robuste Image Fallbacks (Broken Images):**
  - Universelle \`onError\`-Fallbacks für alle Cover, Volume-Thumbnails (Raster- & Listenansicht), Einkaufsliste, Release-Radar und Auto-Fill-Suchergebnisse.
- ⌨️ **Universal Modal & UX Handling:**
  - Globaler \`Escape\`-Key-Listener schließt zuverlässig alle Modals und Dropdowns.
  - Intuitiver Backdrop-Click-Outside zum Schließen.
- 🇩🇪 **Manga Passion First im Auto-Fill:** Priorisiert die deutsche Manga Passion Datenbank beim Anlegen und Bearbeiten von Reihen für offizielle deutsche Titel, Verlage, Bände und Beschreibungen.

#### Deployment-Hinweis:
Laden Sie einfach die beigefügte \`pterodactyl-manga-shelf.zip\` auf Ihren Server bzw. Ihr Pterodactyl-Panel hoch und führen Sie \`npm install\` aus.`;

    const notesFile = path.join(__dirname, 'RELEASE_NOTES.tmp');
    fs.writeFileSync(notesFile, releaseNotes, 'utf8');

    try {
      run(`gh release create ${tag} "${zipPath}" --title "${releaseTitle}" --notes-file "${notesFile}"`);
    } catch (createErr) {
      console.log('Release existiert evtl. bereits, versuche Upload via `gh release upload`...');
      run(`gh release upload ${tag} "${zipPath}" --clobber`);
    }

    if (fs.existsSync(notesFile)) {
      fs.unlinkSync(notesFile);
    }

    console.log(`\n🎉 Release ${tag} erfolgreich auf GitHub veröffentlicht!`);
    const releaseUrl = runOutput(`gh release view ${tag} --json url -q .url`);
    console.log(`🔗 Release URL: ${releaseUrl}`);
  } catch (err) {
    console.error('❌ Fehler beim Erstellen des GitHub Releases via gh CLI:', err.message);
    console.log('Hinweis: Der Git Tag wurde bereits gepusht. Falls GitHub Actions eingerichtet ist, wird der Release dort gebaut.');
  }
}

main().catch(err => {
  console.error('\n❌ Fehler im Release-Skript:', err);
  process.exit(1);
});
