// Shared target resolution and HTTP client for the scripts that talk to a running Manga Shelf instance.
// Precedence: command line, then REMOTE_URL, then REMOTE_HOST/REMOTE_PORT, then http://localhost:3000.

const net = require('net');

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);

/** This machine: localhost, *.localhost, ::1 and the numeric 127.0.0.0/8 range (a DNS name like 127.evil.example is not). */
function isLoopback(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost')) return true;
    return net.isIPv4(host) && host.startsWith('127.');
}

function parsePort(raw) {
    const text = String(raw).trim();
    const port = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Ungültiger Port "${raw}" (1-65535)`);
    return port;
}

// host/path followed by a query or fragment: an "@" after that belongs to the query, not to a user part. Without a
// ":" before the first "/" only: "user:2024/secret?x@nas" reads like host:port/path, but 2024 may start a password.
const PLAIN_AUTHORITY_WITH_PATH = /^[A-Za-z0-9.-]+\/[^?#@]*[?#]/;

/**
 * Hides everything between the scheme and the last "@" so no user:password part shows in messages, even one with
 * "#", "/" or "?" in the password. An "@" after a plain host (no port) and path before a "?" or "#" stays.
 */
function redactUrl(value) {
    const text = String(value);
    const [, scheme, rest] = /^((?:[^:/?#\s]*:\/\/)?)([\s\S]*)$/.exec(text);
    if (!rest.includes('@') || PLAIN_AUTHORITY_WITH_PATH.test(rest)) return text;
    return `${scheme}***@${rest.slice(rest.lastIndexOf('@') + 1)}`;
}

/** host or host:port as a URL; anything with a scheme, path or user part is refused (redacted). */
function hostUrl(host, port) {
    if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/.test(String(host))) {
        throw new Error(`Ungültiger Host "${redactUrl(host)}" (erwartet: Name oder Adresse, oder eine http(s)://-URL)`);
    }
    return parseUrl(`http://${host}:${parsePort(port)}`);
}

function parseUrl(raw) {
    // credentials come from REMOTE_USER/REMOTE_PASS. Checked before parsing: in "https://user:1234/pw@host" the
    // parser takes "user" as host and 1234 as port, so a parsed username/password would not reveal the password.
    if (String(raw).replace(/^[^:/?#\s]*:\/\//, '').includes('@')) {
        throw new Error('Zugangsdaten gehören nicht in die URL (kein "@"): REMOTE_USER und REMOTE_PASS verwenden');
    }
    let url;
    try {
        url = new URL(raw);
    } catch (e) {
        throw new Error(`Ungültige URL "${redactUrl(raw)}"`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Nur http:// oder https:// erlaubt: "${redactUrl(raw)}"`);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    url.search = '';
    url.hash = '';
    return url;
}

/**
 * Target instance from positional arguments (`<url>` or `<host> [port]`) and the environment.
 * `insecure` is true when credentials would travel over plain http to a host other than this machine.
 */
function resolveTarget(argv = process.argv.slice(2), env = process.env) {
    const [first, second] = argv.filter(a => !String(a).startsWith('--'));
    let url;
    let source;
    if (first && /^https?:\/\//i.test(first)) {
        url = parseUrl(first);
        source = 'Kommandozeile';
    } else if (first) {
        url = hostUrl(first, second || env.REMOTE_PORT || 3000);
        source = 'Kommandozeile';
    } else if (env.REMOTE_URL) {
        url = parseUrl(env.REMOTE_URL);
        source = 'REMOTE_URL';
    } else if (env.REMOTE_HOST) {
        url = hostUrl(env.REMOTE_HOST, env.REMOTE_PORT || 3000);
        source = 'REMOTE_HOST/REMOTE_PORT';
    } else {
        url = parseUrl(`http://localhost:${parsePort(env.REMOTE_PORT || 3000)}`);
        source = 'Standard';
    }
    return { baseUrl: url.href, source, insecure: url.protocol === 'http:' && !isLoopback(url.hostname) };
}

/** Refuses to send a password over plain http to another host unless REMOTE_ALLOW_HTTP=1. */
function assertSecureTarget(target, env = process.env) {
    if (target.insecure && !/^(1|true|yes)$/i.test(String(env.REMOTE_ALLOW_HTTP || ''))) {
        throw new Error(`${target.baseUrl} ist unverschlüsselt (http) und nicht lokal: das Passwort ginge im Klartext über das Netz. ` +
            'Nutze https://… (REMOTE_URL oder als Argument) oder setze REMOTE_ALLOW_HTTP=1.');
    }
}

function credentials(env = process.env) {
    return {
        username: env.REMOTE_USER || env.ADMIN_USER || 'admin',
        password: env.REMOTE_PASS || env.ADMIN_PASS || ''
    };
}

class RemoteClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.cookie = '';
    }

    url(p) {
        return new URL(String(p).replace(/^\//, ''), this.baseUrl).href;
    }

    async request(method, p, body) {
        const headers = {};
        if (this.cookie) headers.Cookie = this.cookie;
        let payload = body;
        if (body !== undefined && body !== null && !(body instanceof FormData)) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const res = await fetch(this.url(p), { method, headers, body: payload ?? undefined, redirect: 'manual' });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        return { status: res.status, ok: res.status >= 200 && res.status < 300, data, text, headers: res.headers };
    }

    async login(username, password) {
        const res = await this.request('POST', '/api/auth/login', { username, password });
        const cookies = res.headers.getSetCookie().map(c => c.split(';')[0]).filter(Boolean);
        if (!res.ok || cookies.length === 0) {
            throw new Error(`Login als "${username}" fehlgeschlagen (Status ${res.status}): ${res.data?.error || res.text || ''}`.trim());
        }
        this.cookie = cookies.join('; ');
        return res.data;
    }
}

module.exports = { resolveTarget, assertSecureTarget, credentials, parsePort, isLoopback, redactUrl, RemoteClient };
