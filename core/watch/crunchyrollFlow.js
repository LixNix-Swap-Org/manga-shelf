const crunchyroll = require('./crunchyroll');

class FlowError extends Error {
    constructor(code) {
        super(code);
        this.name = 'FlowError';
        this.code = code;
    }
}

const sendFailure = (err) => new FlowError(err && err.code === 'not_allowed' ? 'bad_response' : 'network');

/** Login, history and logout of one device against Crunchyroll, fenced by a generation that connect and disconnect bump. */
function createFlow({ send, readSecret, writeSecret, deleteSecret, randomUUID, now }) {
    let generation = 0;
    let inflight = null;

    const stored = async () => crunchyroll.parseSecret(await readSecret());

    async function connect({ etpRt, scriptResult, isCancelled } = {}) {
        const gen = generation;
        const previous = await stored();
        const secret = crunchyroll.parseSecret(crunchyroll.secretFromLogin(
            { cookie: { value: etpRt }, scriptResult },
            { deviceId: (previous && previous.device_id) || randomUUID(), now: now() }
        ));
        if (!secret) throw new FlowError('bad_response');
        if (typeof isCancelled === 'function' && isCancelled()) throw new FlowError('cancelled');
        if (gen !== generation) throw new FlowError('stale');
        generation += 1;
        await writeSecret(secret);
    }

    async function run(gen) {
        const live = () => {
            if (gen !== generation) throw new FlowError('stale');
        };
        const request = async (req) => {
            let res;
            try {
                res = await send(req);
            } catch (err) {
                live();
                throw sendFailure(err);
            }
            live();
            return res;
        };
        const fail = async (failure) => {
            const code = (failure && failure.error) || 'bad_response';
            if (code === 'reconnect') {
                live();
                await deleteSecret();
            }
            throw new FlowError(code);
        };
        const save = async (next) => {
            const value = crunchyroll.parseSecret({ ...next, saved_at: now() });
            live();
            await writeSecret(value);
            live();
            return value;
        };

        let secret = await stored();
        live();
        if (!secret) throw new FlowError('not_connected');
        const token = crunchyroll.parseTokenResponse(await request(crunchyroll.buildTokenRequest(secret)));
        if (!token.ok) return fail(token);
        if (token.etp_rt && token.etp_rt !== secret.etp_rt) secret = await save({ ...secret, etp_rt: token.etp_rt });
        let accountId = token.account_id || secret.account_id;
        if (!accountId) {
            const me = crunchyroll.parseMe(await request(crunchyroll.buildApiRequest(crunchyroll.ENDPOINTS.me, token.access_token)));
            if (!me.ok) return fail(me);
            accountId = me.account_id;
        }
        if (accountId !== secret.account_id) await save({ ...secret, account_id: accountId });

        const lists = [];
        let firstFailure = null;
        for (const urlOf of [crunchyroll.ENDPOINTS.watchHistory, crunchyroll.ENDPOINTS.discoverHistory]) {
            let parsed;
            try {
                parsed = crunchyroll.parseHistoryResponse(await request(crunchyroll.buildApiRequest(urlOf(accountId), token.access_token)));
            } catch (err) {
                if (!(err instanceof FlowError) || err.code === 'stale') throw err;
                parsed = { ok: false, error: err.code };
            }
            if (parsed.ok) lists.push(parsed.items);
            else if (!firstFailure) firstFailure = parsed;
        }
        if (!lists.length) return fail(firstFailure);
        live();
        return { items: crunchyroll.mergeItems(...lists).slice(0, crunchyroll.MAX_ITEMS) };
    }

    function history() {
        if (inflight && inflight.gen === generation) return inflight.promise;
        const entry = { gen: generation };
        entry.promise = run(entry.gen).finally(() => {
            if (inflight === entry) inflight = null;
        });
        inflight = entry;
        return entry.promise;
    }

    async function disconnect() {
        generation += 1;
        await deleteSecret();
    }

    const connected = async () => (await stored()) !== null;

    return { connect, history, disconnect, connected };
}

module.exports = { createFlow, FlowError };
