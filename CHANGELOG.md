# Changelog

## Unveröffentlicht – Übergabe-Branch `improve/handover-2026-10`

Stand: Basis v2.19.1 (`f0c2a64`), Commits „Vite 7“ bis zur Spitze des Branches (siehe `git log`), zuletzt die Abschlusswelle nach der Gesamtprüfung des Branches, ihre Nacharbeit und ein UI-Durchgang. Die Arbeit lief in Runden: Runde 0 Werkzeuge, Runde 1 Audit-Fehler, Runde 2 Backend-Grundlagen, Runde 3 Frontend-Grundlagen, Runde 4 Funktionen und Domänen-Kern, Runde 5 Verteilung (Desktop, Android/iPhone, Server-Binärdateien, Release-Pipeline). Nach jeder Welle gab es eine Prüfung mit eigenen Nacharbeits-Paketen. Einzelheiten zu jeder Stelle stehen in `AGENTS.md`.

### Hinweise für Admins (bitte vor dem Update lesen)
- **Ersteinrichtung braucht einen Einrichtungscode.** Ohne `SETUP_TOKEN` druckt der Server beim Start einen Code ins Log; `POST /api/setup` verlangt ihn.
- **`TRUST_PROXY` steht standardmäßig auf `loopback`.** Hinter einem Proxy auf einem anderen Host dessen Adresse eintragen (keine Hop-Zahl), vor Pterodactyl/Docker nur die Gateway-Adresse des Docker-Netzes (z. B. `loopback, 172.18.0.1`, nie das ganze Subnetz), und den App-Port nur über den Proxy erreichbar machen.
- **Alle Sitzungen enden einmal:** der Signatur-Schlüssel liegt jetzt in `data/secret.key` (nicht mehr in der Datenbank und damit in keinem Backup).
- **Pterodactyl-Egg neu importieren** (Install-Container mit `ash`, Installation ohne Install-Skripte, Variable `TRUST_PROXY`).
- **Datenbank-Migrationen 12–24** laufen beim ersten Start; vorher entsteht automatisch die Sicherung `backups/vor-update-v<alt>-auf-v<neu>-…zip`.
- **Migration 22 vereinheitlicht bekannte Verlagsschreibweisen** in Reihen und Bänden (z. B. „Carlsen Verlag GmbH“ → „Carlsen Manga“, „EMA“ → „Egmont Manga“, „TOKYOPOP GmbH“ → „TOKYOPOP“, angehängte Rechtsformen bei eingebauten Verlagen). Ein später gelöschter Alias macht das nicht rückgängig.
- **Kein automatischer Rückweg:** zurück zur alten Version nur, indem man die alte Version startet und sofort die Sicherung `vor-update-…zip` wiederherstellt (README Abschnitt 5). Die alte Version nicht dauerhaft auf der neuen Datenbank betreiben: neue „Gelesen“-Bände, die sie schreibt, stellt ein späteres Update nicht mehr um.
- **API-Änderungen für eigene Skripte:** `GET /api/stats` liefert die Kennzahlen nur noch unter `summary` (die alten Felder auf oberster Ebene wie `total_series`, `completed_series`, `total_owned_volumes`, `total_owned_value`, `avg_price_per_volume`, `collection_*`, `start_date`, `duration` und `settings` entfallen; das Startdatum steht in `summary.collection_start_date`). `GET /api/mangas` und die Offline-Kopie enthalten `description` und `manga_passion_edition_data` nicht mehr (nur noch `GET /api/mangas/:id`); den Suchtext für ISBNs und Notizen liefert das neue `GET /api/mangas/volume-search`. Fehler antworten einheitlich mit `{ error, code, ref }`.
- **Docker:** Konsolenbefehle per `docker exec -it -u node manga-shelf node scripts/admin.js <befehl>`; das Image startet als root, übernimmt `./data` für uid 1000 und läuft dann als `node`.
- **Pterodactyl-Update:** neue ZIP entpacken und vorhandene Dateien überschreiben, vorher nichts löschen (`data/`, `.env` und `ssl/` bleiben); README und Release-Text sagen jetzt dasselbe.
- **Windows-Dienst einmal neu einrichten:** wer die Server-Binärdatei schon mit `install-service` eingerichtet hat, führt es erneut aus; erst dann läuft sie als LOCAL SERVICE statt SYSTEM mit den neuen Ordnerrechten. Wurde `C:\ProgramData\manga-shelf` von einem Nicht-Admin angelegt, lehnt die Einrichtung ab, bis ein Admin den Ordner geprüft und übernommen hat.
- **`node release.js` veröffentlicht nicht mehr**, es setzt nur die Version; veröffentlicht wird über den Workflow „Release“.
- Der Status „Gelesen“ ist kein Bandstatus mehr (Lesestand je Person); Altdaten werden umgestellt, die CSV nimmt ihn weiter als Eingabe an.
- **Sicherung aus der App zurück auf einen Server:** die App behält von einer Server-Sammlung („Vom Server holen“, Import einer Server-ZIP) keine Passwörter, auch nicht das des Admins. Wird ihre ZIP auf einem Server wiederhergestellt, nennt die Prüfung die Konten ohne Passwort (`accounts_without_password`); sie brauchen danach einen Passwort-Reset (das eigene Konto vor dem Abmelden in der Benutzerverwaltung, ohne angemeldeten Admin nur über den Konsolenbefehl `passwort-reset`). In einen Server mit eigener Sammlung führt „Zusammenführen“ (CSV).
- Das Repository liegt jetzt unter `https://github.com/LixNix-Swap-Org/manga-shelf`, das Docker-Image unter `ghcr.io/lixnix-swap-org/manga-shelf`.

### UI-Durchgang (Handy, Tablet, Barrierefreiheit)
Alle Dialoge nutzen ein gemeinsames Overlay (`.dialog-overlay`/`.dialog-box`), das selbst scrollt und Notch, Statusleiste und Home-Balken freihält; im Querformat (`short:`, bis 500 px Höhe) werden Köpfe kompakt und der Dashboard-Kopf scrollt mit. Eine dunkle Statusleisten-Abdeckung verhindert, dass Seiten und Dialoge unter die Uhr laufen; Tab-Fokus landet nicht mehr unter dem sticky Kopf oder unter unteren Leisten (scroll-padding). Bedienelemente haben auf Touch 44 px Trefferfläche (`hit-44`), Eingaben 16 px; die untere Navigation und die Handy-Leiste der Reihenseite blenden sich bei offener Tastatur aus, die untere Navigation bleibt beim Drehen gemountet (ein offener Scanner bleibt offen), und ein fokussiertes Feld wird nach Tastatur oder Drehen wieder ins Bild gescrollt. Nach dem Schließen eines Dialogs kehrt der Fokus zuverlässig zurück, ein Ansichtswechsel öffnet oben, zugängliche Namen beginnen mit dem sichtbaren Text (untere Navigation, Rasterkarten), Überschriften der Schlüssel-Karten folgen ihrem Ort, und Emoji in der Oberfläche (auch `source_label` der Reihensuche) sind Lucide-Icons bzw. reinem Text gewichen (Guard-Test `uiEmoji.test.jsx`). Das Regal teilt die Buchrücken nach der gemessenen Breite (nichts ragt auf schmalen Handys heraus), Toasts stehen über der Auswahlleiste und zeigen dort auf dem Handy nur den neuesten, der Kopf ab 640 px hat statt eigener Ansichtsknöpfe „Neuer Manga“. In den Apps funktionieren Downloads (Sicherung, CSV, Einkaufsliste) wieder trotz CSP, der Start ist ohne weißen Blitz dunkel, Android 15 läuft nicht mehr unter die Systemleisten. `npm run test:deep` prüft zusätzlich Querformat, Tablet, schmales Regal, Kopf mit Installationsknopf und Fokus unter dem Kopf.

### Abschlusswelle nach der Gesamtprüfung
- **Docker-Image baut wieder:** die Frontend-Stufe kopiert auch `core/`, das der Web-Build über die App-Hülle braucht.
- **Update bricht sicher ab:** lässt sich die Sicherung `vor-update-…zip` nicht schreiben, startet der Server nicht und ändert nichts; `MIGRATE_WITHOUT_SNAPSHOT=1` migriert bewusst ohne sie.
- **Alte „Gelesen“-Bände** behalten vorhandene Lese-Einträge; Besitzer bzw. ältester Admin wird nur noch Leser, wenn es keinen gibt. Das gilt gleich für Migration 13, die Datenqualitäts-Korrektur und den Besitzwechsel (einzeln und in der Sammelbearbeitung).
- **CSV-Rundlauf** verliert keinen alten Band „Band N“ mehr, wenn dieselbe Reihe auch „N“ hat: der Import legt beide an und schreibt eine Hinweiszeile, auch wenn die Zielreihe einen der beiden schon hat.
- **Regalliste schlanker:** der Suchtext für ISBNs und Notizen kommt aus `GET /api/mangas/volume-search` und wird erst bei der ersten Suche geladen; die Offline-Kopie enthält ihn weiter.
- **Statistik:** Sammlungen bekommen kein festes Startdatum (9.4.2021) mehr, es folgt dem ältesten Kauf- bzw. Anlagedatum. Migration 24 entfernt das früher fest eingetragene Datum, wenn kein Band älter ist; ein selbst gewähltes Datum bleibt. Admins ändern es in der Statistik, `PUT /api/stats/settings` mit `null` oder leer kehrt zum automatischen Datum zurück. Die Ausgaben brauchen nur noch einen Durchlauf über die Bände.
- **CSV-Export** großer Sammlungen blockiert den Server nicht mehr (in Stücken gebaut).
- **Manga Passion nicht erreichbar:** der Neuerscheinungs-Kalender meldet das wieder ausdrücklich (503 `MP_UNAVAILABLE` statt „Interner Serverfehler“), die Reihensuche beim Anlegen unterscheidet „keine Treffer“ von „Quellen nicht erreichbar“ (503 `SOURCES_UNAVAILABLE`, auch für eine gleichzeitige gleiche Suche).
- **Lücken-Abgleich** (`GET /api/mangas/:id/gaps`) und **Neuerscheinungs-Kalender** (`GET /api/manga-passion/releases`) fallen unter das Lookup-Limit je Konto, sobald sie Manga Passion fragen müssen; `force_refresh` nur für Editoren und Admins; der Kalender nimmt nur Jahre von heute − 5 bis heute + 3.
- **Manga-Passion-Import:** Cover von einer vom Client genannten Adresse laufen durch dieselben Prüfungen wie andere Bild-Downloads (Metadaten entfernt, Größenbudget, erkannte Endung).
- **Kalender-Abo** endet mit „Alle Sitzungen beenden“, mit einer Passwortänderung, einem Passwort-Reset über die Benutzerverwaltung oder den Konsolenbefehl `passwort-reset` und beim Löschen des Benutzers.
- **Sammelbearbeitung** antwortet bei Feldnamen wie `constructor` mit 400 `BULK_FIELD` statt 500.
- **`TRUST_PROXY`-Startfehler** empfiehlt nur noch, was die Doku empfiehlt (Gateway-Adresse wie `loopback, 172.18.0.1`; Hop-Zahl oder `true` nur, wenn der Port allein über den Proxy erreichbar ist).
- **Anime-Variablen** (`ANIME_*`, `MAL_CLIENT_ID`, `GOOGLE_BOOKS_KEY`) laufen über die zentrale Konfiguration und warnen beim Start bei ungültigen Werten.
- **Server-Sammlung in der App** („Vom Server holen“ als Admin, Import einer Server-ZIP): das Gerät behält keine Passwort-Hashes (auch nicht den des Admins), API-Schlüssel und Kalender-Schlüssel; Android sichert Datenbank und Bilder nicht mehr automatisch in der Cloud, auf iPhone/iPad stecken sie noch in iCloud- und Gerätesicherungen (die ZIP-Sicherung bleibt der Weg).
- **App ohne Server:** die Fußzeile zeigt „Auf diesem Gerät“ mit Profil und Speicherstand statt „Online & abgeglichen“ und einer Offline-Kopie, die dort nie ging.
- **Kleinigkeiten:** der Sammel-„Gelesen“-Hinweis zählt nur wirklich markierte Bände, „Alle Verlage (N)“ zählt wie die Chips, Hinweise nennen nur vorhandene Knöpfe, Band-Aktionen nennen ihren Band für Screenreader, der Service-Worker-Cache hängt am Build.
- **Headless-Server:** Standardpfade für `ssl/` liegen im Datenordner (nicht mehr im Portal-Cache, den ein Update löscht); System-Dienst mit Datenordner unter `/home` startet (`ProtectHome=tmpfs` + `BindPaths`).
- **Desktop-App selbst bauen** ist ohne Signatur-Variablen immer unsigniert, auch mit Signier-Identität im macOS-Schlüsselbund.
- **`scripts/verify-remote.js`** folgt den Regeln der anderen Remote-Skripte (Passwort nie über reines http an einen fremden Host).
- **Doku:** Docker-Konsole mit `-u node`, `docker attach` nur mit `stdin_open`/`tty`, Headless-Selbstbau mit `npm ci` im Projektordner, einheitliche Pterodactyl-Update-Anleitung, Rückweg zur alten Version, Abschnitt „Von unterwegs“, AGENTS-Landkarte ohne abgeschnittene Kommentare.

### Neue Funktionen
- **Wunschreihen** mit Priorität, eigener Abschnitt in der Einkaufsliste, Badge im Kalender, Filter im Regal.
- **Anime-Reiter:** gemeinsame Liste, Fortschritt je Person, Suche über AniList und MyAnimeList mit Budget, Cache und Ausfallsicherung, Verknüpfung mit Reihen, CSV-Export.
- **Eigene API-Schlüssel** (AniList, MyAnimeList, Google Books) verschlüsselt gespeichert, mit Anleitungen im Konto-Dialog, im Einrichtungsassistenten und in der Konsole (`quellen`).
- **Statistik-Ausbau:** Wertvollste Reihen, Verlage, Ausgaben nach Kaufdatum, Besitz pro Person, Leseverlauf über 24 Monate, Anime-Kennzahlen; „Komplett“ nach fester Regel (Gesamtzahl erreicht).
- **Sammelstatus** je Reihe (aktiv, pausiert, abgebrochen) getrennt vom Erscheinungsstatus.
- **Regal:** Filter nach Sammelstand, Autor und Genre, Gruppierung, Filter in der URL, unscharfe Suche über alle Felder inkl. ISBN und Notizen.
- **Sammelbearbeitung** mehrerer Bände mit Rückgängig (Server-Token).
- **Papierkorb** mit 30 Tagen Wiederherstellung, **Verlags-Aliase** und Zusammenführen, bearbeitbare **Tags**, **Datenqualität** mit Ein-Klick-Korrekturen.
- **Live-Barcode-Scanner** über HTTPS mit Dauer-Modus im Laden, nativer Scanner in der App; Laden-Scan offline über einen ISBN-Index.
- **Einkaufsliste teilen, kopieren und drucken**; **Kalender-Abo** (iCal) für Vorbestellungen.
- **Systemseite** für Admins: Zustand, Speicher, Backups, verwaiste Bilder, Sitzungen beenden, Update-Hinweis.
- **Untere Navigation** und Handy-Leiste auf der Reihenseite unter 640 px.
- **Offline-Outbox:** Besitz, Lesestand und Käufe werden sofort angezeigt und nachgereicht, wenn die Verbindung zurück ist.
- **Lesen:** Leiste „Weiterlesen“ im Regal, wählbares Lesedatum (einzeln und „Lesestatus in Serie“).
- **Kleinere Helfer:** „Genres nachladen“ aus der verknüpften Manga-Passion-Edition, gescannte ISBN wird beim Anlegen eines Bands übernommen, Löschen mit „Rückgängig“ über den Papierkorb.

### Apps und Verteilung
- **Domänen-Kern `core/`:** alle fachlichen Endpunkte als reine Handler mit einer Routentabelle; der Server hängt sie ein, die Apps rufen sie direkt im Gerät auf (gleiche Antworten, Paritätstests).
- **App ohne Server:** Sammlung im Gerät (sql.js), Profile, Sicherung als ZIP im Server-Format, Übernahme auf einen Server bzw. vom Server; ausfallsicheres Speichern und Schutz, wenn die Sammlung in zwei Fenstern offen ist.
- **Desktop-App (Electron):** nur auf diesem Gerät, als Client eines Servers oder als Server für das Heimnetz (Tray, Autostart, QR-Code zum Verbinden).
- **Android/iPhone (Capacitor):** Serverliste mit Token im sicheren Speicher, Deep Links, Downloads über den Teilen-Dialog, nativer Scanner.
- **Headless-Server als Binärdatei** für Linux, Windows und macOS mit Dienst-Installation, dazu `.deb`/`.rpm`.
- **Server-Binärdatei unter Windows als LOCAL SERVICE** (anderes Konto mit `--account LocalService|NetworkService|LocalSystem|<SID>|DOMÄNE\name`, auch `.\name` und Umlaute); der Datenordner bekommt eine frische geschützte ACL nur für dieses Konto, SYSTEM und die Administratoren; eine fremd angelegte `C:\ProgramData\manga-shelf`, Verknüpfungen/Reparse-Points oder fremde Einträge werden abgelehnt (Allow-List-Prüfung vor dem ersten Start).
- **`.env` im Datenordner** wird auf allen Plattformen abgelehnt, wenn sie verlinkt ist, einem anderen Benutzer gehört oder von anderen geändert werden kann (Linux/macOS `chmod 600`, Windows `icacls`); kann die Prüfung nicht laufen, startet der Server nicht.
- **Desktop-App:** ein abgelehnter Wechsel der Betriebsart (laufende Wiederherstellung oder Sicherung) wird zurückgenommen und das Menü wieder richtig gestellt; „Backup jetzt“ zählt als laufender Job; Hinweis, wenn der Schlüsselbund gesperrt ist und das Fenster auf die App-Ansicht wechselt.
- **Server-Binärdatei unter Linux:** Datenordner 0750 (Benutzer-Dienst und macOS 0700), `UMask=0027` in den systemd-Units, Logdatei 0600.
- **Build- und Release-Pipeline:** bei jedem Push Artefakte (ZIP + SBOM, Binärdateien, Pakete, Docker, Desktop, Mobil-Smoke), Veröffentlichen nur per Knopf mit Tag, Multi-Arch-Image auf GHCR, Prüfsummen und Signierung aus Secrets (sonst unsigniert).
- **Release ohne halbe Zustände:** das Docker-Image bekommt zuerst nur die festen Tags `vX.Y.Z`/`X.Y.Z`; `X.Y` und `latest` zeigen erst nach dem GitHub-Release darauf, ein abgebrochener Lauf verschiebt `latest` nie.
- **Android-Release-Signatur** auf den Ubuntu-Runnern über eine Gradle-`signingConfig` aus den Secrets, geprüft mit `apksigner`.
- **Desktop:** ist der Schlüsselbund des Systems nicht verfügbar, bleibt der sichere Speicher gesperrt und die verschlüsselte Datei unverändert (nie Klartext); Wechsel von Betriebsart oder Port laufen nacheinander und werden abgelehnt (mit Hinweis), solange ein Backup oder eine Wiederherstellung läuft.
- **Handy-App:** die Sammlung wird über `.new`/`.old` ausfallsicher gespeichert (beim Start gewinnt die letzte vollständige Kopie); Bilder kommen bei Bedarf direkt aus dem Gerätespeicher statt alle beim Start geladen zu werden.

### Sicherheit
- Sitzungen mit Version, Widerruf beim Logout, Bearer-Token für Apps, Sitzungsende nach Restore und Passwort-Reset; „Alle Sitzungen beenden“.
- Rate-Limits je Adresse und je Konto (Brute-Force-Schutz ohne Aussperren des Admins), Limits je Konto für externe Dienste.
- Cross-Origin-Schutz für schreibende Anfragen, CORS nur für eingetragene Ursprünge und App-Ursprünge, zusätzliche Sicherheits-Header (CSP, Permissions-Policy, COOP, HSTS bei HTTPS).
- Uploads: Prüfung der Magic Bytes, Entfernen von EXIF/GPS, zufällige Dateinamen, eigene CSP für `/uploads`; SSRF-sicherer Bild-Download.
- Die Server-Binärdatei startet nicht über einer `.env` im Datenordner, die andere Benutzer ändern dürfen.
- Apps: ein neues Token derselben Sitzung (Passwortwechsel, „Alle Sitzungen beenden“, eigenes Konto in der Benutzerverwaltung) behält die freigegebenen Serveradressen.
- CodeQL, Dependabot, Audit-Gate und minimale Rechte in der CI.

### Backups und Wiederherstellung
- Geprüfte Snapshots mit Manifest und Wiederherstellungstest, Aufbewahrung je Kategorie, nächtliches Zeitfenster.
- Wiederherstellung in zwei Schritten mit Vorschau, Sicherung davor und „Rückgängig machen“; streamendes Entpacken mit Grenzen, Migration der Backup-Datei vor dem Tausch, Platzprüfung (507).
- Konsolenbefehle für Admins (`status`, `backup`, `benutzer`, `passwort-reset`, `admin`, `rollback-aufraeumen`, `quellen`), auch als `node scripts/admin.js`.

### Backend, Datenbank, Leistung
- `number_sort` und `owned_volumes` per Trigger, weniger Abfragen für Liste, Detail und Offline-Kopie, `synchronous = NORMAL`.
- Einheitliche Fehlerantworten `{ error, code, ref }` mit Request-ID, zentrale Konfiguration (`utils/config.js`) mit Startprüfung, ETag/304 für die Lese-Endpunkte, ausführlicherer `/api/health`, geordnetes Herunterfahren.
- Strenge Eingabeprüfung für Reihen, Bände, Kalender-Import und CSV; verlustfreier CSV-Rundlauf inkl. Reihenfeldern und Lesestand.
- Manga Passion: stabilerer Client (Cache, Budget, Ausfall statt „nicht gefunden“), typgerechter Abgleich von Sonderausgaben und Schubern, Kalenderabgleich über Editionen.
- ISBN-Suche: bessere MARC-Auswertung, Google Books mit Instanz-Schlüssel, kein Raten bei mehrdeutigen Titeln.
- Rückgängig der Sammelbearbeitung mit Speichergrenze (8 MB je Person, 32 MB insgesamt); gelöschte Bände kommen dabei aus dem Papierkorb zurück.
- Erscheinungskalender erkennt mehr Bandnummer-Präfixe (Volume, Nr., No., Teil, Tome, Ausgabe, #; bei Schubern Box und Schuber Nr.).
- Zusammenführungen in eine anders geschriebene eingebaute Verlagsschreibweise („Tokyopop“) bleiben erhalten (Migration 23).

### Frontend
- Ein API-Client mit Zeitlimits, Abbruch und einem Weg für abgelaufene Sitzungen; Toasts mit Rückgängig statt `alert()`; einheitliche deutsche Zahlen- und Datumsformate.
- Schnellerer Start (Prefetch, Cache mit Revalidierung, Lazy-Dialoge), seitenweise lange Listen, Scrollposition und Zurück-Geste.
- Barrierefreiheit: sichtbarer Fokus, Kontraste, reduzierte Bewegung, Sprunglink, Seitentitel, Screenreader-Texte, keine Zoom-Sprünge auf iOS.
- PWA: überarbeiteter Service Worker mit Update-Hinweis, HTTPS-Hinweise, dauerhafter Speicher, Ziehen zum Aktualisieren, Fotos vor dem Upload verkleinert.
- Selbst gehostete Schrift, Vite 7, lucide 1.x.

### Werkzeuge, Tests, Dokumentation
- Vitest-Komponententests, Kern-Szenarien gegen Express, In-Memory und sql.js, Browsertests mit strengen Helfern (inkl. Anime-Suite), Bundle-Budget, Seeder und Benchmark, `npm run dev` für Backend + Frontend.
- `AGENTS.md` neu geschrieben (Datei-Landkarte, Schema, alle Endpunkte, Fälle A–S, Fallstricke); `test/agentsMd.test.js` hält Pfade, Migrationen, Konsolenbefehle und Endpunkte mit dem Code synchron.
