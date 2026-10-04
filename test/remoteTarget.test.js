// Remote script target resolution: secure URL checks, loopback detection, redaction.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveTarget, assertSecureTarget, isLoopback, redactUrl } = require('../scripts/lib/remote');

test('loopback: only numeric 127/8, ::1, localhost and *.localhost count as this machine', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'localhost.']) {
        assert.equal(isLoopback(host), true, host);
    }
    for (const host of ['127.attacker.example', '127.0.0.1.nip.io', '127.0.0.1.example', 'evil.example', '10.0.0.1', 'localhost.evil.example']) {
        assert.equal(isLoopback(host), false, host);
    }
});

test('plain http to a DNS name that only starts with 127. is refused', () => {
    for (const argv of [['127.attacker.example'], ['http://127.0.0.1.nip.io:3000']]) {
        const target = resolveTarget(argv, {});
        assert.equal(target.insecure, true, argv[0]);
        assert.throws(() => assertSecureTarget(target, {}), /unverschlüsselt/);
    }
    assert.equal(resolveTarget(['http://127.0.0.1:3000'], {}).insecure, false);
});

test('a URL with user:password is rejected, so the password never reaches the log', () => {
    assert.throws(() => resolveTarget(['https://admin:geheim@shelf.example'], {}), (err) => /REMOTE_USER/.test(err.message) && !err.message.includes('geheim'));
    assert.throws(() => resolveTarget([], { REMOTE_URL: 'https://admin@shelf.example' }), /Zugangsdaten/);
});

test('no thrown message shows a password, whatever part of the target is broken', () => {
    const cases = [
        [['https://admin:geheim@shelf.example:70000/'], {}],
        [['https://admin:ge heim@shelf.example'], {}],
        [['ftp://admin:geheim@shelf.example/'], {}],
        [['admin:geheim@shelf.example'], {}],
        [[], { REMOTE_URL: 'https://admin:geheim@shelf.example:99999' }],
        [[], { REMOTE_HOST: 'admin:geheim@shelf.example' }]
    ];
    for (const [argv, env] of cases) {
        assert.throws(() => resolveTarget(argv, env), (err) => !err.message.includes('geheim') && !err.message.includes('ge heim'), JSON.stringify([argv, env]));
    }
    assert.equal(redactUrl('https://a:b@host/p@q'), 'https://***@q');
    assert.equal(redactUrl('http://host:3000/'), 'http://host:3000/');
});

test('passwords with "#", "/", "?" or "@" never appear in a message, whichever variable holds them', () => {
    const secrets = ['pa#ss', 'pa/ss', 'pa?ss', 'geheim#1', 'pa@ss#x'];
    for (const secret of secrets) {
        const cases = [
            [[`https://admin:${secret}@nas.example`], {}],
            [[`http://admin:${secret}@nas.example:3000/`], {}],
            [[], { REMOTE_URL: `https://admin:${secret}@nas.example` }],
            [[], { REMOTE_HOST: `admin:${secret}@nas` }],
            [[`admin:${secret}@nas`, '3000'], {}]
        ];
        for (const [argv, env] of cases) {
            assert.throws(() => resolveTarget(argv, env), (err) => !err.message.includes(secret) && !err.message.includes('admin:'),
                JSON.stringify([argv, env]));
        }
        assert.equal(redactUrl(`https://admin:${secret}@nas.example`), 'https://***@nas.example');
    }
});

test('any "@" in a target URL is refused before parsing, so a password with "/", "#" or "?" never picks the host', () => {
    const urls = [
        'https://admin:2024/geheim@shelf.example.com',
        'https://admin:2024#geheim@shelf.example.com',
        'https://admin:2024?geheim@shelf.example.com',
        'http://admin:2024/geheim@shelf.example.com:3000/'
    ];
    for (const raw of urls) {
        for (const [argv, env] of [[[raw], {}], [[], { REMOTE_URL: raw }]]) {
            assert.throws(() => resolveTarget(argv, env), (err) => /Zugangsdaten/.test(err.message) && !err.message.includes('geheim'),
                JSON.stringify([argv, env]));
        }
    }
});

test('redactUrl hides a user part, but an "@" in the query after a host and path keeps the host readable', () => {
    assert.equal(redactUrl('https://admin:2024/geheim@shelf.example.com'), 'https://***@shelf.example.com');
    assert.equal(redactUrl('https://admin:2024#geheim@shelf.example.com'), 'https://***@shelf.example.com');
    assert.equal(redactUrl('https://admin:2024?geheim@shelf.example.com'), 'https://***@shelf.example.com');
    assert.equal(redactUrl('https://shelf.example.com/x?mail=a@b.de'), 'https://shelf.example.com/x?mail=a@b.de');
    // a port before the path looks like user:password, so the cautious form wins
    assert.equal(redactUrl('https://shelf.example.com:8443/x#a@b'), 'https://***@b');
    assert.equal(redactUrl('admin:geheim@nas'), '***@nas');
});

test('a user:digits part with "/" and "?" or "#" in the password never shows up in a message', () => {
    assert.equal(redactUrl('admin:2024/s3cret?x@nas'), '***@nas');
    assert.equal(redactUrl('ftp://admin:2024/secret#x@nas.local'), 'ftp://***@nas.local');
    for (const [argv, env] of [
        [['ftp://admin:2024/secret#x@nas.local'], {}],
        [['admin:2024/s3cret?x@nas'], {}],
        [[], { REMOTE_HOST: 'admin:2024/s3cret?x@nas' }]
    ]) {
        assert.throws(() => resolveTarget(argv, env), (err) => {
            assert.match(err.message, /^Ungültiger Host/);
            assert.doesNotMatch(err.message, /secret|s3cret|2024/);
            return true;
        });
    }
});

describe('verify-remote.js follows the same rules', () => {
    const { prepare } = require('../scripts/verify-remote');

    test('argument before REMOTE_URL before REMOTE_HOST; REMOTE_USER/REMOTE_PASS before ADMIN_USER/ADMIN_PASS', () => {
        const env = { REMOTE_URL: 'https://shelf.example/app', REMOTE_HOST: 'nas.example', REMOTE_USER: 'kim', REMOTE_PASS: 'a', ADMIN_USER: 'admin', ADMIN_PASS: 'b' };
        const fromUrl = prepare([], env);
        assert.equal(fromUrl.target.baseUrl, 'https://shelf.example/app/');
        assert.equal(fromUrl.target.source, 'REMOTE_URL');
        assert.deepEqual([fromUrl.username, fromUrl.password], ['kim', 'a']);
        assert.equal(prepare(['localhost', '3005'], env).target.baseUrl, 'http://localhost:3005/');
        assert.equal(prepare(['https://other.example'], env).target.baseUrl, 'https://other.example/');
        const fallback = prepare([], { ADMIN_USER: 'admin', ADMIN_PASS: 'b' });
        assert.deepEqual([fallback.target.baseUrl, fallback.username, fallback.password], ['http://localhost:3000/', 'admin', 'b']);
    });

    test('plain http to another host is refused unless REMOTE_ALLOW_HTTP=1; credentials in the URL are refused', () => {
        assert.throws(() => prepare([], { REMOTE_HOST: 'nas.example.org', REMOTE_PASS: 'geheim' }), /unverschlüsselt/);
        assert.throws(() => prepare(['http://192.168.1.5:3000'], {}), /unverschlüsselt/);
        assert.equal(prepare([], { REMOTE_HOST: 'nas.example.org', REMOTE_ALLOW_HTTP: '1' }).target.baseUrl, 'http://nas.example.org:3000/');
        assert.throws(() => prepare(['https://admin:geheim@shelf.example'], {}), (err) => /Zugangsdaten/.test(err.message) && !err.message.includes('geheim'));
    });

    test('the script stops before any browser starts and never prints the password', () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-verify-remote-'));
        try {
            const env = { ...process.env, REMOTE_HOST: 'nas.example.org', REMOTE_PASS: 'geheim-123', CHROME_BIN: path.join(cwd, 'kein-browser') };
            for (const name of ['REMOTE_URL', 'REMOTE_ALLOW_HTTP', 'REMOTE_USER', 'ADMIN_PASS']) delete env[name];
            const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'verify-remote.js')], { cwd, encoding: 'utf8', env });
            assert.equal(run.status, 1, run.stderr);
            assert.match(run.stderr, /unverschlüsselt/);
            assert.doesNotMatch(run.stdout + run.stderr, /geheim-123/);
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
