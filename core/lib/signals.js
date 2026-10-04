// AbortSignal.timeout / AbortSignal.any for the app WebViews (iOS 14/15 have neither), built from AbortController and
// setTimeout like linkSignal in frontend/src/utils/api.js.

function timeoutReason() {
    try {
        return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    } catch (_) {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        return err;
    }
}

/** Aborts with a TimeoutError after `ms`. The timer never keeps a host process alive on its own. */
function timeoutSignal(ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutReason()), ms);
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
    return controller.signal;
}

/**
 * Aborts as soon as one of `signals` aborts, with its reason; empty entries are skipped. Once aborted it drops its
 * listeners on the other signals.
 */
function anySignal(signals) {
    const list = signals.filter(Boolean);
    if (list.length === 1) return list[0];
    const controller = new AbortController();
    const first = list.find((signal) => signal.aborted);
    if (first) {
        controller.abort(first.reason);
        return controller.signal;
    }
    const listeners = [];
    const release = () => listeners.forEach(([signal, onAbort]) => signal.removeEventListener('abort', onAbort));
    for (const signal of list) {
        const onAbort = () => {
            release();
            controller.abort(signal.reason);
        };
        listeners.push([signal, onAbort]);
        signal.addEventListener('abort', onAbort);
    }
    return controller.signal;
}

module.exports = { timeoutSignal, anySignal };
