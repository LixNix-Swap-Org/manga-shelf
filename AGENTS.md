# 📚 Manga Shelf 2.0 – Entwickler- & Agenten-Wissensdatenbank (AGENTS.md)

> Diese Datei dient als zentrale Wissensdatenbank und Architekturübersicht für KI-Agenten und Entwickler.  
> Sie dokumentiert die Codebase, Datenstrukturen, API-Endpunkte sowie konkrete Anleitungen, **wo** bei künftigen Änderungen eingegriffen werden muss.

---

## 1. Projektübersicht & Tech-Stack

* **Zweck:** Leichtgewichtiges, modernes Manga-Verwaltungssystem (Self-hosted) mit Multi-User-Support, Rollenmodell, Lese-Tracking, Statistiken und Backup-System.
* **Architektur:** Monolithisch für minimalen Deployment-Overhead (Backend serviert das vorkompilierte React-Frontend als statische Dateien unter `/`).
* **Backend:**
  * **Runtime:** Node.js (kompatibel mit Node 18 bis Node 25+)
  * **Framework:** Express.js (`index.js`)
  * **Datenbank:** SQLite (`manga.db` im WAL-Modus) via `node:sqlite` (integriert in modernem Node) mit Fallback auf `better-sqlite3` (`db.js`)
  * **Auth:** JSON Web Token (JWT) in `httpOnly`-Cookies (`token`), Kennwort-Hashing via `bcryptjs`
  * **Dateiverwaltung:** `multer` für Cover- & Bild-Uploads (gespeichert in `data/uploads/`)
  * **Backups:** `archiver` & `adm-zip` für Zero-Dependency ZIP-Backups der SQLite-DB + Uploads
* **Frontend:**
  * **Tooling:** Vite + React 18 (`frontend/`)
  * **Styling:** Tailwind CSS + Lucide Icons + Custom CSS Animations (`frontend/src/index.css`)
  * **Routing:** `react-router-dom` v6
* **Deployment-Target:**
  * Speziell für **Pterodactyl Panel** (Generic Node.js Egg oder Custom Egg `egg-manga-shelf.json`)
  * Reverse Proxy Unterstützung (Nginx, Caddy, Cloudflare) mit `trust proxy = true`

---

## 2. Verzeichnis- & Datei-Landkarte

```text
c:\Manga Webseite 2.0/
├── AGENTS.md                  # <-- DIESE WISSENSDATENBANK
├── README.md                  # Setup- & Deployment-Anleitung für Nutzer/Admins
├── package.json               # Backend Root Dependencies & NPM Scripts
├── package.js                 # Packager-Skript: baut Frontend & packt Backend als ZIP
├── index.js                   # Hauptserver: Express App, Middleware, alle REST-Routen
├── db.js                      # DB-Verbindung, Schema, Tabellen-Erstellung & Migrationen
├── egg-manga-shelf.json       # Pterodactyl Egg Vorlage
├── Caddyfile.example          # Beispiel-Konfiguration für Reverse Proxy via Caddy
├── nginx.conf.example         # Beispiel-Konfiguration für Reverse Proxy via Nginx
├── test-e2e-suite.js          # Automatisierte Puppeteer Browser E2E-Tests
├── data/                      # Persistente Anwendungsdaten (in .gitignore)
│   ├── manga.db               # SQLite-Hauptdatenbank (WAL-Modus)
│   └── uploads/               # Hochgeladene Cover- & Bandbilder
├── dist_pack/                 # Ausgabeordner für Pterodactyl ZIP-Pakete
└── frontend/                  # React Frontend Projekt
    ├── index.html             # HTML Entrypoint
    ├── vite.config.js         # Vite-Konfiguration (Proxy auf :3000 im Dev-Modus)
    ├── tailwind.config.js     # Tailwind CSS Konfiguration & Themes
    └── src/
        ├── main.jsx           # React Root Mount
        ├── App.jsx            # Routing, Auth-Check & Setup-Check
        ├── Dashboard.jsx      # Hauptdashboard: Manga-Grid, Filter, Suche, Stats, User-Modal
        ├── MangaDetail.jsx    # Manga-Detailseite: Bände, Batch-Lese-Status, Edit-Modals
        ├── Login.jsx          # Login-Maske
        ├── Setup.jsx          # Initialer Einrichtungs-Assistent (Admin-Account)
        └── index.css          # Globale Styles, Scrollbars, Glasmorphismus & Farbtöne
```

---

## 3. Datenbank-Schema & Datenmodelle (`db.js`)

Die SQLite-Datenbank befindet sich in `./data/manga.db`.

### Tabellen-Übersicht

1. **`users`**
   * `id` (INTEGER, PK, AI)
   * `username` (TEXT, UNIQUE, NOT NULL)
   * `password_hash` (TEXT, NOT NULL)
   * `role` (TEXT, DEFAULT `'editor'`) – Werte: `'admin'`, `'editor'`, `'visitor'`
   * `created_at` (DATETIME, DEFAULT CURRENT_TIMESTAMP)

2. **`mangas`**
   * `id` (INTEGER, PK, AI)
   * `title` (TEXT, NOT NULL)
   * `alt_title` (TEXT)
   * `author` (TEXT)
   * `publisher` (TEXT)
   * `language` (TEXT)
   * `status` (TEXT) – z. B. `'Laufend'`, `'Abgeschlossen'`, etc.
   * `tags` (TEXT) – z. B. kommagetrennte Genres / Tags
   * `total_volumes` (INTEGER) – Geplante / bekannte Gesamtbandanzahl
   * `owned_volumes` (INTEGER, DEFAULT 0) – Automatisch oder manuell gezählt
   * `description` (TEXT)
   * `cover_image` (TEXT) – Relativer Pfad, z. B. `uploads/xyz.jpg`
   * `banner_image` (TEXT) – Optionales Bannerbild
   * `created_at`, `updated_at` (DATETIME)
   * `updated_by` (INTEGER, FK -> `users.id`)

3. **`volumes`**
   * `id` (INTEGER, PK, AI)
   * `manga_id` (INTEGER, FK -> `mangas.id` ON DELETE CASCADE)
   * `volume_number` (TEXT, NOT NULL) – String, um z. B. "1", "0", "12.5" oder "Special" zu erlauben
   * `isbn` (TEXT)
   * `price` (REAL) – Kaufpreis in €
   * `release_year` (INTEGER)
   * `condition` (TEXT) – Zustand (z. B. "Sehr gut", "Neu")
   * `pages` (INTEGER) – Seitenanzahl (wichtig für Lesestatistiken)
   * `publisher` (TEXT)
   * `purchase_date` (TEXT) – Kaufdatum (Format `YYYY-MM-DD`)
   * `status` (TEXT) – z. B. "Besitz", "Bestellt", "Wunschliste"
   * `notes` (TEXT)
   * `cover_image` (TEXT)
   * `images` (TEXT) – JSON-String für Zusatzbilder / Galerie
   * `created_at` (DATETIME)

4. **`volume_reads`**
   * Verknüpfungstabelle für den individuellen Lesestatus **pro Benutzer**:
   * `volume_id` (INTEGER, FK -> `volumes.id` ON DELETE CASCADE)
   * `user_id` (INTEGER, FK -> `users.id` ON DELETE CASCADE)
   * `read_at` (DATETIME, DEFAULT CURRENT_TIMESTAMP)
   * *PK: (`volume_id`, `user_id`)*

5. **`app_settings`**
   * `key` (TEXT, PK)
   * `value` (TEXT)
   * z. B. `collection_start_date` (Default: `'2021-04-09'`) für die Berechnung der Sammeljahre

---

## 4. Rollen- & Berechtigungskonzept

* **`admin`**:
  * Volle Kontrolle über das gesamte System
  * Benutzerverwaltung (Nutzer anlegen, Rollen ändern, Passwörter zurücksetzen, löschen)
  * Backups herunterladen (`GET /api/backup`) & einspielen (`POST /api/backup/restore`)
  * Sammlungs-Einstellungen anpassen (`PUT /api/stats/settings`)
* **`editor`**:
  * Kann Mangas erstellen, bearbeiten und löschen
  * Kann Bände anlegen (einzeln oder per Batch), bearbeiten, löschen
  * Kann Bände als gelesen/ungelesen markieren (individuell pro Benutzer)
  * Kann Bilder/Cover hochladen
  * *Kein Zugriff* auf Benutzerverwaltung oder Backups
* **`visitor` / `guest`**:
  * Reiner **Lesezugriff** (Read-Only)
  * Sieht alle Mangas, Bände und Statistiken
  * Kann *keine* Daten manipulieren (wird serverseitig über `requireEditor` Middleware mit HTTP 403 geblockt)

---

## 5. API-Endpunkte Übersicht (`index.js`)

| Endpunkt | Methode | Middleware | Beschreibung |
| :--- | :--- | :--- | :--- |
| `/api/setup/status` | GET | public | Prüft ob initialer Admin existiert (`needsSetup`) |
| `/api/setup` | POST | public | Erstellt initialen Admin-User bei Setup |
| `/api/auth/login` | POST | public | Login (setzt JWT `httpOnly` Cookie) |
| `/api/auth/logout` | POST | public | Logout (löscht Cookie) |
| `/api/auth/me` | GET | `requireAuth` | Gibt aktuell eingeloggten Benutzer zurück |
| `/api/users` | GET, POST | `requireAdmin` | Nutzer auflisten / neuen Nutzer anlegen |
| `/api/users/:id` | PUT, DELETE | `requireAdmin` | Rolle/Passwort ändern / Nutzer löschen |
| `/api/users/:id/stats` | GET | `requireAuth` | Persönliche Lesestatistiken eines Nutzers |
| `/api/mangas` | GET | `requireAuth` | Alle Mangas für die Übersicht abrufen |
| `/api/mangas` | POST | `requireEditor` | Neuen Manga anlegen |
| `/api/mangas/:id` | GET | `requireAuth` | Details eines Mangas inkl. Bände & Lesestatus |
| `/api/mangas/:id` | PUT | `requireEditor` | Manga Metadaten bearbeiten |
| `/api/mangas/:id` | DELETE | `requireEditor` | Manga löschen (löscht kaskadierend Bände) |
| `/api/volumes` | POST | `requireEditor` | Einzelnen Band anlegen |
| `/api/volumes/batch` | POST | `requireEditor` | Mehrere Bände auf einmal generieren |
| `/api/volumes/:id` | PUT | `requireEditor` | Banddetails bearbeiten |
| `/api/volumes/:id` | DELETE | `requireEditor` | Einzelnen Band löschen |
| `/api/volumes/:id/read` | POST | `requireEditor` | Lesestatus für Band umschalten (Toggle) |
| `/api/volumes/batch-read` | POST | `requireEditor` | Bände 1 bis X auf einen Klick als gelesen markieren |
| `/api/stats` | GET | `requireAuth` | Gesamte Sammlungs-Statistiken abrufen |
| `/api/stats/settings` | PUT | `requireAdmin` | z. B. Sammelstartdatum aktualisieren |
| `/api/upload` | POST | `requireEditor` | Einzelnes Bild hochladen (Multer -> `data/uploads`) |
| `/api/upload/multiple` | POST | `requireEditor` | Bis zu 10 Bilder auf einmal hochladen |
| `/api/backup` | GET | `requireAdmin` | Erzeugt & streamt ZIP-Backup von `data/` |
| `/api/backup/restore` | POST | `requireAdmin` | Lädt ZIP-Backup hoch, synchronisiert DB & Bilder |

---

## 6. Wo muss was geändert werden? (Task-to-File Guide)

### 🔹 Fall A: Neues Feld für Mangas hinzufügen (z. B. "Demographie" oder "Originalsprache")
1. **Datenbank (`db.js`):**
   * Im `CREATE TABLE IF NOT EXISTS mangas` das Feld ergänzen.
   * In der Migrationssektion darunter prüfen: `PRAGMA table_info(mangas)` und `ALTER TABLE mangas ADD COLUMN ...` ausführen, damit bestehende Datenbanken das Feld erhalten.
2. **Backend API (`index.js`):**
   * Im `POST /api/mangas` das Feld aus `req.body` entgegennehmen und im `INSERT INTO mangas` eintragen.
   * Im `PUT /api/mangas/:id` das Feld in das `UPDATE mangas SET ...` aufnehmen.
   * Im `GET /api/mangas` und `GET /api/mangas/:id` sicherstellen, dass das Feld selektiert wird (meist durch `SELECT *`).
3. **Frontend UI:**
   * `frontend/src/Dashboard.jsx`: Im Modal "Manga anlegen / bearbeiten" ein Eingabefeld hinzufügen.
   * `frontend/src/MangaDetail.jsx`: In den Metadaten der Detailansicht das Feld anzeigen und im Bearbeiten-Modal editierbar machen.

### 🔹 Fall B: Neues Feld für Bände/Volumes hinzufügen (z. B. "Edition", "Farbe", "Format")
1. **Datenbank (`db.js`):**
   * In `CREATE TABLE IF NOT EXISTS volumes` Spalte ergänzen.
   * Bei `volColNames.has('mein_feld')` ein `ALTER TABLE volumes ADD COLUMN ...` hinzufügen.
2. **Backend API (`index.js`):**
   * In `POST /api/volumes`, `POST /api/volumes/batch` und `PUT /api/volumes/:id` das Feld berücksichtigen.
3. **Frontend UI:**
   * `frontend/src/MangaDetail.jsx`:
     * Im Volume-Card / List-Item rendern.
     * Im "Band hinzufügen"- & "Band bearbeiten"-Modal Formularfelder hinzufügen.

### 🔹 Fall C: Neues Statistik-Widget oder Auswertung hinzufügen
1. **Backend API (`index.js`):**
   * Route `GET /api/stats` aufrufen/bearbeiten.
   * Die SQLite-Aggregatsabfrage (SUM, AVG, COUNT, GROUP BY) hinzufügen und im Antwort-JSON zurückgeben.
2. **Frontend UI (`frontend/src/Dashboard.jsx`):**
   * Im Tab "Statistiken" (`activeTab === 'stats'`) das neue Widget oder Diagramm gestalten.

### 🔹 Fall D: UI/Design/Styling ändern
1. **Globale Farbtöne, Scrollbars, Glasmorphismus:**
   * `frontend/src/index.css` (enthält CSS-Variablen, Scrollbar-Klassen, Animationen).
2. **Tailwind-Konfiguration:**
   * `frontend/tailwind.config.js`.
3. **Komponenten:**
   * Header, Regal-Ansicht, Grid-Ansicht, Modals: `frontend/src/Dashboard.jsx`.
   * Banner, Bandkarten, Cover-Grid: `frontend/src/MangaDetail.jsx`.

### 🔹 Fall E: Benutzerberechtigungen anpassen
1. **Backend Middleware (`index.js`):**
   * Funktionen `requireAuth`, `requireAdmin`, `requireEditor`.
   * Neue Rollen oder feinere Rechte direkt in den entsprechenden Routen prüfen.
2. **Frontend UI:**
   * Bedingte Buttons (`user.role === 'admin'` oder `user.role !== 'visitor'`) in `Dashboard.jsx` und `MangaDetail.jsx`.

---

## 7. Build-, Test- & Release-Workflow

### Lokaler Entwicklungsmodus
* **Backend starten:**
  ```powershell
  npm run dev
  # Server lauscht auf http://localhost:3000 (oder PORT aus .env)
  ```
* **Frontend Hot-Reload starten:**
  ```powershell
  cd frontend
  npm run dev
  # Vite startet auf http://localhost:5173 und proxied API-Calls auf :3000
  ```

### Automatisierte E2E Browser-Tests
* Zum Validieren von UI, Logins, CRUD und Backups:
  ```powershell
  node test-e2e-suite.js
  ```

### Paketierung für Pterodactyl (Release ZIP)
* Ein einziger Befehl kompiliert das Frontend und bündelt das Backend:
  ```powershell
  npm run package
  ```
* Ergebnis: `pterodactyl-manga-shelf.zip` im Root- und `dist_pack/`-Verzeichnis.

### Git & GitHub Deployment
* Repository: `https://github.com/MoltresHD/manga-shelf`
* Push-Befehle:
  ```powershell
  git add .
  git commit -m "feat/fix: Beschreibung"
  git push
  ```

---

## 8. Wichtige Fallstricke & Gotchas (Merke dir das!)

1. **Node.js 25+ Warning Suppression (`index.js` Zeile 1–9):**
   * Node 25 wirft für ältere `fs.Stats` Konstruktoren Warnungen (`DEP0180`). Diese werden am Dateianfang von `index.js` abgefangen, um Logs sauber zu halten. Nicht entfernen!
2. **SQLite WAL-Modus & Backup-Restore:**
   * Vor dem Entpacken eines Restore-Archivs muss `closeDb()` aufgerufen werden (inkl. `PRAGMA wal_checkpoint(TRUNCATE)`), da Windows offene Dateihandles sperrt. Nach dem Restore wird `initDb()` aufgerufen.
3. **Cookie-Handling & HTTPS:**
   * `app.set('trust proxy', true)` ist aktiv. `setAuthCookie` prüft `req.secure` sowie `x-forwarded-proto === 'https'`. Bei reinem HTTP im LAN oder ohne SSL wird das `secure`-Flag dynamisch weggelassen, damit der Login auch ohne HTTPS reibungslos funktioniert.
4. **Verzeichnisse:**
   * Alle persistenten Daten liegen ausschließlich unter `data/` (`manga.db` und `data/uploads/`).
   * Alles unter `data/` ist in `.gitignore`, damit keine privaten Daten oder Passwörter in GitHub landen.
