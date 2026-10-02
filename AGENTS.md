# 📚 Manga Shelf 2.0 – Entwickler- & Agenten-Wissensdatenbank (AGENTS.md)

> Diese Datei dient als zentrale Wissensdatenbank und Architekturübersicht für KI-Agenten und Entwickler.  
> Sie dokumentiert die Codebase, Datenstrukturen, API-Endpunkte sowie konkrete Anleitungen, **wo** bei künftigen Änderungen eingegriffen werden muss.

---

## 1. Projektübersicht & Tech-Stack

* **Zweck:** Leichtgewichtiges, modernes Manga-Verwaltungssystem (Self-hosted) mit Multi-User-Support, Rollenmodell, Lese-Tracking, Statistiken und Backup-System.
* **Architektur:** Monolithisch für minimalen Deployment-Overhead (Backend serviert das vorkompilierte React-Frontend als statische Dateien unter `/`).
* **Backend:**
  * **Runtime:** Node.js >= 22.5 (`node:sqlite` ist erforderlich; `engines` in `package.json`, Docker-Image `node:22-alpine`)
  * **Framework:** Express.js 5 (`index.js`)
  * **Datenbank:** SQLite (`manga.db` im WAL-Modus) via `node:sqlite` (`db.js`). `better-sqlite3` wird nur als optionaler Fallback geladen und ist **keine** Dependency
  * **Auth:** JSON Web Token (JWT) in `httpOnly`-Cookies (`token`), Kennwort-Hashing via asynchrones `bcryptjs`. Nutzer und Rolle werden bei **jedem** Request aus der DB geladen (`middleware/auth.js`), nicht aus dem Token
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
├── .env.example               # Vorlage für Umgebungsvariablen (Port, Host, Secrets)
├── Dockerfile                 # Multi-Stage Docker-Build (Vite Build -> Alpine Runner)
├── docker-compose.yml         # Docker Compose Setup mit Volume-Mapping auf ./data
├── package.json               # Backend Root Dependencies & NPM Scripts
├── eslint.config.js           # ESLint (Flat Config), `npm run lint`
├── package.js                 # Packager-Skript: baut Frontend & packt Backend als ZIP
├── index.js                   # Schlanker Hauptserver: Express Initialisierung & Route-Mounting
├── db.js                      # DB-Verbindung, Schema, Indizes & sequentielle Migrationen
├── mangaPassion.js            # Manga Passion API Client mit Timeout & Resilienz
├── egg-manga-shelf.json       # Pterodactyl Egg Vorlage
├── Caddyfile.example          # Beispiel-Konfiguration für Reverse Proxy via Caddy
├── nginx.conf.example         # Beispiel-Konfiguration für Reverse Proxy via Nginx
├── release.js                 # GitHub Release Automatisierung & Asset-Upload
├── test-e2e-suite.js          # Automatisierte Puppeteer Browser E2E-Tests
├── test-release-radar.js      # Headless E2E-Test für Release-Radar Ansicht
├── test-performance-suite.js  # Performance-Benchmark Suite
├── scripts/                   # Administrative Hilfsskripte (Remote-Prüfung, Seed)
│   ├── check-remote.js
│   ├── seed-remote.js
│   └── verify-remote.js
├── middleware/                # Wiederverwendbare Express-Middlewares
│   ├── auth.js                # Auth, Rollenprüfungen (requireAdmin, requireEditor) & JWT
│   ├── rateLimit.js           # In-Memory Rate-Limiter (Login, Setup)
│   └── upload.js              # Multer Konfiguration (Covers & Staging für Backups)
├── routes/                    # Modularisierte Express Router
│   ├── auth.js                # Setup, Login, Logout, Session & Benutzerverwaltung
│   ├── mangas.js              # Manga CRUD, Editionsabgleich & Lückenverwaltung
│   ├── volumes.js             # Band CRUD, Batch-Generierung & Lese-Status
│   ├── backups.js             # Server-Snapshots & Wiederherstellung (Disk-Staging)
│   ├── stats.js               # Sammlungsstatistiken & Einstellungen
│   ├── radar.js               # Einkaufsliste, Release-Radar & Manga Passion Monatsradar
│   └── lookup.js              # DNB ISBN-Suche, Manga Passion / AniList Lookup & Uploads
├── services/                  # Hintergrund-Dienste
│   └── scheduler.js           # Täglicher automatischer Backup-Scheduler (7 Snapshots)
├── utils/                     # Hilfsfunktionen & Normalisierer
│   ├── publishers.js          # Verlags-Normalisierung & Mappings
│   └── safeFetch.js           # SSRF-sicherer Bild-Download (nur öffentliche Hosts, Größenlimit, Magic Bytes)
├── test/                      # node:test API-Tests (`npm test`) & Deep E2E Tests
│   ├── api.test.js
│   ├── deep-e2e.js
│   └── helpers.js
├── .github/workflows/ci.yml   # CI: Lint, Tests, Docker-Build + Start-Test
├── deploy/workflows/          # Vorlagen für Release-Workflows
├── data/                      # Persistente Anwendungsdaten (in .gitignore)
│   ├── manga.db               # SQLite-Hauptdatenbank (WAL-Modus)
│   ├── temp/                  # Temporäres Staging für Backup-Uploads (Anti-OOM)
│   └── uploads/               # Hochgeladene Cover- & Bandbilder
├── dist_pack/                 # Ausgabeordner für Pterodactyl ZIP-Pakete
└── frontend/                  # React Frontend Projekt
    ├── index.html             # HTML Entrypoint
    ├── vite.config.js         # Vite-Konfiguration (Proxy auf :3000 im Dev-Modus)
    ├── tailwind.config.js     # Tailwind CSS Konfiguration & Themes
    └── src/
        ├── main.jsx           # React Root Mount
        ├── App.jsx            # Routing, Auth-Check & Setup-Check
        ├── Dashboard.jsx      # Schlankes Hauptdashboard (Regal/Grid, Filter, Toolbar)
        ├── MangaDetail.jsx    # Schlanke Manga-Detailansicht (Banner, Buchrücken-Regal, Bände)
        ├── Login.jsx          # Login-Maske
        ├── Setup.jsx          # Initialer Einrichtungs-Assistent (Admin-Account)
        ├── index.css          # Globale Styles, Scrollbars, Glasmorphismus & Farbtöne
        └── components/        # Modulare Komponenten & Modals (Frontend-Refactoring)
            ├── modals/        # Dashboard-Modals
            │   ├── UserManagementModal.jsx  # Benutzerverwaltung (Rollenwechsel, Anlegen, Löschen)
            │   ├── BackupRestoreModal.jsx   # Server-Snapshots, Uploads & 1-Klick Restore
            │   ├── StatsModal.jsx           # Finanz-KPIs, Charts, Leserranking & Leser-Details
            │   └── AddMangaModal.jsx        # Reihe anlegen mit Manga Passion/AniList Metadatensuche
            ├── dashboard/     # Dashboard Views
            │   ├── ShoppingListView.jsx     # Einkaufsliste, Buchladen-Modus & Schnellkauf
            │   └── ReleaseRadarView.jsx     # Neuheiten-Kalender & Monats-Release-Radar
            └── detail/        # Manga-Detailansicht Subkomponenten & Modals
                ├── VolumeEditModal.jsx      # Band-Details, Fotogalerie-Manager & MP-Autofill
                ├── BatchAddModal.jsx        # Batch-Generator für Bandnummern 1..N
                ├── BatchReadModal.jsx       # Batch-Lesestatus bis Band X für Leser
                ├── GapFillModal.jsx         # 1-Klick-Lückenfüller mit MP-Preis/Cover
                ├── MpEditionModal.jsx       # Manga Passion Editionsabgleich & Sync
                └── LightboxGallery.jsx      # Vollbild-Lightbox für Cover- & Bandfotos
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
   * `release_date` (TEXT) – Konkretes Erscheinungsdatum (Format `YYYY-MM-DD` oder `YYYY-MM`) für Release-Radar
   * `release_year` (INTEGER)
   * `condition` (TEXT) – Zustand (z. B. "Sehr gut", "Neu")
   * `pages` (INTEGER) – Seitenanzahl (wichtig für Lesestatistiken)
   * `publisher` (TEXT)
   * `purchase_date` (TEXT) – Kaufdatum (Format `YYYY-MM-DD`)
   * `status` (TEXT) – z. B. "Vorhanden", "Fehlt", "Vorbestellt", "Erscheint bald", "Bestellt"
   * `notes` (TEXT)
   * `cover_image` (TEXT)
   * `images` (TEXT) – JSON-String für Zusatzbilder / Galerie
   * `type` (TEXT, DEFAULT `'volume'`) – Werte: `'volume'` (Einzelband), `'special_edition'` (Special / Limited Edition), `'schuber'` (Sammelschuber / Box Set), `'special'` (Sonderband / Extra / Fanbook)
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

6. **`manga_passion_cache`**
   * `cache_key` (TEXT, PK) – z. B. `'releases_2026_10'`
   * `json_data` (TEXT) – Gecachte Rohdaten der Manga Passion API
   * `created_at` (INTEGER) – Unix-Timestamp für 12h-Cache-Invalidierung

7. **`schema_migrations`**
   * `version` (INTEGER, PK) – Nummer der sequentiellen Migration
   * `applied_at` (DATETIME, DEFAULT CURRENT_TIMESTAMP) – Ausführungszeitpunkt

### Performance-Indizes
Zur Gewährleistung optimaler Query-Laufzeiten bei großen Sammlungen (>10.000 Bände):
* `idx_volumes_manga_id` auf `volumes (manga_id)`
* `idx_volumes_status` auf `volumes (status)`
* `idx_volume_reads_user` auf `volume_reads (user_id)`
* `idx_volume_reads_vol` auf `volume_reads (volume_id)`
* `idx_mangas_passion_id` auf `mangas (manga_passion_id)`

---

## 4. Rollen- & Berechtigungskonzept

* **`admin`**:
  * Volle Kontrolle über das gesamte System
  * Benutzerverwaltung (Nutzer anlegen, Rollen ändern, Passwörter zurücksetzen, löschen)
  * Backups herunterladen (`GET /api/backup`) & einspielen (`POST /api/backup/restore`)
  * Sammlungs-Einstellungen anpassen (`PUT /api/stats/settings`, Datum `YYYY-MM-DD`, nicht in der Zukunft)
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

## 5. API-Endpunkte Übersicht (`routes/*.js`, eingebunden in `index.js`)

| Endpunkt | Methode | Middleware | Beschreibung |
| :--- | :--- | :--- | :--- |
| `/api/health` | GET | public | Liveness-/Readiness-Probe (DB-Check, Version, Uptime); 503 wenn DB nicht erreichbar. Nutzt Docker-`HEALTHCHECK` und CI |
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
| `/api/upload-remote` | POST | `requireEditor` | Externes Bild per URL herunterladen & lokal cachen |
| `/api/lookup/manga` | GET | `requireAuth` | Metadaten & Cover-Suche via Manga Passion API (Prio 1) & AniList GraphQL API (Fallback) |
| `/api/lookup/isbn` | GET | `requireAuth` | Deutscher ISBN- & Barcode-Lookup (DNB MARC21 XML + Bestandsabgleich) |
| `/api/offline-snapshot` | GET | `requireAuth` | Gesamte Sammlung (Liste + alle Reihen-Details, Lesestatus des Aufrufers) in einer Antwort für die Offline-Kopie im Browser |
| `/api/shopping-list` | GET | `requireAuth` | Gibt alle fehlenden Bände (`status = 'Fehlt'`) inkl. Verlag & Gesamtkosten zurück |
| `/api/release-radar` | GET | `requireAuth` | Release-Radar: Vorbestellungen & Neuerscheinungen nach Monaten gruppiert inkl. Budget |
| `/api/manga-passion/releases` | GET | `requireAuth` | Deutscher monatlicher Manga-Erscheinungskalender via Manga Passion API mit Sammlungsabgleich |
| `/api/manga-passion/editions` | GET | `requireAuth` | Suche & Auflistung passender Manga Passion Editionen nach Titel & Verlag |
| `/api/manga-passion/import` | POST | `requireEditor` | 1-Klick-Übernahme eines Bands in die Sammlung (Status: Vorbestellt oder Fehlt) |
| `/api/mangas/:id/gaps` | GET | `requireAuth` | Intelligente Lücken-Erkennung & Abgleich gegen offizielle deutsche Manga Passion Edition |
| `/api/mangas/:id/sync-edition` | POST | `requireEditor` | 1-Klick-Synchronisation von `total_volumes` und Editions-Metadaten |
| `/api/mangas/:id/batch-import-gaps` | POST | `requireEditor` | Batch-Übernahme aller echten Lücken auf die Einkaufsliste (inkl. Preisen & Covern) |
| `/api/backup` | GET | `requireAdmin` | Erzeugt & streamt ZIP-Backup von `data/` |
| `/api/backup/restore` | POST | `requireAdmin` | Lädt ZIP-Backup hoch, synchronisiert DB & Bilder |
| `/api/backups` | GET | `requireAdmin` | Listet alle Server-Snapshots in `data/backups/` auf |
| `/api/backups/create` | POST | `requireAdmin` | Erstellt sofort einen neuen Server-Snapshot |
| `/api/backups/:filename/restore` | POST | `requireAdmin` | Stellt einen Server-Snapshot mit 1 Klick wieder her |
| `/api/backups/:filename/download` | GET | `requireAdmin` | Lädt einen bestimmten Snapshot herunter |
| `/api/backups/:filename` | DELETE | `requireAdmin` | Löscht einen Snapshot vom Server |

---

## 6. Wo muss was geändert werden? (Task-to-File Guide)

### 🔹 Fall A: Neues Feld für Mangas hinzufügen (z. B. "Demographie" oder "Originalsprache")
1. **Datenbank (`db.js`):**
   * Im `CREATE TABLE IF NOT EXISTS mangas` das Feld ergänzen.
   * In der Migrationssektion darunter prüfen: `PRAGMA table_info(mangas)` und `ALTER TABLE mangas ADD COLUMN ...` ausführen, damit bestehende Datenbanken das Feld erhalten.
2. **Backend API (`routes/`):**
   * Im `POST /api/mangas` das Feld aus `req.body` entgegennehmen und im `INSERT INTO mangas` eintragen.
   * Im `PUT /api/mangas/:id` das Feld in das `UPDATE mangas SET ...` aufnehmen.
   * Im `GET /api/mangas` und `GET /api/mangas/:id` sicherstellen, dass das Feld selektiert wird (meist durch `SELECT *`).
3. **Frontend UI:**
   * `frontend/src/components/modals/AddMangaModal.jsx`: Eingabefelder für neue Metadaten beim Anlegen ergänzen.
   * `frontend/src/MangaDetail.jsx`: In den Metadaten der Detailansicht das Feld anzeigen und im Bearbeiten-Modal editierbar machen.

### 🔹 Fall B: Neues Feld für Bände/Volumes hinzufügen (z. B. "Edition", "Farbe", "Format")
1. **Datenbank (`db.js`):**
   * In `CREATE TABLE IF NOT EXISTS volumes` Spalte ergänzen.
   * Bei `volColNames.has('mein_feld')` ein `ALTER TABLE volumes ADD COLUMN ...` hinzufügen.
2. **Backend API (`routes/`):**
   * In `POST /api/volumes`, `POST /api/volumes/batch` und `PUT /api/volumes/:id` das Feld berücksichtigen.
3. **Frontend UI:**
   * `frontend/src/components/detail/VolumeEditModal.jsx`: Formularfelder im Band-Bearbeiten-Modal hinzufügen.
   * `frontend/src/components/detail/BatchAddModal.jsx`: Falls das Feld im Batch-Generator gesetzt werden soll, Eingabefeld hinzufügen.
   * `frontend/src/MangaDetail.jsx`: Im Volume-Card, Tabellen- & Listen-Item rendern.

### 🔹 Fall C: Neues Statistik-Widget oder Auswertung hinzufügen
1. **Backend API (`routes/`):**
   * Route `GET /api/stats` aufrufen/bearbeiten.
   * Die SQLite-Aggregatsabfrage (SUM, AVG, COUNT, GROUP BY) hinzufügen und im Antwort-JSON zurückgeben.
2. **Frontend UI:**
   * `frontend/src/components/modals/StatsModal.jsx`: Das neue KPI-Widget, Diagramm oder die Leser-Statistik gestalten.

### 🔹 Fall D: UI/Design/Styling ändern
1. **Globale Farbtöne, Scrollbars, Glasmorphismus:**
   * `frontend/src/index.css` (enthält CSS-Variablen, Scrollbar-Klassen, Animationen).
2. **Tailwind-Konfiguration:**
   * `frontend/tailwind.config.js`.
3. **Komponenten:**
   * Header, Regal-Ansicht, Grid-Ansicht: `frontend/src/Dashboard.jsx`.
   * Dashboard-Modals: `frontend/src/components/modals/`.
   * Einkaufsliste & Release-Radar: `frontend/src/components/dashboard/`.
   * Banner, Buchrücken-Regal, Bandkarten: `frontend/src/MangaDetail.jsx`.
   * Band-Editor, Batch-Tools, Lückenfüller, Lightbox: `frontend/src/components/detail/`.

### 🔹 Fall E: Benutzerberechtigungen anpassen
1. **Backend Middleware (`middleware/auth.js`):**
   * Funktionen `requireAuth`, `requireAdmin`, `requireEditor`.
   * Neue Rollen oder feinere Rechte direkt in den entsprechenden Routen prüfen.
2. **Frontend UI:**
   * Bedingte Buttons (`user.role === 'admin'` oder `user.role !== 'visitor'`) in `Dashboard.jsx`, `MangaDetail.jsx` und den jeweiligen Modals in `components/`.

### 🔹 Fall F: Einkaufsliste / Buchladen-Modus anpassen
1. **Backend API (`routes/`):**
   * Route `GET /api/shopping-list` selektiert alle Bände mit `status = 'Fehlt'`, ermittelt den effektiven Verlag (`v.publisher` oder `m.publisher`) und summiert Preise & Verlage.
   * `PUT /api/volumes/:id` schaltet den Status um (z. B. von 'Fehlt' auf 'Gekauft' / 'Besitz').
2. **Frontend UI (`frontend/src/components/dashboard/ShoppingListView.jsx`):**
   * Filtern nach Verlagschips, Echtzeit-Suche, Offline-Puffer und Schnellkauf-Button (`handleQuickBuy`).
   * Hauptumschalter `activeMainView: 'shelf' | 'shopping' | 'radar'` in `Dashboard.jsx`.

### 🔹 Fall G: ISBN- & Metadaten-Lookup (DNB API)
1. **Backend API (`routes/`):**
   * Route `GET /api/lookup/isbn?isbn=...`: Fragt die SRU MARC21-XML-Schnittstelle der Deutschen Nationalbibliothek (DNB) ab.
   * Parst deutsche Titel (`245$a`), Bandnummer (`245$n`), Untertitel (`245$p`), Autor (`100$a`), Verlag (`264$b`), Seiten (`300$a`) und Festpreis in EUR (`020$c`).
   * Gleicht die gefundene Reihe und den Band automatisch mit der SQLite-Datenbank ab (`matched_manga`, `matched_volume`).
2. **Architektur-Hinweis (Kamera-Feature):**
   * Das experimentelle Kamera-Live-Scanning wurde ausgebaut, da mobile Web-Browser bei HTTP-Deployments ohne SSL (z. B. Standard-Pterodactyl-Ports) WebRTC-Kamerazugriff sicherheitsbedingt sperren.
   * Der Fokus liegt auf superschneller, schlanker UI (Bundle-Größe um über 50 % reduziert).

### 🔹 Fall H: Backup-System & automatische Snapshots anpassen
1. **Backend API (`routes/backups.js`) & Scheduler (`services/scheduler.js`):**
   * Server-Snapshots werden unter `data/backups/` im ZIP-Format gespeichert.
   * `createBackupSnapshot(prefix)` sichert `manga.db` und den Ordner `uploads/` und löscht automatisch Snapshots, die älter als die neuesten 7 sind.
   * Ein Scheduler prüft 10s nach Serverstart und danach alle 24h, ob für heute bereits ein Backup existiert (`daily-auto`).
   * `restoreFromZipBuffer` führt vor dem Entpacken einen SQLite-Checkpoint und ein Schließen der Verbindung durch und legt ein temporäres Rollback-Backup `manga.db.bak` an.
2. **Frontend UI (`frontend/src/components/modals/BackupRestoreModal.jsx`):**
   * Snapshot-Verwaltung (Erstellen, Wiederherstellen, Download, Löschen) und ZIP-Datei-Upload.

### 🔹 Fall I: Schuber, Special Editions & Sonderbände erfassen & sortieren
1. **Datenbank (`db.js`):**
   * `volumes.type` (`'volume'`, `'special_edition'`, `'schuber'`, `'special'`).
   * Automatische Migration in `db.js` konvertiert vorhandene "Special X" Einträge bei Reihen wie One Piece in `type = 'schuber'` und `volume_number = 'Schuber X'`, sowie Einträge mit "Special Edition" oder "Limited Edition" in `type = 'special_edition'`.
2. **Backend API (`routes/`):**
   * `GET /api/mangas/:id`: Sortiert per `ORDER BY CASE` reguläre Bände und nummerierte Special Editions an erster Stelle (Standard Band 1 -> Band 1 Special Edition -> Band 2). Unnummerierte Special Editions ordnen sich direkt dahinter ein (Rang 1.5), gefolgt von Schubern (Rang 2) und Specials/Extras (Rang 3).
   * `POST /api/volumes` und `PUT /api/volumes/:id`: Nehmen `type` entgegen, validieren gegen die erlaubten Typen und speichern ihn ab.
3. **Frontend UI:**
   * `frontend/src/components/detail/VolumeEditModal.jsx`: Dropdown zur Auswahl des Eintrags-Typs ("📖 Einzelband", "✨ Special Edition", "📦 Schuber", "⭐ Special / Extra") mit dynamischen Feldern.
   * `frontend/src/MangaDetail.jsx`: Filter-Chips `[Alle]`, `[Nur Bände]`, `[✨ Special Editions]`, `[📦 Nur Schuber]`, `[⭐ Specials]` und Badges in den Ansichten.

### 🔹 Fall J: Fotogalerie & Zusatzbilder pro Band & Schuber (Feature 7)
1. **Datenbank (`db.js`):**
   * `volumes.images` speichert ein JSON-Array von Strings (`["/uploads/...", ...]`).
2. **Backend API (`routes/`):**
   * `POST /api/upload/multiple`: Nimmt bis zu 10 Bilddateien entgegen und speichert sie lokal unter `data/uploads/`.
   * `GET /api/mangas/:id`: Parst `vol.images` automatisch als echtes Array.
   * `POST /api/volumes` und `PUT /api/volumes/:id`: Nehmen `images` entgegen und serialisieren es als JSON in die DB.
3. **Frontend UI:**
   * `frontend/src/components/detail/LightboxGallery.jsx`: Moderne Vollbild-Galerie mit Tastaturnavigation (`Pfeiltaste links/rechts`, `Escape`), Zähler (`1 / X`) und 1-Klick-Cover-Festlegung.
   * `frontend/src/components/detail/VolumeEditModal.jsx`: Foto-Manager mit Multi-Upload (bis zu 10 Fotos), URL-Eingabe, Sortieren (`◀`/`▶`) und Löschen.
   * `frontend/src/MangaDetail.jsx`: Badges `📷 X Fotos` auf Karten und Listen.

### 🔹 Fall K: Intelligente Lücken-Erkennung & Manga Passion Editions-Abgleich
1. **Problem & Hintergrund:**
   * Bei Importen aus internationalen Datenbanken (AniList) werden häufig japanische Tankōbon-Gesamtbandzahlen hinterlegt (z. B. 20th Century Boys: 22 japanische Bände vs. 11 deutsche Doppelbände der Ultimative Edition; Evangelion: 14 vs. 7 Perfect Edition Bände). Dadurch entstanden früher falsche Phantom-Lücken (z. B. Band 12–22).
2. **Backend Service (`mangaPassion.js`) & API (`routes/`):**
   * `mangaPassion.js` gleicht die Reihe intelligent mit der offiziellen deutschen Manga Passion API (`https://api.manga-passion.de`) ab (Caching für 12h in `manga_passion_cache`).
   * `GET /api/mangas/:id/gaps`: Liefert verifizierte echte Lücken mit offiziellen deutschen Preisen, Veröffentlichungsdaten und Cover-Bildern. Erkennt Diskrepanzen zwischen der DB-Gesamtzahl und der deutschen Editions-Bandzahl.
   * `POST /api/mangas/:id/sync-edition`: 1-Klick-Synchronisation der Gesamtbandzahl und Metadaten auf die offizielle deutsche Edition.
   * `POST /api/mangas/:id/batch-import-gaps`: Überträgt alle erkannten Lücken als `Fehlt` mit offiziellen Preisen und Covern direkt in die Einkaufsliste / Sammlung.
3. **Frontend UI (`frontend/src/MangaDetail.jsx`):**
   * **Diskrepanz-Warnung:** Weist auffällig darauf hin, wenn AniList-Zahlen von der deutschen Ausgabe abweichen, und bietet 1-Klick-Anpassung.
   * **Regal Ghost-Spines:** Zeigt Lücken mit transluzentem Original-Cover, Bandnummer und offiziellem Preis in Euro an.
   * **Lücken-Füll-Modal:** Ermöglicht die Vorschau des offiziellen deutschen Covers, Preises und Datums vor der Übernahme in die Sammlung.
   * **Editions-Manager:** Modal zum manuellen Durchsuchen und Auswählen von alternativen deutschen Ausgaben (z. B. Standard vs. Massiv vs. Deluxe).

### 🔹 Fall L: Metadaten- & Erscheinungsdaten-Auto-Fill pro Band & Reihe (Manga Passion & DNB)
1. **Zweck & Nutzen:**
   * Automatische Vervollständigung von Band-Metadaten wie Erscheinungsdatum (Radar `release_date`), Erscheinungsjahr (`release_year`), Seitenzahl (`pages`), ISBN-13 (`isbn`), Preis (`price`) und Verlag (`publisher`).
   * Verhindert manuelle Tipparbeit und Recherche im Browser.
2. **Backend Service (`mangaPassion.js`) & API (`routes/`):**
   * `lookupVolumeMetadata(mangaId, volumeNumber, options)`: Ermittelt die passende offizielle deutsche Manga Passion Edition (mit Paginierung für >100 Bände) und ruft Band-Details (`isbn13`, `date`, `pages`, `price`) ab. Fallback auf DNB MARC21 XML.
   * `autofillMangaVolumes(mangaId, options)`: Reichert in einer atomaren SQLite-Transaktion alle Bände einer Reihe an, bei denen Felder noch leer sind.
   * Endpunkte:
     * `GET /api/volumes/lookup?manga_id=...&volume_number=...`: Liefert Metadaten für das Bearbeiten-Modal.
     * `POST /api/mangas/:id/autofill-volumes`: Batch-Anreicherung aller Bände einer Reihe.
3. **Frontend UI (`frontend/src/MangaDetail.jsx`):**
   * **Band-Bearbeiten-Modal:** Auffälliges Banner `✨ Automatisch ausfüllen (Manga Passion)` sowie Schnell-Link `Auto-Ausfüllen` direkt neben dem Label "Erscheinungsdatum (Radar)". Füllt fehlende Felder aus, ohne bereits manuell gepflegte Daten zu überschreiben.
   * **Editions-Manager:** Button `⚡ Alle Bände mit Erscheinungsdaten anreichern` für 1-Klick-Batch-Vervollständigung der gesamten Serie.

### 🔹 Fall M: Schuber- & Boxset-Bilderdownload & Auto-Matching (Manga Passion)
1. **Problem & Hintergrund:**
   * Bei Schuber-Einträgen (z. B. "Schuber 1" bis "Schuber 10" bei One Piece) wurde früher fälschlicherweise das Bild und die Daten von Band 1 (Tankōbon) geladen, da bei Ziffernextraktion aus "Schuber 1" die Zahl "1" gefunden wurde.
2. **Backend Service (`mangaPassion.js`) & API (`routes/`):**
   * `matchSchuberVolume(volumes, volumeNumber, userPrice, userNotes)`: Erkennt gezielt Schuber (`type === 3` und `specialType === 1`) in der Manga Passion API. Unterscheidet Leerschuber (Ladenpreis ~12 € oder "leer") und gefüllte Sammelschuber (>25 € oder "sammel"). Ordnet "Schuber 1" exakt dem ersten Schuber (z. B. "East Blue Leerschuber" ID 9736) bis "Schuber 10" ("Wa No Kuni Leerschuber") zu.
   * `downloadRemoteImageToUploads(url)`: Lädt das Original-Cover von Manga Passion (`covers.manga-passion.de`) über HTTP-Fetch herunter, prüft die Mindestgröße (>500 Byte) und speichert es lokal unter `data/uploads/` als permanentes Cover ab.
   * Direkter URL- / ID-Lookup: `lookupVolumeMetadata` und die API `GET /api/volumes/lookup` akzeptieren auch direkte Manga Passion URLs (z. B. `https://www.manga-passion.de/volumes/9736/one-piece-east-blue-leerschuber`) oder IDs und laden Metadaten + Cover direkt herunter.
   * Batch-Anreicherung (`autofillMangaVolumes`): Gleicht alle Schuber einer Reihe mit der echten Schuber-Liste ab und versieht sie mit den korrekten Covern, Erscheinungsdaten, Preisen und Schuber-Titeln.
3. **Frontend UI (`frontend/src/MangaDetail.jsx`):**
   * **Schuber-Banner:** Beim Bearbeiten eines Eintrags vom Typ Schuber erscheint ein spezielles Banner `Schuber-Cover & Details automatisch laden (Manga Passion)` mit Aktions-Button `✨ Schuber laden`.
   * **Direkte URL-Erkennung:** Wird in das Feld "URL eingeben" eine Manga Passion Volume-URL oder Volume-ID eingefügt, wird automatisch der komplette Schuber-Datensatz samt lokalem Cover-Download geladen.
   * **Bereinigung fehlerhafter Band-1-Daten:** Überschreibt versehentlich zuvor eingetragene Band-1-Notizen ("Das Abenteuer beginnt"), falsche Seitenzahlen und falsche ISBNs mit den echten Schuber-Daten.

### 🔹 Fall N: Intelligente Lücken- & Editions-Deduplizierung sowie Schuber-Erkennung (v2.9.9)
1. **Problem & Hintergrund:**
   * Bei Reihen mit Schubern (z. B. One Piece) oder Sonderausgaben/Varianten desselben Bandes (z. B. Solo Leveling Band 14 Standard vs. Band 14 Collectors Edition) wurden früher Phantom-Lücken gemeldet oder doppelte Bandnummern im Banner angezeigt (`Band 14, 14, 15, 15` bzw. 6x `Special, Special, Special...`), selbst wenn der Nutzer die Schuber bereits besaß.
2. **Backend Service (`mangaPassion.js`) & API (`routes/`):**
   * `reconcileMangaGaps`: Gleicht offizielle Bände nicht nur gegen `volume_number`, sondern auch intelligent gegen Notizen (`notes`), Titel und Saga-Namen (z. B. "East Blue", "Alabasta") ab. Bereits im Bestand befindliche Schuber werden als "Vorhanden" erkannt und erscheinen nicht als Lücke.
   * Sonderausgaben und Leerschuber mit `volume_number === 'Special'` erhalten ihren echten Titel als Bezeichner.
   * `batchImportGaps`: Erkennt bei der Übernahme von Lücken in die Einkaufsliste automatisch den korrekten Typ (`schuber`, `special_edition` oder `volume`) und speichert Notizen und Cover.
3. **Frontend UI (`MangaDetail.jsx` & `Dashboard.jsx`):**
   * **Lücken-Banner:** Listet Lücken differenziert mit Band-Präfix oder Volltitel auf (z. B. `Band 14, Band 14 (Collectors Edition), Band 15, Band 15 (Sammelschuber)` bzw. `Fischmenscheninsel Leerschuber`), ohne redundante "Special"-Wiederholungen.
   * **Custom-Scrollbars:** Sämtliche scrollbaren Modal-Bereiche (Statistik-Dashboard, Server-Snapshots, Benutzerverwaltung, Batch-Generatoren) nutzen jetzt die einheitliche `custom-scrollbar`-Klasse für ein modernes, dunkles Scroll-Design.

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

### Tests, Lint & CI
* **API-Tests (schnell, ohne Browser):** `npm test` (`node --test test/*.test.js`) startet die App gegen eine temporäre `DATA_DIR`. Neue Backend-Features sollten hier einen Test bekommen.
* **Lint:** `npm run lint` (ESLint). Fehler brechen die CI, Warnungen nicht.
* **CI (`.github/workflows/ci.yml`):** Lint + Tests (Node 22) und ein Docker-Job (Build + Start-Test über `/api/health`). Der Release-Workflow-Entwurf liegt weiterhin in `deploy/workflows/release.yml`.

### Automatisierte E2E Browser-Tests
* Zum Validieren von UI, Logins, CRUD und Backups:
  ```powershell
  node test-e2e-suite.js
  ```
* Für vollständige visuelle Regressionstests, Bildschirmfoto-Generierung aller Modals und Mobile-Check:
  ```powershell
  node test-deep-e2e.js
  ```

### Paketierung & GitHub Releases
* **Regelmäßige Releases (WICHTIG!):**
  * Das Release wird **nach dem Merge** des Feature-/Fix-Branches auf dem Hauptbranch ausgeführt (nicht auf offenen PR-Branches), da `release.js` Commit, Tag und GitHub-Release pusht.
  * Nach jeder abgeschlossenen Feature-Implementierung, Bugfix oder UI-Verbesserung **muss** ein Git-Release via `node release.js patch` (bzw. `minor` bei neuen Funktionen) erstellt und auf GitHub publiziert werden. So bleibt die Versionierung lückenlos und das Pterodactyl-ZIP auf GitHub stets aktuell.
* **Nur ZIP bauen:**
  ```powershell
  npm run package
  ```
  * Ergebnis: `pterodactyl-manga-shelf.zip` im Root- und `dist_pack/`-Verzeichnis.
* **Automatisiertes Release auf GitHub erstellen & ZIP hochladen:**
  ```powershell
  npm run release
  # oder mit gezielter Version / Semver:
  node release.js patch   # Erhöht z.B. von v2.2.0 auf v2.2.1
  node release.js minor   # Erhöht z.B. von v2.2.0 auf v2.3.0
  node release.js v2.3.0  # Explizite Version
  ```
  * Was passiert automatisch:
    1. Baut das Frontend neu (`npm run build`).
    2. Erzeugt die saubere `pterodactyl-manga-shelf.zip`.
    3. Synchronisiert die Version in `package.json` und `frontend/package.json`.
    4. Erstellt einen Git-Commit und den Git-Tag `vX.Y.Z`.
    5. Pusht Commit und Tag zu GitHub.
    6. Erstellt via GitHub CLI (`gh release create`) den offiziellen GitHub-Release mit Release-Notes und hängt die ZIP-Datei als Download-Asset an.
* **GitHub Releases Übersicht:**
  * Alle Releases und deren ZIP-Archive sind jederzeit unter `https://github.com/MoltresHD/manga-shelf/releases` einsehbar und versioniert.

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
   * Vor dem Entpacken eines Restore-Archivs muss `setRestoringState(true)` und `closeDb()` aufgerufen werden (inkl. `PRAGMA wal_checkpoint(TRUNCATE)`), da Windows offene Dateihandles sperrt. Während des Entpackens blockiert der DB-Proxy parallele Zugriffe mit 503. Nach erfolgreichem Restore wird `initDb()` und `setRestoringState(false)` aufgerufen.
3. **Cookie-Handling & HTTPS:**
   * `app.set('trust proxy', true)` ist aktiv. `setAuthCookie` prüft `req.secure` sowie `x-forwarded-proto === 'https'`. Bei reinem HTTP im LAN oder ohne SSL wird das `secure`-Flag dynamisch weggelassen, damit der Login auch ohne HTTPS reibungslos funktioniert.
4. **Verzeichnisse:**
   * Alle persistenten Daten liegen ausschließlich unter `data/` (`manga.db` und `data/uploads/`).
   * Alles unter `data/` ist in `.gitignore`, damit keine privaten Daten oder Passwörter in GitHub landen.
5. **Atomare Transaktionen (`runTransaction`):**
   * Für mehrstufige Schreiboperationen (z. B. Bände anlegen/löschen + Zähleraktualisierung, Batch-Read, Lücken-Import) immer den universellen Helper `runTransaction(callback)` aus `db.js` nutzen statt rohem `db.exec('BEGIN TRANSACTION;')`. Dies verhindert Concurrency-Locks und unvollständige Kaskaden-Löschungen.
6. **SSRF-Schutz für Remote-Bilder (`assertSafeRemoteUrl`):**
   * Alle Downloads externer Bild-URLs (z. B. Cover-Uploads via URL) müssen vor dem HTTP-Aufruf mit `assertSafeRemoteUrl()` aus `utils/security.js` validiert werden, um Zugriffe auf interne Netzwerke (127.0.0.1, 192.168.x.x, Cloud-Metadata) abzuwehren.


11. **JWT-Secret (`middleware/auth.js`):**
   * `JWT_SECRET` aus der Umgebung wird nur akzeptiert, wenn es mindestens 32 Zeichen lang und kein bekannter Platzhalter ist. Sonst wird ein zufälliges Secret in `app_settings.jwt_secret` erzeugt und genutzt. Es gibt bewusst keinen Prozess-Fallback.
12. **Transaktionen (`db.js`):**
   * Es gibt nur **eine** SQLite-Connection. Transaktionen ausschließlich über `withTransaction(fn)` mit synchronem `fn`. Niemals `await` innerhalb einer Transaktion (sonst laufen fremde Requests darin). Netzwerk-I/O (z. B. Cover-Downloads) vorher erledigen.
13. **Externe Downloads:**
   * Alle Remote-Bilder laufen über `utils/safeFetch.js` (`fetchRemoteImage`): SSRF-Schutz, 15-MB-Limit, Redirect-Limit, Magic-Byte-Prüfung. Nie `http.get`/`fetch` direkt auf Nutzer-URLs.
14. **Passwörter & Rate-Limit:**
   * Mindestens 8 Zeichen (max. 72 Bytes wegen bcrypt). `/auth/login` und `/setup` sind per `middleware/rateLimit.js` begrenzt (429).
15. **Restore (`routes/backups.js`):**
   * Die DB aus dem ZIP wird erst als `manga.db.restore-tmp` entpackt und mit `validateDbFile()` geprüft (integrity_check, Tabellen `users`/`mangas`/`volumes`, mindestens ein Admin), dann atomar per `rename` ersetzt. `restoreFromZip` ist synchron, damit kein anderer Request zwischen `closeDb()` und `initDb()` die DB nutzt.
16. **`DATA_DIR`:**
   * Optionale Umgebungsvariable für das Datenverzeichnis (Standard `./data`). Wird von den Tests für isolierte Temp-Datenbanken genutzt.
17. **Express 5 (`index.js`):**
   * Catch-all-Route heißt `app.get('/{*splat}', ...)` (ein nacktes `'*'` ist ungültig). `req.body` ist ohne Body `undefined`; eine Middleware setzt es auf `{}`, weil Handler direkt destrukturieren. `req.query` ist nur lesbar; Strings daraus immer über `qstr()` (`utils/query.js`) lesen, sonst werfen `?a=1&a=2` bzw. `?a[x]=1` bei `.trim()` einen 500.
   * Unbekannte `/api/*`-Pfade liefern JSON-404; der letzte Error-Handler gibt bei 5xx nur eine generische Meldung aus (Details im Log), bei 4xx die Fehlermeldung (z. B. abgelehnter Upload).
18. **Offline-Kopie (`frontend/src/utils/offlineStore.js`):**
   * Nur lesend. IndexedDB `mangashelf-offline` hält letzten Benutzer, Reihenliste und alle Details aus `/api/offline-snapshot`. Sync beim Start, beim Zurückkehren in den Vordergrund und per Button im Footer (gedrosselt auf 5 Min.); danach werden Route-Chunks und bis zu 400 Cover vorgeladen, damit der Service Worker sie cached.
   * `App.jsx`: Antwortet `/api/auth/me` nicht (Netz/Gateway weg) und es gibt einen gespeicherten Benutzer, läuft die App als `{ role: 'visitor', realRole, offline: true }` weiter (alle Bearbeiten-Buttons verschwinden; Einkaufslisten-Schnellkauf nutzt `realRole` und die vorhandene Offline-Warteschlange). Alle 30 s und beim `online`-Event wird erneut geprüft. Bei 401 und beim Logout wird alles gelöscht (`clearOfflineData`) – nie Daten nach dem Abmelden lesbar lassen.
   * Nicht offline verfügbar: Statistiken, Release-Radar, alles Schreibende.
19. **Logging (`utils/logger.js`):**
   * Backend-Code loggt ausschließlich über `const log = require('../utils/logger').child('name')` (`log.info/warn/error/debug(msg, ...args)`; ein `Error` als Argument wird mit Stack bzw. als `err`-Feld ausgegeben, ein Objekt als Kontextfelder). Kein neues `console.*` im Backend. `LOG_LEVEL` (debug|info|warn|error|silent) und `LOG_FORMAT` (text|json) per Umgebungsvariable; `debug` aktiviert das API-Zugriffs-Log, Anfragen > 2 s werden immer als Warnung geloggt.
   * **Ausnahme:** Die Start-Banner in `index.js` (`Manga Shelf running on http://0.0.0.0:`, `Server listening on port`, `change this text 1/2`, `Server is online and ready.`) bleiben bewusst rohes `console.log`: Das Pterodactyl-Egg erkennt „Server gestartet“ an genau diesen Zeichenketten.
   * Fehlercodes: Ungültige Backup-Dateien (kein ZIP, keine `manga.db`, kaputte/ungültige Datenbank) liefern 400 (`err.status`), echte Serverfehler 500.
---

## 9. Deutsche Manga-Spezifika & APIs

1. **Deutsche Verlage:**
   * `Carlsen Manga`, `Egmont Manga (EMA)`, `Tokyopop`, `Altraverse`, `Manga Cult`, `Hayabusa`, `Crunchyroll / Kazé`, `Panini Manga`.
   * Buchpreisbindung in Deutschland: Jeder deutsche Manga hat einen offiziellen festen Ladenpreis (z. B. 7,00 €, 7,50 €, 8,00 €, 10,00 €).
2. **Metadaten-Quellen:**
   * **AniList GraphQL API:** Perfekt für internationale Reihen-Titel, alternative Romaji-/japanische Titel, Status (Laufend/Abgeschlossen) und hochauflösende Cover.
   * **Deutsche Nationalbibliothek (DNB) API / SRU:** Gesetzliche Pflichtablieferung in Deutschland! Jeder in DE gedruckte Manga besitzt dort einen Datensatz mit exakter ISBN-13, Bandnummer, Seitenzahl, offiziellem Preis in € und Verlag. Kostenlos und ohne API-Key abrufbar unter:
     `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=isbn%3D<ISBN>&recordSchema=MARC21-xml`

