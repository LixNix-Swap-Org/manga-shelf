#!/usr/bin/env node
// Entry of the headless server binary (Node SEA, see build-sea.js): starts the server, runs a console command or
// sets up the service. Also runs unbundled (`node scripts/server-bin/main.js`) against the repository.
const fs = require('fs');
const path = require('path');
const { parseArgs, dataDirFor, preludeOptions, defaultCacheDir, UsageError, HELP } = require('./cli');
const { readEnvFile, restrictWindowsFiles } = require('./acl');
const updatePrelude = require('../../services/update/prelude');

/* global __MANGA_SHELF_BUNDLED__ */
const BUNDLED = typeof __MANGA_SHELF_BUNDLED__ !== 'undefined';
const STOP_DEADLINE_MS = 15000;

const out = (text) => process.stdout.write(text + '\n');
const err = (text) => process.stderr.write(text + '\n');

function isSea() {
    try { return require('node:sea').isSea(); } catch (e) { return false; }
}

function version() {
    return require('../../package.json').version;
}

/**
 * SSL_KEY_PATH/SSL_CERT_PATH default to <dataDir>/ssl: the app folder of the bundle is the portal cache of one build,
 * which the next update removes. Set values (environment or .env) stay.
 */
function applySslDefaults(dataDir, env = process.env) {
    const ssl = (name) => path.join(dataDir, 'ssl', name);
    const blank = (value) => value === undefined || String(value).trim() === '';
    if (blank(env.SSL_KEY_PATH)) env.SSL_KEY_PATH = ssl('privkey.pem');
    if (blank(env.SSL_CERT_PATH)) env.SSL_CERT_PATH = fs.existsSync(ssl('fullchain.pem')) ? ssl('fullchain.pem') : ssl('cert.pem');
}

/**
 * DATA_DIR, the .env of the data folder (the environment wins; refused when other users may change it) and, in the
 * bundle, the app folder for __dirname.
 */
function prepareEnvironment(options, { unpackWeb }) {
    const dataDir = dataDirFor(options);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    process.env.DATA_DIR = dataDir;
    process.env.MANGA_SHELF_NO_LISTEN = '1';
    if (options.noConsole) process.env.ADMIN_CONSOLE = 'false';
    const envFile = readEnvFile(dataDir);
    if (envFile.problem) throw new Error(envFile.problem);
    if (envFile.content) {
        const dotenv = require('dotenv');
        dotenv.populate(process.env, dotenv.parse(envFile.content));
    }
    applySslDefaults(dataDir);
    if (BUNDLED) {
        const { webSource, prepareAppDir, appDirFor } = require('./webAssets');
        const source = webSource(__dirname);
        const cacheDir = defaultCacheDir();
        let appDir = appDirFor(cacheDir, source ? source.id : 'ohne-portal');
        if (source && unpackWeb) {
            fs.mkdirSync(cacheDir, { recursive: true });
            appDir = prepareAppDir({ cacheDir, source, dataDir });
        }
        globalThis.__MANGA_SHELF_APP_DIR__ = appDir;
    }
    return dataDir;
}

async function runService(command, options) {
    if (!isSea()) throw new UsageError(`${command} nur mit der gebauten Binärdatei (manga-shelf-server-…)`);
    const { installPlan, uninstallPlan, runPlan } = require('./services');
    const ctx = { platform: process.platform, options, execPath: process.execPath, env: process.env, uid: process.getuid ? process.getuid() : null };
    runPlan(command === 'install-service' ? installPlan(ctx) : uninstallPlan(ctx));
    return 0;
}

/** Windows: owner-only ACLs for secret.key, reset-*.txt and the log; never stops the server. */
function windowsPrivateFiles(dataDir) {
    if (process.platform !== 'win32') return () => {};
    return (files = null) => {
        try {
            const failed = restrictWindowsFiles(dataDir, { files });
            if (failed.length) err(`Rechte nicht eingeschränkt: ${failed.join(', ')}`);
        } catch (e) {
            err(`Rechte nicht eingeschränkt: ${e.message}`);
        }
    };
}

async function runConsole(args, options) {
    const dataDir = prepareEnvironment(options, { unpackWeb: false });
    const admin = require('../admin.js');
    try {
        return await admin.main(args);
    } finally {
        try { require('../../db').closeDb(); } catch (e) { /* never opened */ }
        if (process.platform === 'win32') windowsPrivateFiles(dataDir)(fs.readdirSync(dataDir).filter((n) => /^reset-.*\.txt$/.test(n)));
    }
}

async function startServer(options) {
    const dataDir = prepareEnvironment(options, { unpackWeb: true });
    const restrict = windowsPrivateFiles(dataDir);
    if (options.logFile) {
        const { createRotatingLog, teeStreams } = require('./logFile');
        teeStreams(createRotatingLog(path.join(dataDir, 'logs'), process.platform === 'win32' ? { onOpen: (file) => restrict([file]) } : {}));
    }
    const server = require('../../index.js');
    const update = require('../../services/update');
    update.useWindowsAcl(require('./acl'));
    const log = require('../../utils/logger').child('server-bin');
    let started;
    try {
        started = await server.start({
            host: options.host || '0.0.0.0',
            ...(options.port !== null ? { port: options.port } : {})
        });
    } catch (e) {
        updatePrelude.markListenFailed(e);
        throw e;
    }
    updatePrelude.markStarted();
    out(`Manga Shelf Server v${version()} läuft auf ${started.url} (Port ${started.port}, Daten: ${dataDir})`);
    restrict();
    update.registerRestart(() => server.stop());

    let stopping = false;
    const shutdown = (code) => {
        if (stopping || update.lock.currentPhase() === 'restarting') return;
        stopping = true;
        process.exitCode = code;
        setTimeout(() => process.exit(code || 1), STOP_DEADLINE_MS).unref();
        server.stop().then(() => process.exit(code), (e) => {
            log.error('Beenden fehlgeschlagen:', e);
            process.exit(1);
        });
    };
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
    process.on('unhandledRejection', (reason) => log.error('[Process] Unhandled promise rejection:', reason));
    process.on('uncaughtException', (e) => {
        log.error('[Process] Uncaught exception:', e);
        shutdown(1);
    });
    return null;
}

async function runRestore(file, options) {
    prepareEnvironment(options, { unpackWeb: false });
    return require('../../services/restoreOffline').restoreOffline(file, { allowNewerSchema: options.allowNewerSchema, out });
}

async function main(argv) {
    process.title = 'manga-shelf-server';
    const prelude = preludeOptions(argv);
    if (prelude) updatePrelude.run({ ...prelude, version: version() });
    const { command, args, options } = parseArgs(argv);
    if (command === 'help') {
        out(HELP);
        return 0;
    }
    if (command === 'version') {
        out(`manga-shelf-server v${version()} (Node ${process.version}, ${process.platform}-${process.arch})`);
        return 0;
    }
    if (command === 'install-service' || command === 'uninstall-service') return runService(command, options);
    if (command === 'db-check') return require('../../services/restoreOffline').dbCheck(args[0], { out });
    if (command === 'restore') return runRestore(args[0], options);
    if (command === 'console') return runConsole(args, options);
    return startServer(options);
}

function run(argv) {
    return main(argv).then((code) => {
        if (code !== null) process.exitCode = code;
    }, (e) => {
        if (e instanceof UsageError) {
            err(e.message);
            process.exitCode = 2;
            return;
        }
        err(`Fehler: ${e && e.message ? e.message : e}`);
        process.exit(e && e.code === 'SCHEMA_NEWER' ? e.exitCode : 1);
    });
}

if (require.main === module) run(process.argv.slice(2));

module.exports = { main, run, applySslDefaults, prepareEnvironment };
