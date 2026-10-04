# Manga Shelf

Selbst gehostete Manga-Sammlung für den Haushalt: Reihen und Bände mit Covern, wer was besitzt und gelesen hat, Lücken und Neuerscheinungen über Manga Passion, eine Einkaufsliste mit Barcode-Scanner, eine Anime-Liste und Statistiken. Der Server läuft auf Pterodactyl, in Docker, als einzelnes Programm oder in der Desktop-App; die Apps für Android und iPhone verbinden sich mit ihm oder funktionieren ganz ohne Server.

Repository: **[LixNix-Swap-Org/manga-shelf](https://github.com/LixNix-Swap-Org/manga-shelf)** · Downloads: **[Releases](https://github.com/LixNix-Swap-Org/manga-shelf/releases)**. Das Projekt begann als MoltresHD/manga-shelf.

## Inhalt

1. [Funktionen](#1-funktionen)
2. [Installation auf Pterodactyl](#2-installation-auf-pterodactyl)
3. [Ersteinrichtung und Verwaltung](#3-ersteinrichtung-und-verwaltung)
4. [API-Schlüssel (freiwillig)](#4-api-schlüssel-freiwillig)
5. [Backups & Wiederherstellung](#5-backups--wiederherstellung)
6. [HTTPS & eigene Domain](#6-https--eigene-domain-reverse-proxy-mit-nginx-oder-caddy)
7. [Docker](#7-docker)
8. [Headless-Server](#8-headless-server-ohne-oberfläche-ohne-docker)
9. [Desktop-App](#9-desktop-app-windows-macos-linux)
10. [Android und iPhone, auch ohne Server](#10-android-und-iphone)
11. [Release (für Maintainer)](#11-release-für-maintainer)
12. [Umgebungsvariablen](#12-umgebungsvariablen)
13. [Entwicklung](#13-entwicklung)

**Welche Installation?**

| Du möchtest … | Nimm |
|---|---|
| einen Server bei einem Pterodactyl-Hoster oder im eigenen Panel | [Pterodactyl](#2-installation-auf-pterodactyl) |
| einen Server auf NAS, Raspberry Pi oder VPS mit Docker | [Docker](#7-docker) |
| einen Server ohne Docker (Linux-Dienst, `.deb`/`.rpm`, Windows, macOS) | [Headless-Server](#8-headless-server-ohne-oberfläche-ohne-docker) |
| ein Fenster am PC, allein oder als Server fürs Heimnetz | [Desktop-App](#9-desktop-app-windows-macos-linux) |
| die Sammlung auf dem Handy, mit oder ohne Server | [Android und iPhone](#10-android-und-iphone) |

## 1. Funktionen

**Sammlung**
* Reihen und Bände mit Cover, Verlag, Preis, Erscheinungsdatum, ISBN und Notizen; Sonderausgaben und Schuber; Status je Band (Vorhanden, Fehlt, Vorbestellt, Bestellt, Erscheint bald).
* Mehrere Benutzer: Besitz und Lesestand gelten je Person („gehört Kim und Alex“), Rollen Admin, Editor und Gast (nur lesen).
* Sammelstatus je Reihe (aktiv, pausiert, abgebrochen), Wunschliste mit Priorität und Zielpreis, Tags, Filter, Gruppierung und Sortierung (in der Adresse gespeichert, also teilbar). Die Suche findet auch ISBNs und Notizen.
* **Mehrfachauswahl:** in einer Reihe „Bände auswählen“, dann Status, Besitzer oder Lesestand für alle auf einmal setzen oder löschen, mit „Rückgängig“.
* **Papierkorb:** gelöschte Reihen und Bände lassen sich 30 Tage lang wiederherstellen (Statistik-Dialog → Papierkorb).
* **Aufräumen:** „Verlage zusammenführen“ fasst Schreibweisen zusammen („Carlsen Verlag GmbH“ = „Carlsen Manga“), „Sammlung aufräumen“ zeigt unvollständige oder widersprüchliche Einträge.
* **CSV:** Export und Import der ganzen Sammlung mit Probelauf (Besitzer, Lesestand, Wunsch, Priorität, Zielpreis und Sammelstatus inklusive).

**Nachschlagen und Neuerscheinungen**
* Manga Passion: Reihe per Link oder Suche übernehmen, fehlende Bände erkennen, Daten und Cover automatisch ergänzen.
* ISBN-Suche über DNB, K10plus und Google Books, Cover über Open Library.
* **Release-Radar:** Neuerscheinungen je Monat, die eigenen Vorbestellungen und geänderte Erscheinungstermine („Termin übernehmen“).
* **Kalender abonnieren:** Radar → „Meine Vorbestellungen“ → „Kalender abonnieren“ → „Abo-Adresse erzeugen“. Jeder Band mit genauem Erscheinungstag wird ein ganztägiger Termin.
  * iPhone/iPad: Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo hinzufügen.
  * Android: calendar.google.com → Weitere Kalender → + → Per URL, danach die Synchronisierung in der Kalender-App einschalten (Google holt das Abo von seinen Servern, der Server muss also aus dem Internet erreichbar sein; ohne Google: ICSx⁵).
  * Thunderbird: Kalender → Neuer Kalender → Im Netzwerk.
  * Die Adresse enthält einen eigenen Schlüssel; „Neue Adresse“ macht die alte ungültig, ebenso „Alle Sitzungen beenden“, ein neues Passwort und ein Passwort-Reset (auch über die Konsole).

**Einkaufen und Scannen**
* Einkaufsliste aller fehlenden und vorbestellten Bände, nach Verlag gruppiert; teilen, kopieren oder drucken. Ein Kauf („Gekauft“) klappt auch offline und wird nachgereicht.
* Barcode-Scanner: im Buchladen Bände nacheinander scannen; die Liste zeigt sofort, ob ein Band zu kaufen ist, schon da ist (auch bei wem) oder noch fehlt. Die Live-Kamera braucht HTTPS (oder localhost); die Handy-Apps nutzen den eingebauten Scanner des Systems.

**Anime**
* Eigener Reiter „Anime“: eine gemeinsame Liste (Staffeln und Filme einzeln), Fortschritt je Person (Folgen, Status, Bewertung, Notiz), Suche über AniList und MyAnimeList, Countdown zur nächsten Folge, Verknüpfung mit der passenden Reihe, CSV-Export.
* Daten und Cover stammen von AniList und MyAnimeList (über Jikan oder die offizielle API) und gehören den Quellen; die Nutzung ist nur nicht-kommerziell erlaubt. Manga Shelf speichert IDs und einen schlanken Auszug und verlinkt auf beide Seiten.

**Statistiken und Verwaltung**
* Statistiken: Ausgaben, Besitz je Person, Leseverlauf über 24 Monate mit Stapel („vorhanden, nicht gelesen“) und „Weiterlesen“.
* **System** (Admins): Version und Update-Hinweis, Speicher, Datenbank, Backups, verwaiste Bilder aufräumen, alle Sitzungen beenden, Auslastung der Quellen.
* Als App installierbar (PWA) mit lesbarer Offline-Kopie; Backups täglich und auf Knopfdruck.

## 2. Installation auf Pterodactyl

Voraussetzung: Node.js 22.13 oder neuer (die App nutzt die eingebaute SQLite-Datenbank `node:sqlite`).

### ZIP holen

**Fertig (empfohlen):** Unter **[Releases](https://github.com/LixNix-Swap-Org/manga-shelf/releases)** liegt für jede Version die `pterodactyl-manga-shelf.zip` mit gebautem Frontend (dazu Docker-Image, Server-Programme, Desktop-App und Handy-Apps, siehe Abschnitte 7 bis 10).

**Selbst bauen** (Node.js 22.13+ auf deinem PC):

```bash
npm install
npm run package
```

`npm run package` baut das Frontend (`frontend/dist/`) und schreibt mit `package.js` die `pterodactyl-manga-shelf.zip` nach `dist_pack/` (und eine Kopie in den Projektordner).

**Falls `npm run package` fehlschlägt**, von Hand:
1. `cd frontend && npm install && npm run build`
2. Ins ZIP gehören mit ihrer Ordnerstruktur: `package.json`, `package-lock.json`, `.env.example`, alles, was in `package.json` unter `"files"` steht (heute `index.js`, `db.js`, `mangaPassion.js`, `healthcheck.js`, `scripts/admin.js` und die Ordner `core/`, `middleware/`, `routes/`, `services/`, `utils/` samt Unterordnern) und `frontend/dist/`. Diese Liste ist die Quelle, `package.js` packt genau sie.
3. **Nicht** ins ZIP: `node_modules/` und `data/` (ein mitgepacktes `data/` würde beim Entpacken die Datenbank auf dem Server überschreiben).

### Egg

Das **Generic Node.js Egg** funktioniert; das mitgelieferte Egg ist bequemer (Node-22-Image, Startbefehl, Variable `TRUST_PROXY`):
1. Admin-Panel → **Nests** → **Import Egg**.
2. `egg-manga-shelf.json` hochladen, Ziel-Nest wählen (z. B. Generic), „Import“.

### Server anlegen

1. Neuen Server mit dem Egg „Manga Shelf App“ (oder „Generic Node.js“) anlegen.
2. **Docker Image** „Node.js 22“ (oder neuer). Mit Node 20 oder 21 startet die App nicht. Bietet ein früher importiertes Egg nur Node 20/21 an: Egg neu importieren oder unter **Startup → Docker Image** `ghcr.io/parkervcp/yolks:nodejs_22` eintragen.
3. Port zuweisen (Allocation); die Variable `SERVER_PORT` muss ihm entsprechen (Pterodactyl setzt sie selbst). Soll später ein Reverse Proxy davor (Abschnitt 6), die Allocation an `127.0.0.1` binden.
4. **File Manager:** Standarddateien löschen, die ZIP hochladen, Rechtsklick → **Unarchive**.
5. **Start.** Beim Start installiert das Egg die Abhängigkeiten (`npm install --omit=dev --ignore-scripts`), legt die Datenbank `data/manga.db` an und schreibt den **Einrichtungscode** in die Konsole (Abschnitt 3).

**Update:** neue `pterodactyl-manga-shelf.zip` im File Manager hochladen, entpacken und vorhandene Dateien überschreiben (vorher nichts löschen; `data/`, `.env` und `ssl/` bleiben), dann den Server neu starten. Vor jeder Datenbank-Migration legt der Server selbst `data/backups/vor-update-*.zip` an; gelingt das nicht (z. B. Platte voll), startet er nicht und nennt den Grund (Abschnitt 12, `MIGRATE_WITHOUT_SNAPSHOT`). Zurück zur alten Version: Abschnitt 5.

## 3. Ersteinrichtung und Verwaltung

1. Die Adresse des Servers öffnen (z. B. `http://deine-ip:port`); ohne Admin-Konto erscheint die Einrichtung.
2. Den **Einrichtungscode** eintragen. Er steht beim Start in der Konsole bzw. im Log („Ersteinrichtung: Einrichtungscode für das erste Admin-Konto: …“; Docker: `docker logs manga-shelf`, Dienst: `journalctl -u manga-shelf`). Mit `SETUP_TOKEN` lässt er sich fest vorgeben (mindestens 12 Zeichen; Leerzeichen und Bindestriche zählen nicht). Die Desktop-App setzt und zeigt ihn selbst.
3. Admin-Konto anlegen.
4. Optional „Quellen verbinden (später möglich)“: API-Schlüssel für alle hinterlegen (Abschnitt 4), oder überspringen.

**Benutzer:** Admins legen unter „Benutzer“ weitere Konten an: **Editor** (darf alles an der Sammlung ändern), **Gast** (nur lesen und exportieren), **Admin** (zusätzlich Benutzer, Backups, System).

**Konsolenbefehle** (Pterodactyl-Konsole, Terminal des Headless-Servers; sonst `node scripts/admin.js <befehl>` bzw. als Unterbefehl des Server-Programms; Docker: `docker exec -it -u node manga-shelf node scripts/admin.js <befehl>`, siehe Abschnitt 7):

| Befehl | Wirkung |
|---|---|
| `hilfe` | alle Befehle |
| `status` | Version, Datenordner, Datenbank, Speicherplatz, letztes Backup |
| `backup` | jetzt einen Snapshot erstellen |
| `benutzer` | alle Benutzer mit Rolle |
| `passwort-reset <name>` | zufälliges neues Passwort (im Terminal angezeigt, sonst als Datei im Datenordner); beendet die Sitzungen und die Kalender-Abo-Adresse des Benutzers |
| `admin <name>` | macht `<name>` zum Admin, nur wenn es keinen gibt |
| `rollback-aufraeumen [bestaetigen]` | prüft `manga.db` und löscht eine liegengebliebene `manga.db.bak` |
| `quellen …` | API-Schlüssel: Zustand, Anleitung, setzen, entfernen (Abschnitt 4) |

`ADMIN_CONSOLE=false` schaltet die Konsole auf stdin ab.

## 4. API-Schlüssel (freiwillig)

Ohne Schlüssel läuft alles über den gemeinsamen Zugang des Servers (AniList ohne Token, Jikan statt der offiziellen MyAnimeList-API, Google Books anonym), nur mit dessen Limit. Ein eigener Schlüssel bringt ein eigenes Limit.

| Anbieter | Für wen | Schlüssel | Woher |
|---|---|---|---|
| AniList | je Benutzer | Zugriffstoken (gilt ein Jahr) | [anilist.co/settings/developer](https://anilist.co/settings/developer) → „Create New Client“, Redirect URL `https://anilist.co/api/v2/oauth/pin`; aus der Client-ID baut die Anleitung den Anmeldelink, der den Token anzeigt |
| MyAnimeList | je Benutzer und für alle (Instanz) | Client-ID (32 Zeichen) | [myanimelist.net/apiconfig](https://myanimelist.net/apiconfig) → „Create ID“, App Type **other**, Redirect URL `http://localhost/`, non-commercial, hobbyist; die Client-ID steht danach unter „Edit“ |
| Google Books | für alle (Instanz, nur Admins) | API-Schlüssel (`AIza…`) | [Google Cloud Console](https://console.cloud.google.com/) → Projekt → „Books API“ aktivieren → Anmeldedaten → API-Schlüssel, auf die Books API einschränken |

**Eintragen** – überall dieselbe Schritt-für-Schritt-Anleitung mit Links und Prüfung beim Anbieter:
* **Browser / App mit Server:** Konto-Symbol oben rechts → Reiter „API-Schlüssel“. Admins sehen dort zusätzlich „Für alle (Instanz)“. Auch im Einrichtungsassistenten („Quellen verbinden“).
* **App ohne Server:** bei der Einrichtung „Quellen verbinden (optional)“, später unter „Quellen & Schlüssel“. Die Schlüssel liegen im sicheren Speicher des Geräts.
* **Desktop-App:** Menü „Quellen & Schlüssel…“.
* **Terminal** (Pterodactyl-Konsole, Docker, Headless-Server):
  * `quellen` – Zustand je Anbieter
  * `quellen anleitung <anilist|mal|google_books>` – die Schritte mit Links (bei AniList fragt sie die Client-ID ab und druckt den Anmeldelink)
  * `quellen setzen <anbieter> [--benutzer Name] [--aus-datei pfad]` – fragt den Schlüssel verdeckt ab, prüft ihn und speichert ihn verschlüsselt. AniList-Token gehören immer zu einem Benutzer (`--benutzer`).
  * `quellen entfernen <anbieter> [--benutzer Name]`
  * Den Schlüssel nie direkt in die Befehlszeile schreiben. In der Pterodactyl-Konsole ist die Eingabe sichtbar; verdeckt geht es mit `node scripts/admin.js quellen setzen …` im Terminal.

Instanz-Schlüssel lassen sich auch per Umgebung setzen (`MAL_CLIENT_ID`, `GOOGLE_BOOKS_KEY`); sie haben Vorrang und erscheinen als „aus der Umgebung gesetzt“. Gespeicherte Schlüssel sind mit dem Server-Secret (`JWT_SECRET` bzw. `data/secret.key`) verschlüsselt: Wer das Secret wechselt oder ein Backup auf einem anderen Server einspielt, muss sie neu eintragen.

## 5. Backups & Wiederherstellung

Als Admin unter **Backups**:
* **Automatisch:** jeden Tag um `BACKUP_HOUR` Uhr (Standard 3, Zeitzone `BACKUP_TIMEZONE`) ein geprüfter Snapshot in `data/backups/`. Aufbewahrt werden je Art die neuesten: 7 tägliche, 10 manuelle, 3 vor einer Wiederherstellung, 3 vor einem Update (`BACKUP_KEEP_*`).
* **Neuen Snapshot erstellen** (oder `backup` in der Konsole) und **Direkt-ZIP** zum Herunterladen: Datenbank `manga.db` plus alle Bilder aus `uploads/`.
* **Wiederherstellen** aus einem Snapshot oder einer hochgeladenen ZIP (bis 500 MB): Der Server prüft das Archiv zuerst und zeigt seinen Inhalt; erst nach der Bestätigung wird getauscht. Vorher entsteht ein Snapshot `vor-wiederherstellung-*`, mit dem sich die Wiederherstellung rückgängig machen lässt. Danach sind alle anderen Sitzungen beendet.
* Das Secret (`data/secret.key`) steckt bewusst in keinem Backup. Zieht eine Sammlung per Backup auf einen anderen Server um, müssen gespeicherte API-Schlüssel dort neu eingetragen werden (sie sind mit dem Secret verschlüsselt); wer stattdessen den ganzen `data/`-Ordner kopiert, nimmt das Secret mit.
* **Sicherung aus der App** (Abschnitt 10): eine Server-Sammlung, die in die App geholt oder dort aus einer Server-ZIP importiert wurde, enthält danach keine Passwörter mehr. Spielt man die ZIP der App wieder auf einem Server ein, nennt die Prüfung die Konten ohne Passwort; sie brauchen danach einen Passwort-Reset in der Benutzerverwaltung. Steht das eigene Konto darunter, vor dem Abmelden ein neues Passwort setzen; ist niemand mehr angemeldet, hilft nur der Konsolenbefehl `passwort-reset <name>`. In einen Server mit eigener Sammlung führt „Zusammenführen“ (CSV), nicht die Wiederherstellung.
* Gelöschtes vor dem nächsten Backup: erst im Papierkorb nachsehen (30 Tage).
* **Zurück zur alten Version nach einem Update:** es gibt keinen automatischen Rückweg. Server stoppen, die alte Version einspielen (alte ZIP bzw. altes Image-Tag), starten und sofort als Admin unter Backups die Sicherung `vor-update-v<alt>-auf-v<neu>-….zip` wiederherstellen (hochladen, falls sie nicht in der Liste steht); bis dahin nichts ändern. Die alte Version nie dauerhaft mit der neuen Datenbank betreiben: was sie dann schreibt (z. B. den alten Status „Gelesen“), stellt ein späteres Update nicht mehr um. Die Bilder in `uploads/` bleiben in beiden Richtungen erhalten.

## 6. HTTPS & Eigene Domain (Reverse Proxy mit Nginx oder Caddy)

Für eine Adresse wie `https://manga.deinedomain.de` (ohne Port) richtest du auf dem Host einen Reverse Proxy ein. Browser verlangen HTTPS auch für die Live-Kamera und für die Installation als App mit Offline-Betrieb (Service Worker).

**DNS:** beim Domain-Anbieter einen **A-Record** anlegen: Name z. B. `manga` (oder `@`), Wert die öffentliche IP des Servers.

### Option A: Caddy (empfohlen, holt und erneuert Zertifikate selbst)

1. Caddy installieren:
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install caddy
   ```
2. In `/etc/caddy/Caddyfile` (Vorlage: `Caddyfile.example`; Port anpassen: Pterodactyl-Allocation, sonst 3000):
   ```caddy
   manga.deinedomain.de {
       reverse_proxy 127.0.0.1:25502
   }
   ```
3. `sudo systemctl reload caddy` – fertig, die Seite ist unter `https://manga.deinedomain.de` erreichbar.

### Option B: Nginx und Certbot

1. Installieren:
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
   ```
2. `nginx.conf.example` nach `/etc/nginx/sites-available/manga-shelf` kopieren, `server_name` und den Port in `proxy_pass` anpassen. Die Vorlage ist ein reiner HTTP-Block (ohne Zertifikat startet nginx sonst nicht) und erlaubt Uploads bis 512 MB (Backups bis 500 MB).
3. Aktivieren und prüfen:
   ```bash
   sudo ln -s /etc/nginx/sites-available/manga-shelf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. Zertifikat holen; Certbot ergänzt HTTPS im selben Block, leitet HTTP auf HTTPS um und richtet die Erneuerung ein:
   ```bash
   sudo certbot --nginx -d manga.deinedomain.de --redirect
   ```

### Dem Proxy vertrauen (`TRUST_PROXY`)

Login-Limit und Sperren hängen an der Adresse des Besuchers. Hinter einem Proxy sieht die App zuerst nur den Proxy; `TRUST_PROXY` sagt ihr, wessen `X-Forwarded-For` sie glauben darf. Standard ist `loopback` (nur ein Proxy auf demselben Rechner).

| Aufbau | `TRUST_PROXY` |
|---|---|
| Kein Proxy | Standard lassen (oder `false`) |
| Proxy auf demselben Rechner wie der Headless-Server / `npm start` | Standard `loopback` |
| Proxy auf dem Host vor Pterodactyl oder Docker (die App sieht die Gateway-Adresse des Docker-Netzes) | `loopback, 172.18.0.1` – nur die Gateway-Adresse (Pterodactyl-Netz `pterodactyl_nw`: `172.18.0.1`; Docker: `docker network inspect <netz>` → `Gateway`) |
| Proxy als Container in einem eigenen Docker-Netz, in dem nur Proxy und App hängen | Adresse des Proxy-Containers oder das Subnetz dieses Netzes |
| Proxy auf einem anderen Rechner | dessen Adresse, z. B. `loopback, 192.168.1.10` |

Kein ganzes Subnetz eines Netzes freigeben, in dem noch andere Container hängen (auf einem Pterodactyl-Node z. B. fremde Server): die erreichen den Port der App direkt und könnten sich jede Adresse aussuchen. Ohne passenden Eintrag teilen sich alle Besucher ein Login-Limit. Wichtig: Der Port der App darf dann **nur über den Proxy** erreichbar sein (Pterodactyl-Allocation an `127.0.0.1`, Docker `"127.0.0.1:3000:3000"`; veröffentlichte Docker-Ports umgehen ufw/firewalld), sonst kann jeder eine fremde Adresse vortäuschen und deren Login sperren. Eine Hop-Zahl (`TRUST_PROXY=1`) vertraut jedem, der sich verbindet, und ist deshalb nur hinter einer Firewall sinnvoll. Pterodactyl: Variable „Trust Proxy“ im Startup-Reiter; Docker: `environment` in `docker-compose.yml`; sonst `.env`.

Das Secure-Cookie setzt die App automatisch, sobald der Proxy `X-Forwarded-Proto: https` schickt (beide Vorlagen tun das). Natives HTTPS ohne Proxy: Zertifikat nach `ssl/privkey.pem` und `ssl/fullchain.pem` neben `index.js` legen (oder `SSL_KEY_PATH`/`SSL_CERT_PATH`), siehe Abschnitt 12. Beim Headless-Server liegt `ssl/` im Datenordner (Abschnitt 8).

## 7. Docker

Fertiges Image (Linux amd64 und arm64, z. B. Raspberry Pi 4/5): `ghcr.io/lixnix-swap-org/manga-shelf` mit den Tags `latest`, `X.Y.Z`, `vX.Y.Z` und `X.Y`.

```bash
docker run -d --name manga-shelf -p 3000:3000 -v ./data:/app/data --restart unless-stopped ghcr.io/lixnix-swap-org/manga-shelf:latest
```

Oder mit Compose: `docker-compose.yml` aus dem Repository nehmen (`JWT_SECRET`, `TRUST_PROXY` usw. sind dort als Beispiele auskommentiert) und `docker compose up -d`. Selbst bauen statt laden: in der Compose-Datei `image:` durch `build: .` ersetzen.

* **Daten:** Datenbank, Bilder und Backups liegen in `./data` auf dem Host. Das Image startet kurz als root, übernimmt den Besitz des Ordners (uid 1000) und lässt die App dann als Benutzer `node` laufen.
* **Einrichtungscode** für das erste Admin-Konto: `docker logs manga-shelf` (bzw. `docker compose logs manga-shelf`).
* **Update:** `docker compose pull && docker compose up -d` (ohne Compose: `docker pull …`, Container entfernen, mit demselben `docker run` neu starten). Vor jeder Migration legt der Server selbst eine Sicherung `backups/vor-update-*.zip` an und startet nicht, wenn das misslingt.
* **Gesundheit:** das Image hat einen `HEALTHCHECK` auf `/api/health` (`docker ps` zeigt `healthy`).
* **Reverse Proxy:** Port nur lokal veröffentlichen (`"127.0.0.1:3000:3000"`) und `TRUST_PROXY` auf die Adresse des Proxys setzen (Proxy auf dem Host: nur die Gateway-Adresse des Docker-Netzes, z. B. `loopback, 172.18.0.1`), siehe Abschnitt 6 und die Kommentare in `docker-compose.yml`. Weitere Variablen: Abschnitt 12.
* **Konsolenbefehle:** `docker exec -it -u node manga-shelf node scripts/admin.js status` (auch `backup`, `benutzer`, `passwort-reset <name>`, `quellen`). Immer mit `-u node`: das Image startet als root, ohne `-u node` gehören neu angelegte Backups und Reset-Dateien root.
* **Konsole per `docker attach`:** nur, wenn der Container mit offener Standardeingabe läuft: in `docker-compose.yml` die auskommentierten Zeilen `stdin_open: true` und `tty: true` aktivieren (bzw. `docker run -it -d …`) und den Container neu erstellen. Verlassen mit Strg+P, Strg+Q; Strg+C beendet den Server.
* **Signatur prüfen** (optional): `cosign verify ghcr.io/lixnix-swap-org/manga-shelf:latest --certificate-identity-regexp 'https://github.com/LixNix-Swap-Org/manga-shelf/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com`

## 8. Headless-Server (ohne Oberfläche, ohne Docker)

Für Ubuntu-Server, NAS, Mini-PC oder einen Windows-Rechner als reinen Host gibt es den Server als einzelnes Programm (Node.js ist eingebaut, nichts muss installiert werden). Download im Release:

| System | Datei |
|---|---|
| Linux x64 / arm64 | `manga-shelf-server-linux-x64` / `manga-shelf-server-linux-arm64` |
| Debian/Ubuntu, Fedora/RHEL | `manga-shelf-server_X.Y.Z-1_amd64.deb` / `manga-shelf-server-X.Y.Z-1.x86_64.rpm` (auch arm64/aarch64) |
| Windows | `manga-shelf-server-windows-x64.exe` |
| macOS (Apple Silicon und Intel) | `manga-shelf-server-macos-universal` |

**Starten:**

```bash
chmod +x manga-shelf-server-linux-x64
./manga-shelf-server-linux-x64 --port 3000 --data-dir ./manga-daten
```

Optionen: `--port`, `--host` (Standard `0.0.0.0`), `--data-dir`, `--log-file` (zusätzlich `<datenordner>/logs/manga-shelf.log`, rotiert), `--no-console`, `--version`, `--help`. Ohne `--data-dir` liegen die Daten unter Linux in `~/.local/share/manga-shelf`, unter macOS in `~/Library/Application Support/manga-shelf`, unter Windows in `%LOCALAPPDATA%\manga-shelf\data`. Eine `.env` im Datenordner wird gelesen (`PORT`, `TRUST_PROXY`, `JWT_SECRET` … wie in `.env.example`); Umgebungsvariablen und Kommandozeile haben Vorrang. Ist diese `.env` eine Verknüpfung, gehört sie einem anderen Benutzer oder dürfen andere sie ändern, starten Server und Konsolenbefehle nicht und nennen den Befehl, der das behebt: unter Linux/macOS `chmod 600 <datenordner>/.env` (Besitzer ist der Benutzer des Servers oder root; ein Datenordner, den andere ändern dürfen, muss diesem Benutzer oder root gehören), unter Windows `icacls <datenordner>\.env /inheritance:r /grant:r *S-1-5-32-544:F *<SID des Kontos>:F` (ändern dürfen nur das Konto des Servers, die Administratoren und SYSTEM). Lassen sich die Rechte nicht prüfen (z. B. PowerShell gesperrt), startet er ebenfalls nicht. Natives HTTPS: Zertifikate nach `<datenordner>/ssl/privkey.pem` und `fullchain.pem` legen (beim Linux-Dienst `/var/lib/manga-shelf/ssl/`, Besitzer `manga-shelf`) oder `SSL_KEY_PATH`/`SSL_CERT_PATH` mit absoluten Pfaden in `<datenordner>/.env` setzen. Das Web-Portal wird beim ersten Start in den Cache-Ordner entpackt (`~/.cache/manga-shelf`, `~/Library/Caches/manga-shelf`, `%LOCALAPPDATA%\manga-shelf\cache`; anderer Ort über `MANGA_SHELF_CACHE_DIR`).

**Konsolenbefehle** als Unterbefehle (gleiche Befehle wie in der Pterodactyl-Konsole): `status`, `backup`, `benutzer`, `passwort-reset <name>`, `rollback-aufraeumen`, `quellen …`, z. B. `manga-shelf-server-linux-x64 passwort-reset Kim --data-dir ./manga-daten`. `quellen setzen mal` fragt den Schlüssel verdeckt ab oder liest ihn aus der Standardeingabe.

**Als Dienst einrichten** (startet mit dem Rechner, ohne Anmeldung):

* **Linux (systemd):** `sudo ./manga-shelf-server-linux-x64 install-service` kopiert das Programm nach `/usr/local/bin/manga-shelf-server`, legt den Benutzer `manga-shelf` an, nutzt `/var/lib/manga-shelf` als Datenordner und startet `manga-shelf.service`. Logs und Einrichtungscode: `journalctl -u manga-shelf -n 50`. Ohne root: `install-service --user` (Benutzer-Dienst; damit er ohne Anmeldung läuft: `loginctl enable-linger $USER`). Der Datenordner ist 0750 (mit `--user` 0700), neue Dateien sind für andere Benutzer nicht lesbar (`UMask=0027`). Ein eigener Datenordner unter `/home` (`--data-dir`) geht auch für den System-Dienst: er sieht dann nur diesen Ordner der Home-Verzeichnisse; einfacher ist dort `--user`.
* **Debian/Ubuntu/Fedora:** einfacher über das Paket: `sudo apt install ./manga-shelf-server_*_amd64.deb` bzw. `sudo dnf install ./manga-shelf-server-*.rpm`. Das Paket richtet denselben Dienst ein; Updates einfach neueres Paket installieren. Beim Entfernen bleiben die Daten in `/var/lib/manga-shelf`.
* **macOS (launchd):** `./manga-shelf-server-macos-universal install-service` legt `~/Library/LaunchAgents/de.manga-shelf.server.plist` an (startet bei der Anmeldung, wird bei Absturz neu gestartet; Datenordner 0700). Logs: `~/Library/Application Support/manga-shelf/logs/manga-shelf.log`. Ist das Programm nicht signiert, vorher `xattr -d com.apple.quarantine manga-shelf-server-macos-universal` (macht `install-service` selbst).
* **Windows:** Eingabeaufforderung **als Administrator**, dann `manga-shelf-server-windows-x64.exe install-service`. Das Programm wird nach `C:\Program Files\Manga Shelf Server\` kopiert und als geplante Aufgabe „Manga Shelf Server“ beim Systemstart als **LOCAL SERVICE** gestartet (ohne Zeitlimit, Neustart bei Absturz; anderes Konto mit `--account NetworkService`, `--account DOMÄNE\name`, `.\name` oder einer SID). Daten in `C:\ProgramData\manga-shelf\data` mit frischen Rechten nur für dieses Konto, SYSTEM und die Administratoren; hat ein anderer Benutzer `C:\ProgramData\manga-shelf` vorher angelegt oder liegt dort eine Verknüpfung, bricht die Einrichtung ab; Log (mit dem Einrichtungscode) in `…\data\logs\manga-shelf.log` als Administrator öffnen. Konsolenbefehle für den Dienst als Administrator: `"C:\Program Files\Manga Shelf Server\manga-shelf-server.exe" passwort-reset <name> --data-dir C:\ProgramData\manga-shelf\data`. Wer `install-service` schon mit einer älteren Version eingerichtet hat (lief als SYSTEM), führt es einmal neu aus; das stellt Konto und Rechte um. Ein Node-Prozess ist ohne Hilfsprogramm kein echter Windows-Dienst; wer einen Dienst in der Dienste-Verwaltung möchte, nimmt [WinSW](https://github.com/winsw/winsw) oder [NSSM](https://nssm.cc/) mit `manga-shelf-server-windows-x64.exe --no-console --log-file --data-dir C:\ProgramData\manga-shelf\data`. Für andere Geräte im Netz den Port in der Windows-Firewall freigeben.
* **Entfernen:** `uninstall-service` (Linux mit `sudo` bzw. `--user`); Daten bleiben erhalten.

Selbst bauen (im Projektordner): `npm ci && (cd frontend && npm ci && npm run build) && node scripts/server-bin/build-sea.js` (aktuelles System; `--target linux-x64,linux-arm64,windows-x64,macos-universal` für andere, lädt dafür das passende offizielle Node von nodejs.org und prüft dessen Prüfsumme). Braucht Node 25.5 oder neuer; ein Node aus Homebrew oder einer Distribution ohne SEA-Unterstützung lädt automatisch das offizielle Node als Werkzeug. `--bundle-only` erzeugt nur `dist/server/server.cjs` (läuft mit `node dist/server/server.cjs`), `node scripts/server-bin/smoke.js <datei>` prüft ein Ergebnis.

## 9. Desktop-App (Windows, macOS, Linux)

Installer je System am Release bzw. als Build-Artefakt: Windows `manga-shelf-<version>-windows-x64-setup.exe` (Installationsordner wählbar) oder `-portable.exe`, macOS `manga-shelf-<version>-mac-universal.dmg` (Intel und Apple Silicon), Linux `.AppImage`, `.deb`, `.rpm` (Flatpak als Versuch).

Beim ersten Start wählst du die Betriebsart, später im Menü „Betriebsart“:
* **Nur auf diesem Gerät:** Sammlung im Benutzerordner, das Fenster zeigt den eigenen Server.
* **Mit Server verbinden:** Docker/Pterodactyl/Headless-Server zu Hause; Adressen und Anmeldung im sicheren Speicher des Systems.
* **Dieses Gerät ist Server:** Port 3000 im Heimnetz, „Adresse für andere Geräte“ zeigt Adresse und QR-Code für die Handy-Apps, Tray-Symbol, „Beim Anmelden starten“.

Den Einrichtungscode für das erste Admin-Konto setzt die App selbst und zeigt ihn an (Datei → „Einrichtungscode anzeigen…“). Umzug von „Nur auf diesem Gerät“ auf einen Server: unter Backups die Direkt-ZIP herunterladen und auf dem Server einspielen (Abschnitt 5). Kommandozeile: `--server-only`, `--port <n>`, `--host <adresse>`, `--data-dir <ordner>`, `--connect <url>`.

**Unsignierte Builds** (der Release-Text sagt, ob signiert wurde): macOS meldet „App kann nicht geöffnet werden“ → Rechtsklick → Öffnen (oder `xattr -dr com.apple.quarantine "/Applications/Manga Shelf.app"`); Windows SmartScreen → „Weitere Informationen“ → „Trotzdem ausführen“; Linux AppImage vorher `chmod +x`.

Automatische Updates gibt es noch nicht; Administratoren sehen neue Versionen im System-Fenster (Update-Prüfung über die GitHub-Releases).

Selbst bauen: `npm ci && (cd frontend && npm ci) && cd desktop && npm ci && npm run build:desktop` (Ergebnisse in `desktop/dist/installers/`). Ohne Signatur-Variablen (`CSC_LINK`, `APPLE_ID` …) baut das Skript unsigniert, auch wenn im macOS-Schlüsselbund eine Signier-Identität liegt.

## 10. Android und iPhone

Die Apps liegen als Artefakte jedes Builds bzw. am Release:

* **Android:** `manga-shelf-<version>-android.apk` auf dem Handy öffnen und die Installation aus unbekannten Quellen erlauben. Ohne Signierschlüssel im Release ist sie mit dem Debug-Schlüssel signiert und nicht Play-Store-tauglich; ein späteres Update mit dem echten Schlüssel verlangt einmal Deinstallieren (vorher in der App eine Sicherung exportieren). Die `.aab` ist für den Play Store.
* **iPhone/iPad:** `manga-shelf-<version>-ios-unsigned.ipa` mit AltStore, Sideloadly oder Xcode und der eigenen Apple-ID signieren (mit kostenlosem Konto 7 Tage gültig, danach neu signieren). Mit Zertifikat im Release gibt es stattdessen die signierte `manga-shelf-<version>-ios.ipa` (TestFlight/App Store bzw. die eingetragenen Geräte).
* **Erster Start:** „Ohne Server nutzen“ (Sammlung nur auf dem Gerät) oder Server eintragen bzw. den QR-Code „Mit App verbinden“ aus der Fußzeile scannen (Docker, Pterodactyl, Headless-Server oder Desktop-App im Server-Modus).
* **Selbst bauen:** `cd frontend && npm ci`, dann `cd mobile && npm ci && npm run build:android` (JDK 21, Android SDK 35) bzw. `npm run build:ios` (macOS, Xcode 16+, CocoaPods). Ergebnisse in `mobile/build/out/`.
* **Mindestversionen:** Android 6, iOS 15.5.
* **Gerätesicherung:** Android nimmt Sammlung und Bilder der App nicht in die automatische Cloud-Sicherung auf. Auf dem iPhone/iPad liegen sie im Dokumente-Ordner der App, den iCloud- und Gerätesicherungen noch mit sichern. Der verlässliche Weg ist auf beiden Systemen die ZIP-Sicherung der App (unten).

### Ohne Server nutzen und später umziehen

„Ohne Server nutzen“ legt die Sammlung nur auf dem Handy an: ein lokales Profil (Name, kein Passwort; weitere Profile für Besitz und Lesestand je Person), dieselbe Datenbank wie auf dem Server, Online-Suche direkt vom Gerät (Manga Passion, DNB/K10plus/Google Books, AniList/MyAnimeList) und eigene API-Schlüssel im sicheren Speicher. Es fehlen nur die Server-Dinge: Benutzerverwaltung, Server-Backups, System-Seite, Konsole. „Abmelden“ schließt dort nur die Sammlung; nichts wird gelöscht.

Die Sammlung liegt nur auf diesem Gerät. Regelmäßig „Sicherung exportieren“ und die ZIP an einem anderen Ort ablegen: Android sichert Datenbank und Bilder der App nicht automatisch, auf iPhone/iPad stecken sie zwar in iCloud- und Gerätesicherungen, aber nur als Teil der ganzen Gerätesicherung.

Unter **Server** (Verbindungsanzeige oben) gibt es „Sicherung exportieren/importieren“ (ZIP im Backup-Format des Servers) und drei Übernahmewege:

| Weg | Wann | Was passiert |
|---|---|---|
| **Auf Server übertragen** | neuer, frisch eingerichteter Server | Anmeldung als Admin; die App packt ihre Sammlung samt Covern als Backup und spielt es dort ein (der Server zeigt vorher seine Zahlen und warnt, wenn schon Daten da sind). Das lokale Profil wird zu diesem Admin-Konto, danach ist die App mit dem Server verbunden. |
| **Zusammenführen** | Server mit eigener Sammlung | Reihen und Bände kommen per CSV dazu (erst ein Probelauf mit Vorschau); Besitz und Lesestand landen beim angemeldeten Benutzer, vorhandene Einträge bleiben. Cover werden nicht übertragen (das Autofill lädt sie nach). |
| **Vom Server holen** | Sammlung eines Servers aufs Handy | Als Admin das komplette Backup mit Covern, sonst die Offline-Kopie (Reihen, Bände, eigener Besitz und Lesestand; Cover werden nachgeladen). Ersetzt die Sammlung auf dem Gerät. Passwörter, API-Schlüssel und Kalender-Abos der Server-Konten bleiben nicht auf dem Gerät (ebenso beim Import einer Server-ZIP). Auch auf dem Server-Bildschirm als „Sammlung auf dieses Gerät holen“. |

Danach kann die App ohne Server weiterlaufen oder verbunden bleiben; „Modus wechseln“ führt zurück zum Server-Bildschirm (die lokale Sammlung bleibt erhalten). Einen fortlaufenden Abgleich zwischen einer Sammlung ohne Server und einem Server gibt es nicht; wer beides nutzen will, verbindet die App mit dem Server (Offline-Kopie und nachgereichte Änderungen inklusive).

Server-Adressen in den Apps: `https://…` oder `http://…` nur im Heimnetz (private Adressen, Tailscale `100.64.0.0/10`, Namen auf `.local`, `.lan`, `.fritz.box`, `.home.arpa`, `.internal`).

### Von unterwegs

Ohne öffentliche Adresse ist der Server zu Hause von unterwegs nicht erreichbar. Die App (und der installierte Browser über HTTPS) zeigt dann die Offline-Kopie der Sammlung: lesen und suchen geht, Editoren und Admins können Besitz und Lesestand umschalten und Käufe aus der Einkaufsliste abhaken. Diese Änderungen werden vorgemerkt und gesendet, sobald der Server wieder erreichbar ist. Anlegen, Bearbeiten und Löschen, Release-Radar, Statistik und die Online-Suche gibt es erst wieder mit Verbindung.

Für echten Zugriff von unterwegs gibt es zwei Wege:
* **Öffentliche HTTPS-Adresse** (eigene Domain mit Reverse Proxy, Abschnitt 6) und diese in der App unter „Server“ als weitere Adresse desselben Servers eintragen; einmal über diese Adresse anmelden, danach nimmt die App jeweils die erste erreichbare.
* **VPN** wie Tailscale oder WireGuard (z. B. auf der FRITZ!Box): die Heimnetz-Adresse ist dann überall erreichbar, ohne den Server ins Internet zu stellen. Tailscale-Adressen (`100.64.0.0/10`) gelten in der App als Heimnetz und dürfen deshalb auch `http://` sein.

## 11. Release (für Maintainer)

* **Bei jedem Push** baut GitHub Actions (`ci.yml` → `build.yml`) alles als Workflow-Artefakte (14 Tage): Pterodactyl-ZIP, Server-Programme und Server-Pakete, Docker-Image (nur gebaut, nicht hochgeladen); Desktop-Installer und Handy-Smoke-Builds nur auf `main` und in Pull Requests. Nichts wird veröffentlicht.
* **Veröffentlichen:** Actions → **Release** → **Run workflow**, Branch wählen, `action`:
  * `build`: nur Artefakte bauen (für jeden Branch, mit Signierung, falls Secrets da sind),
  * `release`: Version erhöhen (`bump` = `patch`/`minor`/`major`; `none` nimmt die Version aus `package.json`, der Tag darf noch nicht existieren), Commit und Tag `vX.Y.Z` auf dem Branch, alles bauen (auch die Handy-Apps), Docker-Image nach GHCR mit den festen Tags `vX.Y.Z` und `X.Y.Z` (keyless mit cosign signiert), GitHub-Release mit allen Dateien, `SHA256SUMS.txt` und generierten Notizen; erst danach zeigen `X.Y` und `latest` auf dieses Image. Schlägt ein Schritt fehl, bleibt `latest` beim letzten Release. Ein Tag-Push allein veröffentlicht nichts.
* **Lokal:** `node release.js minor --dry-run` zeigt die nächste Version; `node release.js minor` setzt sie in allen `package.json`/`package-lock.json` (Server, `frontend/`, `desktop/`, `mobile/`), ohne Commit, Tag oder Push. Danach committen, pushen und den Workflow mit `bump = none` starten.
* **Einmalig einrichten:**
  * Ist der Branch geschützt, braucht der Workflow einen Fine-grained-PAT mit `Contents: Read and write` als Secret `RELEASE_TOKEN` (sonst genügt `GITHUB_TOKEN`).
  * Das GHCR-Paket `manga-shelf` nach dem ersten Release unter Packages → Package settings auf **Public** stellen (bei privatem Repository ist es sonst privat).
* **Signierung (optional, Repository-Secrets; fehlen sie, wird unsigniert gebaut):**

| Secret | Inhalt | Herkunft |
|---|---|---|
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Code-Signing-Zertifikat (`.pfx`, base64) und Passwort | Zertifizierungsstelle (OV/EV-Code-Signing) |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | „Developer ID Application“-Zertifikat (`.p12`, base64) und Passwort | Apple Developer Program → Certificates |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarisierung | appleid.apple.com → App-spezifische Passwörter; Team-ID im Developer-Konto |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Upload-/Release-Keystore (base64) | `keytool -genkeypair …` (gut aufheben, ein verlorener Schlüssel bedeutet neue App-ID im Store) |
| `IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` (+ `APPLE_TEAM_ID`) | Distribution-Zertifikat und Provisioning-Profil | Apple Developer Program |

  base64 einer Datei: `base64 -i datei.p12 | pbcopy` (macOS) bzw. `base64 -w0 datei.p12` (Linux). Der Release-Text nennt, welche Teile signiert sind.
* **Update-Hinweis:** Der Server prüft einmal täglich `releases/latest` von `LixNix-Swap-Org/manga-shelf` (Tag `vX.Y.Z`, kein Pre-Release) und zeigt Administratoren neue Versionen im System-Fenster; `UPDATE_CHECK=false` schaltet das ab.

## 12. Umgebungsvariablen

Alle Variablen sind optional. Sie kommen aus der Umgebung (Pterodactyl: Startup-Reiter bzw. Egg-Variablen; Docker: `environment`), aus einer `.env` im Arbeitsverzeichnis (Headless-Server: im Datenordner) oder beim Headless-Server aus der Kommandozeile. Ausführlich kommentiert in `.env.example`. Ein unbrauchbarer Wert erzeugt beim Start eine Warnung und der Standard gilt; nur ein ungültiger Port, ein ungültiges `TRUST_PROXY`, eine Sicherung vor dem Update, die sich nicht schreiben lässt (`MIGRATE_WITHOUT_SNAPSHOT`), und beim Headless-Server eine `.env`, die andere Benutzer ändern dürfen (Abschnitt 8), verhindern den Start.

| Variable | Standard | Wirkung |
|---|---|---|
| `PORT` | `3000` | Port des Servers. `SERVER_PORT` (setzt Pterodactyl) hat Vorrang. |
| `DATA_DIR` | `data/` im App-Ordner (Docker `/app/data`) | Datenbank, Bilder, Backups, `secret.key`. In Docker passend zum Volume ändern. |
| `TRUST_PROXY` | `loopback` | Wessen `X-Forwarded-For` gilt: `false`, `loopback`, Adressen/Subnetze wie `loopback, 172.18.0.1`, eine Hop-Zahl oder `true`. Hinter einem Proxy vor Docker/Pterodactyl nur die Gateway-Adresse eintragen, siehe Abschnitt 6. |
| `JWT_SECRET` | zufällig in `<DATA_DIR>/secret.key` | Signatur der Sitzungen und Schlüssel für gespeicherte API-Schlüssel; mindestens 32 Zeichen. Wechsel = alle neu anmelden, API-Schlüssel neu eintragen. |
| `SETUP_TOKEN` | beim Start erzeugt | Fester Einrichtungscode für das erste Admin-Konto, mindestens 12 Zeichen (ohne Leerzeichen und Bindestriche); kürzere Werte werden ignoriert. |
| `COOKIE_SECURE` | `false` | Secure-Cookie und HSTS erzwingen (nur hinter einem TLS-Proxy ohne `X-Forwarded-Proto`; über reines HTTP klappt die Anmeldung dann nicht). |
| `SSL_KEY_PATH`, `SSL_CERT_PATH` | `ssl/privkey.pem`, `ssl/fullchain.pem` (sonst `ssl/cert.pem`) im App-Ordner; Headless-Server im Datenordner | Natives HTTPS auf demselben Port, sobald beide Dateien da sind. |
| `CORS_ORIGIN` | leer | Zusätzliche Web-Ursprünge mit Cookie-Zugriff (kommagetrennt); das mitgelieferte Frontend braucht das nicht. |
| `APP_ORIGINS` | `capacitor://localhost`, `https://localhost`, `ionic://localhost`, `app://manga-shelf` | Ursprünge der Handy- und Desktop-Apps (Bearer-Token, kein Cookie); `none` schaltet sie ab. |
| `FRONTEND_DIR` | `frontend/dist`, sonst `dist/` | Ordner des gebauten Frontends. |
| `APP_TIMEZONE` | `Europe/Berlin` | Was „heute“ im Release-Radar ist. |
| `BACKUP_HOUR`, `BACKUP_TIMEZONE` | `3`, `Europe/Berlin` | Zeitpunkt des täglichen Snapshots. |
| `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_MANUAL`, `BACKUP_KEEP_PRE_RESTORE`, `BACKUP_KEEP_PRE_UPDATE` | `7`, `10`, `3`, `3` | Wie viele Snapshots je Art bleiben (1 bis 1000). |
| `MIGRATE_WITHOUT_SNAPSHOT` | `false` | Lässt sich die Sicherung vor dem Update (`backups/vor-update-….zip`) nicht schreiben, bricht der Start vor den Migrationen ab; `1` migriert trotzdem ohne diese Sicherung (nur einmalig setzen). |
| `RESTORE_MAX_DB_BYTES`, `RESTORE_MAX_UPLOADS_BYTES`, `RESTORE_MAX_ENTRIES` | 2 GiB, 4 GiB, `100000` | Grenzen beim Entpacken eines Backups. |
| `ADMIN_CONSOLE` | `true` | Konsolenbefehle auf stdin (Abschnitt 3). |
| `UPDATE_CHECK` | `true` | Die System-Seite fragt höchstens einmal am Tag bei GitHub nach einer neuen Version (nur solange ein Admin sie offen hat). |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `text` | `debug`/`info`/`warn`/`error`/`silent`; `json` für Log-Werkzeuge. |
| `ANIME_ANILIST_RPM`, `ANIME_JIKAN_RPM` | `30`, `60` | Anfragen pro Minute des gemeinsamen Zugangs zu AniList bzw. Jikan (1 bis 600). |
| `ANIME_SOURCES` | `anilist,jikan` | Aktive Anime-Quellen (`jikan` bzw. `mal` steht für MyAnimeList); unbekannte Namen werden mit Warnung ignoriert. |
| `MAL_CLIENT_ID`, `GOOGLE_BOOKS_KEY` | leer | Instanz-Schlüssel (Abschnitt 4); haben Vorrang vor den in der Oberfläche hinterlegten. |
| `MANGA_SHELF_CACHE_DIR` | System-Cache | Nur Headless-Server: wohin das Web-Portal entpackt wird. |

Die Skripte `scripts/check-remote.js`, `seed-remote.js` und `verify-remote.js` lesen `REMOTE_URL`, `REMOTE_HOST`, `REMOTE_PORT`, `REMOTE_USER`, `REMOTE_PASS` (der Server selbst nie), die Browser-Tests `CHROME_BIN`.

## 13. Entwicklung

```bash
npm install && (cd frontend && npm install)
npm run dev          # Backend mit node --watch und Vite in einem Terminal; Demo-Daten in data-dev/, Logins in data-dev/seed-users.json
npm test             # Backend (node:test)
npm run test:frontend   # Vitest
npm run lint
```

Die Browser-Suites (`npm run test:e2e`, `test:radar`, `test:anime`, `test:deep`, `test:perf`) brauchen Chrome oder Chromium (`CHROME_BIN`). Aufbau, Regeln und Datei-Landkarte für Mitwirkende stehen in `AGENTS.md`.
