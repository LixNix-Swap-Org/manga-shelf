#!/usr/bin/env node
// node scripts/release/notes.js vX.Y.Z  → release text (downloads, checksums, signing state from the secrets
// in the environment); GitHub appends the generated change list.
const { detectSigning, notes } = require('./signing');

const PTERODACTYL_UPDATE = 'upload the new `pterodactyl-manga-shelf.zip` in the File Manager, unpack it and overwrite the existing files (delete nothing beforehand; `data/`, `.env` and `ssl/` stay), then restart the server.';

function releaseNotes(tag, env = process.env, repository = env.GITHUB_REPOSITORY || 'LixNix-Swap-Org/manga-shelf') {
    const image = `ghcr.io/${repository.toLowerCase()}`;
    return [
        '### Downloads',
        `- **Pterodactyl:** ${PTERODACTYL_UPDATE}`,
        `- **Docker:** \`docker compose pull && docker compose up -d\` (image \`${image}:${tag.replace(/^v/, '')}\`, also \`latest\`).`,
        '- **Headless server:** `manga-shelf-server-linux-x64`, `-linux-arm64`, `-windows-x64.exe`, `-macos-universal`; for Debian/Ubuntu and Fedora/RHEL the packages `manga-shelf-server_*.deb` / `manga-shelf-server-*.rpm` (systemd service).',
        '- **Desktop app:** Windows installer (`*-setup*.exe`) or portable `.exe`, macOS `.dmg`, Linux AppImage, `.deb`, `.rpm`.',
        '- **Phone:** Android APK, iPhone IPA.',
        '',
        'Checksums: `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt --ignore-missing`).',
        '',
        notes(detectSigning(env), env),
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
