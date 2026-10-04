const test = require('node:test');
const assert = require('node:assert/strict');
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
    assert.equal(redactUrl('https://shelf.example.com:8443/x#a@b'), 'https://shelf.example.com:8443/x#a@b');
    assert.equal(redactUrl('admin:geheim@nas'), '***@nas');
});
