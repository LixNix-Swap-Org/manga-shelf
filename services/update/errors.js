const { HttpError, msg } = require('../../core/errors');
const { TUF_HOST } = require('./constants');

const UPDATE_TEXTS = {
    UPDATE_INSTALL_OFF: 'Installieren über die Systemseite ist abgeschaltet ({variable}=false).',
    NOT_INSTALLABLE: 'Dieses Update kann auf diesem Server nicht installiert werden.',
    VERSION_UNKNOWN: 'Diese Version ist auf GitHub nicht veröffentlicht.',
    VERSION_NOT_NEWER: 'Es können nur neuere Versionen installiert werden.',
    RELEASE_UNSIGNED: 'Diese Version hat keine Signatur und kann nicht installiert werden.',
    UPDATE_BUSY: 'Es wird gerade schon ein Update vorbereitet.',
    UPDATE_RUNNING: 'Gerade läuft ein Update – bitte warten, bis der Server neu gestartet ist.',
    NO_SPACE: 'Nicht genug Speicherplatz für das Update (frei: {free}, benötigt: {needed}).',
    STAGING_NOT_FOUND: 'Keine vorbereitete Aktualisierung gefunden.',
    STAGING_EXPIRED: 'Die Prüfung ist abgelaufen. Bitte das Update erneut vorbereiten.',
    JOB_RUNNING: 'Gerade läuft ein Backup oder eine Wiederherstellung – bitte danach erneut versuchen.',
    MAINTENANCE: 'Der Server wird gerade aktualisiert. Bitte in ein paar Minuten erneut versuchen.',
    GITHUB_UNAVAILABLE: 'GitHub ist nicht erreichbar.',
    RATE_LIMITED: 'GitHub-Abfragegrenze erreicht.',
    DOWNLOAD_FAILED: 'Download von GitHub fehlgeschlagen.',
    DOWNLOAD_HOST: 'Download von einem nicht erlaubten Server abgelehnt.',
    DOWNLOAD_TOO_LARGE: 'Die Datei ist größer als erlaubt.',
    DOWNLOAD_ABORTED: 'Download abgebrochen.',
    SIGNATURE_INVALID: 'Die Signatur der Prüfsummen ist ungültig.',
    SIGNATURE_IDENTITY: 'Die Signatur stammt nicht aus dem Release-Workflow von manga-shelf.',
    BUNDLE_FORMAT: 'Die Signaturdatei hat ein unerwartetes Format.',
    VERSION_UNBOUND: 'Die signierten Prüfsummen gehören nicht zu dieser Version.',
    CHECKSUM_MISMATCH: 'Download beschädigt: die Prüfsumme stimmt nicht.',
    CHECKSUM_MISSING: 'Für diese Datei gibt es keine signierte Prüfsumme.',
    SIGSTORE_TRUST_UNAVAILABLE: 'Signaturdienst nicht erreichbar ({host}).',
    PREFLIGHT_FAILED: 'Die neue Version hat die Vorabprüfung nicht bestanden.',
    BAD_PACKAGE: 'Das Update-Paket ist ungültig.',
    BACKUP_FAILED: 'Das Backup vor dem Update ist fehlgeschlagen.',
    VERSION_MISMATCH: 'Die installierte Datei meldet eine andere Version als erwartet.',
    UPDATE_INTERRUPTED: 'Das Update wurde unterbrochen; die bisherige Version läuft weiter.',
    START_FAILED: 'Die neue Version ist nicht gestartet; die vorherige Version wurde wiederhergestellt.',
    UPDATE_FAILED: 'Das Update ist fehlgeschlagen.'
};

const FIXED_PARAMS = {
    UPDATE_INSTALL_OFF: { variable: 'UPDATE_INSTALL' },
    SIGSTORE_TRUST_UNAVAILABLE: { host: TUF_HOST }
};

const STATUS = {
    UPDATE_INSTALL_OFF: 403,
    NOT_INSTALLABLE: 409,
    VERSION_UNKNOWN: 404,
    VERSION_NOT_NEWER: 409,
    RELEASE_UNSIGNED: 409,
    UPDATE_BUSY: 409,
    UPDATE_RUNNING: 409,
    NO_SPACE: 507,
    STAGING_NOT_FOUND: 404,
    STAGING_EXPIRED: 410,
    JOB_RUNNING: 409,
    MAINTENANCE: 503,
    GITHUB_UNAVAILABLE: 502,
    RATE_LIMITED: 503,
    DOWNLOAD_FAILED: 502,
    DOWNLOAD_HOST: 502,
    DOWNLOAD_TOO_LARGE: 502,
    DOWNLOAD_ABORTED: 409,
    SIGSTORE_TRUST_UNAVAILABLE: 503
};

/** HttpError with the fixed text of `code`; `params` fill its placeholders, `extra` lands in the error body. */
function updateError(code, params, extra) {
    const known = Object.prototype.hasOwnProperty.call(UPDATE_TEXTS, code) ? code : 'UPDATE_FAILED';
    const fixed = FIXED_PARAMS[known];
    const all = fixed || params ? { ...fixed, ...params } : null;
    const message = all ? msg(UPDATE_TEXTS[known], all) : UPDATE_TEXTS[known];
    return new HttpError(STATUS[code] || 422, message, code, extra);
}

/** { code, message } of an error for the status answer; unknown errors become UPDATE_FAILED. */
function errorSummary(err) {
    if (err && typeof err.code === 'string' && Object.prototype.hasOwnProperty.call(UPDATE_TEXTS, err.code)) {
        const out = { code: err.code, message: err.message };
        if (err.extra && err.extra.msg) {
            out.msg = err.extra.msg;
            out.params = err.extra.params;
        }
        if (err.extra && err.extra.reason) out.reason = err.extra.reason;
        return out;
    }
    if (err && err.code === 'INSUFFICIENT_SPACE') return { code: 'NO_SPACE', message: err.message };
    return { code: 'UPDATE_FAILED', message: UPDATE_TEXTS.UPDATE_FAILED };
}

module.exports = { UPDATE_TEXTS, updateError, errorSummary };
