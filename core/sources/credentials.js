// Where the core gets API keys from. The host plugs in a provider: the server keeps them encrypted in
// user_api_credentials (routes/apiKeys.js), the apps later in the device's secure storage. ctx.credentials wins over
// the registered provider; without either every request goes through the shared pool without a key.
//
// provider = {
//   get(userId, provider)      -> { secret, allowBackground } | null   personal key, readable and not disabled
//   instance(provider)         -> { secret, fromEnv } | null           instance key (environment or database)
//   background(provider)       -> [{ userId, secret }]                 personal keys released for background work
//   failed(userId, provider, message)                                   key refused by the provider: disable it
//   used(userId, provider, ok)                                          last use (the host throttles the writes)
//   status(userId, provider)   -> { configured, last_error } | null   for the "key disabled" hint
// }
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
