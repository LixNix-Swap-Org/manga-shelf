// Docker HEALTHCHECK: probes /api/health on the port and protocol index.js actually uses.
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { X509Certificate } = require('crypto');

function sslFiles(env, appDir) {
    const keyPath = env.SSL_KEY_PATH || path.join(appDir, 'ssl', 'privkey.pem');
    const fullchain = path.join(appDir, 'ssl', 'fullchain.pem');
    const certPath = env.SSL_CERT_PATH || (fs.existsSync(fullchain) ? fullchain : path.join(appDir, 'ssl', 'cert.pem'));
    return { keyPath, certPath };
}

/** Same port and TLS choice as index.js: SERVER_PORT, then PORT, then 3000; HTTPS when key and cert files exist. */
function resolveListen(env = process.env, appDir = __dirname) {
    const port = Number(env.SERVER_PORT || env.PORT || 3000);
    const { keyPath, certPath } = sslFiles(env, appDir);
    return { port, tls: fs.existsSync(keyPath) && fs.existsSync(certPath) };
}

/** The name the leaf certificate is issued for: first DNS name, else first IP address, else the subject CN. */
function certificateName(cert) {
    const altNames = (cert.subjectAltName || '').split(', ');
    const first = (prefix) => altNames.filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length))[0];
    const cn = /^CN=(.+)$/m.exec(cert.subject || '');
    const name = first('DNS:') || first('IP Address:') || (cn ? cn[1] : null);
    return name && name.startsWith('*.') ? `healthcheck${name.slice(1)}` : name;
}

/** Trust for the HTTPS probe: public roots plus the server's own certificate file; null if unreadable. */
function serverTrust(certFile) {
    try {
        const pems = fs.readFileSync(certFile, 'utf8').match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g);
        if (!pems) return null;
        const leaf = new X509Certificate(pems[0]);
        const name = certificateName(leaf);
        const checkable = name && !tls.checkServerIdentity(name, leaf.toLegacyObject());
        return { ca: [...tls.rootCertificates, ...pems], name: checkable ? name : null, pin: leaf.fingerprint256 };
    } catch {
        return null;
    }
}

/** GET /api/health on 127.0.0.1; `trust` (from serverTrust) selects HTTPS, without it plain HTTP. */
function probe(trust, port, timeoutMs = 4000) {
    return new Promise(resolve => {
        const options = { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs };
        if (trust) {
            options.secureContext = tls.createSecureContext({ ca: trust.ca, allowPartialTrustChain: true });
            options.agent = new https.Agent({ maxCachedSessions: 0 });
            if (!trust.name) {
                options.checkServerIdentity = (host, cert) =>
                    (cert.fingerprint256 === trust.pin ? undefined : new Error('not the certificate from the server certificate file'));
            } else if (net.isIP(trust.name)) {
                options.checkServerIdentity = (host, cert) => tls.checkServerIdentity(trust.name, cert);
            } else {
                options.servername = trust.name;
            }
        }
        const req = (trust ? https : http).get(options, res => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
    });
}

async function check(env = process.env, appDir = __dirname) {
    const { port, tls: useTls } = resolveListen(env, appDir);
    const trust = useTls ? serverTrust(sslFiles(env, appDir).certPath) : null;
    if (await probe(trust, port)) return true;
    // index.js falls back to HTTP when it cannot read the certificate files
    return trust ? probe(null, port) : false;
}

if (require.main === module) {
    check().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { resolveListen, serverTrust, probe, check };
