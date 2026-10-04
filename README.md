# Manga Shelf

Self-hosted manga collection for a household. Series and volumes with covers, who owns and has read what, gaps and new releases from Manga Passion, a shopping list with barcode scanner, a release radar, an anime list and statistics. It runs as a server (Docker, Pterodactyl, a single binary, or from source) that browsers and the apps connect to, or as a standalone app on a desktop or phone without any server.

Repository: **[LixNix-Swap-Org/manga-shelf](https://github.com/LixNix-Swap-Org/manga-shelf)** · Downloads: **[Releases](https://github.com/LixNix-Swap-Org/manga-shelf/releases)** · Changes: [`CHANGELOG.md`](CHANGELOG.md) · Maintainer reference: [`AGENTS.md`](AGENTS.md). The project started as MoltresHD/manga-shelf (v2.19.1).

## Contents

1. [What it is](#1-what-it-is)
2. [Ways to run it](#2-ways-to-run-it)
3. [Web app features](#3-web-app-features)
4. [Desktop and phone apps](#4-desktop-and-phone-apps)
5. [Configuration](#5-configuration)
6. [Data, backups and security](#6-data-backups-and-security)
7. [Development](#7-development)
8. [Languages](#8-languages)
9. [Credits and data sources](#9-credits-and-data-sources)

## 1. What it is

* **One collection per household.** Every account sees the same series; ownership and reading state are tracked per person ("owned by Kim and Alex"). Roles: Admin, Editor, Guest (read only).
* **German-first.** It is built around the German market: Manga Passion (German editions, prices, release calendar), the German National Library (DNB) for ISBNs, German publisher spellings. Editions in other languages can be tracked as well ([section 8](#8-languages)).
* **Interface in 13 languages.** German is the source text; English and eleven more follow the device language or a per-account choice.
* **Offline-capable.** The installed web app and the phone apps keep a readable offline copy and queue ownership, reading and purchase changes until the server is reachable again.
* **Server or standalone.** The same domain core (`core/`) runs on the server and inside the apps, so a phone or desktop app can hold the collection on its own and move it to a server later.

| You want … | Use |
|---|---|
| a server on a NAS, Raspberry Pi or VPS with Docker | [Docker](#docker) |
| a server at a Pterodactyl host or in your own panel | [Pterodactyl](#pterodactyl) |
| a server without Docker (Linux service, `.deb`/`.rpm`, Windows, macOS) | [Headless server](#headless-server-binary) |
| a window on your PC, alone or as the server for your home network | [Desktop app](#desktop-app) |
| the collection on your phone, with or without a server | [Android and iPhone](#android-and-iphone) |

## 2. Ways to run it

Every release ships the Pterodactyl ZIP, the Docker image, the headless server binaries and packages, the desktop installers and the phone apps, plus `SHA256SUMS.txt`. Whatever you pick, the first start works the same way ([First start](#first-start)).

### Docker

Image for Linux amd64 and arm64: `ghcr.io/lixnix-swap-org/manga-shelf` with the tags `latest`, `X.Y`, `X.Y.Z` and `vX.Y.Z`.

```bash
docker run -d --name manga-shelf -p 3000:3000 -v ./data:/app/data --restart unless-stopped ghcr.io/lixnix-swap-org/manga-shelf:latest
```

With Compose: take `docker-compose.yml` from the repository (`JWT_SECRET`, `TRUST_PROXY`, `SETUP_TOKEN` are commented examples there) and run `docker compose up -d`. To build instead of pulling, replace the `image:` line with `build: .`.

* **Data:** database, images and backups live in `./data` on the host. The container starts as root, takes over the folder for uid 1000 and then runs the app as the user `node`.
* **Setup code:** `docker logs manga-shelf` (or `docker compose logs manga-shelf`).
* **Update:** `docker compose pull && docker compose up -d`. Without Compose: `docker pull`, remove the container, run the same `docker run` again.
* **Health:** the image has a `HEALTHCHECK` on `/api/health`; `docker ps` shows `healthy`.
* **Console commands:** `docker exec -it -u node manga-shelf node scripts/admin.js status` (likewise `backup`, `benutzer`, `passwort-reset <name>`, `quellen`). Always pass `-u node`; without it new backups and reset files belong to root.
* **Console via `docker attach`:** only when the container runs with an open stdin: enable the commented lines `stdin_open: true` and `tty: true` in `docker-compose.yml` (or `docker run -it -d …`) and recreate the container. Leave with Ctrl+P, Ctrl+Q; Ctrl+C stops the server.
* **Behind a reverse proxy:** publish the port only locally (`"127.0.0.1:3000:3000"`) and set `TRUST_PROXY`, see [HTTPS and reverse proxy](#https-and-reverse-proxy).
* **Verify the signature** (optional): `cosign verify ghcr.io/lixnix-swap-org/manga-shelf:latest --certificate-identity-regexp 'https://github.com/LixNix-Swap-Org/manga-shelf/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com`

### Pterodactyl

Requires Node.js 22.13 or newer (the app uses the built-in `node:sqlite`).

1. **ZIP:** download `pterodactyl-manga-shelf.zip` from the [releases](https://github.com/LixNix-Swap-Org/manga-shelf/releases), or build it with `npm install && npm run package` (builds `frontend/dist/` and writes the ZIP to `dist_pack/` and the project folder).
2. **Egg:** Admin panel → **Nests** → **Import Egg** → `egg-manga-shelf.json`. It brings the Node 22 image (`ghcr.io/parkervcp/yolks:nodejs_22`), the start command and the variable `TRUST_PROXY`. The generic Node.js egg also works.
3. **Server:** create it with the egg "Manga Shelf App", Docker image "Node.js 22" or newer (Node 20/21 do not start). Assign an allocation; Pterodactyl sets `SERVER_PORT` to it. If a reverse proxy goes in front later, bind the allocation to `127.0.0.1`.
4. **Files:** File Manager → delete the default files, upload the ZIP, right click → **Unarchive**.
5. **Start.** The egg installs the dependencies at every start (`npm install --omit=dev --ignore-scripts`), creates `data/manga.db` and prints the setup code to the console.

**Update:** upload the new `pterodactyl-manga-shelf.zip` in the File Manager, unpack it and overwrite the existing files (delete nothing beforehand; `data/`, `.env` and `ssl/` stay), then restart the server.

If `npm run package` fails, build the ZIP by hand: run `cd frontend && npm install && npm run build`, then zip with their folder structure `package.json`, `package-lock.json`, `.env.example`, `frontend/dist/` and everything listed under `"files"` in `package.json` (today `index.js`, `db.js`, `core/`, `mangaPassion.js`, `healthcheck.js`, `middleware/`, `routes/`, `scripts/admin.js`, `services/`, `utils/`). Never include `node_modules/` or `data/` (a packed `data/` would overwrite the database on the server when unpacked).

### Headless server binary

A single program with Node.js built in, for a server, NAS, mini PC or a Windows machine as a host:

| System | File |
|---|---|
| Linux x64 / arm64 | `manga-shelf-server-linux-x64` / `manga-shelf-server-linux-arm64` (arm64 needs `libatomic1`: `apt install libatomic1`; the .deb/.rpm declare it) |
| Debian/Ubuntu, Fedora/RHEL (amd64, arm64) | `manga-shelf-server_X.Y.Z-1_amd64.deb` / `manga-shelf-server-X.Y.Z-1.x86_64.rpm` and the arm64/aarch64 builds |
| Windows | `manga-shelf-server-windows-x64.exe` |
| macOS (Apple Silicon and Intel) | `manga-shelf-server-macos-universal` |

```bash
chmod +x manga-shelf-server-linux-x64
./manga-shelf-server-linux-x64 --port 3000 --data-dir ./manga-data
```

Options: `--port`, `--host` (default `0.0.0.0`), `--data-dir`, `--log-file` (also writes `<data folder>/logs/manga-shelf.log`, rotated), `--no-console`, `--version`, `--help`. Without `--data-dir` the data lives in `~/.local/share/manga-shelf` (Linux), `~/Library/Application Support/manga-shelf` (macOS) or `%LOCALAPPDATA%\manga-shelf\data` (Windows). A `.env` in the data folder is read; the environment and the command line win. The server refuses to start when that `.env` is a link, belongs to another user or can be changed by others, and names the fix (`chmod 600 <data folder>/.env`, on Windows an `icacls` line). The web portal is unpacked into a cache folder (`MANGA_SHELF_CACHE_DIR` moves it). Console commands run as subcommands: `manga-shelf-server-linux-x64 passwort-reset Kim --data-dir ./manga-data`.

**As a service** (`uninstall-service` removes it; the data stays):

* **Linux (systemd):** `sudo ./manga-shelf-server-linux-x64 install-service` copies the program to `/usr/local/bin/manga-shelf-server`, creates the user `manga-shelf`, uses `/var/lib/manga-shelf` (0750) and starts `manga-shelf.service`. Logs and setup code: `journalctl -u manga-shelf -n 50`. Without root: `install-service --user` (plus `loginctl enable-linger $USER` to run without a login).
* **Debian/Ubuntu/Fedora:** `sudo apt install ./manga-shelf-server_*_amd64.deb` or `sudo dnf install ./manga-shelf-server-*.rpm` sets up the same service; install a newer package to update. Removing the package keeps `/var/lib/manga-shelf`.
* **macOS (launchd):** `./manga-shelf-server-macos-universal install-service` creates the LaunchAgent `de.manga-shelf.server` (starts at login, restarts after a crash). Logs: `~/Library/Application Support/manga-shelf/logs/manga-shelf.log`.
* **Windows:** in a command prompt **as Administrator** `manga-shelf-server-windows-x64.exe install-service`. The program goes to `C:\Program Files\Manga Shelf Server\` and runs as the scheduled task "Manga Shelf Server" at system start as **LOCAL SERVICE** (`--account NetworkService`, `DOMAIN\name`, `.\name` or a SID for another account), data in `C:\ProgramData\manga-shelf\data` with permissions only for that account, SYSTEM and the Administrators. Installs made with an older version (ran as SYSTEM) run `install-service` once more. Open the port in the Windows Firewall for other devices.

Build it yourself (in the project folder): `npm ci && (cd frontend && npm ci && npm run build) && node scripts/server-bin/build-sea.js` (current system; `--target linux-x64,linux-arm64,windows-x64,macos-universal` for others, `macos-universal` only on a Mac, downloading the official Node per target and checking its checksum; needs Node 25.5 or newer). `node scripts/server-bin/smoke.js <file>` checks a result.

### From source

```bash
npm install && (cd frontend && npm install && npm run build)
npm start
```

Node.js 22.13 or newer. `.env` in the working directory is read ([section 5](#5-configuration)); the data goes to `data/`.

### First start

1. Open the server address (e.g. `http://your-ip:3000`). Without an admin account the setup page appears.
2. Enter the **setup code**. The server prints it at startup in the console or log (the line starts with "Ersteinrichtung: Einrichtungscode für das erste Admin-Konto"; Docker `docker logs manga-shelf`, service `journalctl -u manga-shelf`). `SETUP_TOKEN` fixes it in advance: at least 12 characters; spaces, hyphens and upper or lower case do not count. The desktop app sets and shows it by itself.
3. Create the admin account.
4. Optionally "Connect sources (possible later)": add API keys for everyone ([API keys](#api-keys)).

Admins add further accounts under Users: **Editor** (changes the collection), **Guest** (reads and exports), **Admin** (also users, backups, system page).

**Console commands** (Pterodactyl console, the terminal of the headless server, `node scripts/admin.js <command>`, Docker as above; `ADMIN_CONSOLE=false` turns off the stdin console). The command names are German; English aliases work too (`help`, `users`, `reset-password`, `promote`, `rollback-cleanup`, `sources`):

| Command | Effect |
|---|---|
| `hilfe` | list all commands |
| `status` | version, data folder, database, disk space, last backup |
| `backup` | create a snapshot now |
| `benutzer` | list users with their role |
| `passwort-reset <name>` | random new password (shown in the terminal, otherwise written to a file in the data folder); ends the user's sessions and calendar feed address |
| `admin <name>` | make `<name>` an admin, only when there is none |
| `rollback-aufraeumen [bestaetigen]` | check `manga.db` and delete a leftover `manga.db.bak` |
| `quellen …` | API keys: state, guide, set, remove ([API keys](#api-keys)) |

### Upgrading from v2.19.1

Read the admin notes at the top of [`CHANGELOG.md`](CHANGELOG.md) first. In short:

* **Database migrations 12–27** run at the first start. Before any pending migration the server writes `data/backups/vor-update-v<old>-auf-v<new>-….zip`; if that fails (disk full, read-only folder) it does not start and changes nothing. `MIGRATE_WITHOUT_SNAPSHOT=1` migrates without it, once and deliberately.
* **Data changes:** migration 22 unifies known publisher spellings (e.g. "Carlsen Verlag GmbH" → "Carlsen Manga"); migration 27 turns series languages into ISO codes ("Deutsch" → `de`), sets the currency `EUR` on every series and sets an unrecognised language to `de`, named in the start log, so check those series afterwards.
* **Everyone signs in again once:** the session key moves to `data/secret.key`.
* **Setup code and `TRUST_PROXY`** are new: a server without an admin needs the code, and behind a proxy `TRUST_PROXY` has to name it ([HTTPS and reverse proxy](#https-and-reverse-proxy)).
* **Pterodactyl:** import the egg again. **Windows service:** run `install-service` again.
* **Scripts against the API:** `GET /api/stats` moved its key figures under `summary`, series languages are ISO codes, money totals add euro only. Details in the changelog.

**No downgrade.** There is no automatic way back. To return to the old version: stop the server, install the old version (old ZIP or image tag), start it and at once restore the `vor-update-…zip` backup as an admin (upload it if it is not listed); change nothing before. Never run the old version permanently on the migrated database: what it writes (e.g. the old volume status "Gelesen") is not converted by a later update. Images in `uploads/` survive both directions.

### HTTPS and reverse proxy

Browsers require HTTPS (or `localhost`) for the live camera scanner and for installing the web app with offline support. For an address like `https://manga.example.com` create an A record for the host and put a reverse proxy in front of the app.

**Caddy** (gets and renews certificates itself), `/etc/caddy/Caddyfile` (template `Caddyfile.example`; port: Pterodactyl allocation, otherwise 3000), then `sudo systemctl reload caddy`:

```caddy
manga.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx + Certbot:** copy `nginx.conf.example` to `/etc/nginx/sites-available/manga-shelf`, adjust `server_name` and the port in `proxy_pass`, link it into `sites-enabled/`, run `sudo nginx -t && sudo systemctl reload nginx`, then `sudo certbot --nginx -d manga.example.com --redirect`. The template is a plain HTTP block (nginx would not start with an SSL listener before the certificate exists) and allows uploads up to 512 MB (backups up to 500 MB).

**`TRUST_PROXY`.** Login limits and locks depend on the client address. Behind a proxy the app first sees the proxy; `TRUST_PROXY` says whose `X-Forwarded-For` to believe. The default `loopback` trusts only a proxy on the same machine.

| Setup | `TRUST_PROXY` |
|---|---|
| no proxy | default (or `false`) |
| proxy on the same machine as the headless server or `npm start` | default `loopback` |
| proxy on the host in front of Pterodactyl or Docker | `loopback, 172.18.0.1`: only the gateway address of the Docker network (Pterodactyl `pterodactyl_nw` is `172.18.0.1`; Docker: `docker network inspect <network>` → `Gateway`) |
| proxy container in a Docker network of its own with only the proxy and the app | address of the proxy container or the subnet of that network |
| proxy on another machine | its address, e.g. `loopback, 192.168.1.10` |

Never trust the whole subnet of a network that other containers share (on a Pterodactyl node, other people's servers): they reach the app port directly and could claim any address. The app port must then be reachable **only through the proxy** (Pterodactyl allocation on `127.0.0.1`, Docker `"127.0.0.1:3000:3000"`; published Docker ports bypass ufw/firewalld). A hop count (`TRUST_PROXY=1`) trusts anyone who connects and only makes sense behind a firewall. An invalid value stops the start.

The secure cookie is set automatically when the proxy sends `X-Forwarded-Proto: https` (both templates do). Native HTTPS without a proxy: put `ssl/privkey.pem` and `ssl/fullchain.pem` next to `index.js` (headless server: into `<data folder>/ssl/`), or set `SSL_KEY_PATH`/`SSL_CERT_PATH`.

## 3. Web app features

The interface switches between shelf, shopping list, release radar and anime tab; below 640 px a bottom navigation takes over.

* **Collection:** series and volumes with cover, publisher, price, release date, ISBN and notes; box sets, special editions and specials; a status per volume (Owned, Missing, Pre-ordered, Ordered, Coming soon); a collecting state per series (active, paused, dropped) apart from the publication status.
* **Shelf:** series as a grid or a compact list; filters by status, publisher, collecting state (also gaps, pre-orders, complete), author, genres/tags and language, grouping by publisher, author or status, and sorting, kept in the URL. The search also finds ISBNs and notes. A "Continue reading" bar and selectable read dates. On the series page the volumes can also stand as spines on shelves.
* **Several volumes at once:** select volumes and set status, owners or reading state together, with undo.
* **Manga Passion:** take over a series by link or search, detect missing volumes, fill in data and covers, load genres, track release date changes. German editions only.
* **ISBN lookup** via DNB, K10plus and Google Books, covers via Open Library.
* **Shopping list and shop mode:** every missing and pre-ordered volume grouped by publisher; share, copy or print it. In the shop the barcode scanner checks volume after volume: to buy, already owned (and by whom), or missing. "Bought" works offline and is sent later. The live camera needs HTTPS; the apps use the native scanner.
* **Release radar:** new releases per month from the Manga Passion calendar, your pre-orders and changed release dates.
* **Calendar feed (iCal):** release radar → "Subscribe to calendar" → "Create subscription address". Every volume with an exact release day becomes an all-day event. The address carries its own key; a new address, "End all sessions", a password change or a password reset end the old one. Google Calendar fetches the feed from its own servers, so the server has to be reachable from the internet for that.
* **Wishlist:** series with priority and target price, their own section in the shopping list, a badge in the calendar, a shelf filter.
* **Anime tab:** one shared list (seasons and films separately), progress per person (episodes, status, rating, note), search via AniList and MyAnimeList, countdown to the next episode, link to the matching manga series, CSV export.
  * **Share links:** share a Crunchyroll episode to Manga Shelf (share sheet of the installed web app, the Android share dialog, the iOS share extension in the apps, or "Paste link"). After "Yes, watched" your progress rises, never backwards, with undo.
  * **"Continue on Crunchyroll"** opens the next episode (in the apps the Crunchyroll app when installed).
  * **AniList list sync** (optional, account → sources, needs your own AniList key): the higher episode count wins.
  * **Crunchyroll history** (apps only, experimental): see [Crunchyroll history](#crunchyroll-history-experimental).
* **Statistics:** spending by purchase date, ownership per person, most valuable series, publishers, reading history over 24 months, series and volumes per language, anime figures. Totals add euro prices only and list other currencies beside them.
* **CSV:** export and import of the whole collection with a dry run (owners, reading state, wishlist, editions included). The import accepts German or English headers.
* **Backups and restore** (admins): see [section 6](#backups-and-restore).
* **Trash:** deleted series and volumes can be restored for 30 days (statistics dialog → Trash).
* **Tidy up:** "Merge publishers" unifies spellings, editable tags, "Tidy up collection" lists incomplete or contradictory entries with one-click fixes.
* **Users and roles:** Admin, Editor, Guest; "End all sessions"; "Connect with app" shows a QR code for the phone apps.
* **System page** (admins): version and update notice, storage, database, backups, orphaned images, load of the external sources.
* **Installable web app (PWA)** with a readable offline copy and an offline outbox.

### API keys

Without keys everything runs through the shared access of the server (AniList without a token, Jikan instead of the official MyAnimeList API, Google Books anonymously) with its rate limit. Your own key brings your own limit.

| Provider | For | Key | Where |
|---|---|---|---|
| AniList | per user | access token (valid for a year) | [anilist.co/settings/developer](https://anilist.co/settings/developer) → "Create New Client", redirect URL `https://anilist.co/api/v2/oauth/pin` |
| MyAnimeList | per user and instance | client ID (32 characters) | [myanimelist.net/apiconfig](https://myanimelist.net/apiconfig) → "Create ID", App Type **other**, redirect URL `http://localhost/` |
| Google Books | instance (admins) | API key (`AIza…`) | [Google Cloud Console](https://console.cloud.google.com/) → enable "Books API" → Credentials → API key |

The same step-by-step guide with a check against the provider is in the account dialog (tab for API keys; admins also see "For everyone (instance)"), in the setup assistant, in the apps without a server under "Sources & keys", in the desktop menu and in the console: `quellen`, `quellen anleitung <anilist|mal|google_books>`, `quellen setzen <provider> [--benutzer name] [--aus-datei path]` (asks for the key: hidden with `node scripts/admin.js` or a subcommand in a terminal, but visible in the Pterodactyl console and the server's own stdin console, so use `--aus-datei` there), `quellen entfernen <provider> [--benutzer name]`. Never type the key on the command line. `MAL_CLIENT_ID` and `GOOGLE_BOOKS_KEY` in the environment win over stored instance keys. Stored keys are encrypted with the server secret: a new secret, or a backup restored on another server, means entering them again.

## 4. Desktop and phone apps

Installers and apps are attached to every release. CI runs on `main` and in pull requests keep the desktop installers as build artifacts for 14 days and the phone smoke builds (debug APK, simulator app) for 7 days. Actions → **Release** with `action` = `build` gives every artifact, apps included, for any branch. Without signing secrets they are built unsigned; the release text says which parts are signed.

### Desktop app

Windows `manga-shelf-<version>-windows-x64-setup.exe` or `-portable.exe`, macOS `manga-shelf-<version>-mac-universal.dmg` or `.zip` (Intel and Apple Silicon), Linux AppImage, `.deb` and `.rpm` (a Flatpak build is an attempt). At the first start you pick the mode; the native menus are German:

* **"Nur auf diesem Gerät"** (only this device): the collection lives in the user folder; a local server on `127.0.0.1:37210` serves the window.
* **"Mit Server verbinden"** (connect to a server): a client of your Docker, Pterodactyl or headless server; addresses and sign-in in the system keychain.
* **"Dieses Gerät ist Server"** (this device is the server): port 3000 in the home network, "Adresse für andere Geräte" shows the address and a QR code for the phone apps, tray icon, optional start at login.

The app sets and shows the setup code (File → "Einrichtungscode anzeigen…"). To move from "only this device" to a server, download the backup ZIP and restore it on the server. Command line: `--server-only`, `--port <n>`, `--host <address>`, `--data-dir <folder>`, `--connect <url>`, `--hidden`, `--user-data-dir <folder>`. There are no automatic updates; admins see new versions on the system page.

Unsigned builds: macOS "cannot be opened" → right click → Open (or `xattr -dr com.apple.quarantine "/Applications/Manga Shelf.app"`); Windows SmartScreen → "More info" → "Run anyway"; Linux AppImage needs `chmod +x`.

### Android and iPhone

* **Android:** open `manga-shelf-<version>-android.apk` on the phone and allow installing from unknown sources. Without a release keystore the APK carries the debug key (sideloading only); a later update with the real key needs one uninstall, so export a backup in the app first. The `.aab` is for the Play Store (`-android-unsigned.aab` without the keystore).
* **iPhone/iPad:** sign `manga-shelf-<version>-ios-unsigned.ipa` yourself with AltStore, Sideloadly or Xcode and your Apple ID (seven days with a free account, then sign again). With certificates in the release there is a signed `manga-shelf-<version>-ios.ipa` instead. Re-signed builds may lose the share extension's App Group; then "Paste link" is the way to share episodes.
* **First start:** "Use without a server" (collection only on the device), enter a server address, or scan the "Connect with app" QR code (footer of the web app, or the desktop app in server mode).
* **Server addresses:** `https://…` anywhere, `http://…` only in the home network (private ranges, Tailscale `100.64.0.0/10`, names ending in `.local`, `.lan`, `.fritz.box`, `.home.arpa`, `.internal`).
* **Minimum versions:** Android 6, iOS 15.5.
* **Device backups:** Android keeps the app's collection and images out of cloud backup and device transfer. On iPhone/iPad they live in the app's data folder, which iCloud and device backups still include. On both, the ZIP backup of the app is the reliable way.

### Use without a server

"Use without a server" keeps the collection on the phone: a local profile (name, no password; more profiles for ownership and reading per person), the same database schema as the server, online lookups straight from the device (Manga Passion, DNB/K10plus/Google Books, AniList/MyAnimeList) and your own API keys in the device's secure storage. Server-only parts are missing: user management, server backups, system page, console.

The collection exists only on that device. Export a backup ZIP regularly and keep it elsewhere: Android does not back up the app data, and on iPhone/iPad iCloud includes it only as part of the whole device backup.

Under **Server** you find "Export backup"/import (ZIP in the server's backup format) and three takeover paths:

| Path | When | What happens |
|---|---|---|
| **Transfer to server** | a new, freshly set up server | sign in as admin; the app sends its collection with covers as a backup, the server shows its figures first and warns when it already holds data; the local profile becomes that admin account |
| **Merge** | a server with its own collection | series and volumes are added via CSV (dry run with preview first); ownership and reading go to the signed-in user; covers are not transferred |
| **Fetch from server** | a server collection onto the phone | as admin the full backup with covers, otherwise the offline copy; replaces the collection on the device; passwords, API keys and calendar keys of server accounts never stay on the device |

There is no continuous sync between a standalone collection and a server; whoever wants both connects the app to the server (offline copy and queued changes included).

### Away from home

Without a public address the server at home is not reachable on the road. The app (and the web app installed over HTTPS) then shows the offline copy: reading and searching work, editors and admins can toggle ownership and reading state and tick off purchases; these changes are sent once the server is reachable again. Creating, editing, the radar, statistics and online lookups need the connection. For real access on the road:

* a **public HTTPS address** ([HTTPS and reverse proxy](#https-and-reverse-proxy)), added in the app under "Server" as another address of the same server; the app then uses the first one that answers;
* a **VPN** such as Tailscale or WireGuard: the home address is reachable everywhere without exposing the server; Tailscale addresses count as home network and may use `http://`.

### Crunchyroll history (experimental)

Apps only, off by default, editors and admins. The card "Crunchyroll history (experimental)" (account → keys, without a server under "Sources & keys") signs in to Crunchyroll in an embedded login after a warning. The Crunchyroll session (refresh cookie, client, device and account ID) stays only in the secure storage of the device (no iCloud, no device transfer); the password is typed into Crunchyroll's own page. The app reads the history in the foreground at most every 15 minutes and sends the server only the matched items (series ID and title, season, episode, watched state and time, next-episode link), never cookies, tokens or the raw history. It uses an unofficial interface whose terms forbid automated access, which is why store builds can switch it off: the repository variable `WATCH_CRUNCHYROLL` = `off`, or locally `VITE_WATCH_CRUNCHYROLL=off npm run build:android`. Details: [`AGENTS.md`](AGENTS.md).

## 5. Configuration

Every variable is optional. Sources in order of priority: the command line of the headless server (`--port`, `--host`, `--data-dir`), the environment (Pterodactyl startup tab, Docker `environment`), a `.env` in the working directory (headless server: in the data folder; `scripts/admin.js`: next to `index.js`). `.env.example` comments every value. An unusable value logs a warning at startup and the default applies; only an invalid port, an invalid `TRUST_PROXY`, an unreadable `secret.key`, a pre-update backup that cannot be written and, for the headless server, a `.env` others may change stop the start.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port of the server. `SERVER_PORT` (set by Pterodactyl) wins. |
| `DATA_DIR` | `data/` in the app folder (Docker `/app/data`) | Database, images, backups, `secret.key`. |
| `TRUST_PROXY` | `loopback` | Whose `X-Forwarded-For` counts: `false`, `loopback`, addresses or subnets such as `loopback, 172.18.0.1`, a hop count or `true` ([HTTPS and reverse proxy](#https-and-reverse-proxy)). |
| `JWT_SECRET` | random in `<DATA_DIR>/secret.key` | Signs sessions and encrypts stored API keys; at least 32 characters (shorter values and placeholders such as `changeme` are ignored with a warning). Changing it signs everyone out and voids stored keys. |
| `SETUP_TOKEN` | generated at startup | Fixed setup code for the first admin, at least 12 characters (spaces, hyphens and case do not count); shorter values are ignored. |
| `COOKIE_SECURE` | `false` | Force the secure cookie and HSTS (only behind a TLS proxy without `X-Forwarded-Proto`; plain HTTP sign-in then fails). |
| `SSL_KEY_PATH`, `SSL_CERT_PATH` | `ssl/privkey.pem`, `ssl/fullchain.pem` (else `ssl/cert.pem`) in the app folder; headless server in the data folder | Native HTTPS on the same port once both files exist. |
| `CORS_ORIGIN` | empty | Extra web origins with cookie access (comma-separated); the bundled frontend does not need it. |
| `APP_ORIGINS` | `capacitor://localhost`, `https://localhost`, `ionic://localhost`, `app://manga-shelf` | Origins of the phone and desktop apps (bearer token, no cookie); `none` turns them off. |
| `FRONTEND_DIR` | `frontend/dist`, then `dist/` | Folder of the built frontend. |
| `APP_TIMEZONE` | `Europe/Berlin` | What "today" is for the radar, calendar and anime dates. |
| `BACKUP_HOUR`, `BACKUP_TIMEZONE` | `3`, `Europe/Berlin` | Time of the daily snapshot. |
| `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_MANUAL`, `BACKUP_KEEP_PRE_RESTORE`, `BACKUP_KEEP_PRE_UPDATE` | `7`, `10`, `3`, `3` | Snapshots kept per kind (1 to 1000). |
| `MIGRATE_WITHOUT_SNAPSHOT` | `false` | `1` migrates even when the pre-update backup cannot be written (set once, deliberately). |
| `RESTORE_MAX_DB_BYTES`, `RESTORE_MAX_UPLOADS_BYTES`, `RESTORE_MAX_ENTRIES` | 2 GiB, 4 GiB, `100000` | Limits when unpacking a backup. |
| `ADMIN_CONSOLE` | `true` | Console commands on stdin. |
| `UPDATE_CHECK` | `true` | The system page asks GitHub for a new version at most once a day, only while an admin has it open. |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `text` | `debug`/`info`/`warn`/`error`/`silent`; `json` for log tools. |
| `ANIME_ANILIST_RPM`, `ANIME_JIKAN_RPM` | `30`, `60` | Requests per minute of the shared AniList and Jikan access (1 to 600). |
| `ANIME_SOURCES` | `anilist,jikan` | Active anime sources (`jikan` or `mal` stands for MyAnimeList); unknown names are ignored with a warning. |
| `MAL_CLIENT_ID`, `GOOGLE_BOOKS_KEY` | empty | Instance API keys; win over keys stored in the interface. |
| `MANGA_SHELF_CACHE_DIR` | system cache | Headless server only: where the web portal is unpacked. |

Not read by the server: `REMOTE_URL`, `REMOTE_HOST`, `REMOTE_PORT`, `REMOTE_USER`, `REMOTE_PASS`, `REMOTE_ALLOW_HTTP` for `scripts/check-remote.js`, `seed-remote.js` and `verify-remote.js`; `CHROME_BIN` or `PUPPETEER_EXECUTABLE_PATH` for the browser tests.

**Ports**

| Port | Used by |
|---|---|
| `3000` | the server (`PORT`), the Docker image, the headless binary, the desktop app in server mode |
| Pterodactyl allocation | the server via `SERVER_PORT`, which wins over `PORT` |
| `37210` | the desktop app in "only this device" mode, bound to `127.0.0.1` |
| `5173` | the Vite dev server of `npm run dev` (proxies `/api` and `/uploads` to 3000) |

## 6. Data, backups and security

### Data folder

`DATA_DIR` holds `manga.db` (SQLite, WAL), `uploads/` (images), `backups/` (snapshots), `secret.key` and, for the headless server, `.env`, `ssl/` and `logs/`. Copying the whole folder while the server is stopped moves everything, the secret included.

### Backups and restore

As an admin under **Backups**:

* **Automatic:** every day at `BACKUP_HOUR` (default 3, time zone `BACKUP_TIMEZONE`) a verified snapshot in `data/backups/`. Kept per kind: 7 daily, 10 manual, 3 before a restore, 3 before an update (`BACKUP_KEEP_*`).
* **Create a snapshot** (or `backup` in the console) and **download a ZIP** directly: `manga.db` plus every image from `uploads/`.
* **Restore** from a snapshot or an uploaded ZIP (up to 500 MB). The server checks the archive first and shows its content; it swaps only after confirmation. A `vor-wiederherstellung-*` snapshot is taken before, so the restore can be undone. Every other session ends.
* **Secret:** `secret.key` is in no backup. Stored API keys are encrypted with it, so after restoring on another server they have to be entered again.
* **Backup from the app:** a server collection fetched into the app, or imported there from a server ZIP, holds no passwords any more. When that app ZIP is restored on a server, the check names the accounts without a password; they need a password reset in the user management. If your own account is among them, set a new password before signing out; with nobody signed in only the console command `passwort-reset <name>` helps. Into a server with a collection of its own, use "Merge" (CSV) instead of a restore.
* Deleted something after the last backup? Look in the trash first (30 days).
* Going back to an older version: see [Upgrading from v2.19.1](#upgrading-from-v2191).

### Security model

* **Sessions:** a JWT in the `httpOnly` cookie `token` (browser) or as a bearer token (apps), valid 7 days, checked against the database on every request. Logout blocks the token; a password change, a password reset, "End all sessions" and a restore end sessions. The signing key is `JWT_SECRET` or `<DATA_DIR>/secret.key` (0600).
* **First setup** only with the setup code; afterwards it has no effect.
* **Origin check:** writing API requests a browser sends from another origin are rejected; CORS only for `CORS_ORIGIN` and the app origins. Security headers include a CSP, Permissions-Policy, COOP and HSTS over HTTPS.
* **Rate limits** per address and per account (brute-force protection without locking out the admin) and per-account limits for external lookups. They depend on correct client addresses, hence `TRUST_PROXY`.
* **Uploads:** images up to 15 MB, checked by magic bytes, EXIF/GPS stripped, random file names, a CSP of their own under `/uploads`; image downloads from URLs are SSRF-safe.
* **Headless server:** refuses a `.env` others can change; Linux data folder 0750 and `UMask=0027`, Windows service as LOCAL SERVICE with a protected ACL.
* **Apps:** tokens and API keys in the system keychain or keystore; plain `http://` only to home-network addresses.

## 7. Development

`AGENTS.md` is the maintainer reference: file map, schema and migrations, every endpoint, task-to-file guide, conventions and pitfalls. Read it before changing code.

```bash
npm ci && (cd frontend && npm ci)
npm run dev      # backend (node --watch) on :3000 and Vite on :5173; demo data in data-dev/, logins in data-dev/seed-users.json
```

### npm scripts

| Script | Does |
|---|---|
| `npm run dev` | backend and Vite together, demo collection in `data-dev/` |
| `npm run dev:api` | backend only |
| `npm start` | production server (`node index.js`) |
| `npm test` | backend tests (`node:test`: `test/`, `test/core/`, `test/anime/`) |
| `npm run test:frontend` | Vitest component tests in `frontend/` |
| `npm run lint` | ESLint 10 |
| `npm run build:frontend` | `npm ci` and the Vite build of `frontend/` |
| `npm run check:bundle` | bundle budget (`frontend/bundle-budget.json`; `-- --update` after intended growth) |
| `npm run package` | Pterodactyl ZIP |
| `npm run build:server` | headless server binary (`scripts/server-bin/build-sea.js`) |
| `npm run seed` | fill an empty database deterministically (`-- --series 1500 --volumes 45000 --seed 42`) |
| `npm run bench` | endpoint benchmark against a seeded database |
| `npm run release` | local version helper (`release.js`) |
| `npm run test:e2e` | browser suite: login, search, users, backup and restore, volumes, wishlist, bulk edit |
| `npm run test:radar` | browser suite: release radar |
| `npm run test:anime` | browser suite: anime tab without external APIs |
| `npm run test:deep` | browser walkthrough with screenshots (phone, landscape, tablet) |
| `npm run test:perf` | page load, API latency, bundle sizes |

**Gates before a PR:** `npm run lint`, `npm test`, `npm run test:frontend`, the frontend build with `npm run check:bundle`, then the browser suites. `test/docs.test.js` and `test/agentsMd.test.js` keep this README, `.env.example` and `AGENTS.md` in line with the code and run in `npm test`.

**Browser suites** need a built frontend (`npm run build:frontend`) and Chrome, Chromium, Edge or Brave (`CHROME_BIN` or `PUPPETEER_EXECUTABLE_PATH` picks one). Each suite starts its own server on a temporary database with a throwaway admin; never point them at a real instance. They run with `--lang=de-DE`.

**Desktop:** `cd desktop && npm ci && npm run build:desktop` (installers in `desktop/dist/installers/`; unsigned unless signing variables such as `CSC_LINK` or `APPLE_ID` are set), `npm start` for development, `npm test`.

**Android/iPhone:** `cd frontend && npm ci`, then `cd mobile && npm ci && npm run build:android` (JDK 21, Android SDK 35) or `npm run build:ios` (macOS, Xcode 16+, CocoaPods). Output in `mobile/build/out/`. After changing the version by hand run `npm run version:sync` (`release.js` and the Release workflow do it themselves).

### Release workflow

* **Every pull request and every push to `main`** runs `ci.yml` (lint, tests on Node 22.13.0/22/24, frontend build and budget, ZIP install check, Docker build, browser suites) and `build.yml`: artifacts for 14 days (Pterodactyl ZIP with SBOM, server binaries and packages; desktop installers and the phone smoke builds of `mobile.yml`, a debug APK and the simulator app for 7 days, not for Dependabot's pull requests). A branch without a pull request gets no run of its own. Nothing is published. `codeql.yml` is wired for `main`, pull requests and a weekly run, but code scanning only works once the repository is public; while it is private the job is skipped.
* **Build by button:** Actions → **Build** → **Run workflow** on any branch builds every artifact (unsigned, nothing published; the desktop installers can be switched off); Actions → **Mobile** → **Run workflow** builds only the apps (`smoke`: debug APK and simulator app, `build`: APK/AAB and IPA).
* **Publishing only by button:** Actions → **Release** → **Run workflow**, pick the branch and `action`:
  * `build`: build everything (signed when the secrets exist), publish nothing;
  * `release`: bump the version (`bump` = `patch`/`minor`/`major`; `none` takes the version from `package.json`, its tag must not exist), commit and tag `vX.Y.Z`, build everything including the apps, push the image to GHCR with `X.Y.Z` and `vX.Y.Z` (signed keyless with cosign), create the GitHub release with all files, `SHA256SUMS.txt` and generated notes; only then do `X.Y` and `latest` move to that image. A failed run never moves `latest`; a pushed tag alone publishes nothing.
* **Locally:** `node release.js minor --dry-run` shows the next version, `node release.js minor` (or `patch`, `major`, `X.Y.Z`) needs a clean tree and a free tag and sets it in every `package.json`/`package-lock.json` and the native Android/iOS projects, without commit, tag or push; then commit, push and run the workflow with `bump = none`.
* **Once:** with a protected branch, a fine-grained PAT with `Contents: Read and write` as the secret `RELEASE_TOKEN` (otherwise `GITHUB_TOKEN` is enough). Set the GHCR package `manga-shelf` to public after the first release. While the repository itself is private, release downloads and the image are reachable only for collaborators and the in-app update notice gets no data; make the repository public for end users.
* **Recovery:** `release` pushes the version commit and the tag before it builds; if a later job fails, use **Re-run failed jobs** on that run (a fresh run would need the next version). `release` only runs from the default branch; `build` runs from any branch.
* **Update notice:** the server checks `releases/latest` of `LixNix-Swap-Org/manga-shelf`; never publish releases as pre-releases.

**Signing** (repository secrets; missing groups are built unsigned):

| Secret | Content |
|---|---|
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code signing certificate (`.pfx`, base64) and password |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | "Developer ID Application" certificate (`.p12`, base64) and password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarisation |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Android release keystore (keep it safe: a lost key means a new app ID in the store) |
| `IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` | iOS distribution certificate and provisioning profile (with `APPLE_TEAM_ID`) |
| `IOS_SHARE_PROVISIONING_PROFILE_BASE64` | optional: profile of the share extension `de.mangashelf.app.ShareToMangaShelf` (App Group `group.de.mangashelf.app` on both App IDs); without it the signed IPA has no share extension |

base64 of a file: `base64 -i file.p12 | pbcopy` (macOS) or `base64 -w0 file.p12` (Linux). The repository variable `WATCH_CRUNCHYROLL` = `off` removes the Crunchyroll history from the app builds.

### Language of tooling output

The interface, the docs, the release text and the workflow names are English or multilingual. Maintainer tooling is still German: console command names and their output (`scripts/admin.js`, the headless binary's subcommands and help), server log and startup messages (such as the setup code line and "TRUST_PROXY ungültig"), the desktop app's menus and dialogs, the comments in `docker-compose.yml`, `Caddyfile.example` and `nginx.conf.example`, and error messages inside the workflow steps. Code comments and `AGENTS.md` are English.

## 8. Languages

* **Interface:** 13 languages: German (`de`) as the source text, English (`en`), French (`fr`), Spanish (`es`), Italian (`it`), Portuguese (Brazil) (`pt-BR`), Dutch (`nl`), Polish (`pl`), Japanese (`ja`), Korean (`ko`), Simplified Chinese (`zh-Hans`), Russian (`ru`) and Turkish (`tr`). The interface follows the device language (browser, apps, desktop); an unsupported language falls back by its primary language (pt-PT → pt-BR, zh-TW → zh-Hans), otherwise to German. Each account can pick a language under account → "Language" (also on the login and setup screens), which applies on all its devices. Offline, a language whose catalog was never loaded cannot be chosen.
* **Not translated:** the desktop app's native menus and dialogs, the console and server logs, stored values such as volume statuses and CSV values (CSV headers may be German or English), and the German publisher and Manga Passion data.
* **Editions:** a series is one edition in one language with a region and a currency tag (ISO 639-1 language code, two-letter region, currency, default `EUR`); editions of the same work are linked ("+ Ausgabe" on the series page creates or links one), and a volume can override the language. Your default edition language is set in the account's language tab. Prices are shown in the currency of their series and never converted.
* **Manga Passion is German-market only:** gap check, autofill, release calendar and lookups skip editions in other languages; lookups for those ask AniList and MyAnimeList only. Regions and currencies are tags, there is no release source outside Germany.
* **Adding an interface language:** the steps are in `AGENTS.md`, Gotcha 38 (catalog in `frontend/src/i18n/locales/`, `LANGUAGES` in `frontend/src/i18n/index.js`, `UI_LOCALES` in `core/lib/locales.js`, a manifest, tests and the bundle budget).

## 9. Credits and data sources

* **Manga Passion** for German editions, prices and the release calendar.
* **Deutsche Nationalbibliothek**, **K10plus** and **Google Books** for ISBN lookups, **Open Library** for covers.
* **[AniList](https://anilist.co/)** and **[MyAnimeList](https://myanimelist.net/)** (directly or via Jikan) for anime and manga metadata. Their data and covers belong to them and may be used non-commercially only; Manga Shelf stores IDs and a slim excerpt and links back to both.
* Started by MoltresHD as manga-shelf; maintained by Felix and Max at [LixNix-Swap-Org/manga-shelf](https://github.com/LixNix-Swap-Org/manga-shelf).
