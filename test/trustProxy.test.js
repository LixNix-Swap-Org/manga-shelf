const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { parseTrustProxy, DEFAULT_TRUST_PROXY } = require('../utils/trustProxy');

const trustFn = (setting) => {
    const app = express();
    app.set('trust proxy', setting);
    return app.get('trust proxy fn');
};

/** req.ip as Express computes it for a socket address and an X-Forwarded-For header. */
const clientIpFor = (setting, remoteAddress, forwardedFor) => {
    const app = express();
    app.set('trust proxy', setting);
    const socket = { remoteAddress };
    const req = Object.create(app.request, {
        app: { value: app },
        headers: { value: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} },
        socket: { value: socket },
        connection: { value: socket }
    });
    return req.ip;
};

test('unset or empty TRUST_PROXY trusts only a proxy on this host', () => {
    assert.equal(DEFAULT_TRUST_PROXY, 'loopback');
    for (const v of [undefined, null, '', '   ']) assert.equal(parseTrustProxy(v), DEFAULT_TRUST_PROXY, String(v));
    const trusted = trustFn(parseTrustProxy(undefined));
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(trusted(ip, 0), true, ip);
    for (const ip of ['172.17.0.1', '10.0.0.2', '192.168.1.10', '169.254.1.1', 'fd00::1', 'fe80::1', '203.0.113.9', '2001:db8::1']) {
        assert.equal(trusted(ip, 0), false, ip);
    }
});

test('with the default, a LAN, link-local or Docker-gateway peer cannot pick its address through X-Forwarded-For', () => {
    const def = parseTrustProxy(undefined);
    assert.equal(clientIpFor(def, 'fe80::1', '::1'), 'fe80::1');
    assert.equal(clientIpFor(def, '192.168.1.50', '192.168.1.10'), '192.168.1.50');
    assert.equal(clientIpFor(def, '172.17.0.1', '198.51.100.1, 192.168.1.10'), '172.17.0.1');
    // a proxy on this host still passes the client on
    assert.equal(clientIpFor(def, '127.0.0.1', '198.51.100.7'), '198.51.100.7');
    assert.equal(clientIpFor(def, '127.0.0.1', '6.6.6.6, 198.51.100.7'), '198.51.100.7');
});

test('one trusted hop takes the address the proxy appended, not one the client sent', () => {
    assert.equal(clientIpFor(parseTrustProxy('1'), '172.18.0.2', '6.6.6.6, 198.51.100.7'), '198.51.100.7');
});

test('booleans, hop counts and address lists are parsed', () => {
    for (const v of ['true', 'TRUE', 'yes', 'ON', 'Yes']) assert.equal(parseTrustProxy(v), true, v);
    for (const v of ['false', 'no', 'OFF']) assert.equal(parseTrustProxy(v), false, v);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy(' 2 '), 2);
    assert.equal(parseTrustProxy('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
    assert.equal(parseTrustProxy('loopback'), 'loopback');
    for (const v of [undefined, 'yes', 'off', '3', 'loopback, uniquelocal', '172.16.0.0/12']) {
        assert.doesNotThrow(() => express().set('trust proxy', parseTrustProxy(v)), String(v));
    }
});

test('values Express cannot use stop the start with a German message', () => {
    for (const v of ['1.5', '-1', 'garbage', 'yes1', '10.0.0.0/99']) {
        assert.throws(() => parseTrustProxy(v), /^Error: TRUST_PROXY ungültig: /, v);
    }
});

test('loopback alone still ignores a proxy in another container', () => {
    const trusted = trustFn(parseTrustProxy('loopback'));
    assert.equal(trusted('127.0.0.1', 0), true);
    assert.equal(trusted('172.17.0.1', 0), false);
});

test('the documented proxy subnet passes the proxy on; a direct peer cannot pick its address, unlike with a hop count', () => {
    const recommended = parseTrustProxy('loopback, 172.18.0.0/16');
    assert.equal(clientIpFor(recommended, '172.18.0.5', '6.6.6.6, 198.51.100.7'), '198.51.100.7');
    assert.equal(clientIpFor(recommended, '203.0.113.9', '198.51.100.7'), '203.0.113.9');
    // why the docs demand a port reachable only through the proxy when a hop count is used
    assert.equal(clientIpFor(parseTrustProxy('1'), '203.0.113.9', '198.51.100.7'), '198.51.100.7');
});
