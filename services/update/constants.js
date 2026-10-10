const REPOSITORY_URL = 'https://github.com/LixNix-Swap-Org/manga-shelf';
const API_BASE = 'https://api.github.com/repos/LixNix-Swap-Org/manga-shelf';
const DOWNLOAD_BASE = 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/download/';
const RELEASE_PAGE_BASE = 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/';
const REPOSITORY_ID = '1403549029';
const OWNER_ID = '300401444';

const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const SIGNER_IDENTITY = 'https://github.com/LixNix-Swap-Org/manga-shelf/.github/workflows/release.yml@refs/heads/main';
const SIGNER_IDENTITY_PATTERN = '^https://github\\.com/LixNix-Swap-Org/manga-shelf/\\.github/workflows/release\\.yml@refs/heads/main$';

const FULCIO_PINS = Object.freeze({
    '1.3.6.1.4.1.57264.1.8': OIDC_ISSUER,
    '1.3.6.1.4.1.57264.1.11': 'github-hosted',
    '1.3.6.1.4.1.57264.1.12': REPOSITORY_URL,
    '1.3.6.1.4.1.57264.1.14': 'refs/heads/main',
    '1.3.6.1.4.1.57264.1.15': REPOSITORY_ID,
    '1.3.6.1.4.1.57264.1.17': OWNER_ID,
    '1.3.6.1.4.1.57264.1.20': 'workflow_dispatch'
});

const BUNDLE_MEDIA_TYPES = Object.freeze([
    'application/vnd.dev.sigstore.bundle.v0.3+json',
    'application/vnd.dev.sigstore.bundle+json;version=0.3'
]);

const ALLOWED_HOSTS = Object.freeze([
    'api.github.com',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com'
]);
const TUF_HOST = 'tuf-repo-cdn.sigstore.dev';

const SUMS_NAME = 'SHA256SUMS.txt';
const BUNDLE_NAME = 'SHA256SUMS.txt.sigstore.json';
const markerName = (version) => `manga-shelf-release-v${version}.json`;
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_PATTERN = new RegExp(`^${markerName('\0').split('\0').map(escapePattern).join('.*')}$`);
const ZIP_ASSET = 'pterodactyl-manga-shelf.zip';
const RELEASE_MANIFEST = '.manga-shelf-release.json';
const SEA_ASSETS = Object.freeze({
    'linux-x64': 'manga-shelf-server-linux-x64',
    'linux-arm64': 'manga-shelf-server-linux-arm64',
    'win32-x64': 'manga-shelf-server-windows-x64.exe',
    'darwin-x64': 'manga-shelf-server-macos-universal',
    'darwin-arm64': 'manga-shelf-server-macos-universal'
});

const MB = 1024 * 1024;
const MAX_ASSET_BYTES = 512 * MB;
const MAX_SMALL_BYTES = 64 * 1024;
const MAX_API_BYTES = 2 * MB;

const STAGING_TTL_MS = 15 * 60 * 1000;
const CONFIRM_AFTER_MS = 10 * 60 * 1000;
const RELEASES_TTL_MS = 60 * 60 * 1000;
const EXIT_RESTART = 75;
const EXIT_ROLLBACK_PENDING = 74;
const STATE_FORMAT = 1;
const STATE_FILE = 'update-state.json';

module.exports = {
    REPOSITORY_URL, API_BASE, DOWNLOAD_BASE, RELEASE_PAGE_BASE, REPOSITORY_ID, OWNER_ID,
    OIDC_ISSUER, SIGNER_IDENTITY, SIGNER_IDENTITY_PATTERN, FULCIO_PINS, BUNDLE_MEDIA_TYPES,
    ALLOWED_HOSTS, TUF_HOST, SUMS_NAME, BUNDLE_NAME, markerName, MARKER_PATTERN, ZIP_ASSET, RELEASE_MANIFEST, SEA_ASSETS,
    MB, MAX_ASSET_BYTES, MAX_SMALL_BYTES, MAX_API_BYTES,
    STAGING_TTL_MS, CONFIRM_AFTER_MS, RELEASES_TTL_MS, EXIT_RESTART, EXIT_ROLLBACK_PENDING, STATE_FORMAT, STATE_FILE
};
