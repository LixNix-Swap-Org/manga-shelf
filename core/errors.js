const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** '{name}' placeholders filled like a template literal (String(value)); unknown names stay as they are. */
function fill(template, params) {
    const values = params && typeof params === 'object' ? params : {};
    return String(template).replace(/\{(\w+)\}/g, (whole, name) => (hasOwn(values, name) ? String(values[name]) : whole));
}

/**
 * A dynamic message: German template plus language-neutral params (numbers, field keys, API values; never German
 * fragments). The answer keeps the filled German text in `error` and adds { msg, params } for the client's catalog.
 */
class Msg {
    constructor(template, params) {
        this.template = String(template);
        this.params = params && typeof params === 'object' ? { ...params } : {};
    }

    get text() {
        return fill(this.template, this.params);
    }

    toString() {
        return this.text;
    }

    // a Msg nested as a param (a cause inside a sentence) reaches the client as { msg, params }; serverText fills it
    toJSON() {
        return { msg: this.template, params: this.params };
    }
}

const msg = (template, params) => new Msg(template, params);
const isMsg = (value) => value instanceof Msg;

/** Stored German values as one list param: German text 'a, b', each item a nested msg() the client translates. */
function msgList(values) {
    const params = {};
    const template = values.map((value, i) => {
        params[`v${i}`] = msg(value);
        return `{v${i}}`;
    }).join(', ');
    return msg(template, params);
}

/** Plain { msg, params } of a message (nested messages too), for a payload's `<field>_msg`; null for plain text. */
const msgData = (message) => (isMsg(message) ? JSON.parse(JSON.stringify(message)) : null);

/** A text in a 2xx payload: the German `field` unchanged plus `<field>_msg` for the client's catalog (contract 22 addendum). */
const payloadMsg = (field, message) => ({ [field]: String(message), [`${field}_msg`]: msgData(message) });

/** The text of a message and the fields a Msg adds to the error body. */
function messageParts(message, extra) {
    if (!isMsg(message)) return { text: message, extra };
    return { text: message.text, extra: { msg: message.template, params: message.params, ...(extra || {}) } };
}

/**
 * Errors a handler throws (or rejects with). On the server the final error handler in index.js is the only place that
 * builds the JSON body: { error, code?, ...extra }. `expose` marks the message as safe for the client. `message` is
 * text or a Msg (then extra carries msg/params).
 */
class HttpError extends Error {
    constructor(status, message, code = undefined, extra = undefined) {
        const parts = messageParts(message, extra);
        super(parts.text);
        this.name = 'HttpError';
        this.status = status;
        this.expose = true;
        if (code) this.code = code;
        if (parts.extra) this.extra = parts.extra;
    }
}

const badRequest = (message, code, extra) => new HttpError(400, message, code, extra);
const forbidden = (message = 'Zugriff verweigert', code = 'FORBIDDEN', extra) => new HttpError(403, message, code, extra);
/** notFound('Band') -> "Band nicht gefunden" */
const notFound = (subject = 'Eintrag', code = 'NOT_FOUND', extra) => new HttpError(404, `${subject} nicht gefunden`, code, extra);
const conflict = (message, code = 'CONFLICT', extra) => new HttpError(409, message, code, extra);

/** Default codes for errors that carry none (body-parser, serve-static, multer, own 4xx/5xx without a code). */
const STATUS_CODES = {
    400: 'BAD_REQUEST',
    401: 'AUTH_REQUIRED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_ERROR',
    502: 'BAD_GATEWAY',
    503: 'SERVICE_UNAVAILABLE',
    504: 'GATEWAY_TIMEOUT',
    507: 'INSUFFICIENT_SPACE'
};

/** Texts of the role checks (server: middleware/auth.js, apps: core/routes.js dispatch). */
const AUTH_TEXTS = {
    AUTH_REQUIRED: 'Nicht angemeldet',
    FORBIDDEN: 'Keine Berechtigung (nur Administratoren)',
    READ_ONLY: 'Nur Lesezugriff für Besucher/Gäste gestattet'
};

const defaultCode = (status) => STATUS_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');

/** The JSON error body: { error, code, ...extra } plus the request id as `ref` on 5xx. */
function errorBody(req, status, message, code, extra) {
    const parts = messageParts(message, extra);
    const body = { error: parts.text, code: code || defaultCode(status) };
    if (parts.extra && typeof parts.extra === 'object') Object.assign(body, parts.extra);
    if (status >= 500 && req && req.id) body.ref = req.id;
    return body;
}

// Own codes are upper-case words joined by "_" (SCHEMA_NEWER); errno (ENOENT) and Node's ERR_* codes stay internal
const isAppCode = (code) => typeof code === 'string' && /^[A-Z]+(?:_[A-Z]+)*$/.test(code) && !code.startsWith('ERR_') && !/^E[A-Z]+$/.test(code);

// Status and JSON body for an error a handler threw, by the server's error-handler rules: 4xx keep their text, 5xx
// only when the status was set on purpose (503 restore, 507 disk full), else "Interner Serverfehler".
// `ref` (the request id) is only known to the server.
function errorAnswer(err, ref) {
    const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
    const isHttpError = err && err.name === 'HttpError';
    const exposed = status < 500 || isHttpError || (status !== 500 && Number.isInteger(err.status));
    const message = exposed ? err.message : 'Interner Serverfehler';
    const code = isAppCode(err && err.code) && (status !== 500 || isHttpError) ? err.code : defaultCode(status);
    // a hidden 500 must not carry the template of its text either
    return { status, body: errorBody(ref ? { id: ref } : null, status, message, code, exposed ? err && err.extra : undefined) };
}

module.exports = {
    HttpError, Msg, msg, msgList, msgData, payloadMsg, fill, isMsg, badRequest, forbidden, notFound, conflict, defaultCode, errorBody, errorAnswer, isAppCode,
    STATUS_CODES, AUTH_TEXTS
};
