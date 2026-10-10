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

Every release ships the Pterodactyl ZIP, the Docker image, the headless server binaries and packages, the desktop installers and the phone apps, plus `SHA256SUMS.txt` with its Sigstore signature ([Updating](#updating)). Whatever you pick, the first start works the same way ([First start](#first-start)).

### Docker

Image for Linux amd64 and arm64: `ghcr.io/lixnix-swap-org/manga-shelf` with the tags `latest`, `X.Y`, `X.Y.Z` and `vX.Y.Z`.

```bash
docker run -d --name manga-shelf -p 3000:3000 -v ./data:/app/data --restart unless-stopped ghcr.io/lixnix-swap-org/manga-shelf:latest
```

With Compose: take `docker-compose.yml` from the repository (`JWT_SECRET`, `TRUST_PROXY`, `SETUP_TOKEN` are commented examples there) and run `docker compose up -d`. To build instead of pulling, replace the `image:` line with `build: .`.

* **Data:** database, images and backups live in `./data` on the host. The container starts as root, takes over the folder for uid 1000 and then runs the app as the user `node`.
* **Setup code:** `docker logs manga-shelf` (or `docker compose logs manga-shelf`).
* **Update:** `docker compose pull && docker compose up -d`. Without Compose: `docker pull`, remove the container, run the same `docker run` again. A specific version and the way back: [Updating](#updating).
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

From 3.1.0 on the server installs a new release by itself under System → Updates ([Updating](#updating)); the manual way above stays valid.

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

Options: `--port`, `--host` (default `0.0.0.0`), `--data-dir`, `--log-file` (also writes `<data folder>/logs/manga-shelf.log`, rotated), `--no-console`, `--version`, `--help`. For a stopped server there are `restore <backup.zip> [--allow-newer-schema]` and `db-check <file>` ([Updating](#updating)). Without `--data-dir` the data lives in `~/.local/share/manga-shelf` (Linux), `~/Library/Application Support/manga-shelf` (macOS) or `%LOCALAPPDATA%\manga-shelf\data` (Windows). A `.env` in the data folder is read; the environment and the command line win. The server refuses to start when that `.env` is a link, belongs to another user or can be changed by others, and names the fix (`chmod 600 <data folder>/.env`, on Windows an `icacls` line). The web portal is unpacked into a cache folder (`MANGA_SHELF_CACHE_DIR` moves it). Console commands run as subcommands: `manga-shelf-server-linux-x64 passwort-reset Kim --data-dir ./manga-data`.

**As a service** (`uninstall-service` removes it; the data stays):

* **Linux (systemd):** `sudo ./manga-shelf-server-linux-x64 install-service` copies the program to `/usr/local/bin/manga-shelf-server`, creates the user `manga-shelf`, uses `/var/lib/manga-shelf` (0750) and starts `manga-shelf.service`. Logs and setup code: `journalctl -u manga-shelf -n 50`. Without root: `install-service --user` (plus `loginctl enable-linger $USER` to run without a login); that service runs the program file where it lies and can update itself under System → Updates when that folder is yours.
* **Debian/Ubuntu/Fedora:** `sudo apt install ./manga-shelf-server_*_amd64.deb` or `sudo dnf install ./manga-shelf-server-*.rpm` sets up the same service; install a newer package to update (System → Updates shows the command for the version you pick). Removing the package keeps `/var/lib/manga-shelf`.
* **macOS (launchd):** `./manga-shelf-server-macos-universal install-service` creates the LaunchAgent `de.manga-shelf.server` (starts at login, restarts after a crash; the program stays where it is and can update itself under System → Updates when that folder is yours). Logs: `~/Library/Application Support/manga-shelf/logs/manga-shelf.log`.
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

Two more commands run only as a one-shot call, not in the console: `node scripts/admin.js wiederherstellen <backup.zip>` restores a backup into a stopped server, and `node scripts/admin.js db-check <file>` tests on a copy whether this version can open and migrate a database (the headless binary has them as the subcommands `restore` and `db-check`; [Updating](#updating)).

### Updating

As an admin, open **System → Updates** to see every published release. Where the server can replace itself (Pterodactyl, a headless binary installed under your own user), "Auf vX aktualisieren", or another version plus "Herunterladen und prüfen", downloads and checks the release in the background. You can close the dialog meanwhile, and "Abbrechen" discards the download. "Installieren" asks for your password again, creates a verified database backup and restarts the server. The page reloads by itself once the new version answers; after 3 minutes it shows where to look (panel console, journalctl, launchd log, or the start command). Everywhere else the card shows the exact command or download link for the chosen version.

Only newer versions can be installed with a click, and only releases from 3.1.0 on carry the signature the check needs (older ones show "ohne Signatur"). The step from 3.0.0 to 3.1.0 is therefore the last manual one for Pterodactyl servers and self-installed binaries; servers before 3.1.0 have no Updates card. The phone apps and the desktop app are updated separately from the server.

* **Pterodactyl** (recognised by the variable `P_SERVER_UUID` that the panel sets; the program folder must be writable): installs `pterodactyl-manga-shelf.zip` by itself. After the switch the server exits with code 75 and Wings starts it again like after a crash; if it stays stopped, press **Start** in the panel. The console shows `[Update] Neustart für Update auf vX (Exit 75 beabsichtigt)` first, and the panel console then shows a crash with exit code 75: that is intended. When a release changes the production dependencies, the start command has to install them (`npm install` or `npm ci`, as the egg does), otherwise the update is refused before anything changes. Only the files the ZIP ships are replaced; files the previous release listed in its `.manga-shelf-release.json` (3.1.0 and newer) and the new one no longer ships are moved aside, and `data/`, `node_modules/`, `.env`, `ssl/`, `uploads/` and files of your own are never touched.
* **Headless binary in a folder of your own** (the file belongs to the account that runs it, is not a link, cannot be changed by others and is not in a system folder such as `/usr/bin`, `/usr/local/bin` or `Program Files`): replaces the file. Started by systemd (`install-service --user`) or launchd (the macOS LaunchAgent) it exits with code 75 and the service manager starts the new file; started by hand (also on Windows) it exits cleanly after the switch and the page shows the command to start it again.
* **Everything else** shows the steps for the version you pick:
  * Linux service made with `sudo … install-service`: `curl -LO <download link> && chmod +x <file> && sudo ./<file> install-service` plus your usual options.
  * Debian/Ubuntu/Fedora packages: `curl -LO <download link> && sudo apt install ./<file>` or `sudo dnf install ./<file>`.
  * Windows task: download `manga-shelf-server-windows-x64.exe` and run `manga-shelf-server-windows-x64.exe install-service` in a command prompt as Administrator, with your usual options.
  * Any other binary you cannot change (system folder, another owner): replace the file as its owner and restart it.
  * Docker: `docker compose pull && docker compose up -d` for the newest release. For another version put the line `image: ghcr.io/lixnix-swap-org/manga-shelf:X.Y.Z` into `docker-compose.yml` and run `docker compose up -d`. Started with `docker run`: `docker pull ghcr.io/lixnix-swap-org/manga-shelf:X.Y.Z`, remove the container and run the same `docker run` command again with that tag.
  * Desktop app (also for a server it hosts): install the new version from the [releases](https://github.com/LixNix-Swap-Org/manga-shelf/releases).
  * From source: unpack `pterodactyl-manga-shelf.zip` of the release over the program files (`data/`, `.env` and `ssl/` stay) and run `npm ci --omit=dev`, or check out the tag (`git fetch --tags && git checkout vX.Y.Z`) and run `npm ci && (cd frontend && npm ci && npm run build)`; then restart.

**Private data folder.** Installing from the system page needs a private data folder: `DATA_DIR` must be a real folder (no symbolic link) owned by the user the server runs as and not writable by group or others (for example `chmod 700`; on Windows only the check for a link applies). Otherwise the page refuses with "Dieses Update kann auf diesem Server nicht installiert werden." and the console names the folder and the problem (`symlink`, `foreign_owner` or `shared_writable`). `temp/` and `temp/update/` inside it are created with 0700, and existing ones lose the write permission of group and others automatically.

**What is checked.** Before a downloaded file is written into place:

* It comes over HTTPS from `api.github.com`, `github.com`, `objects.githubusercontent.com` or `release-assets.githubusercontent.com` (at most three redirects, all to these hosts; addresses of the local network are refused; size limits apply).
* `SHA256SUMS.txt` carries a keyless Sigstore signature (`SHA256SUMS.txt.sigstore.json`) made by the release workflow `release.yml` on `main` of this repository: the signer identity, the issuer and the certificate's repository, owner, trigger, runner and branch are pinned. The Sigstore trust root comes from `tuf-repo-cdn.sigstore.dev` (cached in `<data folder>/cache/sigstore`).
* The signed sums contain the version marker `manga-shelf-release-vX.Y.Z.json`, which ties them to the chosen version, and the SHA-256 of the downloaded file has to match its line.
* The new files must fit the server: for the ZIP the version, the Node.js range, the syntax of `index.js` and `db.js` and the dependencies, for a binary a test run (`version`, and from 3.1.0 on `db-check` on a copy of the database).

If anything fails, nothing changes and the download is deleted. A successful check stays valid for 15 minutes. By hand (cosign v3), the same as in the release text:

```bash
cosign verify-blob SHA256SUMS.txt --bundle SHA256SUMS.txt.sigstore.json --certificate-identity https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum -c SHA256SUMS.txt --ignore-missing
```

A server trusts whatever the release workflow on `main` signs, so protecting `main` and that workflow is the maintainers' job. Before the first release with the updater (3.1.0) the maintainers set up three things: branch protection or a ruleset on `main` with at least one required approving review, the GitHub Environment `release` with required reviewers (Settings → Environments; limit its deployment branches to `main`), and immutable releases (Settings → General → Releases). The job `sign` runs in that environment, so nothing is signed before a reviewer approves the run, and the `version` job refuses `action: release` while `main` is unprotected or the environment has no required reviewers. A compromised maintainer account is outside what the check can catch.

**What "Installieren" does.** From the backup until the restart the server refuses every write request (503 `MAINTENANCE`; restoring and deleting backups answer 409 `UPDATE_RUNNING`), reading keeps working and everyone stays signed in:

1. The backup `backups/vor-update-v<old>-auf-v<new>-<time>.zip` (database only, verified, uploads stay) is written. It is kept until the new version has run for 10 minutes. If the new version still has database migrations to run, it writes its own `vor-update-…` backup with schema numbers at its first start.
2. The new files are put next to the old ones, the old server shuts down, and only then the files are switched (a journal makes a crash in between harmless: the next start completes or undoes the switch).
3. The server restarts as described above and counts the start. Ten minutes after a good start the previous files, the staging and the hold on the backup are removed.

If the new version does not come up, or crashes within 10 minutes of starting, the previous files are put back automatically (Pterodactyl at the first crash, binaries at the second). If the new version had already migrated the database, the backup from before the update is restored too; if it had already started by then, the database it wrote is kept in the data folder as `manga.db.v<version>-<time>` (with its `-wal` file), so changes made in those minutes are not lost. On Pterodactyl the console then says `[Update] vorherige Version wiederhergestellt – Server im Panel starten`: press **Start**. System → Updates shows the result and the name of the backup.

The exit codes of this process: 75 asks Wings, systemd or launchd for a restart (after the switch and after a rollback), 78 stands for a database from a newer version (below), and 74 means that a rollback was started and could not be finished. The console then says `[Update] Zurücksetzen auf vX unterbrochen: … – der nächste Start setzt es fort`, the server stops on purpose, and the next start finishes the rollback before the new version runs. If that line comes back after every start, check the file permissions in the code folder (for a binary: the folder it lies in).

**Going back.** The database only migrates forward, so there is no click for an older version. To return, the backup from before the update is the way (the file stays in `<data folder>/backups`; upload it in the Backups dialog if it is not listed):

1. Stop the server and install the old version the usual way (old ZIP, image tag or binary), but do not start it yet.
2. With the old version from 3.1.0 on, restore the backup while the server is stopped: `manga-shelf-server restore <backup.zip>` for the binary (plus `--data-dir <folder>` if you use one), `node scripts/admin.js wiederherstellen <backup.zip>` for the ZIP, from source and Docker (`docker compose run --rm manga-shelf node scripts/admin.js wiederherstellen <backup.zip>`). The file name from `backups/` is enough; the current database is saved as `vor-wiederherstellung-….zip` first. Then start the server.
3. With an old version before 3.1.0 (no offline restore) start it and at once restore the backup as an admin in the Backups dialog; change nothing before.

**Pterodactyl:** a stopped server has no shell, so the offline restore of step 2 cannot be run there. Install the old ZIP with the panel's file manager and, with an old version from 3.1.0 on, add the line `ALLOW_NEWER_SCHEMA=1` to `.env` in the server's folder (`/home/container/.env`) with the file manager. Start the server and restore the `vor-update-…zip` backup in the Backups dialog right away (your password is asked); change nothing before that. Then remove the line again.

Never run an old version permanently on the migrated database: what it writes (e.g. the old volume status "Gelesen") is not converted by a later update. Images in `uploads/` survive both directions.

**Database from a newer version.** From 3.1.0 on a server refuses to open a database written by a newer version: it logs `SCHEMA_NEWER` with the way out and exits with code 78 (a systemd unit made by `install-service` does not restart after it; the `.deb`/`.rpm` unit and the macOS LaunchAgent keep trying every few seconds until you act). Either install the newer version again, or restore the backup from before the update as above. Only if you know that this version can work with the newer database, start it once with `ALLOW_NEWER_SCHEMA=1` (and remove that afterwards). On Pterodactyl (`P_SERVER_UUID` set) the `SCHEMA_NEWER` message names the panel route instead of the shell commands: `.env` with `ALLOW_NEWER_SCHEMA=1`, then the Backups dialog ("Going back" above). A restore confirmed with "allow newer schema" (the Backups dialog or `--allow-newer-schema`) is remembered and lets the server start.

**Switches and connections.** `UPDATE_CHECK=false` hides the card and switches off every connection to GitHub; `UPDATE_INSTALL=false` keeps the list and the instructions but refuses downloading and installing ([section 5](#5-configuration)). The server contacts `api.github.com` (the release list), `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com` (downloads) and `tuf-repo-cdn.sigstore.dev` (Sigstore trust root, only when a release is verified), and only while an admin has System open or an update is being prepared. The release list is cached for an hour in `<data folder>/cache/releases.json`; after a failure "Erneut versuchen" asks again (at most six times in ten minutes), and a GitHub rate limit shows the time of the next try.

### Upgrading from v2.19.1

Read the admin notes of the 3.0.0 section in [`CHANGELOG.md`](CHANGELOG.md) first. In short:

* **Database migrations 12–27** run at the first start. Before any pending migration the server writes `data/backups/vor-update-v<old>-auf-v<new>-….zip`; if that fails (disk full, read-only folder) it does not start and changes nothing. `MIGRATE_WITHOUT_SNAPSHOT=1` migrates without it, once and deliberately.
* **Data changes:** migration 22 unifies known publisher spellings (e.g. "Carlsen Verlag GmbH" → "Carlsen Manga"); migration 27 turns series languages into ISO codes ("Deutsch" → `de`), sets the currency `EUR` on every series and sets an unrecognised language to `de`, named in the start log, so check those series afterwards.
* **Everyone signs in again once:** the session key moves to `data/secret.key`.
* **Setup code and `TRUST_PROXY`** are new: a server without an admin needs the code, and behind a proxy `TRUST_PROXY` has to name it ([HTTPS and reverse proxy](#https-and-reverse-proxy)).
* **Pterodactyl:** import the egg again. **Windows service:** run `install-service` again.
* **Scripts against the API:** `GET /api/stats` moved its key figures under `summary`, series languages are ISO codes, money totals add euro only. Details in the changelog.

**No downgrade.** There is no automatic way back; the steps with the `vor-update-…zip` backup are under "Going back" in [Updating](#updating).

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

* **Collection:** series and volumes with cover, publisher, price, release date, ISBN and notes; box sets, special editions and specials; a status per volume (Owned, Missing, Pre-ordered, Ordered, Coming soon); a collecting state per series (active, paused, dropped) apart from the publication status. The progress of a series counts its regular numbered volumes against the total; a series without a known total shows only the number of volumes, has no percentage and sorts last when sorting by completion.
* **Shelf:** series as a grid or a compact list; filters by status, publisher, collecting state (also gaps, pre-orders, complete), author, genres/tags and language, grouping by publisher, author or status, and sorting, kept in the URL. The search also finds ISBNs and notes. A "Continue reading" bar and selectable read dates. On the series page the volumes can also stand as spines on shelves.
* **Search the shelf and online:** the globe button in the search field (after the scanner, name "Also search online") switches between searching your collection only (the default) and searching your collection plus Manga Passion (German editions only) and AniList/MyAnimeList. The choice is stored per device. In the online mode the shelf still filters as you type; from three characters on, 600 ms after the last keystroke (or at once with Enter), up to ten online hits appear below the shelf, Manga Passion first, or in place of "No matches found" when the shelf has none. Each hit shows whether the series is already in your collection (with a link), another edition of it is (with its language) or a similar title exists (with a link). Editors add a hit with "Create": the add dialog opens prefilled, as after Auto-fill, and only needs a confirm, after which you land on the new series. In the collection-only mode, "Search online for “…”" below the shelf and in the empty panel runs one online search without changing the setting; in the empty panel editors also get "Create new series “…”", which opens the add dialog with the title. Guests can search online but not add. Offline nothing is looked up, and on the offline copy the globe button is hidden.
* **Several volumes at once:** select volumes and set status, owners or reading state together, with undo.
* **Add volumes in a range:** "Add several volumes" creates the regular volumes from one number to another. The dialog starts after your highest regular volume (box sets and special editions do not count) and proposes the range up to the known total, the larger of the stored total and the Manga Passion count, otherwise ten volumes, at most 300. An empty publisher field takes the series publisher; for a German series linked to Manga Passion, prices and release dates of the new volumes are filled in afterwards (empty fields only).
* **Manga Passion:** take over a series by link or search, detect missing volumes, fill in data and covers, load genres, track release date changes. German editions only. Volumes that are announced but not released yet are no gaps: the gap banner counts them separately as announced, "All to shopping list" never adds them, and their placeholder stays on the shelf so you can pre-order them. That button adds the regular volumes only; special editions and box sets have a button of their own.
* **ISBN lookup** via DNB, K10plus and Google Books, covers via Open Library.
* **Shopping list and shop mode:** every missing and pre-ordered volume grouped by publisher; share, copy or print it. In the shop the barcode scanner checks volume after volume: to buy, already owned (and by whom), or missing. "Bought" works offline and is sent later. The live camera needs HTTPS; the apps use the native scanner.
* **Release radar:** new releases per month from the Manga Passion calendar, your pre-orders and changed release dates.
* **Calendar feed (iCal):** release radar → "Subscribe to calendar" → "Create subscription address". Every volume with an exact release day becomes an all-day event. The address carries its own key; a new address, "End all sessions", a password change or a password reset end the old one. Google Calendar fetches the feed from its own servers, so the server has to be reachable from the internet for that.
* **Wishlist:** series with priority and target price, their own section in the shopping list, a badge in the calendar, a shelf filter.
* **Anime tab:** one shared list (seasons and films separately), progress per person (episodes, status, rating, note), search via AniList and MyAnimeList, countdown to the next episode, link to the matching manga series, CSV export.
  * **Status and counter:** a newly added anime is "Planned" for the person who added it. Choosing "Planned" sets the episode counter back to 0, a counter above 0 turns "Planned" into "Watching", and adding an episode (or lowering the counter) on a "Watched" entry sets it back to "Watching" unless the counter reaches the known episode count. The finish date is cleared when an entry leaves "Watched". "Watched" cannot be chosen while a series is still airing or not out yet; it is set by itself when the counter reaches a known episode count. A running series without an episode count shows the episodes aired so far once its next airing is confirmed (for example 12 / 1180+). "Remove from my list" can be undone from the notice.
  * **Share links:** share a Crunchyroll episode to Manga Shelf (share sheet of the installed web app, the Android share dialog, the iOS share extension in the apps, or "Paste link"). After "Yes, watched" your progress rises, never backwards, with undo.
  * **"Continue on Crunchyroll"** opens the next episode (in the apps the Crunchyroll app when installed).
  * **AniList list sync** (optional, account → sources, needs your own AniList key): the higher episode count wins.
  * **Refresh:** the "Refresh" button in the toolbar (browser, desktop app and apps) reloads the list. For editors it also runs the AniList list sync and, where a Crunchyroll history is connected, reads that history first. The notice says how many series changed ("Nothing new" otherwise); a run right after another one answers "Just synced – available again in N s". Editors also see when the Crunchyroll history was last imported and from which device.
  * **Crunchyroll history** (desktop app and phone apps, experimental): see [Crunchyroll history](#crunchyroll-history-experimental). It can also add shows you start on Crunchyroll to the shared list.
* **Statistics:** spending by purchase date, ownership per person, most valuable series, publishers, reading history over 24 months, series and volumes per language, anime figures (the status tiles count your own list). Totals add euro prices only and list other currencies beside them. The collecting time starts at the earliest purchase or creation date unless an admin sets the start date by hand; a hand-set date is marked, and the date form has a button to go back to the automatic start.
* **CSV:** export and import of the whole collection with a dry run (owners, reading state, wishlist, editions included). The import accepts German or English headers.
* **Backups and restore** (admins): see [section 6](#backups-and-restore).
* **Trash:** deleted series and volumes can be restored for 30 days (statistics dialog → Trash).
* **Tidy up:** "Merge publishers" unifies spellings, editable tags, "Tidy up collection" lists incomplete or contradictory entries with one-click fixes.
* **Users and roles:** Admin, Editor, Guest; "End all sessions"; "Connect with app" shows a QR code for the phone apps.
* **System page** (admins): version, releases and updates ([Updating](#updating)), storage, database, backups, orphaned images, load of the external sources.
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

In "Dieses Gerät ist Server" the desktop web build is also what browsers in the home network load. Their service worker, like the one in the Electron window, precaches the Crunchyroll chunks. Without `window.mangashelfDesktop.watch` they stay inert: there is no card and no request. The Crunchyroll history of the desktop app is described under [Crunchyroll history](#crunchyroll-history-experimental).

The app sets and shows the setup code (File → "Einrichtungscode anzeigen…"). To move from "only this device" to a server, download the backup ZIP and restore it on the server. Command line: `--server-only`, `--port <n>`, `--host <address>`, `--data-dir <folder>`, `--connect <url>`, `--hidden`, `--user-data-dir <folder>`. There are no automatic updates: under System → Updates admins see the new versions and the download link.

Unsigned builds: macOS "cannot be opened" → right click → Open (or `xattr -dr com.apple.quarantine "/Applications/Manga Shelf.app"`); Windows SmartScreen → "More info" → "Run anyway"; Linux AppImage needs `chmod +x`.

### Android and iPhone

* **Android:** open `manga-shelf-<version>-android.apk` on the phone and allow installing from unknown sources. Without a release keystore the APK carries the debug key (sideloading only); a later update with the real key needs one uninstall, so export a backup in the app first. The `.aab` is for the Play Store (`-android-unsigned.aab` without the keystore).
* **iPhone/iPad:** sign `manga-shelf-<version>-ios-unsigned.ipa` yourself with AltStore, Sideloadly or Xcode and your Apple ID (seven days with a free account, then sign again). With certificates in the release there is a signed `manga-shelf-<version>-ios.ipa` instead. Re-signed builds may lose the share extension's App Group; then "Paste link" is the way to share episodes.
* **First start:** "Use without a server" (collection only on the device), enter a server address, or scan the "Connect with app" QR code (footer of the web app, or the desktop app in server mode) with "QR-Code scannen" on the server screen of the app.
* **Server addresses:** `https://…` anywhere, `http://…` only in the home network (private ranges, Tailscale `100.64.0.0/10`, names ending in `.local`, `.lan`, `.fritz.box`, `.home.arpa`, `.internal`).
* **Minimum versions:** Android 6, iOS 15.5.
* **Device backups:** Android keeps the app's collection and images out of cloud backup and device transfer. On iPhone/iPad they live in the app's data folder, which iCloud and device backups still include. On both, the ZIP backup of the app is the reliable way.

### Use without a server

"Use without a server" keeps the collection on the phone: a local profile (name, no password; more profiles for ownership and reading per person), the same database schema as the server, online lookups straight from the device (Manga Passion, DNB/K10plus/Google Books, AniList/MyAnimeList) and your own API keys in the device's secure storage. Server-only parts are missing: user management, server backups, system page, console.

The collection exists only on that device. Export a backup ZIP regularly and keep it elsewhere: Android does not back up the app data, and on iPhone/iPad iCloud includes it only as part of the whole device backup.

Under **Server** you find "Export backup"/import (ZIP in the server's backup format) and three takeover paths:

| Path | When | What happens |
|---|---|---|
| **Transfer to server** | a new, freshly set up server | sign in as admin (that password confirms the restore); the app sends its collection with covers as a backup, the server shows its figures first and warns when it already holds data; the local profile becomes that admin account |
| **Merge** | a server with its own collection | series and volumes are added via CSV (dry run with preview first); ownership and reading go to the signed-in user; covers are not transferred |
| **Fetch from server** | a server collection onto the phone | as admin the full backup with covers, otherwise the offline copy; replaces the collection on the device; passwords, API keys and calendar keys of server accounts never stay on the device |

There is no continuous sync between a standalone collection and a server; whoever wants both connects the app to the server (offline copy and queued changes included).

### Away from home

Without a public address the server at home is not reachable on the road. The app (and the web app installed over HTTPS) then shows the offline copy: reading and searching work, editors and admins can toggle ownership and reading state and tick off purchases; these changes are sent once the server is reachable again. Creating, editing, the radar, statistics and online lookups need the connection. For real access on the road:

* a **public HTTPS address** ([HTTPS and reverse proxy](#https-and-reverse-proxy)), added in the app under "Server" as another address of the same server; the app then uses the first one that answers;
* a **VPN** such as Tailscale or WireGuard: the home address is reachable everywhere without exposing the server; Tailscale addresses count as home network and may use `http://`.

### Crunchyroll history (experimental)

Desktop app (macOS, Windows, Linux) and phone apps only, never in a browser; off by default, editors and admins. The card "Crunchyroll history (experimental)" (account → keys, without a server under "Sources & keys") signs in to Crunchyroll after a warning; the password is typed into Crunchyroll's own page. The app reads the history only while it is open in the foreground (about every 15 minutes, and on "Sync now" or the refresh button) and sends the server only the matched items (series ID, title and slug, season, episode, watched state and time, next-episode link), the device type and the series you skipped on this device, never cookies, tokens or the raw history. It uses an unofficial interface whose terms forbid automated access, which is why store builds can switch it off (see below). Details: [`AGENTS.md`](AGENTS.md).

* **Phone apps:** an embedded login sheet. The Crunchyroll session (refresh cookie, client, device and account ID) stays only in the secure storage of the device (no iCloud, no device transfer) and survives a switch of the server.
* **Desktop app:** a sign-in window of its own that shows only `crunchyroll.com` pages (anything else is refused with a notice) and is wiped when it closes. The login is kept in its own encrypted file, `watch-secret.json` in the app's user folder (separate from `secure-store.json`, mode 0600), and its cookie never reaches the page: the main process reads the history itself, with requests that carry no browser cookies and follow no redirects. It syncs only while the window is visible and in focus and the computer is neither idle nor locked, and once after waking from sleep (macOS and Windows) when the screen is unlocked. The protection and its limits per system are listed under [Security model](#security-model).
* **Linux:** the desktop app needs a real key store, GNOME Keyring (libsecret) or KWallet. If Chromium does not recognise your desktop environment, start Manga Shelf with `--password-store=gnome-libsecret`. Without a key store the card shows the note and offers no sign-in.
* **Automatic adding:** a show you start on Crunchyroll is added to the shared list when it is not in it yet. "Starting" means an episode of the last seven days, including an episode 1 you have not finished. The server looks the title up at AniList (your own key first, then the shared pool, only clear matches of the right season) and adds the entry with your progress; at most three shows per sync, ten AniList requests and five new entries per hour and person, and nothing is added while the lookup limit is reached. A notice "Added to the list: …" with "Undo" (shown for 15 seconds, accepted by the server for an hour) takes it back: the entry goes when nobody else has progress on it, otherwise only your progress. With your AniList list sync on, a new entry reaches AniList only after 60 seconds, so an undo inside that minute never reaches it. The switch "Automatically add new shows from the history to the shared list" is in the card, per person and on by default; with it off (or without AniList in `ANIME_SOURCES`) the server makes no lookups, so the match dialog has no suggestions under "Not in the list yet". A show you removed with "Remove from my list", or an entry deleted for everyone (which also covers everyone it was added for), is not added again; matching it by hand in the dialog or undoing the removal lifts that.
* **Match dialog:** series the history cannot place are offered with the matching entries of your list and, below "Not in the list yet", up to three AniList suggestions ("Create: …"); "Search for another anime…" opens the add dialog and uses what you pick. A shared Crunchyroll link whose series is not in the list offers "Create and mark as watched" in the share dialog when AniList names exactly one entry for it.
* **Switching it off:** the repository variable `WATCH_CRUNCHYROLL` = `off` removes the card, the dialog and the sync from the app and the desktop installers; locally `VITE_WATCH_CRUNCHYROLL=off npm run build:android` (or `build:ios`, or `build:desktop` in `desktop/`).

## 5. Configuration

Every variable is optional. Sources in order of priority: the command line of the headless server (`--port`, `--host`, `--data-dir`), the environment (Pterodactyl startup tab, Docker `environment`), a `.env` in the working directory (headless server: in the data folder; `scripts/admin.js`: next to `index.js`). `.env.example` comments every value. An unusable value logs a warning at startup and the default applies; only an invalid port, an invalid `TRUST_PROXY`, an unreadable `secret.key`, a pre-update backup that cannot be written, a database written by a newer version (exit code 78) and, for the headless server, a `.env` others may change stop the start.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port of the server. `SERVER_PORT` (set by Pterodactyl) wins. |
| `DATA_DIR` | `data/` in the app folder (Docker `/app/data`) | Database, images, backups, `secret.key`. |
| `TRUST_PROXY` | `loopback` | Whose `X-Forwarded-For` counts: `false`, `loopback`, addresses or subnets such as `loopback, 172.18.0.1`, a hop count or `true` ([HTTPS and reverse proxy](#https-and-reverse-proxy)). |
| `RATE_LIMIT_UMBRELLA` | `1200` | General request limit per client and minute for `/api` (web app files 2.5 times, covers under `/uploads` 20 times as many; 0 to 100000); above it 429 with `Retry-After`; `0` switches it off. The login, setup and lookup limits stay. |
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
| `UPDATE_CHECK` | `true` | The system page asks GitHub for the published releases (list cached for an hour), only while an admin has it open. `false` removes the update card and every connection to GitHub. |
| `UPDATE_INSTALL` | `true` | Install updates from the system page (Pterodactyl, headless binary in your own folder). `false` keeps the list and the manual instructions but refuses downloading and installing (403 `UPDATE_INSTALL_OFF`). |
| `LOG_LEVEL`, `LOG_FORMAT` | `info`, `text` | `debug`/`info`/`warn`/`error`/`silent`; `json` for log tools. |
| `ANIME_ANILIST_RPM`, `ANIME_JIKAN_RPM` | `30`, `60` | Requests per minute of the shared AniList and Jikan access (1 to 600). |
| `ANIME_SOURCES` | `anilist,jikan` | Active anime sources (`jikan` or `mal` stands for MyAnimeList); unknown names are ignored with a warning. Without `anilist` the Crunchyroll history adds no shows by itself. |
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

`DATA_DIR` holds `manga.db` (SQLite, WAL), `uploads/` (images), `backups/` (snapshots), `secret.key`, `cache/` (release list and Sigstore trust root of the updater, safe to delete), `temp/` (staging; during an update `temp/update/`), the journal `update-state.json` of the last in-app update and, for the headless server, `.env`, `ssl/` and `logs/`. Copying the whole folder while the server is stopped moves everything, the secret included.

### Backups and restore

As an admin under **Backups**:

* **Automatic:** every day at `BACKUP_HOUR` (default 3, time zone `BACKUP_TIMEZONE`) a verified snapshot in `data/backups/`. Kept per kind: 7 daily, 10 manual, 3 before an update (`BACKUP_KEEP_*`; the backup an update still needs is never removed before the update is confirmed).
* **Create a snapshot** (or `backup` in the console) and **download a ZIP** directly: `manga.db` plus every image from `uploads/`.
* **Restore** from a snapshot or an uploaded ZIP (up to 500 MB). The server checks the archive first and shows its content; it swaps only after confirmation, which asks for your current password because a restore replaces every account and its password (a wrong entry counts toward the sign-in lock; scripts send it as `current_password`). A `vor-wiederherstellung-*` snapshot is taken before, so the restore can be undone. Every other session ends.
* **Secret:** `secret.key` is in no backup. Stored API keys are encrypted with it, so after restoring on another server they have to be entered again.
* **Backup from the app:** a server collection fetched into the app, or imported there from a server ZIP, holds no passwords any more. When that app ZIP is restored on a server, the check names the accounts without a password; they need a password reset: another admin sets one in the user management, or the console command `passwort-reset <name>` does. Your own password cannot be changed without its current one, so if your account is among them and nobody else can sign in, only the console helps. Into a server with a collection of its own, use "Merge" (CSV) instead of a restore.
* Deleted something after the last backup? Look in the trash first (30 days).
* Going back to an older version: see "Going back" in [Updating](#updating).

### Security model

* **Sessions:** a JWT in the `httpOnly` cookie `token` (browser) or as a bearer token (apps), valid 7 days, checked against the database on every request. Logout blocks the token; a password change, a password reset, "End all sessions" and a restore end sessions. The signing key is `JWT_SECRET` or `<DATA_DIR>/secret.key` (0600).
* **First setup** only with the setup code; afterwards it has no effect.
* **Origin check:** writing API requests a browser sends from another origin are rejected; CORS only for `CORS_ORIGIN` and the app origins. Security headers include a CSP, Permissions-Policy, COOP and HSTS over HTTPS.
* **Rate limits** per address and per account (brute-force protection without locking out the admin) and per-account limits for external lookups. They depend on correct client addresses, hence `TRUST_PROXY`. A general limit per client in front of every route (`RATE_LIMIT_UMBRELLA`, default 1200 API, 3000 web app and 24000 cover requests per minute) is a flood guard; it is set high enough that clients sharing one address behind a proxy, or an app taking over a large collection, do not reach it.
* **Uploads:** images up to 15 MB, checked by magic bytes, EXIF/GPS stripped, random file names, a CSP of their own under `/uploads`; image downloads from URLs are SSRF-safe.
* **Updates:** only admins, and the install asks for the current password again (cookie and bearer alike; wrong entries count toward the sign-in lock of the account). Nothing is installed that is not signed by this repository's release workflow ([Updating](#updating)); one update at a time, writes are refused while it runs. Restoring a backup, changing your own account and creating or promoting an admin in the user management ask for your current password as well (scripts send it as `current_password`).
* **Headless server:** refuses a `.env` others can change; Linux data folder 0750 and `UMask=0027`, Windows service as LOCAL SERVICE with a protected ACL.
* **Apps:** tokens and API keys in the system keychain or keystore; plain `http://` only to home-network addresses.
* **Desktop app, Crunchyroll history:** the login is kept in its own encrypted file (`watch-secret.json`, separate from `secure-store.json`, mode 0600 where the system has file modes), and its cookie never reaches the page. On macOS, Windows and Linux the encryption protects against other OS users and against reading the disk offline. On Windows and Linux it does not protect against other processes of the same user. Linux needs GNOME Keyring or KWallet ([Crunchyroll history](#crunchyroll-history-experimental)).

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
| `npm test` | backend tests (`node:test`: `test/`, `test/core/`, `test/anime/`, `test/update/`) |
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

**Desktop:** `cd desktop && npm ci && npm run build:desktop` (installers in `desktop/dist/installers/`; unsigned unless signing variables such as `CSC_LINK` or `APPLE_ID` are set), `npm start` for development, `npm test`. For `npm start` with the Crunchyroll card, build the web part with `npm run build -- --mode desktop` (in `frontend/`); `npm run build:desktop` and `build:dir` do this themselves, and the stage stops when the web build has no Crunchyroll card, unless `VITE_WATCH_CRUNCHYROLL=off` is set. `npm run test:electron` runs the gate test of the Crunchyroll transport inside Electron (CI: the Linux smoke job, under `xvfb-run`).

**Android/iPhone:** `cd frontend && npm ci`, then `cd mobile && npm ci && npm run build:android` (JDK 21, Android SDK 35) or `npm run build:ios` (macOS, Xcode 16+, CocoaPods). Output in `mobile/build/out/`. After changing the version by hand run `npm run version:sync` (`release.js` and the Release workflow do it themselves).

### Release workflow

* **Every pull request and every push to `main`** runs `ci.yml` (lint, tests on Node 22.13.0/22/24, frontend build and budget, ZIP install check, Docker build, browser suites) and `build.yml`: artifacts for 14 days (Pterodactyl ZIP with SBOM, server binaries and packages; desktop installers and the phone smoke builds of `mobile.yml`, a debug APK and the simulator app for 7 days, not for Dependabot's pull requests). A branch without a pull request gets no run of its own. Nothing is published. `codeql.yml` is wired for `main`, pull requests and a weekly run, but code scanning only works once the repository is public; while it is private the job is skipped.
* **Build by button:** Actions → **Build** → **Run workflow** on any branch builds every artifact (unsigned, nothing published; the desktop installers can be switched off); Actions → **Mobile** → **Run workflow** builds only the apps (`smoke`: debug APK and simulator app, `build`: APK/AAB and IPA).
* **Publishing only by button:** Actions → **Release** → **Run workflow**, pick the branch and `action`:
  * `build`: build everything (signed when the secrets exist), publish nothing;
  * `release`: bump the version (`bump` = `patch`/`minor`/`major`; `none` takes the version from `package.json`, its tag must not exist), commit and tag `vX.Y.Z` (only when `main` is protected and the environment `release` has required reviewers, otherwise the run stops before anything is committed), build everything including the apps, push the image to GHCR with `X.Y.Z` and `vX.Y.Z`, write the version marker `manga-shelf-release-vX.Y.Z.json` and `SHA256SUMS.txt` and sign the sums and the image keyless with Sigstore (job `sign`, which waits for the approval of the `release` environment; `SHA256SUMS.txt.sigstore.json` is checked with the server's own verifier before anything is published, and the image signature is the last step and does not stop the release), create the GitHub release with all files, the signed sums and generated notes; only then do `X.Y` and `latest` move to that image. A failed run never moves `latest`; a pushed tag alone publishes nothing.
* **Locally:** `node release.js minor --dry-run` shows the next version, `node release.js minor` (or `patch`, `major`, `X.Y.Z`) needs a clean tree and a free tag and sets it in every `package.json`/`package-lock.json` and the native Android/iOS projects, without commit, tag or push; then commit, push and run the workflow with `bump = none`.
* **Once:** protect `main` with a required review, create the environment `release` with required reviewers and turn on immutable releases ([Updating](#updating)). A fine-grained PAT with `Contents: Read and write` goes in as the secret `RELEASE_TOKEN`; with a required review on `main` it has to belong to an account allowed to bypass that rule (classic protection: an admin with bypassing allowed; ruleset: the bypass list), because the `tag` job pushes the version commit directly. Set the GHCR package `manga-shelf` to public after the first release. While the repository itself is private, release downloads and the image are reachable only for collaborators, System → Updates gets no data and the `sign` job refuses to run; make the repository public for end users.
* **Recovery:** `release` pushes the version commit and the tag before it builds; if a later job fails, use **Re-run failed jobs** on that run (a fresh run would need the next version). If the `sign` job fails after the tag exists, open the run and use "Re-run failed jobs": `sign` and `publish` run again, nothing was published (the image only has its fixed `X.Y.Z`/`vX.Y.Z` tags, `latest` did not move). The sign job refuses to run for a private repository, because a keyless signature writes the repository name into the public Rekor log. `release` only runs from the default branch; `build` runs from any branch.
* **Update list:** servers from 3.1.0 on read the published releases of `LixNix-Swap-Org/manga-shelf` (tags `vX.Y.Z`, no drafts or pre-releases), older servers read `releases/latest`; never publish releases as pre-releases.
* **Admin notes:** a `### Before updating` block inside the CHANGELOG section `## X.Y.Z` is copied by `scripts/release/notes.js` to the top of the release text (it ends at the next heading) and shown by System → Updates in the confirm step. The section has to be on `main` before the release is dispatched.

**Signing** (repository secrets; missing groups are built unsigned):

| Secret | Content |
|---|---|
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Windows code signing certificate (`.pfx`, base64) and password |
| `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | "Developer ID Application" certificate (`.p12`, base64) and password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarisation |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Android release keystore (keep it safe: a lost key means a new app ID in the store) |
| `IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64` | iOS distribution certificate and provisioning profile (with `APPLE_TEAM_ID`) |
| `IOS_SHARE_PROVISIONING_PROFILE_BASE64` | optional: profile of the share extension `de.mangashelf.app.ShareToMangaShelf` (App Group `group.de.mangashelf.app` on both App IDs); without it the signed IPA has no share extension |

base64 of a file: `base64 -i file.p12 | pbcopy` (macOS) or `base64 -w0 file.p12` (Linux). The repository variable `WATCH_CRUNCHYROLL` = `off` removes the Crunchyroll history from the app and desktop builds.

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
