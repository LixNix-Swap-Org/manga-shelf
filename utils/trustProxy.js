const express = require('express');

// Only a proxy on this host may set the client address. Trusting private ranges would let every LAN, link-local or
// Docker-gateway peer (docker-proxy forwards IPv6 clients as 172.x.0.1) pick its own req.ip through X-Forwarded-For
// and walk around the per-IP limits. Setups with a proxy elsewhere set a hop count or the proxy's subnet.
const DEFAULT_TRUST_PROXY = 'loopback';

const ALLOWED = 'erlaubt: true/false, Anzahl Proxys (z. B. 1) oder Adressen/Subnetze wie "loopback, uniquelocal" oder "172.16.0.0/12"';

/** Value for Express' `trust proxy` setting from the TRUST_PROXY environment variable. Throws on values Express cannot use. */
function parseTrustProxy(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TRUST_PROXY;
    const value = String(raw).trim();
    if (/^(true|yes|on)$/i.test(value)) return true;
    if (/^(false|no|off)$/i.test(value)) return false;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    try {
        express().set('trust proxy', value);
    } catch (e) {
        throw new Error(`TRUST_PROXY ungültig: "${value}" (${ALLOWED})`);
    }
    return value;
}

module.exports = { parseTrustProxy, DEFAULT_TRUST_PROXY };
