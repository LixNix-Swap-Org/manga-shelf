// Documentation checks: .env.example and README.md stay consistent with the code.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { ENTRIES, MIN_SETUP_TOKEN_LENGTH } = require('../utils/config');
const { DEFAULT_TRUST_PROXY } = require('../utils/trustProxy');

const CONFIG_NAMES = new Set(ENTRIES.flatMap((e) => [e.name, ...(e.aliases || [])]));
const DOCUMENTED = ENTRIES.filter((e) => e.doc !== false).map((e) => e.name);

function sourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') out.push(...sourceFiles(rel));
        } else if (entry.name.endsWith('.js')) {
            out.push(rel);
        }
    }
    return out;
}

// Code that reads environment variables outside utils/config.js (anime gateway, API keys, remote and browser scripts)
const CODE = ['index.js', 'healthcheck.js', ...['core', 'routes', 'services', 'middleware', 'utils', 'scripts', 'test/browser'].flatMap(sourceFiles)]
    .map(read).join('\n');

const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

describe('.env.example', () => {
    const example = read('.env.example');
    const names = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);

    test('every variable it names is read by the server or a script', () => {
        assert.ok(names.length > 20);
        const unknown = names.filter((name) => !CONFIG_NAMES.has(name) && !new RegExp(`\\b${name}\\b`).test(CODE));
        assert.deepEqual(unknown, [], `.env.example names variables nobody reads: ${unknown.join(', ')}`);
    });

    test('the commented example values are accepted by utils/config.js', () => {
        const { readConfig } = require('../utils/config');
        const values = Object.fromEntries([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=(\S.*?)\s*(?:#.*)?$/gm)]
            .filter((m) => CONFIG_NAMES.has(m[1]))
            .map((m) => [m[1], m[2]]));
        assert.ok(Object.keys(values).length > 10);
        const { warnings, errors } = readConfig(values);
        assert.deepEqual([...errors, ...warnings], []);
    });
});

describe('README.md', () => {
    const readme = read('README.md');

    test('links only to the current repository', () => {
        assert.doesNotMatch(readme, /github\.com\/MoltresHD/i);
        assert.match(readme, /https:\/\/github\.com\/LixNix-Swap-Org\/manga-shelf/);
    });

    test('every in-page link points at a heading', () => {
        const anchors = new Set([...readme.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1])));
        const broken = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !anchors.has(a));
        assert.deepEqual(broken, []);
    });

    test('the HTTPS section keeps the anchor the dashboard footer links to', () => {
        const anchors = [...readme.matchAll(/^## (.+)$/gm)].map((m) => slug(m[1]));
        assert.ok(anchors.includes('6-https--eigene-domain-reverse-proxy-mit-nginx-oder-caddy'));
    });

    test('the variable table lists every variable of utils/config.js and only real ones', () => {
        const section = readme.slice(readme.indexOf('## 12. Umgebungsvariablen'), readme.indexOf('## 13.'));
        assert.ok(section.length > 100, 'section 12 missing');
        const missing = DOCUMENTED.filter((name) => !section.includes(`\`${name}\``));
        assert.deepEqual(missing, [], `missing from the README table: ${missing.join(', ')}`);
        const rows = section.split('\n').filter((line) => line.startsWith('| `'));
        const named = rows.flatMap((line) => [...line.split('|')[1].matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]));
        const unknown = named.filter((name) => !CONFIG_NAMES.has(name) && !new RegExp(`\\b${name}\\b`).test(CODE));
        assert.deepEqual(unknown, []);
    });

    test('states the TRUST_PROXY default and the SETUP_TOKEN minimum of the code', () => {
        assert.match(readme, new RegExp(`\\| \`TRUST_PROXY\` \\| \`${DEFAULT_TRUST_PROXY}\` \\|`));
        assert.match(readme, new RegExp(`mindestens ${MIN_SETUP_TOKEN_LENGTH} Zeichen`));
    });

    test('the manual ZIP names what package.js ships', () => {
        const { PACKAGE_FILES, FRONTEND_DIST } = require('../package');
        const manual = readme.slice(readme.indexOf('Falls `npm run package` fehlschlägt'), readme.indexOf('### Egg'));
        for (const file of [...PACKAGE_FILES, FRONTEND_DIST]) assert.ok(manual.includes(`\`${file}`), `${file} missing from the ZIP instructions`);
        assert.match(manual, /"files"/);
        const shipped = JSON.parse(read('package.json')).files;
        for (const file of shipped) assert.ok(manual.includes(`\`${file}\``), `${file} from package.json "files" missing from the ZIP instructions`);
    });

    test('gives the same Pterodactyl update instruction as the release text', () => {
        const { PTERODACTYL_UPDATE, releaseNotes } = require('../scripts/release/notes');
        assert.ok(readme.includes(`**Update:** ${PTERODACTYL_UPDATE}`));
        assert.ok(releaseNotes('v1.2.3', {}).includes(PTERODACTYL_UPDATE));
        assert.doesNotMatch(readme + PTERODACTYL_UPDATE, /alte Dateien außer `data\/` löschen/);
    });

    test('runs console commands in Docker as node and explains docker attach', () => {
        const execs = [...readme.matchAll(/docker exec [^`]*scripts\/admin\.js/g)].map((m) => m[0]);
        assert.ok(execs.length >= 2);
        assert.deepEqual(execs.filter((cmd) => !/ -u node /.test(cmd)), []);
        assert.match(readme, /`docker attach`[^\n]*`stdin_open: true`[^\n]*`tty: true`/);
        const compose = read('docker-compose.yml');
        assert.match(compose, /^\s*# stdin_open: true$/m);
        assert.match(compose, /^\s*# tty: true$/m);
        assert.doesNotMatch(read('.env.example'), /\(Pterodactyl, docker attach\)/);
    });

    test('the headless self-build installs the root dependencies before build-sea.js', () => {
        const line = readme.split('\n').find((l) => l.includes('node scripts/server-bin/build-sea.js') && l.startsWith('Selbst bauen'));
        assert.ok(line, 'self-build line of the headless server missing');
        const command = /`([^`]*build-sea\.js)`/.exec(line)[1];
        assert.match(command, /^npm ci && /);
    });

    test('has the section for use away from home', () => {
        const start = readme.indexOf('### Von unterwegs');
        assert.ok(start > readme.indexOf('## 10.') && start < readme.indexOf('## 11.'));
        const section = readme.slice(start, readme.indexOf('## 11.'));
        assert.match(section, /Offline-Kopie/);
        assert.match(section, /Tailscale/);
        assert.match(section, /Abschnitt 6/);
    });

    test('the example files it names exist', () => {
        const names = new Set([...readme.matchAll(/`([\w.-]+\.(?:example|ya?ml))`/g)].map((m) => m[1]));
        const places = ['', '.github/workflows'];
        const missing = [...names].filter((name) => !places.some((dir) => fs.existsSync(path.join(root, dir, name))));
        assert.deepEqual(missing, []);
    });
});

describe('CHANGELOG.md', () => {
    const changelog = read('CHANGELOG.md');

    test('names the migrations up to LATEST_SCHEMA_VERSION and no fixed branch hash as its state', () => {
        const { LATEST_SCHEMA_VERSION } = require('../core/schema');
        const range = /\*\*Database migrations 12–(\d+)\*\*/.exec(changelog);
        assert.ok(range, 'migration line missing');
        assert.equal(Number(range[1]), LATEST_SCHEMA_VERSION);
        const state = changelog.split('\n').find((line) => line.startsWith('State:'));
        assert.match(state, /see `git log`/);
        assert.deepEqual([...state.matchAll(/`([0-9a-f]{7,40})`/g)].map((m) => m[1]), ['f0c2a64']);
    });

    test('says the console passwort-reset ends the calendar feed, as services/console.js does', () => {
        assert.match(read('services/console.js'), /revokeFeedTokens\(db, user\.id\)/);
        const line = changelog.split('\n').find((l) => l.startsWith('- **Calendar feed** ends'));
        assert.match(line, /console command `passwort-reset`/);
        assert.doesNotMatch(line, /not yet/);
    });
});

describe('README.md device backups', () => {
    const readme = read('README.md');

    test('section 10 and the standalone section say iOS backs up the app data and Android does not', () => {
        const apps = readme.slice(readme.indexOf('## 10.'), readme.indexOf('### Ohne Server nutzen'));
        const standalone = readme.slice(readme.indexOf('### Ohne Server nutzen'), readme.indexOf('### Von unterwegs'));
        for (const part of [apps, standalone]) {
            assert.match(part, /iCloud/);
            assert.match(part, /Android/);
            assert.match(part, /ZIP/);
        }
        const rules = read('mobile/android/app/src/main/res/xml/backup_rules.xml');
        assert.match(rules, /manga\.db/);
    });

    test('section 5 explains that accounts from an app backup need a password reset', () => {
        const backups = readme.slice(readme.indexOf('## 5.'), readme.indexOf('## 6.'));
        assert.match(backups, /Sicherung aus der App/);
        assert.match(backups, /Passwort-Reset/);
        assert.match(backups, /`passwort-reset <name>`/);
    });
});

describe('deploy examples', () => {
    test('the egg variables and the compose environment are variables of utils/config.js', () => {
        const egg = JSON.parse(read('egg-manga-shelf.json'));
        for (const v of egg.variables) assert.ok(CONFIG_NAMES.has(v.env_variable), v.env_variable);
        const compose = read('docker-compose.yml');
        const env = [...compose.matchAll(/^\s*#?\s*- ([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]).filter((n) => n !== 'NODE_ENV');
        assert.ok(env.length >= 3);
        for (const name of env) assert.ok(CONFIG_NAMES.has(name), name);
    });
});

describe('nginx.conf.example', () => {
    const conf = read('nginx.conf.example');
    const active = conf.split('\n').map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean);
    let tmp;

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-docs-'));
        process.env.DATA_DIR = tmp;
        process.env.LOG_LEVEL = 'silent';
    });
    after(() => {
        if (require.cache[require.resolve('../db')]) require('../db').closeDb();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('is structurally valid: balanced blocks, every directive ends with a semicolon', () => {
        let depth = 0;
        for (const line of active) {
            depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
            assert.ok(depth >= 0, `unbalanced at "${line}"`);
            assert.match(line, /[;{}]$/, `"${line}" does not end with ; { or }`);
        }
        assert.equal(depth, 0);
    });

    test('starts before certbot: no ssl listener without a certificate, no http2 directive older nginx rejects', () => {
        const sslListen = active.some((line) => /^listen\b.*\bssl\b/.test(line));
        const cert = active.some((line) => /^ssl_certificate\s/.test(line));
        assert.ok(!sslListen || cert, 'listen ... ssl needs an ssl_certificate');
        assert.ok(!active.some((line) => /^http2\s+on\b/.test(line)), '"http2 on" needs nginx 1.25.1+');
    });

    test('the body limit is above the backup upload limit of the app', () => {
        const m = /^client_max_body_size\s+(\d+)([kKmMgG]?);$/m.exec(active.join('\n'));
        assert.ok(m, 'client_max_body_size missing');
        const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
        const { uploadBackup } = require('../middleware/upload');
        assert.ok(Number(m[1]) * unit > uploadBackup.limits.fileSize, `${m[1]}${m[2]} <= ${uploadBackup.limits.fileSize}`);
    });

    test('overwrites X-Forwarded-For and forwards the real scheme', () => {
        assert.ok(active.includes('proxy_set_header X-Forwarded-For $remote_addr;'));
        assert.ok(active.includes('proxy_set_header X-Forwarded-Proto $scheme;'));
        assert.ok(!active.some((line) => line.includes('$proxy_add_x_forwarded_for')));
    });
});
