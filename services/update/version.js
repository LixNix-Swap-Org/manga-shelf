const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** [major, minor, patch] of a strict 'X.Y.Z', else null. */
function parseVersion(value) {
    const m = typeof value === 'string' ? VERSION.exec(value) : null;
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 'X.Y.Z' of a strict tag 'vX.Y.Z', else null. */
function versionFromTag(tag) {
    const m = typeof tag === 'string' ? TAG.exec(tag) : null;
    return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Sign of a − b for two strict versions; null when either is unreadable. */
function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return null;
    return Math.sign(cmp(pa, pb));
}

const PARTIAL = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?$/;

function partial(text) {
    const m = PARTIAL.exec(text);
    if (!m) return null;
    const parts = [m[1], m[2], m[3]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)));
    if (parts[1] === null && parts[2] !== null) return null;
    const precision = parts[1] === null ? 1 : parts[2] === null ? 2 : 3;
    return { base: [parts[0], parts[1] ?? 0, parts[2] ?? 0], precision };
}

function bump(base, precision) {
    if (precision === 1) return [base[0] + 1, 0, 0];
    if (precision === 2) return [base[0], base[1] + 1, 0];
    return [base[0], base[1], base[2] + 1];
}

function comparatorSet(text) {
    const tests = [];
    for (const token of text.trim().split(/\s+/)) {
        if (token === '*' || token === 'x' || token === 'X') continue;
        const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
        if (!m) return null;
        const op = m[1] || '=';
        const p = partial(m[2]);
        if (!p) return null;
        const { base, precision } = p;
        if (op === '^') {
            const upper = base[0] > 0 || precision === 1 ? [base[0] + 1, 0, 0]
                : base[1] > 0 || precision === 2 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
            tests.push((v) => cmp(v, base) >= 0 && cmp(v, upper) < 0);
        } else if (op === '~') {
            const upper = precision === 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
            tests.push((v) => cmp(v, base) >= 0 && cmp(v, upper) < 0);
        } else if (op === '>=') {
            tests.push((v) => cmp(v, base) >= 0);
        } else if (op === '>') {
            const floor = precision === 3 ? null : bump(base, precision);
            tests.push(floor ? (v) => cmp(v, floor) >= 0 : (v) => cmp(v, base) > 0);
        } else if (op === '<') {
            tests.push((v) => cmp(v, base) < 0);
        } else if (op === '<=') {
            const ceiling = precision === 3 ? null : bump(base, precision);
            tests.push(ceiling ? (v) => cmp(v, ceiling) < 0 : (v) => cmp(v, base) <= 0);
        } else {
            const upper = precision === 3 ? null : bump(base, precision);
            tests.push(upper ? (v) => cmp(v, base) >= 0 && cmp(v, upper) < 0 : (v) => cmp(v, base) === 0);
        }
    }
    return tests;
}

/** true/false for `nodeVersion` ('v22.13.0' or '22.13.0') against an engines range; null when the range is not understood. */
function satisfiesRange(range, nodeVersion) {
    if (typeof range !== 'string' || range.length > 200) return null;
    const v = parseVersion(String(nodeVersion).replace(/^v/, ''));
    if (!v) return null;
    if (range.trim() === '') return true;
    if (/\s-\s/.test(range)) return null;
    let any = false;
    for (const alternative of range.split('||')) {
        const tests = comparatorSet(alternative);
        if (!tests) return null;
        if (tests.every((t) => t(v))) any = true;
    }
    return any;
}

module.exports = { parseVersion, versionFromTag, compareVersions, satisfiesRange };
