// Error contract: German `error` text unchanged, dynamic messages add { msg, params } for the client's catalog
// (core/errors.js msg()). The source scan fails on any error message built from a template literal or concatenation
// (and on a msg() whose template is built that way): the client looks texts up by their literal source text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const errors = require('../core/errors');

const ROOT = path.join(__dirname, '..');

test('msg() fills {name} like a template literal and keeps template and params for the client', () => {
    const m = errors.msg('Zu viele Einträge (maximal {max_entries})', { max_entries: 500 });
    assert.equal(m.text, 'Zu viele Einträge (maximal 500)');
    assert.equal(String(m), 'Zu viele Einträge (maximal 500)');
    assert.equal(errors.fill('{a} und {b}', { a: 1 }), '1 und {b}', 'unknown names stay');
    assert.equal(errors.fill('Wert {v}', { v: null }), 'Wert null', 'same as `${null}`');
    const err = errors.badRequest(m, 'TOO_MANY');
    assert.equal(err.message, 'Zu viele Einträge (maximal 500)');
    assert.deepEqual(errors.errorAnswer(err), {
        status: 400,
        body: { error: 'Zu viele Einträge (maximal 500)', code: 'TOO_MANY', msg: 'Zu viele Einträge (maximal {max_entries})', params: { max_entries: 500 } }
    });
});

test('plain texts keep their body; extra fields stay next to msg/params', () => {
    assert.deepEqual(errors.errorAnswer(errors.badRequest('Titel darf nicht leer sein')).body, { error: 'Titel darf nicht leer sein', code: 'BAD_REQUEST' });
    assert.deepEqual(errors.errorAnswer(errors.notFound('Band')).body, { error: 'Band nicht gefunden', code: 'NOT_FOUND' });
    const body = errors.errorBody({ id: 'r1' }, 503, errors.msg('{n} Monate fehlen', { n: 2 }), 'X', { months: 2 });
    assert.deepEqual(body, { error: '2 Monate fehlen', code: 'X', msg: '{n} Monate fehlen', params: { n: 2 }, months: 2, ref: 'r1' });
    const conflict = errors.conflict(errors.msg('Band {number} gibt es schon', { number: '5' }), 'VOLUME_DUPLICATE', { existing_id: 9 });
    assert.deepEqual(conflict.extra, { msg: 'Band {number} gibt es schon', params: { number: '5' }, existing_id: 9 });
});

test('a nested msg() param keeps the German text and reaches the client as { msg, params }', () => {
    const reason = errors.msg('Kein Platz (frei: {free})', { free: '3 MB' });
    const body = errors.errorBody(null, 507, errors.msg('Fehler beim Wiederherstellen: {reason}', { reason }), 'INSUFFICIENT_SPACE');
    assert.equal(body.error, 'Fehler beim Wiederherstellen: Kein Platz (frei: 3 MB)');
    assert.deepEqual(JSON.parse(JSON.stringify(body)), {
        error: 'Fehler beim Wiederherstellen: Kein Platz (frei: 3 MB)',
        code: 'INSUFFICIENT_SPACE',
        msg: 'Fehler beim Wiederherstellen: {reason}',
        params: { reason: { msg: 'Kein Platz (frei: {free})', params: { free: '3 MB' } } }
    });
});

test('a hidden 500 carries neither the text nor the template of its message', () => {
    const m = errors.msg('{host} lässt Anfragen aus dem Browser nicht zu (CORS).', { host: 'api.example' });
    const plain = Object.assign(new Error(m.text), { code: 'CORS_BLOCKED', extra: { msg: m.template, params: m.params } });
    assert.deepEqual(errors.errorAnswer(plain, 'r1'), { status: 500, body: { error: 'Interner Serverfehler', code: 'INTERNAL_ERROR', ref: 'r1' } });
    // a status set on purpose (507 disk full) and an HttpError 5xx stay exposed with their template
    const full = Object.assign(new Error(m.text), { status: 507, extra: { msg: m.template, params: m.params } });
    assert.equal(errors.errorAnswer(full).body.msg, m.template);
    assert.equal(errors.errorAnswer(new errors.HttpError(502, m)).body.msg, m.template);
});

test('msgList: German list text unchanged, every item a nested message', () => {
    const list = errors.msgList(['Vorhanden', 'Erscheint bald']);
    assert.equal(list.text, 'Vorhanden, Erscheint bald');
    const body = JSON.parse(JSON.stringify(errors.errorAnswer(errors.badRequest(errors.msg('Ungültiger Status (erlaubt: {allowed})', { allowed: list }))).body));
    assert.deepEqual(body, {
        error: 'Ungültiger Status (erlaubt: Vorhanden, Erscheint bald)',
        code: 'BAD_REQUEST',
        msg: 'Ungültiger Status (erlaubt: {allowed})',
        params: { allowed: { msg: '{v0}, {v1}', params: { v0: { msg: 'Vorhanden', params: {} }, v1: { msg: 'Erscheint bald', params: {} } } } }
    });
});

test('ensureFreeSpace: one sentence per purpose, German text unchanged, msg/params for the body', (t) => {
    const disk = require('../utils/disk');
    t.mock.method(disk, 'freeBytes', () => 1024);
    const WHAT = { backup: 'das Backup', restore: 'die Wiederherstellung', inspect: 'die Prüfung des Backups', snapshot: 'den Snapshot', other: 'diesen Vorgang' };
    for (const [purpose, what] of Object.entries(WHAT)) {
        assert.throws(() => disk.ensureFreeSpace('/', 20 * 1024 * 1024, purpose), (e) => {
            assert.equal(e.message, `Nicht genug Speicherplatz auf dem Server für ${what} (frei: 0.0 MB, benötigt: 20 MB). Bitte Platz freigeben (z. B. alte Snapshots löschen) und erneut versuchen.`);
            assert.equal(e.status, 507);
            assert.equal(e.code, 'INSUFFICIENT_SPACE');
            assert.deepEqual(e.extra, { msg: disk.SPACE_TEXTS[purpose], params: { free: '0.0 MB', needed: '20 MB' } });
            return true;
        });
    }
});

const SCAN_DIRS = ['core', 'routes', 'middleware', 'services', 'utils', 'frontend/src/local'];
const CONSTRUCTORS = new Set(['badRequest', 'conflict', 'forbidden', 'notFound', 'httpError', 'HttpError', 'sendError', 'CsvFormatError', 'msg', 'notAZip', 'invalidBackup', 'invalidDbFile']);
// constructors that put their argument into a sentence as a param: it must be a msg(), never a German fragment
const PARAM_CONSTRUCTORS = new Set(['notAZip', 'invalidDbFile']);

function sources() {
    const files = [path.join(ROOT, 'index.js'), path.join(ROOT, 'db.js')];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(js|mjs|cjs)$/.test(entry.name)) files.push(full);
        }
    };
    for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir));
    // notFound's own '<subject> nicht gefunden' is the one template the client expands itself
    return files.filter((file) => file !== path.join(ROOT, 'core', 'errors.js'));
}

// the message argument: HttpError(status, msg), sendError(res, status, msg), httpError(status, msg), else the first
const messageArg = (name, args) => {
    if (name === 'sendError') return args[2];
    if (name === 'HttpError' || name === 'httpError') return args[1];
    return args[0];
};

const isText = (node) => Boolean(node) && ((node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral'
    || (node.type === 'BinaryExpression' && node.operator === '+' && (isText(node.left) || isText(node.right))));

function dynamicSites(acorn) {
    const found = [];
    const fragments = [];
    for (const file of sources()) {
        const code = fs.readFileSync(file, 'utf8');
        let ast;
        try {
            ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, locations: true });
        } catch (_) {
            ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true });
        }
        const visit = (node) => {
            if (!node || typeof node.type !== 'string') return;
            if (node.type === 'CallExpression' || node.type === 'NewExpression') {
                const callee = node.callee.type === 'Identifier' ? node.callee.name : node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name : null;
                if (callee && CONSTRUCTORS.has(callee)) {
                    const arg = messageArg(callee, node.arguments);
                    const dynamic = arg && ((arg.type === 'TemplateLiteral' && arg.expressions.length > 0) || (arg.type === 'BinaryExpression' && arg.operator === '+'));
                    if (dynamic) found.push(`${path.relative(ROOT, file)}:${node.loc.start.line} ${callee}`);
                    const where = `${path.relative(ROOT, file)}:${node.loc.start.line} ${callee}`;
                    if (PARAM_CONSTRUCTORS.has(callee) && isText(node.arguments[0])) fragments.push(where);
                    const params = callee === 'msg' && node.arguments[1];
                    if (params && params.type === 'ObjectExpression' && params.properties.some((p) => p.type === 'Property' && isText(p.value))) fragments.push(where);
                }
            }
            for (const key of Object.keys(node)) {
                if (key === 'loc') continue;
                const value = node[key];
                if (Array.isArray(value)) value.forEach(visit);
                else if (value && typeof value.type === 'string') visit(value);
            }
        };
        visit(ast);
    }
    return { found, fragments };
}

test('no error message is built by template or concatenation (msg() with a literal template instead)', (t) => {
    let acorn;
    try { acorn = require('acorn'); } catch (_) { t.skip('acorn is not installed'); return; }
    const sites = dynamicSites(acorn).found;
    assert.deepEqual(sites, [], `dynamische Fehlertexte ohne msg(); mit msg('… {name} …', { name }) bauen (Parameter sprachneutral: Zahlen, Feldschlüssel, API-Werte):\n${sites.join('\n')}`);
});

test('no German text fragment as a param (notAZip detail, literal msg() param values)', (t) => {
    let acorn;
    try { acorn = require('acorn'); } catch (_) { t.skip('acorn is not installed'); return; }
    const sites = dynamicSites(acorn).fragments;
    assert.deepEqual(sites, [], `Textteil als Parameter; als verschachteltes msg('…') übergeben:\n${sites.join('\n')}`);
});

// params are numbers, field keys, API values and user data (shown verbatim), or nested messages for translatable values
const GERMAN_LABEL = /^(Band|Schuber|Special|Notiz|Deutscher Titel|Cover|den |die |Vorhanden|Fehlt|Vorbestellt|Erscheint bald|Bestellt)/;
const isNeutral = (value) => typeof value === 'number' || (typeof value === 'string' && !GERMAN_LABEL.test(value))
    || (Boolean(value) && typeof value === 'object' && typeof value.msg === 'string' && Object.values(value.params).every(isNeutral));
const fillDeep = (template, params) => errors.fill(template, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v && typeof v === 'object' ? fillDeep(v.msg, v.params) : v])));
const nested = (template, params = {}) => ({ msg: template, params });

test('converted sites answer the same German text plus msg/params (in-memory core)', async () => {
    const { createMemoryCore } = require('./core/harness');
    const core = createMemoryCore();
    const editor = core.client('ed');
    try {
        const m = (await editor('POST', '/mangas', { title: 'Fehlervertrag' })).body.id;
        assert.equal((await editor('POST', '/volumes', { manga_id: m, volume_number: '1' })).status, 200);
        const dup = await editor('POST', '/volumes', { manga_id: m, volume_number: 'Band 1' });
        assert.deepEqual(dup.body, {
            error: 'Band 1 existiert bereits (Vorhanden). Bitte den vorhandenen Eintrag bearbeiten.',
            code: 'VOLUME_DUPLICATE',
            msg: 'Band {number} existiert bereits ({status}). Bitte den vorhandenen Eintrag bearbeiten.',
            params: { number: '1', status: nested('Vorhanden') },
            existing_id: dup.body.existing_id
        });

        const cover = await editor('PUT', `/mangas/${m}`, { cover_image: 'x'.repeat(2049) });
        assert.deepEqual(cover.body, { error: 'Cover ist zu lang (maximal 2048 Zeichen)', code: 'BAD_REQUEST', msg: 'Cover ist zu lang (maximal {max} Zeichen)', params: { max: 2048 } });
        // a per-field text without a number stays a plain literal (looked up by its text)
        assert.deepEqual((await editor('PUT', `/mangas/${m}`, { author: ['x'] })).body, { error: 'Autor muss ein Text sein', code: 'BAD_REQUEST' });
        assert.deepEqual((await editor('POST', '/anime', { title: 'A', manga_id: 'x' })).body, { error: 'Ungültige Reihen-ID', code: 'BAD_REQUEST' });

        const status = await editor('POST', '/volumes', { manga_id: m, volume_number: '2', status: 'Gekauft' });
        assert.equal(status.body.error, 'Ungültiger Status (erlaubt: Vorhanden, Fehlt, Vorbestellt, Erscheint bald, Bestellt)');
        assert.equal(status.body.msg, 'Ungültiger Status (erlaubt: {allowed})');
        assert.deepEqual(status.body.params.allowed.params.v4, nested('Bestellt'));
        const series = await editor('PUT', `/mangas/${m}`, { status: 'Irgendwas' });
        assert.equal(series.body.error, 'Ungültiger Status (erlaubt: Laufend, Abgeschlossen, Pausiert, Abgebrochen, Geplant)');
        assert.deepEqual(series.body.params.allowed.params.v0, nested('Laufend'));
        const collecting = await editor('PUT', `/mangas/${m}`, { collecting: 'nie' });
        assert.equal(collecting.body.error, 'Ungültiger Sammelstatus (erlaubt: aktiv, pausiert, abgebrochen)');
        assert.deepEqual(collecting.body.params.allowed.params.v1, nested('pausiert'));

        const csv = await editor('POST', '/import/csv', { csv: 'Reihe;Bandnummer\n"offen;1', dry_run: true });
        assert.deepEqual(csv.body, { error: 'Anführungszeichen ab Zeile 2 nicht geschlossen', code: 'CSV_FORMAT', msg: 'Anführungszeichen ab Zeile {line} nicht geschlossen', params: { line: 2 }, line: 2 });

        for (const body of [dup.body, cover.body, status.body, series.body, collecting.body, csv.body]) {
            assert.equal(fillDeep(body.msg, body.params), body.error);
            for (const value of Object.values(body.params)) assert.ok(isNeutral(value), `${body.msg}: ${value}`);
        }
    } finally {
        await core.close();
    }
});
