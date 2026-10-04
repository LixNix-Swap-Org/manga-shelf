// --log-file: everything written to stdout/stderr also goes to <dir>/manga-shelf.log; at maxBytes the file is
// rotated (manga-shelf.log.1 … .<keep>). The log holds the first-run setup code: owner-only (0600; on Windows
// onOpen restricts the ACL).
const fs = require('fs');
const path = require('path');

function openPrivate(file, onOpen) {
    const fd = fs.openSync(file, 'a', 0o600);
    if (process.platform !== 'win32' && (fs.fstatSync(fd).mode & 0o077)) fs.fchmodSync(fd, 0o600);
    onOpen?.(file);
    return fd;
}

function createRotatingLog(dir, { name = 'manga-shelf.log', maxBytes = 10 * 1024 * 1024, keep = 5, onOpen = null } = {}) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, name);
    let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    let fd = openPrivate(file, onOpen);

    function rotate() {
        fs.closeSync(fd);
        for (let i = keep - 1; i >= 1; i--) {
            const from = `${file}.${i}`;
            if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
        }
        fs.renameSync(file, `${file}.1`);
        fd = openPrivate(file, onOpen);
        size = 0;
    }

    function write(chunk) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        try {
            if (size > 0 && size + buf.length > maxBytes) rotate();
            fs.writeSync(fd, buf);
            size += buf.length;
        } catch (e) {
            // a full disk must not take the server down with it
        }
    }

    return { file, write, close: () => fs.closeSync(fd) };
}

/** Copies every write of the given streams into the log; returns a function that undoes it. */
function teeStreams(log, streams = [process.stdout, process.stderr]) {
    const originals = streams.map((stream) => stream.write);
    streams.forEach((stream, i) => {
        stream.write = function (chunk, encoding, callback) {
            log.write(typeof chunk === 'string' && typeof encoding === 'string' ? Buffer.from(chunk, encoding) : chunk);
            return originals[i].call(this, chunk, encoding, callback);
        };
    });
    return () => streams.forEach((stream, i) => { stream.write = originals[i]; });
}

module.exports = { createRotatingLog, teeStreams };
