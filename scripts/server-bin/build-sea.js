#!/usr/bin/env node
// Builds the headless server binaries (Node single executable applications); options: see parseArgs below.
// esbuild bundles entry.js + backend into server.cjs, the built frontend becomes SEA assets, and `node --build-sea`
// injects both into an official Node binary per target (checked against SHASUMS256.txt); macOS is signed ad hoc.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const NAME = 'manga-shelf-server';
const TARGETS = {
    'linux-x64': { dist: 'linux-x64', archive: 'tar.gz', exe: 'bin/node' },
    'linux-arm64': { dist: 'linux-arm64', archive: 'tar.gz', exe: 'bin/node' },
    'windows-x64': { dist: 'win-x64', archive: 'zip', exe: 'node.exe', suffix: '.exe' },
    'macos-arm64': { dist: 'darwin-arm64', archive: 'tar.gz', exe: 'bin/node' },
    'macos-x64': { dist: 'darwin-x64', archive: 'tar.gz', exe: 'bin/node' },
    'macos-universal': { parts: ['macos-arm64', 'macos-x64'] }
};
const POSTJECT = 'postject@1.0.0-alpha.6';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const log = (text) => process.stdout.write(text + '\n');

function hostTarget(platform = process.platform, arch = process.arch) {
    const os_ = { linux: 'linux', darwin: 'macos', win32: 'windows' }[platform];
    return os_ && TARGETS[`${os_}-${arch}`] ? `${os_}-${arch}` : null;
}

const binaryName = (target) => `${NAME}-${target}${(TARGETS[target] && TARGETS[target].suffix) || ''}`;

function parseArgs(argv) {
    const opts = { targets: ['host'], out: path.join(ROOT, 'dist', 'server'), frontend: path.join(ROOT, 'frontend', 'dist'), nodeBinary: null, bundleOnly: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            if (argv[i + 1] === undefined) throw new Error(`${a} braucht einen Wert`);
            return argv[++i];
        };
        if (a === '--target' || a === '--targets') opts.targets = value().split(',').map(t => t.trim()).filter(Boolean);
        else if (a === '--out') opts.out = path.resolve(value());
        else if (a === '--frontend') opts.frontend = path.resolve(value());
        else if (a === '--node-binary') opts.nodeBinary = path.resolve(value());
        else if (a === '--bundle-only') opts.bundleOnly = true;
        else throw new Error(`Unbekannte Option ${a}`);
    }
    opts.targets = opts.targets.map(t => (t === 'host' ? hostTarget() : t));
    for (const t of opts.targets) {
        if (!t || !TARGETS[t]) throw new Error(`Unbekanntes Ziel ${t} (bekannt: ${Object.keys(TARGETS).join(', ')})`);
    }
    if (opts.nodeBinary && opts.targets.length !== 1) throw new Error('--node-binary nur mit genau einem Ziel');
    return opts;
}

function loadEsbuild() {
    for (const base of [ROOT, path.join(ROOT, 'frontend')]) {
        try {
            return require(require.resolve('esbuild', { paths: [base] }));
        } catch (e) { /* next */ }
    }
    throw new Error('esbuild nicht gefunden (cd frontend && npm ci)');
}

/**
 * Repository modules resolve files relative to their own folder (__dirname); in the bundle they all share one file,
 * so each gets its own __dirname below the app folder main.js prepares (globalThis.__MANGA_SHELF_APP_DIR__).
 */
function dirnamePlugin(root) {
    const own = path.join(root, 'scripts', 'server-bin') + path.sep;
    const deps = path.sep + 'node_modules' + path.sep;
    return {
        name: 'app-dirname',
        setup(build) {
            build.onLoad({ filter: /\.js$/ }, (args) => {
                if (!args.path.startsWith(root + path.sep) || args.path.includes(deps) || args.path.startsWith(own)) return null;
                let contents = fs.readFileSync(args.path, 'utf8');
                if (!/__dirname|__filename/.test(contents)) return null;
                // a shebang would land behind the shim; `.` never matches \r, so allow the CRLF of a Windows checkout
                contents = contents.replace(/^#![^\r\n]*\r?\n/, '\n');
                const rel = path.relative(root, args.path).split(path.sep).join('/');
                const base = 'globalThis.__MANGA_SHELF_APP_DIR__ || process.cwd()';
                const shim = `var __dirname = require("path").join(${base}, ${JSON.stringify(path.posix.dirname(rel))}), ` +
                    `__filename = require("path").join(${base}, ${JSON.stringify(rel)});`;
                return { contents: shim + contents, loader: 'js' };
            });
        }
    };
}

async function bundle(outDir) {
    const esbuild = loadEsbuild();
    const outfile = path.join(outDir, 'server.cjs');
    const result = await esbuild.build({
        absWorkingDir: ROOT,
        entryPoints: [path.join(__dirname, 'entry.js')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        define: { __MANGA_SHELF_BUNDLED__: 'true' },
        plugins: [dirnamePlugin(ROOT)],
        legalComments: 'none',
        logLevel: 'error',
        metafile: true
    });
    return { outfile, warnings: result.warnings, metafile: result.metafile };
}

/** require() calls the bundle still makes at run time; in a SEA only built-in modules can be loaded that way. */
function runtimeRequires(code) {
    const builtins = new Set(require('module').builtinModules);
    const found = [];
    const re = /(?<!function )\b(__require|require)\(\s*([^)]*?)\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
        const arg = m[2];
        const literal = /^(["'])([^"']+)\1$/.exec(arg);
        if (literal && (builtins.has(literal[2].replace(/^node:/, '')) || literal[2].startsWith('node:'))) continue;
        found.push(`${m[1]}(${arg})`);
    }
    return found;
}

function listFiles(dir) {
    const out = [];
    const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            if (['.DS_Store', 'Thumbs.db'].includes(entry.name)) continue;
            const child = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(child);
            else if (entry.isFile()) out.push(child);
        }
    };
    walk('');
    return out.sort();
}

/** Copies the portal to <out>/web, writes <out>/web-manifest.json and returns the SEA asset map. */
function prepareWeb(frontendDir, outDir, version) {
    if (!fs.existsSync(path.join(frontendDir, 'index.html'))) throw new Error(`${frontendDir}/index.html fehlt (zuerst cd frontend && npm run build)`);
    const files = listFiles(frontendDir);
    const hash = crypto.createHash('sha256');
    const webDir = path.join(outDir, 'web');
    fs.rmSync(webDir, { recursive: true, force: true });
    const assets = {};
    for (const rel of files) {
        const src = path.join(frontendDir, ...rel.split('/'));
        const content = fs.readFileSync(src);
        hash.update(rel).update('\0').update(content);
        const dest = path.join(webDir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        assets[`web/${rel}`] = dest;
    }
    const manifest = { id: `${version}-${hash.digest('hex').slice(0, 12)}`, files };
    const manifestPath = path.join(outDir, 'web-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assets['web-manifest.json'] = manifestPath;
    return { manifest, assets };
}

async function download(url, dest) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download ${url}: HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Official Node binary of the running version for a target, cached under <out>/.node-cache. */
async function officialNode(target, cacheDir) {
    const { dist, archive, exe } = TARGETS[target];
    const version = process.version;
    const base = `node-${version}-${dist}`;
    const file = `${base}.${archive}`;
    const dir = path.join(cacheDir, base);
    const binary = path.join(dir, ...exe.split('/'));
    if (fs.existsSync(binary)) return binary;
    fs.mkdirSync(cacheDir, { recursive: true });
    const archivePath = path.join(cacheDir, file);
    const url = `https://nodejs.org/dist/${version}/`;
    log(`Lade ${url}${file} ...`);
    await download(url + file, archivePath);
    const sums = await (await fetch(url + 'SHASUMS256.txt')).text();
    const line = sums.split('\n').find(l => l.trim().endsWith(`  ${file}`));
    if (!line || line.split(/\s+/)[0] !== sha256(archivePath)) {
        fs.rmSync(archivePath, { force: true });
        throw new Error(`Prüfsumme von ${file} stimmt nicht mit SHASUMS256.txt überein`);
    }
    if (archive === 'zip') {
        const AdmZip = require('adm-zip');
        new AdmZip(archivePath).extractEntryTo(`${base}/${exe}`, dir, false, true);
        fs.renameSync(path.join(dir, path.basename(exe)), binary);
    } else {
        fs.mkdirSync(dir, { recursive: true });
        execFileSync('tar', ['-xzf', archivePath, '-C', cacheDir, `${base}/${exe}`]);
    }
    fs.rmSync(archivePath, { force: true });
    return binary;
}

const seaEnabled = () => process.config.variables.single_executable_application !== false;
const hasBuildSea = () => process.allowedNodeEnvironmentFlags.has('--build-sea');

function findSigntool() {
    const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
    if (!fs.existsSync(kits)) return null;
    const versions = fs.readdirSync(kits).filter(v => /^10\./.test(v)).sort().reverse();
    for (const v of versions) {
        const candidate = path.join(kits, v, 'x64', 'signtool.exe');
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Copy of the base binary without its signature (the injection would break it). */
function unsignedCopy(binary, target, workDir) {
    const copy = path.join(workDir, path.basename(binary));
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(binary, copy);
    fs.chmodSync(copy, 0o755);
    if (target.startsWith('macos') && process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', copy]);
    if (target.startsWith('windows') && process.platform === 'win32') {
        const signtool = findSigntool();
        if (signtool) {
            try { execFileSync(signtool, ['remove', '/s', copy], { stdio: 'ignore' }); } catch (e) { /* unsigned already */ }
        }
    }
    return copy;
}

function injectWithBuildSea(builder, config, configPath) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    execFileSync(builder, ['--build-sea', configPath], { stdio: 'inherit' });
}

function injectWithPostject(builder, config, configPath, target) {
    const blob = config.output + '.blob';
    const { executable, output, ...rest } = config;
    fs.writeFileSync(configPath, JSON.stringify({ ...rest, output: blob }, null, 2));
    execFileSync(builder, ['--experimental-sea-config', configPath], { stdio: 'inherit' });
    fs.copyFileSync(executable, output);
    const args = ['--yes', POSTJECT, output, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE];
    if (target.startsWith('macos')) args.push('--macho-segment-name', 'NODE_SEA');
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
    fs.rmSync(blob, { force: true });
}

/** Operating system and CPU of an executable from its header: 'linux-x64', 'windows-x64', 'macos-arm64' … or null. */
function binaryTarget(file) {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096);
    try {
        fs.readSync(fd, head, 0, head.length, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (head.readUInt32BE(0) === 0x7f454c46) {
        const machine = head.readUInt16LE(18);
        return { 0x3e: 'linux-x64', 0xb7: 'linux-arm64' }[machine] || null;
    }
    if (head.toString('latin1', 0, 2) === 'MZ') {
        const pe = head.readUInt32LE(0x3c);
        if (pe + 6 > head.length || head.toString('latin1', pe, pe + 4) !== 'PE\0\0') return null;
        return head.readUInt16LE(pe + 4) === 0x8664 ? 'windows-x64' : null;
    }
    if (head.readUInt32LE(0) === 0xfeedfacf) {
        return { 0x01000007: 'macos-x64', 0x0100000c: 'macos-arm64' }[head.readUInt32LE(4)] || null;
    }
    return null;
}

function adHocSign(file) {
    if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', '--force', file]);
}

async function buildTarget(target, ctx) {
    const { outDir, assets, opts } = ctx;
    const output = path.join(outDir, binaryName(target));
    if (TARGETS[target].parts) {
        if (process.platform !== 'darwin') throw new Error(`${target} braucht macOS (lipo, codesign)`);
        const parts = [];
        for (const part of TARGETS[target].parts) parts.push(await buildTarget(part, ctx));
        execFileSync('lipo', ['-create', '-output', output, ...parts]);
        for (const part of parts) fs.rmSync(part, { force: true });
        adHocSign(output);
        return output;
    }
    const base = opts.nodeBinary || (target === hostTarget() && seaEnabled() ? process.execPath : await officialNode(target, ctx.cacheDir));
    const workDir = path.join(ctx.workDir, target);
    const executable = unsignedCopy(base, target, workDir);
    const config = { ...ctx.template, main: ctx.bundlePath, output, executable, assets };
    const configPath = path.join(workDir, 'sea-config.json');
    fs.rmSync(output, { force: true });
    if (hasBuildSea()) injectWithBuildSea(ctx.builder, config, configPath);
    // a --build-sea that ignores "executable" would quietly give every target the builder's own platform
    if (!hasBuildSea() || binaryTarget(output) !== target) {
        if (hasBuildSea()) log(`--build-sea lieferte ${binaryTarget(output)} statt ${target}, nehme postject`);
        fs.rmSync(output, { force: true });
        injectWithPostject(ctx.builder, config, configPath, target);
    }
    if (binaryTarget(output) !== target) throw new Error(`${path.basename(output)} ist keine ${target}-Binärdatei`);
    fs.chmodSync(output, 0o755);
    if (target.startsWith('macos')) adHocSign(output);
    log(`${path.relative(ROOT, output)} (${(fs.statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
    return output;
}

async function build(opts) {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    fs.mkdirSync(opts.out, { recursive: true });
    const { outfile, warnings } = await bundle(opts.out);
    const dynamic = runtimeRequires(fs.readFileSync(outfile, 'utf8'));
    log(`${path.relative(ROOT, outfile)} gebündelt (${warnings.length} Warnungen)`);
    if (dynamic.length) log(`Laufzeit-require ausserhalb der Node-Module: ${dynamic.join(', ')}`);
    const { manifest, assets } = prepareWeb(opts.frontend, opts.out, version);
    log(`Web-Portal: ${manifest.files.length} Dateien (${manifest.id})`);
    if (opts.bundleOnly) return { bundle: outfile, binaries: [] };

    const cacheDir = path.join(opts.out, '.node-cache');
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sea-'));
    try {
        // Homebrew and distro builds of node come without SEA support: use the official build as the builder then
        const builder = seaEnabled() ? process.execPath : await officialNode(hostTarget(), cacheDir);
        const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'sea-config.json'), 'utf8'));
        const ctx = { outDir: opts.out, assets, opts, cacheDir, workDir, builder, template, bundlePath: outfile };
        const binaries = [];
        for (const target of opts.targets) binaries.push(await buildTarget(target, ctx));
        return { bundle: outfile, binaries };
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

if (require.main === module) {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        process.stderr.write(e.message + '\n');
        process.exit(2);
    }
    build(opts).catch((e) => {
        process.stderr.write(`SEA-Build fehlgeschlagen: ${e.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { build, bundle, runtimeRequires, prepareWeb, parseArgs, hostTarget, binaryName, binaryTarget, dirnamePlugin, TARGETS };
