/**
 * Reads a query-string value as a plain string. `?a=1&a=2` or `?a[x]=1` would otherwise yield an
 * array/object and make string methods like trim() throw (500). Returns undefined if absent.
 */
function qstr(value) {
    if (Array.isArray(value)) value = value[0];
    if (value === undefined || value === null || typeof value === 'object') return undefined;
    return String(value);
}

module.exports = { qstr };
