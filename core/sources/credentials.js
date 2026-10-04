// API key source: the host plugs in a provider (server: encrypted in the database; apps: secure storage); ctx.credentials wins.
// With neither, requests use the shared pool without a key. provider = { get(userId, p) -> {secret, allowBackground}|null,
//   instance(p) -> {secret, fromEnv}|null, background(p) -> [{userId, secret}], failed(userId, p, message),
//   used(userId, p, ok), status(userId, p) -> {configured, last_error}|null }
const NONE = {
    get: () => null,
    instance: () => null,
    background: () => [],
    failed: () => {},
    used: () => {},
    status: () => null
};

let registered = null;

function setCredentialProvider(provider) {
    registered = provider || null;
}

/** The provider of this ctx with every method present. */
function credentialsOf(ctx) {
    const p = (ctx && ctx.credentials) || registered;
    return p ? { ...NONE, ...p } : NONE;
}

module.exports = { setCredentialProvider, credentialsOf, NONE };
