// Small dependency-free logger.
//
//   LOG_LEVEL   debug | info (default) | warn | error | silent
//   LOG_FORMAT  text (default, readable in the Pterodactyl console) | json (one object per line)
//
// Usage:  const log = require('../utils/logger').child('backup');
//         log.warn('WAL checkpoint failed', err);          // Error -> message + stack
//         log.info('Restored snapshot', { file, mangas }); // plain object -> context fields
//
// The server start banner (matched by the Pterodactyl egg's "done" strings) intentionally stays on console.log.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serializeError(err) {
    return { message: err.message, ...(err.code ? { code: err.code } : {}), stack: err.stack };
}

/**
 * Splits console-style extra arguments into an error, structured context and trailing message text.
 */
function splitArgs(args) {
    let error = null;
    const ctx = {};
    const text = [];
    for (const arg of args) {
        if (arg instanceof Error) {
            if (!error) error = arg; else text.push(arg.message);
        } else if (arg && typeof arg === 'object') {
            Object.assign(ctx, arg);
        } else if (arg !== undefined) {
            text.push(String(arg));
        }
    }
    return { error, ctx, text };
}

function createLogger({ level = 'info', format = 'text', write, component } = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info;
    const sink = write || ((lvl, line) => {
        const stream = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
        stream(line);
    });

    function emit(lvl, message, args) {
        if (LEVELS[lvl] < threshold) return;
        const { error, ctx, text } = splitArgs(args);
        const msg = [message, ...text].join(' ');
        const time = new Date().toISOString();
        if (format === 'json') {
            const entry = { time, level: lvl, ...(component ? { component } : {}), msg, ...ctx };
            if (error) entry.err = serializeError(error);
            sink(lvl, JSON.stringify(entry));
            return;
        }
        let line = `${time} ${lvl.toUpperCase().padEnd(5)}${component ? ` [${component}]` : ''} ${msg}`;
        const ctxKeys = Object.keys(ctx);
        if (ctxKeys.length) line += ' ' + ctxKeys.map((k) => `${k}=${typeof ctx[k] === 'string' ? ctx[k] : JSON.stringify(ctx[k])}`).join(' ');
        if (error) line += `: ${error.message}` + (lvl === 'error' || threshold <= LEVELS.debug ? `\n${error.stack}` : '');
        sink(lvl, line);
    }

    return {
        debug: (msg, ...args) => emit('debug', msg, args),
        info: (msg, ...args) => emit('info', msg, args),
        warn: (msg, ...args) => emit('warn', msg, args),
        error: (msg, ...args) => emit('error', msg, args),
        child: (name) => createLogger({ level, format, write, component: component ? `${component}:${name}` : name })
    };
}

const root = createLogger({
    level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
    format: (process.env.LOG_FORMAT || 'text').toLowerCase()
});

module.exports = { ...root, createLogger };
