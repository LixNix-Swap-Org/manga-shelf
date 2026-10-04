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

const MAX_CAUSE_DEPTH = 5;

/** Error -> plain object, following err.cause and AggregateError.errors (Node's fetch hides ENOTFOUND etc. there). */
function serializeError(err, depth = 0) {
    if (!(err instanceof Error)) return err;
    const out = { message: err.message, ...(err.code ? { code: err.code } : {}), stack: err.stack };
    if (depth >= MAX_CAUSE_DEPTH) return out;
    if (err.cause !== undefined) out.cause = serializeError(err.cause, depth + 1);
    if (Array.isArray(err.errors) && err.errors.length) out.errors = err.errors.map(e => serializeError(e, depth + 1));
    return out;
}

/** JSON.stringify that never throws: circular references become '[Circular]', BigInt a string, Errors objects. */
function safeJson(value) {
    const ancestors = [];
    try {
        return JSON.stringify(value, function replacer(key, v) {
            if (typeof v === 'bigint') return v.toString();
            if (v instanceof Error) v = serializeError(v);
            if (v === null || typeof v !== 'object') return v;
            while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
            if (ancestors.includes(v)) return '[Circular]';
            ancestors.push(v);
            return v;
        });
    } catch (e) {
        return safeString(value);
    }
}

function safeString(value) {
    try { return String(value); } catch (e) { return '[unserializable]'; }
}

/** " (cause: ENOTFOUND getaddrinfo ENOTFOUND host)" for the text format; empty without a cause. */
function describeCauses(err) {
    const parts = [];
    let cause = err.cause;
    for (let depth = 0; cause !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
        if (cause instanceof Error) {
            const inner = Array.isArray(cause.errors) ? cause.errors.map(e => (e && (e.code || e.message)) || safeString(e)) : [];
            parts.push([cause.code, cause.message, inner.length ? `[${inner.join(', ')}]` : ''].filter(Boolean).join(' '));
            cause = cause.cause;
        } else {
            parts.push(typeof cause === 'object' && cause !== null ? safeJson(cause) : safeString(cause));
            break;
        }
    }
    return parts.length ? ` (cause: ${parts.join(' <- ')})` : '';
}

function causeStacks(err) {
    const stacks = [];
    let cause = err.cause;
    for (let depth = 0; cause instanceof Error && depth < MAX_CAUSE_DEPTH; depth++) {
        stacks.push(`Caused by: ${cause.stack}`);
        cause = cause.cause;
    }
    return stacks.length ? '\n' + stacks.join('\n') : '';
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
        try {
            sink(lvl, render(lvl, message, args));
        } catch (e) {
            try { sink(lvl, `${safeString(message)} [log entry could not be written: ${safeString(e && e.message)}]`); } catch (e2) { /* the logger must never throw */ }
        }
    }

    function render(lvl, message, args) {
        const { error, ctx, text } = splitArgs(args);
        let msg = [message, ...text].map(safeString).join(' ');
        const time = new Date().toISOString();
        if (format === 'json') {
            const entry = { ...ctx, time, level: lvl, ...(component ? { component } : {}), msg };
            if (error) entry.err = serializeError(error);
            return safeJson(entry);
        }
        if (error) msg = msg.replace(/:\s*$/, '');
        let line = `${time} ${lvl.toUpperCase().padEnd(5)}${component ? ` [${component}]` : ''} ${msg}`;
        const ctxKeys = Object.keys(ctx);
        if (ctxKeys.length) line += ' ' + ctxKeys.map((k) => `${k}=${typeof ctx[k] === 'string' ? ctx[k] : safeJson(ctx[k])}`).join(' ');
        if (error) {
            line += `: ${error.message}${describeCauses(error)}`;
            if (lvl === 'error' || threshold <= LEVELS.debug) line += `\n${error.stack}${causeStacks(error)}`;
        }
        return line;
    }

    return {
        debug: (msg, ...args) => emit('debug', msg, args),
        info: (msg, ...args) => emit('info', msg, args),
        warn: (msg, ...args) => emit('warn', msg, args),
        error: (msg, ...args) => emit('error', msg, args),
        child: (name) => createLogger({ level, format, write, component: component ? `${component}:${name}` : name })
    };
}

const { config } = require('./config');

const root = createLogger({ level: config.logLevel, format: config.logFormat });

module.exports = { ...root, createLogger };
