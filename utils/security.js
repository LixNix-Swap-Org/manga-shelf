const dns = require('dns').promises;
const net = require('net');

/**
 * Checks whether an IP address belongs to a private, loopback, link-local,
 * multicast, or reserved range (protects against SSRF attacks).
 * @param {string} ip - IPv4 or IPv6 address string
 * @returns {boolean} true if private/reserved/loopback, false if public
 */
function isPrivateIp(ip) {
    if (!ip || typeof ip !== 'string') return true;

    let cleanIp = ip.trim();
    // Normalize IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    if (cleanIp.startsWith('::ffff:')) {
        cleanIp = cleanIp.substring(7);
    }

    const family = net.isIP(cleanIp);
    if (family === 4) {
        const parts = cleanIp.split('.').map(p => parseInt(p, 10));
        if (parts.length !== 4 || parts.some(isNaN)) return true;

        // 0.0.0.0/8 (Current network)
        if (parts[0] === 0) return true;
        // 10.0.0.0/8 (Private)
        if (parts[0] === 10) return true;
        // 127.0.0.0/8 (Loopback)
        if (parts[0] === 127) return true;
        // 169.254.0.0/16 (Link-local / Cloud metadata service)
        if (parts[0] === 169 && parts[1] === 254) return true;
        // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        // 192.168.0.0/16 (Private)
        if (parts[0] === 192 && parts[1] === 168) return true;
        // 100.64.0.0/10 (Shared address / Carrier NAT)
        if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
        // 192.0.0.0/24 (IETF Protocol Assignments)
        if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
        // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET documentation)
        if ((parts[0] === 192 && parts[1] === 0 && parts[2] === 2) ||
            (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
            (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)) return true;
        // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
        if (parts[0] >= 224) return true;

        return false;
    } else if (family === 6) {
        const lower = cleanIp.toLowerCase();
        // ::1 (Loopback) & :: (Unspecified)
        if (lower === '::1' || lower === '::') return true;
        // fc00::/7 (Unique local address)
        if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
        // fe80::/10 (Link-local unicast)
        if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;

        return false;
    }

    return true;
}

/**
 * Validates a remote URL and asserts it is safe to fetch (prevents SSRF).
 * Ensures protocol is http/https and resolved IP does not point to internal resources.
 * @param {string} urlString
 * @returns {Promise<URL>} Parsed URL if safe
 * @throws {Error} if URL is invalid or unsafe
 */
async function assertSafeRemoteUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') {
        throw new Error('Ungültige URL übergeben');
    }

    let parsed;
    try {
        parsed = new URL(urlString.trim());
    } catch (e) {
        throw new Error('Ungültiges URL-Format');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Nur HTTP- und HTTPS-Protokolle sind erlaubt');
    }

    const hostname = parsed.hostname.toLowerCase();

    // Check for empty hostname or localhost / internal domains
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        throw new Error('Zugriff auf lokale und interne Adressen ist blockiert');
    }

    // Direct IP address check
    if (net.isIP(hostname)) {
        if (isPrivateIp(hostname)) {
            throw new Error('Zugriff auf private und interne IP-Adressen ist blockiert');
        }
        return parsed;
    }

    // DNS Resolution to prevent DNS rebinding or private host resolution
    try {
        const addresses = await dns.lookup(hostname, { all: true });
        if (!addresses || addresses.length === 0) {
            throw new Error(`Hostname "${hostname}" konnte nicht aufgelöst werden`);
        }
        for (const addr of addresses) {
            if (isPrivateIp(addr.address)) {
                throw new Error(`Zugriff auf private und interne IP-Adressen (${addr.address}) ist blockiert`);
            }
        }
    } catch (err) {
        if (err.message && err.message.includes('blockiert')) {
            throw err;
        }
        throw new Error(`DNS-Auflösung für "${hostname}" fehlgeschlagen: ` + err.message);
    }

    return parsed;
}

module.exports = {
    isPrivateIp,
    assertSafeRemoteUrl
};
