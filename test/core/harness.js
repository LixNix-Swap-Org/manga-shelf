// Two ways to call the endpoints of core/routes.js with the same client() API ({ status, body } plus raw() for text):
// the Express test server and an in-memory ctx (node:sqlite ':memory:') through core/routes.js dispatch().
const { DatabaseSync } = require('node:sqlite');
const { createCtx, withUser, dbFromConnection } = require('../../core/ctx');
const { applySchema } = require('../../core/schema');
const { dispatch } = require('../../core/routes');
const { errorAnswer } = require('../../core/errors');

const USERS = [
    { id: 1, username: 'admin', role: 'admin' },
    { id: 2, username: 'ed', role: 'editor' },
    { id: 3, username: 'vis', role: 'visitor' }
];
const PASSWORD = 'password123';

const offline = (url) => Object.assign(new TypeError(`fetch failed (offline in tests): ${url}`), { cause: { code: 'ENOTFOUND' } });

let aniList = null;

/**
 * Switches a fake graphql.anilist.co on for both harnesses ({ media: [AniList Media], search: { term: [ids] } }) or off
 * (null): every search alias (Page, s1, …) answers the ids listed for its term, id_in answers from `media`.
 */
function useAniList(fixtures) {
    aniList = fixtures || null;
}

function aniListAnswer(url, init) {
    if (!aniList || URL.parse(String(url))?.hostname !== 'graphql.anilist.co') return null;
    const { query, variables = {} } = JSON.parse(init.body);
    const byId = (id) => aniList.media.find((m) => m.id === id);
    let data;
    if (query.includes('id_in')) {
        data = { Page: { media: variables.ids.map(byId).filter(Boolean) } };
    } else {
        data = {};
        for (const [name, term] of Object.entries(variables)) {
            const i = Number(name.slice(1));
            data[i === 0 ? 'Page' : `s${i}`] = { media: ((aniList.search || {})[term] || []).map(byId).filter(Boolean) };
        }
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** No network: external lookups fail like an unreachable host (AniList answers from useAniList() while it is on). */
const offlineHttp = () => ({
    fetch: async (url, init) => {
        const fake = aniListAnswer(url, init);
        if (fake) return fake;
        throw offline(url);
    },
    fetchText: async (url) => { throw offline(url); },
    fetchImage: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }
});

function memoryFiles() {
    const files = new Map();
    return {
        files,
        write: async (name, bytes) => { files.set(name, bytes); },
        read: async (name) => files.get(name),
        stat: async (name) => (files.has(name) ? { size: files.get(name).length } : null),
        touch: async () => {},
        remove: async (name) => { files.delete(name); },
        list: async () => [...files.keys()]
    };
}

const roundTrip = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** In-memory core: schema from core/schema.js, the three users above, no network. `overrides` replaces ctx parts. */
function createMemoryCore(overrides = {}) {
    const conn = new DatabaseSync(':memory:');
    conn.exec('PRAGMA foreign_keys = ON;');
    applySchema(conn);
    const insert = conn.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)');
    for (const u of USERS) insert.run(u.id, u.username, 'not-a-hash', u.role);
    const files = memoryFiles();
    const ctx = createCtx({
        db: dbFromConnection(conn),
        files,
        http: offlineHttp(),
        config: { appTimeZone: 'Europe/Berlin', appVersion: 'test' },
        ...overrides
    });

    async function request(user, method, url, body) {
        try {
            const res = await dispatch(withUser(ctx, user), { method, url, body: roundTrip(body) });
            const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
            return { status: res.status, body: typeof res.body === 'string' ? null : JSON.parse(text), text, headers: res.headers };
        } catch (err) {
            const { status, body } = errorAnswer(err);
            // like the transports: nested msg() params arrive as plain { msg, params }
            const errBody = roundTrip(body);
            return { status, body: errBody, text: JSON.stringify(errBody), headers: {} };
        }
    }

    const client = (username) => {
        const user = username ? USERS.find(u => u.username === username) : null;
        const api = async (method, url, body) => {
            const res = await request(user, method, url, body);
            return { status: res.status, body: res.body };
        };
        api.raw = (method, url, body) => request(user, method, url, body);
        return api;
    };
    const run = (sql, ...params) => conn.prepare(sql).run(...params);
    return { kind: 'memory', conn, ctx, files, client, run, users: USERS, close: async () => conn.close() };
}

/**
 * The Express test server with the same three users (same ids) and global.fetch limited to the test server, so
 * external lookups fail like in the memory core.
 */
async function startExpressCore() {
    const { startTestServer } = require('../helpers');
    const server = await startTestServer();
    const realFetch = global.fetch;
    global.fetch = (url, init) => {
        if (String(url).startsWith(server.root)) return realFetch(url, init);
        const fake = aniListAnswer(url, init || {});
        return fake ? Promise.resolve(fake) : Promise.reject(offline(url));
    };

    const clients = {};
    clients.admin = server.client();
    const setup = await clients.admin('POST', '/setup', { username: 'admin', password: PASSWORD });
    if (setup.status !== 200) throw new Error('setup failed: ' + JSON.stringify(setup.body));
    for (const u of USERS.filter(u => u.role !== 'admin')) {
        const res = await clients.admin('POST', '/users', { username: u.username, password: PASSWORD, role: u.role });
        if (res.status !== 200 || res.body.user?.id !== u.id) throw new Error(`user ${u.username}: ${JSON.stringify(res.body)}`);
        clients[u.username] = server.client();
        await clients[u.username]('POST', '/auth/login', { username: u.username, password: PASSWORD });
    }

    const client = (username) => {
        const base = username ? clients[username] : server.client();
        const api = (method, url, body) => base(method, url, body);
        api.raw = async (method, url, body) => {
            const res = await realFetch(server.base + url, {
                method,
                headers: { 'Content-Type': 'application/json', ...(base.cookie ? { Cookie: base.cookie } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            // keep a BOM as the memory core does (res.text() drops it)
            const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
            let json = null;
            try { json = JSON.parse(text); } catch (e) { /* text body */ }
            return { status: res.status, body: json, text, headers: Object.fromEntries(res.headers) };
        };
        return api;
    };
    return {
        kind: 'express',
        server,
        client,
        // seeds what no endpoint of the core writes (e.g. a calendar feed token) straight into the server's database
        run: (sql, ...params) => require('../../db').db.prepare(sql).run(...params),
        users: USERS,
        close: async () => {
            global.fetch = realFetch;
            await server.close();
        }
    };
}

module.exports = { createMemoryCore, startExpressCore, USERS, offlineHttp, useAniList };
