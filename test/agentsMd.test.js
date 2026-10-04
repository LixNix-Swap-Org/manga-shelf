// Keeps AGENTS.md in step with the code: file map, paths, tables and endpoint list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-shelf-agentsmd-'));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const AGENTS = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

// runtime data and build output that never lives in the repository
const GENERATED_PREFIXES = [
    'data/', 'data-dev/', 'dist/', 'dist_pack/', 'frontend/dist/', 'frontend/dist-app/', 'mobile/www/', 'mobile/build/',
    'desktop/dist/', 'test/browser/screenshots/', 'test/browser/test_screenshots/', 'test/browser/reports/',
    'uploads/', 'temp/', 'backups/', 'server/', 'app-frontend/', 'www/', 'ios/App/App/public', 'android/app/src/main/assets/public'
];
const GENERATED_NAMES = new Set([
    'seed-users.json', 'test_report.json', 'desktop-settings.json', 'secure-store.json', 'web-manifest.json',
    'manga-shelf-sbom.cdx.json', 'native-bridge.js', 'qr.mjs', 'server.cjs', 'manga-shelf.log'
]);
const BASES = ['', 'frontend/', 'frontend/src/', 'frontend/src/components/'];
const FILE_EXT = /^[\w.-]*\w[\w.-]*\.(js|jsx|mjs|cjs|ts|json|ya?ml|md|css|html|sh|plist|example|gradle)$/;
// deleted files and replaced rules that older notes still describe
const REMOVED = ['routes/mangas.js', 'routes/stats.js', 'routes/exchange.js', 'deploy/workflows', 'restoreFromZipBuffer', 'setRestoringState', 'trust proxy = true', '/{*splat}'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist_pack', 'data', 'data-dev', 'www', 'build', 'Pods']);

function walk(dir, out = new Set()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), out);
        else out.add(entry.name);
    }
    return out;
}

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const isGenerated = (rel) => GENERATED_PREFIXES.some(prefix => rel.startsWith(prefix) || rel === prefix.replace(/\/$/, ''));

function section(title) {
    const start = AGENTS.indexOf(title);
    assert.ok(start >= 0, `section "${title}" missing in AGENTS.md`);
    const next = AGENTS.slice(start + title.length).search(/\n#{2,3} /);
    return next < 0 ? AGENTS.slice(start) : AGENTS.slice(start, start + title.length + next);
}

function codeSpans(text) {
    const spans = [];
    let inFence = false;
    for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('```')) { inFence = !inFence; continue; }
        if (inFence) continue;
        for (const match of line.matchAll(/`([^`\n]+)`/g)) spans.push(match[1]);
    }
    return spans;
}

const isDirAtBase = (name) => BASES.some(base => fs.existsSync(path.join(ROOT, base + name)) && fs.statSync(path.join(ROOT, base + name)).isDirectory());

/** Code spans that name a repository file: a known top-level folder, or a file name with a source extension. */
function pathCandidates(text) {
    return codeSpans(text).filter(span => {
        if (/[\s*{}<>?=:@|,()$'"\\]/.test(span) || span.startsWith('/') || span.startsWith('-') || /^\.?\.\//.test(span)) return false;
        if (!span.includes('/')) return FILE_EXT.test(span);
        if (!/^[\w.@-]+(\/[\w.@-]+)*\/?$/.test(span)) return false;
        const segments = span.split('/').filter(Boolean);
        return isDirAtBase(segments[0]) || FILE_EXT.test(segments[segments.length - 1]);
    });
}

/** Paths of the file-map tree, assembled from the indentation of "├── "/"└── " lines. */
function treePaths() {
    const block = section('## 2. Directory');
    const fence = block.match(/```text\n([\s\S]*?)```/);
    assert.ok(fence, 'file map without a ```text block');
    const stack = [];
    const paths = [];
    for (const line of fence[1].split('\n')) {
        const marker = line.search(/[├└]── /);
        if (marker < 0) continue;
        const depth = marker / 4;
        assert.ok(Number.isInteger(depth), `uneven indentation: ${line}`);
        const name = line.slice(marker + 4).split(/\s+#|\s{2,}/)[0].trim();
        stack.length = depth;
        stack.push(name);
        paths.push(stack.join(''));
    }
    return paths;
}

function documentedRoutes() {
    const rows = new Set();
    for (const match of AGENTS.matchAll(/^\|\s*([A-Z][A-Z ,/]*?)\s*\|\s*`(\/api\/[^`]+)`\s*\|/gm)) {
        for (const method of match[1].split(/[,/]/).map(m => m.trim()).filter(Boolean)) rows.add(`${method} ${match[2]}`);
    }
    return rows;
}

function serverRoutes() {
    const found = new Set();
    for (const file of fs.readdirSync(path.join(ROOT, 'routes'))) {
        const source = fs.readFileSync(path.join(ROOT, 'routes', file), 'utf8');
        for (const match of source.matchAll(/router\.(get|post|put|delete)\(\s*'([^']+)'/g)) {
            found.add(`${match[1].toUpperCase()} /api${match[2]}`);
        }
    }
    const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    for (const match of index.matchAll(/app\.(get|post|put|delete)\(\s*'(\/api\/[^']+)'/g)) found.add(`${match[1].toUpperCase()} ${match[2]}`);
    return found;
}

test.after(() => {
    try { require('../db').closeDb(); } catch { /* db never opened */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test('every path of the file map exists', () => {
    const paths = treePaths();
    assert.ok(paths.length > 100, `too few entries in the file map (${paths.length})`);
    const missing = paths.filter(p => !isGenerated(p) && !exists(p));
    assert.deepEqual(missing, []);
});

test('every file path mentioned in AGENTS.md exists', () => {
    const names = walk(ROOT);
    const missing = [];
    for (const candidate of new Set(pathCandidates(AGENTS))) {
        if (candidate.includes('/')) {
            if (isGenerated(candidate)) continue;
            if (!BASES.some(base => exists(base + candidate))) missing.push(candidate);
        } else if (!GENERATED_NAMES.has(candidate) && !names.has(candidate)) {
            missing.push(candidate);
        }
    }
    assert.deepEqual(missing, []);
});

test('the path check catches a deleted file', () => {
    assert.deepEqual(pathCandidates('See `routes/mangas.js` and `core/lib/trash.js`, not `/api/mangas`.'), ['routes/mangas.js', 'core/lib/trash.js']);
    assert.equal(BASES.some(base => exists(base + 'routes/mangas.js')), false);
});

test('no removed file or replaced rule is mentioned', () => {
    assert.deepEqual(REMOVED.filter(name => AGENTS.includes(name)), []);
});

test('the migration table matches core/schema.js migrationList()', () => {
    const { migrationList, LATEST_SCHEMA_VERSION } = require('../core/schema');
    const block = section('### Migrations');
    const documented = [...block.matchAll(/^\|\s*(\d+)\s*\|\s*`([a-z0-9_]+)`\s*\|/gm)].map(m => `${m[1]} ${m[2]}`);
    assert.deepEqual(documented, migrationList().map(m => `${m.version} ${m.name}`));
    assert.equal(Number(documented[documented.length - 1].split(' ')[0]), LATEST_SCHEMA_VERSION);
});

test('the console table matches services/console.js COMMANDS', () => {
    const { COMMANDS } = require('../services/console');
    const block = section('### 🔹 Case S');
    const documented = [...block.matchAll(/^\|\s*`([^`]+)`\s*\|([^|]*)\|/gm)].map(m => {
        const aliases = [...m[2].matchAll(/`([^`]+)`/g)].map(a => a[1]);
        return [m[1], ...aliases].join(' ');
    });
    assert.deepEqual(documented, COMMANDS.map(c => c.names.join(' ')));
});

test('every endpoint is documented in §5 and every documented endpoint exists', () => {
    const { routes } = require('../core/routes');
    const actual = new Set([...routes.map(r => `${r.method} /api${r.path}`), ...serverRoutes()]);
    const documented = documentedRoutes();
    assert.deepEqual([...actual].filter(r => !documented.has(r)).sort(), [], 'endpoints without a row in §5');
    assert.deepEqual([...documented].filter(r => !actual.has(r)).sort(), [], 'rows in §5 without an endpoint');
});

test('no file-map comment is cut off mid-sentence', () => {
    const fence = section('## 2. Directory').match(/```text\n([\s\S]*?)```/)[1];
    const count = (text, ch) => text.split(ch).length - 1;
    const broken = fence.split('\n').filter(line => /[├└│]/.test(line) && line.includes(' # ')).filter(line => {
        const comment = line.slice(line.indexOf(' # ') + 3);
        return /\s$/.test(line) || /(<[\w-]*|[(|])$/.test(comment) || count(comment, '(') !== count(comment, ')')
            || count(comment, "'") % 2 !== 0;
    });
    assert.deepEqual(broken, []);
});

test('Gotcha 22 states the size limit of core/anime/request.js', () => {
    const source = fs.readFileSync(path.join(ROOT, 'core/anime/request.js'), 'utf8');
    const mb = Number(/const MAX_BYTES = (\d+) \* 1024 \* 1024;/.exec(source)[1]);
    const gotcha = AGENTS.slice(AGENTS.indexOf('22. **ISBN'), AGENTS.indexOf('\n23. '));
    assert.match(gotcha, new RegExp(`core/anime/request\\.js\`[^;]*\\b${mb} MB limit`));
    assert.doesNotMatch(gotcha, /AniList via `fetch`/);
});

test('§7 names every place that loads a .env file', () => {
    const block = section('### Environment variables');
    const loaders = ['index.js', 'scripts/admin.js', 'scripts/server-bin/main.js']
        .filter(rel => /dotenv|loadDotenv\(/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
    assert.equal(loaders.length, 3);
    for (const rel of loaders) assert.ok(block.includes(`\`${rel}\``), `${rel} missing in §7 Environment variables`);
    assert.doesNotMatch(block, /\.env` is read only by `index\.js`/);
});

test('§7 says the desktop installers build only on main and in pull requests', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ci, /installers: \$\{\{ github\.ref == 'refs\/heads\/main' \|\| \(github\.event_name == 'pull_request' && github\.actor != 'dependabot\[bot\]'\) \}\}/);
    const line = AGENTS.split('\n').find(l => l.startsWith('* **Build on every push:**'));
    assert.match(line, /`desktop-<OS>`.*?only on `main` and in pull requests/);
});

test('Gotcha 31 lists the console passwort-reset among the feed revocations', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'services/console.js'), 'utf8'), /revokeFeedTokens\(db, user\.id\)/);
    const gotcha = AGENTS.slice(AGENTS.indexOf('31. **System page'), AGENTS.indexOf('\n32. '));
    assert.match(gotcha, /console `passwort-reset` likewise \(`services\/console\.js`\)/);
    assert.doesNotMatch(gotcha, /still leaves the feed address/);
});

test('the device sanitiser named in §4 is the one replaceDatabase runs', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'frontend/src/local/runtime.js'), 'utf8');
    assert.match(runtime, /sanitizeImportedDatabase\(/);
    const block = section('### Frontend architecture & operating modes');
    assert.match(block, /`sanitizeImportedDatabase\(conn\)` \(`local\/sanitize\.js`\)/);
    assert.doesNotMatch(AGENTS, /sanitizePulledDatabase/);
});
