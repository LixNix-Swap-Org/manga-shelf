#!/usr/bin/env node
// node scripts/release/notes.js vX.Y.Z  → German release text (downloads, checksums, signing state from the secrets
// in the environment); GitHub appends the generated change list.
const { detectSigning, notes } = require('./signing');

// README §2 repeats this sentence word for word (test/docs.test.js)
const PTERODACTYL_UPDATE = 'neue `pterodactyl-manga-shelf.zip` im File Manager hochladen, entpacken und vorhandene Dateien überschreiben (vorher nichts löschen; `data/`, `.env` und `ssl/` bleiben), dann den Server neu starten.';

function releaseNotes(tag, env = process.env, repository = env.GITHUB_REPOSITORY || 'LixNix-Swap-Org/manga-shelf') {
    const image = `ghcr.io/${repository.toLowerCase()}`;
    return [
        '### Downloads',
        `- **Pterodactyl:** ${PTERODACTYL_UPDATE}`,
        `- **Docker:** \`docker compose pull && docker compose up -d\` (Image \`${image}:${tag.replace(/^v/, '')}\`, auch \`latest\`).`,
        '- **Server ohne Oberfläche:** `manga-shelf-server-linux-x64`, `-linux-arm64`, `-windows-x64.exe`, `-macos-universal`; für Debian/Ubuntu und Fedora/RHEL die Pakete `manga-shelf-server_*.deb` / `manga-shelf-server-*.rpm` (systemd-Dienst).',
        '- **Desktop-App:** Windows-Installer (`*-setup*.exe`) oder portable `.exe`, macOS `.dmg`, Linux AppImage, `.deb`, `.rpm`.',
        '- **Handy:** Android-APK, iPhone-IPA.',
        '',
        'Prüfsummen: `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt --ignore-missing`).',
        '',
        notes(detectSigning(env)),
        ''
    ].join('\n');
}

if (require.main === module) {
    const tag = process.argv[2];
    if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) {
        process.stderr.write('Aufruf: node scripts/release/notes.js vX.Y.Z\n');
        process.exit(2);
    }
    process.stdout.write(releaseNotes(tag));
}

module.exports = { releaseNotes, PTERODACTYL_UPDATE };
