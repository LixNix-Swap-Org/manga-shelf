// Every module in core/ loads and runs in a context without Node: no fs/path/crypto/zlib/os/child_process, no
// process, Buffer, setImmediate or fetch, require() only reaches other files in core/, and nothing newer than the
// apps' es2020 floor (AbortSignal.any/timeout, Object.hasOwn). The probes in fixtures/ must fail lint and this loader.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..', '..');
const CORE = path.join(ROOT, 'core');
const FIXTURES = path.join(__dirname, 'fixtures');

function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return jsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

/** The probes as the core files they pretend to be: fixtures/lib/x.js is checked as core/lib/x.js. */
const probes = () => new Map(jsFiles(FIXTURES).map(file => [path.join(CORE, path.relative(FIXTURES, file)), fs.readFileSync(file, 'utf8')]));

// Web standards both hosts have (the browser and the app WebViews); nothing Node-specific
const WEB_GLOBALS = {
    URL, URLSearchParams, TextDecoder, TextEncoder, AbortController, AbortSignal, setTimeout, clearTimeout, DOMException
};
// newer than the apps' floor: hidden inside the context
const HIDDEN = new Map([[AbortSignal, new Set(['any', 'timeout'])]]);

/**
 * Host values reach the context only through proxies: every property read, call result and thrown error is wrapped
 * again, and the host's Function constructors turn into the context's own, so a constructor chain never reaches the
 * Node realm. Context functions handed to the host (listeners, timer callbacks) see wrapped arguments.
 */
function membrane(context) {
    const inside = (code) => vm.runInContext(code, context);
    const isInside = inside('(value) => value instanceof Object');
    const insideKinds = inside('[Function, (async () => {}).constructor, (function* () {}).constructor, (async function* () {}).constructor]');
    const hostKinds = [Function, (async () => {}).constructor, (function* () {}).constructor, (async function* () {}).constructor];
    const functionKinds = new Map(hostKinds.map((ctor, i) => [ctor, insideKinds[i]]));
    const InsideUint8Array = inside('Uint8Array');
    const proxies = new WeakMap();
    const targets = new WeakMap();
    const callbacks = new WeakMap();
    const callbackSources = new WeakMap();
    const isHidden = (target, key) => HIDDEN.has(target) && HIDDEN.get(target).has(key);

    const toInside = (value) => {
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
        if (functionKinds.has(value)) return functionKinds.get(value);
        if (callbackSources.has(value)) return callbackSources.get(value);
        if (targets.has(value) || isInside(value)) return value;
        if (value instanceof Uint8Array) return new InsideUint8Array(value);
        let proxy = proxies.get(value);
        if (!proxy) {
            proxy = new Proxy(value, handler);
            proxies.set(value, proxy);
            targets.set(proxy, value);
        }
        return proxy;
    };
    const toHost = (value) => {
        if (targets.has(value)) return targets.get(value);
        if (typeof value !== 'function' || !isInside(value)) return value;
        let wrapper = callbacks.get(value);
        if (!wrapper) {
            wrapper = function (...args) {
                return toHost(Reflect.apply(value, toInside(this), args.map(toInside)));
            };
            callbacks.set(value, wrapper);
            callbackSources.set(wrapper, value);
        }
        return wrapper;
    };
    const guarded = (fn) => {
        try {
            return toInside(fn());
        } catch (err) {
            throw toInside(err);
        }
    };
    const handler = {
        get: (target, key) => (isHidden(target, key) ? undefined : toInside(Reflect.get(target, key))),
        has: (target, key) => !isHidden(target, key) && Reflect.has(target, key),
        set: (target, key, value) => Reflect.set(target, key, toHost(value)),
        getPrototypeOf: (target) => toInside(Reflect.getPrototypeOf(target)),
        getOwnPropertyDescriptor: (target, key) => {
            if (isHidden(target, key)) return undefined;
            const desc = Reflect.getOwnPropertyDescriptor(target, key);
            if (desc) for (const part of ['value', 'get', 'set']) if (part in desc) desc[part] = toInside(desc[part]);
            return desc;
        },
        apply: (target, self, args) => guarded(() => Reflect.apply(target, toHost(self), args.map(toHost))),
        construct: (target, args, newTarget) => guarded(() => Reflect.construct(target, args.map(toHost), targets.get(newTarget) || newTarget))
    };
    return { toInside, inside };
}

/** Every require() literal of a source, resolved like the loader does; anything else is an error message. */
function staticRequires(file, source) {
    const found = [];
    const errors = [];
    const call = /(\.\s*)?\brequire\s*\(/g;
    let m;
    while ((m = call.exec(source))) {
        const literal = /^\s*(['"])([^'"\n]+)\1\s*\)/.exec(source.slice(m.index + m[0].length));
        if (m[1]) errors.push('module.require');
        else if (!literal) errors.push('require() ohne festen Pfad');
        else found.push(literal[2]);
    }
    return { specs: found, errors };
}

function resolveSpec(file, spec, exists) {
    const where = path.relative(CORE, file);
    if (!/^\.\.?\//.test(spec)) throw new Error(`${where} lädt "${spec}" (nur Dateien aus core/ erlaubt)`);
    let target = path.resolve(path.dirname(file), spec);
    if (path.relative(CORE, target).startsWith('..')) throw new Error(`${where} lädt "${spec}" außerhalb von core/`);
    if (!target.endsWith('.js')) target += exists(target + '.js') ? '.js' : '/index.js';
    if (!exists(target)) throw new Error(`${where} lädt "${spec}", die Datei gibt es nicht`);
    return target;
}

/** A loader with its own global object: require() resolves relative paths inside core/ only. */
function strippedLoader(extra = new Map()) {
    const context = vm.createContext({});
    const { toInside, inside } = membrane(context);
    for (const [name, value] of Object.entries(WEB_GLOBALS)) context[name] = toInside(value);
    inside('delete Object.hasOwn');
    const exists = (file) => extra.has(file) || fs.existsSync(file);
    const read = (file) => (extra.has(file) ? extra.get(file) : fs.readFileSync(file, 'utf8'));
    const cache = new Map();
    const load = (file) => {
        if (cache.has(file)) return cache.get(file).exports;
        const source = read(file);
        const { specs, errors } = staticRequires(file, source);
        if (errors.length) throw new Error(`${path.relative(CORE, file)}: ${errors.join(', ')}`);
        for (const spec of specs) resolveSpec(file, spec, exists);
        const module = inside('({ exports: {} })');
        cache.set(file, module);
        const fn = vm.runInContext(`(function (exports, require, module) {${source}\n})`, context, { filename: file });
        fn(module.exports, toInside((spec) => load(resolveSpec(file, spec, exists))), module);
        return module.exports;
    };
    return { load, context, inside };
}

test('every core module loads without Node globals and requires nothing outside core/', () => {
    const files = jsFiles(CORE);
    assert.ok(files.length >= 25, `only ${files.length} files found`);
    const { load } = strippedLoader();
    for (const file of files) {
        assert.doesNotThrow(() => load(file), (err) => `${path.relative(CORE, file)}: ${err.message}`);
    }
});

test('the loader refuses Node modules, packages and files outside core/', () => {
    const inline = [
        ['builtin.js', "require('fs');"],
        ['package.js', "require('express');"],
        ['outside.js', "require('../utils/logger');"],
        ['dynamic.js', 'const name = "fs"; require(name);'],
        ['global.js', 'module.exports = process.env;'],
        ['buffer.js', "module.exports = Buffer.from('x');"]
    ];
    const extra = new Map(inline.map(([name, source]) => [path.join(CORE, name), source]));
    const { load, inside } = strippedLoader(extra);
    for (const [name] of inline) {
        assert.throws(() => load(path.join(CORE, name)), /core\/|festen Pfad|is not defined/, name);
    }
    assert.equal(inside('typeof setImmediate + typeof fetch + typeof require + typeof process'), 'undefined'.repeat(4));
    assert.equal(inside('typeof AbortSignal.any + typeof AbortSignal.timeout + typeof Object.hasOwn'), 'undefined'.repeat(3));
});

test('the review probes fail the loader: requires are checked before they run, the host realm stays out of reach', () => {
    const extra = probes();
    const { load } = strippedLoader(extra);
    const at = (name) => path.join(CORE, name);
    assert.throws(() => load(at('globals.js')), /module\.require/);
    assert.throws(() => load(at('lib/parentPath.js')), /außerhalb von core\//);
    assert.throws(() => load(at('lazyRequire.js')), /außerhalb von core\//, 'a require inside a function that never runs');
    const escapes = load(at('realmEscape.js'));
    for (const [name, attempt] of Object.entries(escapes)) {
        assert.equal(attempt(), 'undefined', `${name} reached the Node realm`);
    }
});

test('the review probes and the es2020 floor fail the core lint rules', async () => {
    const { ESLint } = require('eslint');
    const eslint = new ESLint({ cwd: ROOT });
    const ruleErrors = async (source, filePath) => {
        const [result] = await eslint.lintText(source, { filePath });
        return result.messages.filter(msg => msg.severity === 2);
    };
    for (const [file, source] of probes()) {
        assert.ok((await ruleErrors(source, file)).length > 0, `${path.relative(CORE, file)} passes lint`);
    }
    for (const source of [
        'module.exports = AbortSignal.any([]);',
        'module.exports = AbortSignal.timeout(5);',
        "module.exports = Object.hasOwn({}, 'a');",
        "module.exports = globalThis['Buffer'];",
        "const load = require; module.exports = load('./x');",
        'let a = null; a ??= 1; module.exports = a;'
    ]) {
        assert.ok((await ruleErrors(source, path.join(CORE, 'lib', 'probe.js'))).length > 0, source);
    }
    assert.deepEqual(await ruleErrors("module.exports = [require('./x'), require('../errors')];", path.join(CORE, 'lib', 'probe.js')), []);
    assert.deepEqual(await ruleErrors("module.exports = require('./lib/x');", path.join(CORE, 'probe.js')), []);
});

test('the handlers run inside the stripped context against a host ctx (node:sqlite outside)', async () => {
    const { load } = strippedLoader();
    const { applySchema } = load(path.join(CORE, 'schema.js'));
    const { createCtx, withUser, dbFromConnection } = load(path.join(CORE, 'ctx.js'));
    const { dispatch } = load(path.join(CORE, 'routes.js'));

    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    applySchema(conn);
    conn.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run();
    const ctx = withUser(createCtx({ db: dbFromConnection(conn) }), { id: 1, username: 'admin', role: 'admin' });
    const call = (method, url, body) => dispatch(ctx, { method, url, body });

    const id = (await call('POST', '/mangas', { title: 'Sandbox' })).body.id;
    await call('POST', '/volumes/batch', { manga_id: id, from: 1, to: 3 });
    await call('POST', '/volumes', { manga_id: id, volume_number: '4', status: 'Vorbestellt', release_date: '2099-01' });
    const vol = (await call('GET', `/mangas/${id}`)).body.volumes[0];
    await call('POST', `/volumes/${vol.id}/read`, {});
    await call('POST', `/volumes/${vol.id}/owners`, { owned: false });
    await call('POST', `/volumes/${vol.id}/owners`, { owned: true, previous_purchase_date: null });
    for (const url of ['/mangas', '/offline-snapshot', '/stats', '/shopping-list?include_others=1&x=1&x=2', '/release-radar', '/dashboard-summary', '/users/1/stats', '/export/csv']) {
        const res = await call('GET', url);
        assert.equal(res.status, 200, url);
    }
    const dry = await call('POST', '/import/csv', { csv: 'Reihe;Bandnummer\nX;1', dry_run: true });
    assert.equal(dry.body.created_volumes, 1);
    // without ctx.http every catalogue fails like an unreachable one
    assert.equal((await call('GET', '/lookup/isbn?isbn=9783551023452')).body.found, false);

    // the Manga Passion client combines its timeouts without AbortSignal.any/timeout
    const signals = [];
    const http = {
        fetch: async (url, init) => {
            signals.push(init.signal);
            return { ok: true, status: 200, headers: new Headers(), json: async () => ({ 'hydra:member': [] }) };
        }
    };
    const withHttp = { ...ctx, http: { ...ctx.http, ...http } };
    const editions = await dispatch(withHttp, { method: 'GET', url: '/manga-passion/editions?title=Sandbox' });
    assert.equal(editions.status, 200);
    assert.ok(signals.length > 0 && signals.every(signal => signal && signal.aborted === false));
    conn.close();
});
