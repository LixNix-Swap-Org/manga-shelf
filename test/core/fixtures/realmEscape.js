// probe 4: the Function constructor reached through injected host functions and objects
const viaTimer = () => setTimeout.constructor('return typeof process')();
const viaInstance = () => new URL('https://example.org/').constructor.constructor('return typeof process')();
const viaPrototype = () => Object.getPrototypeOf(new AbortController().signal).constructor.constructor('return typeof process')();
const viaRequire = () => require.constructor('return typeof process')();
const viaError = () => {
    try {
        new URL('kein url');
    } catch (err) {
        return err.constructor.constructor('return typeof process')();
    }
};
const viaEvent = () => {
    const controller = new AbortController();
    let seen;
    controller.signal.addEventListener('abort', (event) => { seen = event.constructor.constructor('return typeof process')(); });
    controller.abort();
    return seen;
};
module.exports = { viaTimer, viaInstance, viaPrototype, viaRequire, viaError, viaEvent };
