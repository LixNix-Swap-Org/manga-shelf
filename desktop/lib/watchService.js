const TOKEN_GAP_MS = 30000;

/** The Crunchyroll flow of the desktop: one run at a time, at most one token grant per 30 s, the login in its own store. */
function createWatchService({ createFlow, FlowError, crunchyroll, secret, transport, apiSession, randomUUID, now, isForeground }) {
    let lastTokenAt = null;
    let inflight = null;

    const flow = createFlow({
        send(request) {
            if (request && request.url === crunchyroll.ENDPOINTS.token) lastTokenAt = now();
            return transport(request);
        },
        readSecret: async () => secret.read(),
        writeSecret: async (value) => secret.write(value),
        deleteSecret: async () => secret.remove(),
        randomUUID: () => randomUUID(),
        now: () => now()
    });

    const failure = (err) => {
        if (err instanceof FlowError) return { ok: false, code: err.code };
        if (err && err.storeError) return { ok: false, code: err.code };
        return { ok: false, code: 'network' };
    };

    function status() {
        const { state, value } = secret.state();
        if (state === 'ok') return { ok: true, available: true, connected: crunchyroll.parseSecret(value) !== null };
        return { ok: true, available: false, reason: state, connected: state !== 'unavailable' };
    }

    async function run() {
        try {
            await apiSession.closeAllConnections();
            const { items } = await flow.history();
            return { ok: true, items };
        } catch (err) {
            return failure(err);
        } finally {
            await Promise.resolve().then(() => apiSession.clearStorageData()).catch(() => {});
        }
    }

    function sync() {
        if (!isForeground()) return Promise.resolve({ ok: false, code: 'background' });
        if (inflight) return inflight;
        if (lastTokenAt !== null) {
            const remainingMs = TOKEN_GAP_MS - (now() - lastTokenAt);
            if (remainingMs > 0) return Promise.resolve({ ok: false, code: 'too_soon', retryIn: Math.ceil(remainingMs / 1000) });
        }
        const current = run().finally(() => {
            if (inflight === current) inflight = null;
        });
        inflight = current;
        return current;
    }

    const connect = ({ etpRt, scriptResult, isCancelled }) => flow.connect({ etpRt, scriptResult, isCancelled });

    async function logout() {
        await flow.disconnect();
        return { ok: true };
    }

    return { status, sync, connect, logout };
}

module.exports = { createWatchService, TOKEN_GAP_MS };
