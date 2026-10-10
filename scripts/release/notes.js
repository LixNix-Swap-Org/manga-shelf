#!/usr/bin/env node
// node scripts/release/notes.js vX.Y.Z  → release text (downloads, checksums, signing state from the secrets
// in the environment); GitHub appends the generated change list.
const fs = require('fs');
const path = require('path');
const { detectSigning, notes } = require('./signing');
const { SUMS_NAME, BUNDLE_NAME, markerName, OIDC_ISSUER, SIGNER_IDENTITY } = require('../../services/update/constants');

const PTERODACTYL_UPDATE = 'upload the new `pterodactyl-manga-shelf.zip` in the File Manager, unpack it and overwrite the existing files (delete nothing beforehand; `data/`, `.env` and `ssl/` stay), then restart the server.';
const SYSTEM_PAGE_UPDATE = '**Update from the system page:** servers from v3.1.0 on install this release under System → Updates (Pterodactyl and self-installed headless binaries; signature checked). Docker, packages, the desktop app and older servers update as below.';
const BEFORE_UPDATING = '### Before updating';
const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');

function readChangelog(file = CHANGELOG) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return '';
        throw e;
    }
}

/** Body of the `### Before updating` block in the CHANGELOG section `## X.Y.Z` (trimmed), '' when there is none. */
function beforeUpdating(changelog, version) {
    const lines = String(changelog || '').split(/\r?\n/);
    const heading = new RegExp(`^## v?${String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    const start = lines.findIndex(line => heading.test(line));
    if (start < 0) return '';
    const next = lines.findIndex((line, i) => i > start && /^#{1,2} /.test(line));
    const section = lines.slice(start + 1, next < 0 ? lines.length : next);
    const from = section.findIndex(line => line.trim() === BEFORE_UPDATING);
    if (from < 0) return '';
    const to = section.findIndex((line, i) => i > from && /^#{1,3} /.test(line));
    return section.slice(from + 1, to < 0 ? section.length : to).join('\n').trim();
}

function verifyCommand() {
    return `cosign verify-blob ${SUMS_NAME} --bundle ${BUNDLE_NAME} --certificate-identity ${SIGNER_IDENTITY} --certificate-oidc-issuer ${OIDC_ISSUER}`;
}

function releaseNotes(tag, env = process.env, repository = env.GITHUB_REPOSITORY || 'LixNix-Swap-Org/manga-shelf', changelog = readChangelog()) {
    const version = tag.replace(/^v/, '');
    const image = `ghcr.io/${repository.toLowerCase()}`;
    const adminNotes = beforeUpdating(changelog, version);
    return [
        ...(adminNotes ? [BEFORE_UPDATING, adminNotes, ''] : []),
        '### Downloads',
        `- ${SYSTEM_PAGE_UPDATE}`,
        `- **Pterodactyl:** ${PTERODACTYL_UPDATE}`,
        `- **Docker:** \`docker compose pull && docker compose up -d\` (image \`${image}:${version}\`, also \`latest\`).`,
        '- **Headless server:** `manga-shelf-server-linux-x64`, `-linux-arm64`, `-windows-x64.exe`, `-macos-universal`; for Debian/Ubuntu and Fedora/RHEL the packages `manga-shelf-server_*.deb` / `manga-shelf-server-*.rpm` (systemd service).',
        '- **Desktop app:** Windows installer (`*-setup*.exe`) or portable `.exe`, macOS `.dmg`, Linux AppImage, `.deb`, `.rpm`.',
        '- **Phone:** Android APK, iPhone IPA.',
        '',
        `Checksums: \`${SUMS_NAME}\` (\`sha256sum -c ${SUMS_NAME} --ignore-missing\`), signed keyless with Sigstore by this repository's release workflow: bundle \`${BUNDLE_NAME}\`, version marker \`${markerName(version)}\`. Check the signature first (cosign v3):`,
        '',
        '```sh',
        verifyCommand(),
        '```',
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

module.exports = { releaseNotes, beforeUpdating, verifyCommand, PTERODACTYL_UPDATE, SYSTEM_PAGE_UPDATE, BEFORE_UPDATING };
