/**
 * Errors a handler throws (or rejects with). On the server the final error handler in index.js is the only place that
 * builds the JSON body: { error, code?, ...extra }. `expose` marks the message as safe for the client.
 */
class HttpError extends Error {
    constructor(status, message, code = undefined, extra = undefined) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.expose = true;
        if (code) this.code = code;
        if (extra) this.extra = extra;
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
    const body = { error: message, code: code || defaultCode(status) };
    if (extra && typeof extra === 'object') Object.assign(body, extra);
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
    return { status, body: errorBody(ref ? { id: ref } : null, status, message, code, err && err.extra) };
}

module.exports = {
    HttpError, badRequest, forbidden, notFound, conflict, defaultCode, errorBody, errorAnswer, isAppCode, STATUS_CODES, AUTH_TEXTS
};
