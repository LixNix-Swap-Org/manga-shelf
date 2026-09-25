# Manga Shelf - Setup & Deployment Guide

Diese Anwendung ist ein leichtgewichtiges Manga-Verwaltungssystem, das speziell für das einfache Deployment auf Pterodactyl ohne Git-Overhead konzipiert wurde.

## 1. Lokales Bauen & Packen (ZIP-Erstellung)

Um die Anwendung für Pterodactyl vorzubereiten, musst du sie lokal bauen. Du benötigst Node.js (v18+) auf deinem PC.

1. Öffne ein Terminal im Projektordner.
2. Installiere die Backend-Abhängigkeiten (nur für das Packaging Script nötig, optional falls du manuell zippst):
   ```bash
   npm install
   ```
3. Führe den Build- und Package-Befehl aus:
   ```bash
   npm run package
   ```
Dieser Befehl macht Folgendes:
- Er navigiert in den `frontend/` Ordner, installiert die Vite/React Dependencies und kompiliert das Frontend in statische Dateien (`frontend/dist/`).
- Er ruft das Skript `package.js` auf.
- Es wird eine fertige `pterodactyl-manga-shelf.zip` im Ordner `dist_pack/` erzeugt.

**Falls `npm run package` fehlschlägt, kannst du es manuell machen:**
1. Geh in `frontend/`, führe `npm install` und `npm run build` aus.
2. Markiere folgende Dateien/Ordner: `index.js`, `db.js`, `package.json`, `frontend/dist/`.
3. Verpacke diese in ein ZIP-Archiv.

## 2. Pterodactyl Egg Vorbereitung

Du kannst entweder das **Generic Node.js Egg** deines Pterodactyl-Servers nutzen, oder unser mitgeliefertes Egg importieren:

**Optional: Eigenes Egg importieren**
1. Gehe in Pterodactyl ins Admin-Panel.
2. Navigiere zu **Nests** -> **Import Egg**.
3. Lade die Datei `egg-manga-shelf.json` hoch.
4. Wähle das Ziel-Nest (z.B. Generic) und klicke "Import".

## 3. Server anlegen & hochladen

1. Erstelle einen neuen Server in Pterodactyl. Wähle als Egg das importierte "Manga Shelf App" oder das "Generic Node.js" Egg.
2. Weise dem Server einen Port zu (Standard Pterodactyl Allocation).
3. Stelle sicher, dass die Umgebungsvariable `SERVER_PORT` mit dem zugewiesenen Port übereinstimmt.
4. Gehe auf den **File Manager** deines neuen Servers.
5. Lösche eventuelle Standarddateien.
6. Lade die generierte `pterodactyl-manga-shelf.zip` (oder dein manuelles ZIP) hoch.
7. Mache einen Rechtsklick auf die ZIP-Datei und wähle **Unarchive**.
8. Klicke auf **Start**.

Beim ersten Start wird:
- `npm install --production` ausgeführt (falls im Egg konfiguriert).
- Die SQLite Datenbank in `./data/manga.db` im WAL-Modus angelegt.
- Der Server auf dem konfigurierten Port lauschen.

## 4. Ersteinrichtung der App

1. Öffne die URL deines Pterodactyl Servers im Browser (z.B. `http://deine-ip:port`).
2. Du wirst automatisch zum Setup-Screen weitergeleitet.
3. Lege den initialen Admin-Account fest.
4. Du bist nun im Dashboard und kannst Mangas anlegen, Cover hochladen und deine Bände tracken.

## 5. Backups & Wiederherstellung (Restore)

Als Administrator stehen dir im Dashboard zwei wichtige Funktionen zur Datensicherung zur Verfügung:

1. **Backup herunterladen**: Über den Button **Backup** lädst du direkt ein ZIP-Archiv deines `data/`-Verzeichnisses herunter (inklusive der SQLite-Datenbank `manga.db` und aller Coverbilder im `uploads/`-Ordner).
2. **Backup einspielen (Restore)**: Über den Button **Backup einspielen** kannst du ein zuvor gespeichertes `.zip`-Backup auswählen und hochladen. Das System schließt sicher die Datenbankverbindung, synchronisiert alle Tabellen & Bilder, führt automatische Migrationen durch und aktualisiert das Dashboard sofort.

## 6. HTTPS & Eigene Domain (Reverse Proxy mit Nginx oder Caddy)

Um die Manga-Shelf Webseite über eine saubere Domain mit gültigem HTTPS (ohne Portangabe wie `:25502`) aufzurufen, richtest du auf deinem Host-Server einen Reverse Proxy ein.

### Schritt 1: DNS A-Record anlegen
Trage bei deinem Domain-Registrar (z. B. Cloudflare, Strato, Namecheap, Hetzner, etc.) einen **A-Record** ein:
- **Typ**: `A`
- **Name / Host**: z. B. `manga` (oder `@` für die Hauptdomain)
- **Wert / Ziel**: Die öffentliche IP-Adresse deines Servers (z. B. `159.195.49.57`)

### Option A: Mit Caddy (Empfohlen – Einfachste & schnellste Lösung)
Caddy besorgt und erneuert SSL-Zertifikate von Let's Encrypt komplett automatisch:
1. Installiere Caddy auf deinem Host-Server (falls noch nicht vorhanden):
   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install caddy
   ```
2. Öffne `/etc/caddy/Caddyfile` und trage ein:
   ```caddy
   manga.deinedomain.de {
       reverse_proxy 127.0.0.1:25502
   }
   ```
3. Starte Caddy neu:
   ```bash
   sudo systemctl reload caddy
   ```
Fertig! Deine Seite ist sofort unter `https://manga.deinedomain.de` erreichbar.

### Option B: Mit Nginx & Certbot
1. Installiere Nginx und Certbot:
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
   ```
2. Kopiere die Vorlage aus `nginx.conf.example` nach `/etc/nginx/sites-available/manga-shelf`:
   Passe `server_name` an deine Domain an.
3. Aktiviere die Seite:
   ```bash
   sudo ln -s /etc/nginx/sites-available/manga-shelf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. Hole das kostenlose SSL-Zertifikat mit Certbot:
   ```bash
   sudo certbot --nginx -d manga.deinedomain.de
   ```
Certbot konfiguriert Nginx automatisch und richtet die automatische Erneuerung ein.
