process.env.LOG_LEVEL = 'silent';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const github = require('../../services/update/github');
const version = require('../../services/update/version');
const h = require('../fixtures/update/helpers');

const DL = 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/download/';
const asset = (tag, name) => ({ name, size: 10, browser_download_url: `${DL}${tag}/${name}`, digest: `sha256:${'a'.repeat(64)}` });
const signedAssets = (v) => [
    asset(`v${v}`, 'SHA256SUMS.txt'),
    asset(`v${v}`, 'SHA256SUMS.txt.sigstore.json'),
    asset(`v${v}`, `manga-shelf-release-v${v}.json`),
    asset(`v${v}`, 'pterodactyl-manga-shelf.zip')
];
const raw = (tag, over = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', html_url: 'https://evil.example/', body: '', assets: [], ...over });

test('strict versions and tags; the parsed version is used, never the raw tag', () => {
    assert.equal(version.versionFromTag('v3.1.0'), '3.1.0');
    for (const tag of ['v3.1.0-rc.1', '3.1.0', 'v03.1.0', 'v9.0.0/foo', 'v9.0.0-x', 'v1.2', ' v1.2.3', 'v1.2.3 ', 'V1.2.3']) {
        assert.equal(version.versionFromTag(tag), null, tag);
    }
    assert.equal(version.compareVersions('3.10.0', '3.9.9'), 1);
    assert.equal(version.compareVersions('3.1.0', '3.1.0'), 0);
    assert.equal(version.compareVersions('3.1.0', 'x'), null);
});

test('engines ranges npm writes are understood; unknown syntax is not guessed', () => {
    const cases = [
        ['>=22.13.0', 'v22.13.0', true], ['>=22.13.0', 'v22.12.9', false], ['>=22.13', 'v24.1.0', true], ['^22.13.0', 'v23.0.0', false],
        ['^22.13.0 || >=24', 'v24.0.0', true], ['~22.13.0', 'v22.14.0', false], ['22.x', 'v22.99.1', true], ['>22', 'v22.5.0', false],
        ['<=22', 'v22.9.0', true], ['>=20 <23', 'v23.0.0', false], ['*', 'v1.0.0', true], ['', 'v1.0.0', true]
    ];
    for (const [range, node, expected] of cases) assert.equal(version.satisfiesRange(range, node), expected, `${range} ${node}`);
    for (const range of ['>=22.0.0-rc', '22 - 24', 'latest', '>=a']) assert.equal(version.satisfiesRange(range, 'v22.13.0'), null, range);
});

test('releases: drafts, pre-releases and loose tags are dropped; assets must point at this repository', () => {
    assert.equal(github.normalizeRelease(raw('v3.1.0', { draft: true })), null);
    assert.equal(github.normalizeRelease(raw('v3.1.0', { prerelease: true })), null);
    assert.equal(github.normalizeRelease(raw('v3.1.0-beta')), null);
    const r = github.normalizeRelease(raw('v3.1.0', {
        assets: [
            asset('v3.1.0', 'SHA256SUMS.txt'),
            { name: 'pterodactyl-manga-shelf.zip', size: 1, browser_download_url: 'https://github.com/other/repo/releases/download/v3.1.0/pterodactyl-manga-shelf.zip' },
            { name: '../x', size: 1, browser_download_url: `${DL}v3.1.0/../x` },
            asset('v3.0.0', 'manga-shelf-server-linux-x64')
        ]
    }));
    assert.equal(r.version, '3.1.0');
    assert.equal(r.html_url, 'https://github.com/LixNix-Swap-Org/manga-shelf/releases/tag/v3.1.0', 'html_url is built, not taken from the answer');
    assert.deepEqual(r.assets.map((a) => a.name), ['SHA256SUMS.txt']);
});

test('decorate: installed, older, unsigned, no_asset and installable', () => {
    const decorate = (v, assets, current = '3.1.0', assetName = 'pterodactyl-manga-shelf.zip') =>
        github.decorate(github.normalizeRelease(raw(`v${v}`, { assets })), { current, assetName });
    assert.equal(decorate('3.1.0', signedAssets('3.1.0')).reason, 'installed');
    assert.equal(decorate('3.0.0', signedAssets('3.0.0')).reason, 'older');
    const unsigned = decorate('3.2.0', signedAssets('3.2.0').filter((a) => a.name !== 'manga-shelf-release-v3.2.0.json'));
    assert.equal(unsigned.reason, 'unsigned');
    assert.equal(unsigned.signed, false);
    assert.equal(decorate('3.2.0', signedAssets('3.2.0'), '3.1.0', 'manga-shelf-server-linux-arm64').reason, 'no_asset');
    const ok = decorate('3.2.0', signedAssets('3.2.0'));
    assert.equal(ok.installable, true);
    assert.equal(ok.reason, null);
});

test('admin notes: the "### Before updating" block up to the next heading', () => {
    const body = '## 3.2.0\n\n### Before updating\nRe-import the egg.\n\nThen restart.\n\n### Fixed\n- x';
    assert.equal(github.adminNotes(body), 'Re-import the egg.\n\nThen restart.');
    assert.equal(github.adminNotes('## 3.2.0\n### Fixed'), null);
});

test('list: cached in memory and in cache/releases.json for an hour; refresh forces a fetch', async () => {
    const dataDir = h.tmpDir();
    github.resetCache();
    let calls = 0;
    const fetchJson = async (url) => {
        calls++;
        assert.match(url, /\/repos\/LixNix-Swap-Org\/manga-shelf\/releases\?per_page=30&page=1$/);
        return [raw('v3.1.0', { assets: signedAssets('3.1.0') }), raw('v3.2.0', { assets: signedAssets('3.2.0') }), raw('v3.2.0-rc1'), raw('nightly')];
    };
    const t0 = Date.parse('2026-10-10T10:00:00Z');
    const first = await github.listReleases({ dataDir, now: t0, fetchJson });
    assert.deepEqual(first.releases.map((r) => r.version), ['3.2.0', '3.1.0']);
    assert.equal(first.error, null);
    assert.ok(fs.existsSync(path.join(dataDir, 'cache', 'releases.json')));
    await github.listReleases({ dataDir, now: t0 + 30 * 60 * 1000, fetchJson });
    assert.equal(calls, 1);
    github.resetCache();
    const afterRestart = await github.listReleases({ dataDir, now: t0 + 31 * 60 * 1000, fetchJson });
    assert.equal(calls, 1, 'a restart reads the cache file');
    assert.deepEqual(afterRestart.releases.map((r) => r.version), ['3.2.0', '3.1.0']);
    assert.equal(github.cachedLatest(dataDir).version, '3.2.0');
    await github.listReleases({ dataDir, now: t0 + 32 * 60 * 1000, fetchJson, force: true });
    assert.equal(calls, 2);
    await github.listReleases({ dataDir, now: t0 + 2 * 60 * 60 * 1000, fetchJson });
    assert.equal(calls, 3, 'stale after an hour');
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rate limit: next_try_at from x-ratelimit-reset, no request before it, cached list kept', async () => {
    const dataDir = h.tmpDir();
    github.resetCache();
    const t0 = Date.parse('2026-10-10T10:00:00Z');
    await github.listReleases({ dataDir, now: t0, fetchJson: async () => [raw('v3.1.0', { assets: signedAssets('3.1.0') })] });
    const reset = Math.floor((t0 + 2 * 60 * 60 * 1000 + 20 * 60 * 1000) / 1000);
    let calls = 0;
    const limited = async () => {
        calls++;
        throw Object.assign(new Error('403'), { httpStatus: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    };
    const r = await github.listReleases({ dataDir, now: t0 + 2 * 60 * 60 * 1000, fetchJson: limited });
    assert.equal(r.error, 'RATE_LIMITED');
    assert.equal(r.next_try_at, new Date(reset * 1000).toISOString());
    assert.deepEqual(r.releases.map((x) => x.version), ['3.1.0']);
    const again = await github.listReleases({ dataDir, now: t0 + 2 * 60 * 60 * 1000 + 1000, fetchJson: limited, force: true });
    assert.equal(again.error, 'RATE_LIMITED');
    assert.equal(calls, 1, 'not even a forced refresh asks before the reset');
    github.resetCache();
    await github.listReleases({ dataDir, now: t0 + 2 * 60 * 60 * 1000 + 2000, fetchJson: limited });
    assert.equal(calls, 1, 'the reset time survives a restart');
    const retry = Object.assign(new Error('429'), { httpStatus: 429, headers: { 'retry-after': '30' } });
    assert.equal(github.rateLimitUntil(retry, 1000), 31000);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GitHub unreachable: error code, cached list kept, retried after a pause', async () => {
    const dataDir = h.tmpDir();
    github.resetCache();
    let calls = 0;
    const down = async () => { calls++; throw new Error('ECONNRESET'); };
    const r = await github.listReleases({ dataDir, now: 0, fetchJson: down });
    assert.equal(r.error, 'GITHUB_UNAVAILABLE');
    assert.equal(r.next_try_at, null);
    await github.listReleases({ dataDir, now: 1000, fetchJson: down });
    assert.equal(calls, 1);
    await github.listReleases({ dataDir, now: 6 * 60 * 1000, fetchJson: down });
    assert.equal(calls, 2);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('pages until ten strict releases or a short page', async () => {
    github.resetCache();
    const pages = [];
    const fetchJson = async (url) => {
        const page = Number(/[?&]page=(\d+)/.exec(url)[1]);
        pages.push(page);
        if (page === 1) return Array.from({ length: 30 }, (_, i) => raw(i < 25 ? `v0.0.${i}-junk` : `v1.0.${i}`));
        return Array.from({ length: 5 }, (_, i) => raw(`v2.0.${i}`));
    };
    const r = await github.listReleases({ now: 0, fetchJson });
    assert.deepEqual(pages, [1, 2]);
    assert.equal(r.releases.length, 10);
    assert.equal(r.releases[0].version, '2.0.4');
});

test('fetchRelease: a fresh copy of exactly that tag', async () => {
    const r = await github.fetchRelease('3.2.0', { fetchJson: async (url) => {
        assert.match(url, /\/releases\/tags\/v3\.2\.0$/);
        return raw('v3.2.0', { assets: signedAssets('3.2.0') });
    } });
    assert.equal(r.version, '3.2.0');
    assert.equal(await github.fetchRelease('3.2.0', { fetchJson: async () => raw('v3.1.0') }), null);
    assert.equal(await github.fetchRelease('3.2.0', { fetchJson: async () => raw('v3.2.0', { draft: true }) }), null);
});
