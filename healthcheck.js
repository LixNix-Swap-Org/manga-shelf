// Docker HEALTHCHECK: probes /api/health on the port and protocol index.js actually uses.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

/** Same port and TLS choice as index.js: SERVER_PORT, then PORT, then 3000; HTTPS when key and cert files exist. */
function resolveListen(env = process.env, appDir = __dirname) {
    const port = Number(env.SERVER_PORT || env.PORT || 3000);
    const keyPath = env.SSL_KEY_PATH || path.join(appDir, 'ssl', 'privkey.pem');
    const fullchain = path.join(appDir, 'ssl', 'fullchain.pem');
    const certPath = env.SSL_CERT_PATH || (fs.existsSync(fullchain) ? fullchain : path.join(appDir, 'ssl', 'cert.pem'));
    return { port, tls: fs.existsSync(keyPath) && fs.existsSync(certPath) };
}

function probe(useTls, port, timeoutMs = 4000) {
    return new Promise(resolve => {
        // the certificate is issued for the public host name, never for 127.0.0.1
        const req = (useTls ? https : http).get(
            { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs, rejectUnauthorized: false },
            res => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            }
        );
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
    });
}

async function check(env = process.env, appDir = __dirname) {
    const { port, tls } = resolveListen(env, appDir);
    if (await probe(tls, port)) return true;
    // index.js falls back to HTTP when it cannot read the certificate files
    return tls ? probe(false, port) : false;
}

if (require.main === module) {
    check().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { resolveListen, probe, check };
