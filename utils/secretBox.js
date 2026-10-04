// AES-256-GCM for stored API keys. The key is derived (HKDF-SHA256) from the session signing secret, so a database
// copy alone does not reveal them; whoever also has <DATA_DIR>/secret.key (or JWT_SECRET) can decrypt them.
const crypto = require('crypto');

const INFO = 'manga-shelf/api-credentials';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UNREADABLE = 'Schlüssel nicht mehr lesbar, bitte neu eintragen';

class SecretBoxError extends Error {
    constructor(message = UNREADABLE) {
        super(message);
        this.name = 'SecretBoxError';
    }
}

const keys = new Map();
function keyFor(secret) {
    if (typeof secret !== 'string' || !secret) throw new Error('secretBox: kein Geheimnis');
    if (!keys.has(secret)) keys.set(secret, Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), INFO, 32)));
    return keys.get(secret);
}

/** base64(iv | tag | ciphertext) with a fresh 12-byte IV per call. */
function seal(plaintext, secret) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** Plain text, or SecretBoxError when the data is damaged or was sealed with another secret. */
function open(sealed, secret) {
    try {
        const raw = Buffer.from(String(sealed), 'base64');
        if (raw.length < IV_BYTES + TAG_BYTES + 1) throw new Error('zu kurz');
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch (err) {
        throw new SecretBoxError();
    }
}

const serverSecret = () => require('../middleware/auth').JWT_SECRET;

module.exports = {
    seal,
    open,
    sealForServer: (plaintext) => seal(plaintext, serverSecret()),
    openForServer: (sealed) => open(sealed, serverSecret()),
    SecretBoxError,
    UNREADABLE
};
