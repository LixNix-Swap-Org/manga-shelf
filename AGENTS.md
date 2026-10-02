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
manga-shelf/
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
├── mangaPassion.js            # Re-Export von `services/mangaPassion/` (Dockerfile/package.js und alle `require('../mangaPassion')` bleiben so gültig)
├── egg-manga-shelf.json       # Pterodactyl Egg Vorlage
├── Caddyfile.example          # Beispiel-Konfiguration für Reverse Proxy via Caddy
├── nginx.conf.example         # Beispiel-Konfiguration für Reverse Proxy via Nginx
├── release.js                 # GitHub Release Automatisierung & Asset-Upload
├── PROJECT_KNOWLEDGE.md       # Nur Verweis auf diese Datei
├── test-e2e-suite.js          # Automatisierte Puppeteer Browser E2E-Tests (`npm run test:e2e`)
├── test-release-radar.js      # Headless E2E-Test für Release-Radar Ansicht (`npm run test:radar`)
├── test-performance-suite.js  # Performance-Benchmark Suite (`npm run test:perf`)
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
│   ├── scheduler.js           # Täglicher automatischer Backup-Scheduler (7 Snapshots)
│   └── mangaPassion/          # Manga-Passion-Anbindung
│       ├── client.js          # API-Aufrufe (Timeout, Basis-URL), 12-h-Cache (nur vollständige Antworten), Editionssuche, Cover-Download
│       ├── classify.js        # Reine Funktionen: scoreEdition, classifyOfficialVolume, findRegularVolume, matchSchuberVolume, cleanOfficialDate
│       ├── gaps.js            # reconcileMangaGaps, batchImportGaps, syncMangaWithEdition
│       ├── autofill.js        # lookupVolumeMetadata, autofillMangaVolumes, applyAutofillUpdates
│       └── index.js           # bündelt die Exporte
├── utils/                     # Hilfsfunktionen & Normalisierer
│   ├── publishers.js          # Verlags-Normalisierung & Mappings
│   ├── isbn.js                # ISBN-10/13-Normalisierung & Prüfsummen
│   ├── logger.js              # Zentraler Logger (`LOG_LEVEL`, `LOG_FORMAT`)
│   ├── query.js               # `qstr()`: Query-Strings sicher lesen (Express 5)
│   ├── staticHeaders.js       # Cache-Header für `index.html`, `sw.js`, `manifest.json`
│   ├── volumeType.js          # `inferVolumeType` / `classifyOfficialVolume` (Backend)
│   └── safeFetch.js           # SSRF-sicherer Bild-Download (nur öffentliche Hosts, Größenlimit, Magic Bytes)
├── test/                      # node:test-Tests (`npm test` = `test/*.test.js`) & Deep-E2E
│   ├── helpers.js             # Startet die App gegen eine temporäre DATA_DIR
│   ├── api.test.js            # Auth, CRUD, Rollen, Backups
│   ├── routing.test.js, upload.test.js, logger.test.js, isbn.test.js
│   ├── mangapassion.test.js   # Manga-Passion-Matching, Datumsbereinigung, Schuber
│   ├── specialeditions.test.js # Typ+Nummer-Logik; hält Backend/Frontend-`inferVolumeType` synchron
│   ├── realdata.test.js       # Fortschritt, Doppelte, Platzhalterdaten
│   ├── offline.test.js, offlineStore.test.js, volumeHelpers.test.js
│   └── deep-e2e.js            # Visueller Browser-Regressionstest (`npm run test:deep`, nicht in `npm test`)
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
        ├── Dashboard.jsx      # Container des Dashboards: State, Hauptumschalter (`activeMainView`), Modals; Darstellung in `components/dashboard/`
        ├── MangaDetail.jsx    # Schlanker Container der Detailansicht: setzt die Hooks aus `hooks/` und die Komponenten aus `components/detail/` zusammen
        ├── Login.jsx          # Login-Maske
        ├── Setup.jsx          # Initialer Einrichtungs-Assistent (Admin-Account)
        ├── hooks/             # Zustand & Aktionen der Detailansicht (je ein Thema)
        │   ├── useMangaData.js        # Reihe laden (Server/Offline-Kopie), Bearbeiten-Formular, Cover-Upload, Metadaten-Lookup
        │   ├── useVolumeFilters.js    # Filter, Suche, Sortierung, Typ-Zähler, Ansichtsmodus
        │   ├── useMpGaps.js           # Manga-Passion-Lückenabgleich, Lücken übernehmen, Edition wählen/synchronisieren, Autofill
        │   ├── useVolumeActions.js    # Band anlegen, Besitz-/Lesestatus umschalten, bearbeiten, löschen
        │   ├── useVolumeGallery.js    # Foto-Lightbox
        │   ├── useShelfLayout.js      # Regal-Modus, Skalierung, Zeilenaufteilung, Tastatur-Fokus
        │   └── useDetailKeyboard.js   # Escape, Pfeiltasten, J/K/Leertaste/E
        ├── utils/
        │   ├── offlineStore.js    # IndexedDB-Offline-Kopie (nur lesend)
        │   └── volumeHelpers.js   # Anzeigenamen, Typ-/Editions-Logik, Fortschritt (`getSeriesProgress`)
        ├── utils/
        │   ├── offlineStore.js    # IndexedDB-Offline-Kopie (nur lesend)
        │   └── volumeHelpers.js   # Anzeigenamen, Typ-/Editions-Logik, Fortschritt (`getSeriesProgress`)
        ├── index.css          # Globale Styles, Scrollbars, Glasmorphismus & Farbtöne
        └── components/        # Modulare Komponenten & Modals (Frontend-Refactoring)
            ├── modals/        # Dashboard-Modals
            │   ├── UserManagementModal.jsx  # Benutzerverwaltung (Rollenwechsel, Anlegen, Löschen)
            │   ├── BackupRestoreModal.jsx   # Server-Snapshots, Uploads & 1-Klick Restore
            │   ├── StatsModal.jsx           # Finanz-KPIs, Charts, Leserranking & Leser-Details
            │   └── AddMangaModal.jsx        # Reihe anlegen mit Manga Passion/AniList Metadatensuche
            ├── common/
            │   └── BarcodeScannerButton.jsx # ISBN-Barcode per Foto (BarcodeDetector, Fallback ZXing)
            ├── dashboard/     # Dashboard Views
            │   ├── DashboardHeader.jsx      # Kopfzeile, Hauptumschalter, Scanner
            │   ├── CollectionToolbar.jsx    # Suche, Filter, Sortierung, Ansicht
            │   ├── MangaCollectionGrid.jsx  # Regal-/Grid-Darstellung der Reihen
            │   ├── ShoppingListView.jsx     # Einkaufsliste, Buchladen-Modus & Schnellkauf
            │   └── ReleaseRadarView.jsx     # Neuheiten-Kalender & Monats-Release-Radar
            └── detail/        # Manga-Detailansicht Subkomponenten & Modals
                ├── MangaHeroCard.jsx        # Banner/Kopf der Reihe mit Metadaten & Fortschritt
                ├── ReaderBar.jsx            # Leser-Umschalter mit Lese-Fortschritt
                ├── GapNotices.jsx           # Banner: Doppelte, Editions-Abweichung, erkannte Lücken
                ├── ShelfSpine.jsx           # Ein Buchrücken (oder Ghost-Spine) im Regal
                ├── AddVolumeBar.jsx         # Schnelles Anlegen einzelner Bände
                ├── VolumeFilterBar.jsx      # Filter-Chips (Alle/Bände/Special Editions/Schuber/Specials)
                ├── VolumeShelfView.jsx      # Buchrücken-Regal inkl. Ghost-Spines für Lücken
                ├── VolumeGridView.jsx       # Kartenansicht
                ├── VolumeListView.jsx       # Listen-/Tabellenansicht
                ├── VolumePhotoManager.jsx   # Foto-Manager (Upload, Sortieren, Löschen)
                ├── VolumeEditModal.jsx      # Band-Details & MP-Autofill
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
   * `manga_passion_id` (INTEGER, NULL) – Verknüpfte deutsche Manga-Passion-Edition (Index `idx_mangas_passion_id`)
   * `manga_passion_edition_data` (TEXT, NULL) – JSON-Metadaten der verknüpften Edition
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
   * `name` (TEXT, NOT NULL) – Name der Migration
   * `applied_at` (DATETIME, DEFAULT CURRENT_TIMESTAMP) – Ausführungszeitpunkt
   * Aktuell Version 1–8 (Spalten, Typ-/Verlagsnormalisierung, Indizes, Verlagsnamen, ISBN-Format, Bandnummern ohne Label, Platzhalterdaten `2999-12-31`, „Band“-Präfix entfernen). Neue Migrationen werden in `runSequentialMigrations()` in `db.js` ans Array **angehängt**; bereits ausgelieferte Migrationen nie ändern.

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
| `/api/version` | GET | public | App-Version aus `package.json` |
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
| `/api/volumes/lookup` | GET | `requireAuth` | Metadaten (Datum, Seiten, ISBN, Preis, Cover) für einen Band via Manga Passion / DNB; akzeptiert auch MP-URL oder -ID (`manga_id`, `volume_number`) |
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
| `/api/mangas/:id/autofill-volumes` | POST | `requireEditor` | Batch-Anreicherung aller Bände einer Reihe (Datum, Seiten, ISBN, Preis, Schuber-Cover) |
| `/api/mangas/:id/batch-import-gaps` | POST | `requireEditor` | Batch-Übernahme aller echten Lücken auf die Einkaufsliste (inkl. Preisen & Covern) |
| `/api/backup` | GET | `requireAdmin` | Erzeugt & streamt ZIP-Backup von `data/` |
| `/api/backup/restore` | POST | `requireAdmin` | Lädt ZIP-Backup hoch, synchronisiert DB & Bilder (Alias: `POST /api/restore`) |
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
   * Zusätzlich eine **neue Migration** (nächste freie `version`) in `runSequentialMigrations()` anhängen: `PRAGMA table_info(mangas)` prüfen und `ALTER TABLE mangas ADD COLUMN ...` ausführen, damit bestehende Datenbanken das Feld erhalten. Die Migration läuft selbst in einer Transaktion – kein eigenes `BEGIN`.
2. **Backend API (`routes/`):**
   * Im `POST /api/mangas` das Feld aus `req.body` entgegennehmen und im `INSERT INTO mangas` eintragen.
   * Im `PUT /api/mangas/:id` das Feld in das `UPDATE mangas SET ...` aufnehmen.
   * Im `GET /api/mangas` und `GET /api/mangas/:id` sicherstellen, dass das Feld selektiert wird (meist durch `SELECT *`).
3. **Frontend UI:**
   * `frontend/src/components/modals/AddMangaModal.jsx`: Eingabefelder für neue Metadaten beim Anlegen ergänzen.
   * `frontend/src/components/detail/MangaHeroCard.jsx`: Feld in der Detailansicht anzeigen und im Bearbeiten-Formular editierbar machen (State/Speichern in `frontend/src/hooks/useMangaData.js`).

### 🔹 Fall B: Neues Feld für Bände/Volumes hinzufügen (z. B. "Edition", "Farbe", "Format")
1. **Datenbank (`db.js`):**
   * In `CREATE TABLE IF NOT EXISTS volumes` Spalte ergänzen.
   * Eine neue Migration (nächste freie `version`) anhängen, die per `PRAGMA table_info(volumes)` prüft und `ALTER TABLE volumes ADD COLUMN ...` ausführt.
   * Feld ggf. in `GET /api/offline-snapshot` / `GET /api/mangas/:id` prüfen, damit auch die Offline-Kopie es enthält.
2. **Backend API (`routes/`):**
   * In `POST /api/volumes`, `POST /api/volumes/batch` und `PUT /api/volumes/:id` das Feld berücksichtigen.
3. **Frontend UI:**
   * `frontend/src/components/detail/VolumeEditModal.jsx`: Formularfelder im Band-Bearbeiten-Modal hinzufügen.
   * `frontend/src/components/detail/BatchAddModal.jsx`: Falls das Feld im Batch-Generator gesetzt werden soll, Eingabefeld hinzufügen.
   * `VolumeGridView.jsx`, `VolumeListView.jsx`, `VolumeShelfView.jsx` (alle in `components/detail/`): Feld in Karte, Liste und Regal rendern.

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
   * Header, Regal-Ansicht, Grid-Ansicht: `frontend/src/Dashboard.jsx` und `components/dashboard/` (`DashboardHeader`, `CollectionToolbar`, `MangaCollectionGrid`).
   * Dashboard-Modals: `frontend/src/components/modals/`.
   * Einkaufsliste & Release-Radar: `frontend/src/components/dashboard/`.
   * Banner, Buchrücken-Regal, Bandkarten: `frontend/src/components/detail/` (`MangaHeroCard`, `VolumeShelfView`, `VolumeGridView`, `VolumeListView`).
   * Band-Editor, Batch-Tools, Lückenfüller, Lightbox: `frontend/src/components/detail/`.

### 🔹 Fall E: Benutzerberechtigungen anpassen
1. **Backend Middleware (`middleware/auth.js`):**
   * Funktionen `requireAuth`, `requireAdmin`, `requireEditor`.
   * Neue Rollen oder feinere Rechte direkt in den entsprechenden Routen prüfen.
2. **Frontend UI:**
   * Bedingte Buttons (`user.role === 'admin'` oder `user.role !== 'visitor'`) in `Dashboard.jsx`, `MangaDetail.jsx` (`canEdit` wird an Hooks und Komponenten durchgereicht) und den jeweiligen Modals in `components/`.

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
2. **Architektur-Hinweis (Barcode-Scan):**
   * Kein Live-Kamerastream: Mobile Browser sperren WebRTC bei HTTP-Deployments ohne SSL (z. B. Standard-Pterodactyl-Ports). `frontend/src/components/common/BarcodeScannerButton.jsx` nutzt stattdessen ein `<input type="file" capture="environment">` und dekodiert das Foto mit dem nativen `BarcodeDetector` (Fallback: ZXing, dynamisch geladen). Funktioniert daher auch über HTTP.
   * ISBN-Normalisierung (10→13, Prüfsumme) liegt in `utils/isbn.js`.
   * Mit einer echten Handy-Kamera ist der Scan noch ungetestet.

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
   * `frontend/src/components/detail/VolumeFilterBar.jsx`: Filter-Chips `[Alle]`, `[Nur Bände]`, `[✨ Special Editions]`, `[📦 Nur Schuber]`, `[⭐ Specials]` und Badges in den Ansichten.

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
   * `frontend/src/components/detail/VolumeGridView.jsx`: Badges `📷 X Fotos` auf Karten und Listen.

### 🔹 Fall K: Manga Passion – Editionsabgleich, Lücken, Autofill & Schuber
Hintergrund: AniList liefert japanische Tankōbon-Zahlen (20th Century Boys: 22 vs. 11 deutsche Doppelbände), deshalb gleicht die App Reihen mit der offiziellen deutschen Edition der Manga Passion API (`https://api.manga-passion.de`, 12-h-Cache in `manga_passion_cache`) ab. Alle Logik liegt in `services/mangaPassion/`; Identitätsregeln für Sonderausgaben stehen in Gotcha 14.
1. **Backend (`services/mangaPassion/`, `routes/mangas.js`, `routes/volumes.js`):**
   * `GET /api/mangas/:id/gaps` → `reconcileMangaGaps`: echte Lücken mit deutschem Preis, Datum und Cover; erkennt Abweichungen zwischen DB-Gesamtzahl und deutscher Edition. Abgleich über **Typ + Nummer**, Notizen, Titel und Saga-Namen; vorhandene Schuber gelten nicht als Lücke.
   * `POST /api/mangas/:id/sync-edition` (`syncMangaWithEdition`): Gesamtbandzahl und Metadaten auf die deutsche Edition setzen.
   * `POST /api/mangas/:id/batch-import-gaps` (`batchImportGaps`): Lücken als `Fehlt` mit Typ (`schuber`/`special_edition`/`volume`), Preis, Datum, Notizen und Cover übernehmen.
   * `GET /api/volumes/lookup` (`lookupVolumeMetadata`, Fallback DNB) und `POST /api/mangas/:id/autofill-volumes` (`autofillMangaVolumes`, eine Transaktion): füllen nur **leere** Felder (`release_date`, `release_year`, `pages`, `isbn`, `price`, `publisher`); akzeptieren auch Manga-Passion-URLs oder -IDs.
   * Schuber: `matchSchuberVolume` erkennt sie gezielt (`type === 3`, `specialType === 1`), unterscheidet Leerschuber (~12 €) von Sammelschubern (>25 €) und ordnet „Schuber N“ dem N-ten Schuber zu – nie dem Band N. `downloadRemoteImageToUploads` lädt das Cover über `safeFetch` nach `data/uploads/`.
2. **Frontend (`hooks/useMpGaps.js`, `MangaDetail.jsx`, `components/detail/`):**
   * Diskrepanz-Warnung mit 1-Klick-Anpassung, Ghost-Spines für Lücken im Regal (`VolumeShelfView`), Lücken-Banner mit Band-Präfix bzw. Volltitel (`VolumeFilterBar`), `GapFillModal` (Vorschau vor Übernahme), `MpEditionModal` (alternative Editionen wählen, „Alle Bände anreichern“).
   * `VolumeEditModal`: Banner „Automatisch ausfüllen (Manga Passion)“, Schuber-Banner „Schuber laden“; eine eingefügte MP-Volume-URL/-ID lädt Datensatz und Cover und überschreibt fälschlich eingetragene Band-1-Daten.

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
  npm run test:deep    # = node test/deep-e2e.js
  ```
* Weitere Skripte: `npm run test:radar` (Release-Radar), `npm run test:perf` (Performance-Benchmark).
* **Nie gegen die echte Instanz schreiben:** Die produktive Datenbank (`data/`, Port 3000) nicht für Tests nutzen. Stattdessen `manga.db` kopieren und die Kopie mit eigenem `DATA_DIR`/`PORT` starten (eigener Test-Admin nur in der Kopie).

### Paketierung & GitHub Releases
* **Regelmäßige Releases (WICHTIG!):**
  * Das Release wird **nach dem Merge** des Feature-/Fix-Branches auf dem Hauptbranch ausgeführt (nicht auf offenen PR-Branches), da `release.js` Commit, Tag und GitHub-Release pusht.
  * Nach einer abgeschlossenen Feature-Implementierung, einem Bugfix oder einer UI-Verbesserung wird ein Git-Release via `node release.js patch` (bzw. `minor` bei neuen Funktionen) erstellt, damit die Versionierung lückenlos und das Pterodactyl-ZIP auf GitHub aktuell bleibt. Läuft im Hauptordner auf `main`; **vor dem Release immer beim Maintainer nachfragen** (der Befehl pusht Tag und Release).
  * Pull Requests dürfen bei grüner CI (Lint, Tests, Frontend-Build, Docker) per Squash-Merge gemergt werden. Arbeitsablauf: Branch → `npm run lint` + `npm test` + Frontend-Build → im Browser prüfen → PR → CI abwarten → mergen.
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
5. **Transaktionen (`db.js`):**
   * Es gibt nur **eine** SQLite-Connection. Für mehrstufige Schreiboperationen (Bände anlegen/löschen + Zähler, Batch-Read, Lücken-Import) immer einen Helper aus `db.js` nutzen statt rohem `db.exec('BEGIN')`: `runTransaction(fn)` (in den Routen; wirft 503-artigen Fehler während eines Restores) bzw. `withTransaction(fn)` (in `mangaPassion.js`; lehnt asynchrone Callbacks ausdrücklich ab).
   * `fn` muss **synchron** sein – niemals `await` innerhalb einer Transaktion, sonst laufen fremde Requests darin. Netzwerk-I/O (z. B. Cover-Downloads) vorher erledigen.
6. **JWT-Secret (`middleware/auth.js`):**
   * `JWT_SECRET` aus der Umgebung wird nur akzeptiert, wenn es mindestens 32 Zeichen lang und kein bekannter Platzhalter ist. Sonst wird ein zufälliges Secret in `app_settings.jwt_secret` erzeugt und genutzt. Es gibt bewusst keinen Prozess-Fallback.
7. **Externe Downloads / SSRF (`utils/safeFetch.js`):**
   * Alle Remote-Bilder (Cover per URL, Manga-Passion-Cover) laufen über `fetchRemoteImage()`: SSRF-Schutz (nur öffentliche Hosts, DNS-Prüfung), 15-MB-Limit, Redirect-Limit, Magic-Byte-Prüfung. Nie `http.get`/`fetch` direkt auf Nutzer-URLs.
8. **Passwörter & Rate-Limit:**
   * Mindestens 8 Zeichen (max. 72 Bytes wegen bcrypt). `/auth/login` und `/setup` sind per `middleware/rateLimit.js` begrenzt (429).
9. **Restore (`routes/backups.js`):**
   * Die DB aus dem ZIP wird erst als `manga.db.restore-tmp` entpackt und mit `validateDbFile()` geprüft (integrity_check, Tabellen `users`/`mangas`/`volumes`, mindestens ein Admin), dann atomar per `rename` ersetzt. `restoreFromZip` ist synchron, damit kein anderer Request zwischen `closeDb()` und `initDb()` die DB nutzt.
10. **`DATA_DIR`:**
   * Optionale Umgebungsvariable für das Datenverzeichnis (Standard `./data`). Wird von den Tests für isolierte Temp-Datenbanken genutzt.
11. **Express 5 (`index.js`):**
   * Catch-all-Route heißt `app.get('/{*splat}', ...)` (ein nacktes `'*'` ist ungültig). `req.body` ist ohne Body `undefined`; eine Middleware setzt es auf `{}`, weil Handler direkt destrukturieren. `req.query` ist nur lesbar; Strings daraus immer über `qstr()` (`utils/query.js`) lesen, sonst werfen `?a=1&a=2` bzw. `?a[x]=1` bei `.trim()` einen 500.
   * Unbekannte `/api/*`-Pfade liefern JSON-404; der letzte Error-Handler gibt bei 5xx nur eine generische Meldung aus (Details im Log), bei 4xx die Fehlermeldung (z. B. abgelehnter Upload).
12. **Offline-Kopie (`frontend/src/utils/offlineStore.js`):**
   * Nur lesend. IndexedDB `mangashelf-offline` hält letzten Benutzer, Reihenliste und alle Details aus `/api/offline-snapshot`. Sync beim Start, beim Zurückkehren in den Vordergrund und per Button im Footer (gedrosselt auf 5 Min.); danach werden Route-Chunks und die Reihen-Cover (nicht die Band-Cover, bei großen Sammlungen dutzende MB) vorgeladen und vom Service Worker gecached; `/uploads/*` ist dort cache-first, weil Dateinamen eindeutig und unveränderlich sind.
   * `App.jsx`: Antwortet `/api/auth/me` nicht (Netz/Gateway weg) und es gibt einen gespeicherten Benutzer, läuft die App als `{ role: 'visitor', realRole, offline: true }` weiter (alle Bearbeiten-Buttons verschwinden; Einkaufslisten-Schnellkauf nutzt `realRole` und die vorhandene Offline-Warteschlange). Alle 30 s und beim `online`-Event wird erneut geprüft. Bei 401 und beim Logout wird alles gelöscht (`clearOfflineData`) – nie Daten nach dem Abmelden lesbar lassen.
   * Nicht offline verfügbar: Statistiken, Release-Radar, alles Schreibende.
13. **Logging (`utils/logger.js`):**
   * Backend-Code loggt ausschließlich über `const log = require('../utils/logger').child('name')` (`log.info/warn/error/debug(msg, ...args)`; ein `Error` als Argument wird mit Stack bzw. als `err`-Feld ausgegeben, ein Objekt als Kontextfelder). Kein neues `console.*` im Backend. `LOG_LEVEL` (debug|info|warn|error|silent) und `LOG_FORMAT` (text|json) per Umgebungsvariable; `debug` aktiviert das API-Zugriffs-Log, Anfragen > 2 s werden immer als Warnung geloggt.
   * **Ausnahme:** Die Start-Banner in `index.js` (`Manga Shelf running on http://0.0.0.0:`, `Server listening on port`, `change this text 1/2`, `Server is online and ready.`) bleiben bewusst rohes `console.log`: Das Pterodactyl-Egg erkennt „Server gestartet“ an genau diesen Zeichenketten.
   * Fehlercodes: Ungültige Backup-Dateien (kein ZIP, keine `manga.db`, kaputte/ungültige Datenbank) liefern 400 (`err.status`), echte Serverfehler 500. Bekannte Lücke: ein kaputtes Server-Snapshot-ZIP liefert beim Restore noch 500 statt 400.
14. **Sonderausgaben / Lücken-Identität (`services/mangaPassion/`, `utils/volumeType.js`, `frontend/src/utils/volumeHelpers.js`):**
   * Eine Collectors-/Limited Edition oder ein Schuber trägt dieselbe Nummer wie der normale Band. Lücken werden deshalb über **Typ + Nummer** abgeglichen (`reconcileMangaGaps`, `isGapCovered`), nie nur über die Nummer. `classifyOfficialVolume()` bestimmt den Typ eines offiziellen Eintrags; ein generischer Titel („Collectors Edition“) oder eine nackte Zahl wird nie per Namenssuche zugeordnet.
   * `batchImportGaps` löst die UI-Beschriftungen auf (`"26 (Titel)"`, `"5 (Collectors Edition)"`, `"East Blue Leerschuber"`, reine Zahl = regulärer Band), speichert die saubere Nummer samt Preis/Datum/Cover und fasst vorhandene (`Vorhanden`/`Gelesen`) Einträge nie an. Ghost-Einträge im Regal gibt es nur für reguläre Bände (`detectedGapEntries` mit `type`).
   * Anzeigenamen: `getVolumeDisplayTitle()` / `getEditionLabel()` (Collectors, Limited, Special, Variant …, aus den Notizen) – überall verwenden (Karten, Liste, Regal, Einkaufsliste, Radar), keine eigenen „Band X“-Strings. `inferVolumeType` existiert in Backend und Frontend und wird per `test/specialeditions.test.js` synchron gehalten.
15. **Fortschritt, Doppelte, Platzhalter (aus dem Test mit einer großen echten Sammlung):**
   * Fortschritt einer Reihe = **verschiedene numerierte reguläre Bände** (`regular_owned` in `GET /api/mangas`, `getSeriesProgress()` im Frontend); Schuber, Specials, Extras und nicht numerierte „Starter 1“-Einträge zählen als „+N“. Das Ziel wächst mit der höchsten besessenen Nummer (`max_regular_number`), weil die gespeicherte Gesamtzahl bei laufenden Reihen veraltet. „Band 14“ und „14“ sind derselbe Band (`volumeNumberOf`, Migration v8). Eine Reihe gilt in der Statistik nur als komplett, wenn die regulären Bände reichen.
   * `POST /api/volumes` verweist Doppelte (gleiche Reihe + Typ + Nummer, case-/whitespace-unabhängig) mit **409** ab; ein Collectors-Band mit gleicher Nummer ist erlaubt. Die Detailansicht zeigt schon vorhandene Doppelte als Banner, das Formular ignoriert einen zweiten Submit.
   * Manga Passion nutzt `2999-12-31` für „Termin nicht bekannt“: `cleanOfficialDate()` macht daraus `null` (Eintrag zählt als „kommt noch“), Migration v7 bereinigt Altdaten.
   * Cache-Header: `index.html`, `sw.js` und `manifest.json` immer `no-cache` (`utils/staticHeaders.js`), sonst verweist eine gecachte Startseite nach einem Update auf nicht mehr vorhandene Dateien.

---

## 9. Deutsche Manga-Spezifika & APIs

1. **Deutsche Verlage:**
   * `Carlsen Manga`, `Egmont Manga (EMA)`, `Tokyopop`, `Altraverse`, `Manga Cult`, `Hayabusa`, `Crunchyroll / Kazé`, `Panini Manga`.
   * Buchpreisbindung in Deutschland: Jeder deutsche Manga hat einen offiziellen festen Ladenpreis (z. B. 7,00 €, 7,50 €, 8,00 €, 10,00 €).
2. **Metadaten-Quellen:**
   * **AniList GraphQL API:** Perfekt für internationale Reihen-Titel, alternative Romaji-/japanische Titel, Status (Laufend/Abgeschlossen) und hochauflösende Cover.
   * **Deutsche Nationalbibliothek (DNB) API / SRU:** Gesetzliche Pflichtablieferung in Deutschland! Jeder in DE gedruckte Manga besitzt dort einen Datensatz mit exakter ISBN-13, Bandnummer, Seitenzahl, offiziellem Preis in € und Verlag. Kostenlos und ohne API-Key abrufbar unter:
     `https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query=isbn%3D<ISBN>&recordSchema=MARC21-xml`

