// Sealing and opening of stored secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { seal, open, SecretBoxError, UNREADABLE } = require('../utils/secretBox');

const SECRET = 'a'.repeat(48);

test('secretBox: sealed text opens again with the same secret', () => {
    const sealed = seal('mein-token', SECRET);
    assert.notEqual(sealed, 'mein-token');
    assert.ok(!Buffer.from(sealed, 'base64').toString('utf8').includes('mein-token'));
    assert.equal(open(sealed, SECRET), 'mein-token');
    assert.equal(open(seal('ü€😀', SECRET), SECRET), 'ü€😀');
});

test('secretBox: another secret or damaged data fails with a controlled error', () => {
    const sealed = seal('mein-token', SECRET);
    assert.throws(() => open(sealed, 'b'.repeat(48)), (err) => err instanceof SecretBoxError && err.message === UNREADABLE);
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] ^= 1;
    assert.throws(() => open(raw.toString('base64'), SECRET), SecretBoxError);
    assert.throws(() => open('kurz', SECRET), SecretBoxError);
});

test('secretBox: a fresh 12-byte IV per record', () => {
    const a = Buffer.from(seal('gleich', SECRET), 'base64');
    const b = Buffer.from(seal('gleich', SECRET), 'base64');
    assert.notDeepEqual(a.subarray(0, 12), b.subarray(0, 12));
    assert.notEqual(a.toString('base64'), b.toString('base64'));
    assert.equal(a.length, 12 + 16 + 'gleich'.length);
});
