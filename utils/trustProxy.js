/** Value for Express' `trust proxy` setting from the TRUST_PROXY environment variable (unset = true, the historic default). */
function parseTrustProxy(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return true;
    const value = String(raw).trim();
    if (/^true$/i.test(value)) return true;
    if (/^false$/i.test(value)) return false;
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    return value; // "loopback", "10.0.0.0/8, 172.16.0.0/12": passed through to Express
}

module.exports = { parseTrustProxy };
