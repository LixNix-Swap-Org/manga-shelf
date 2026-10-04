// Addresses other devices in the home network can use (menu "Adresse für andere Geräte", tray "Adresse kopieren").

const PRIVATE_V4 = [
    [/^10\./, 0],
    [/^192\.168\./, 0],
    [/^172\.(1[6-9]|2\d|3[01])\./, 0],
    [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 1],
    [/^169\.254\./, 3]
];
const VIRTUAL_NAME = /^(docker|br-|veth|vmnet|vboxnet|utun|awdl|llw|bridge|virbr|tailscale|zt)/i;

const rank = (address, name) => {
    const hit = PRIVATE_V4.find(([re]) => re.test(address));
    const base = hit ? hit[1] : 2;
    return base + (VIRTUAL_NAME.test(name) ? 4 : 0);
};

/** IPv4 addresses of `interfaces` (os.networkInterfaces()) without loopback, home network first. */
function lanAddresses(interfaces) {
    const found = [];
    for (const [name, list] of Object.entries(interfaces || {})) {
        for (const entry of list || []) {
            const v4 = entry && (entry.family === 'IPv4' || entry.family === 4);
            if (!v4 || entry.internal || !entry.address) continue;
            found.push({ address: entry.address, name, rank: rank(entry.address, name) });
        }
    }
    found.sort((a, b) => a.rank - b.rank || a.address.localeCompare(b.address, 'en', { numeric: true }));
    return [...new Set(found.map((f) => f.address))];
}

/** http://<address>:<port>, or null without a usable address (bound to loopback only). */
function serverAddress(host, port, interfaces) {
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return null;
    const address = host === '0.0.0.0' || host === '::' ? lanAddresses(interfaces)[0] : host;
    if (!address) return null;
    return `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
}

/** The link of the QR code (same format as frontend/src/app/deepLink.js buildConnectLink). */
function connectLink({ url, name, instanceId }) {
    const params = new URLSearchParams({ url });
    if (name) params.set('name', name);
    if (instanceId) params.set('id', instanceId);
    return `manga-shelf://connect?${params}`;
}

module.exports = { lanAddresses, serverAddress, connectLink };
