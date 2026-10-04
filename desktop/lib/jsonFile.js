const fs = require('fs');
const path = require('path');

/** Parsed JSON of `file`, or `fallback` when it is missing or broken. */
function readJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

/** Writes through a temp file and a rename, so a crash never leaves half a file behind. */
function writeJson(file, value, { mode = 0o600 } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
    fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson };
