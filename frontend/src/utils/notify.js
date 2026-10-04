import { ApiError, errorFromResponse, isAbortError } from './api.js';

/** Fired on window for every toast; the browser suites listen to it instead of to alert(). */
export const NOTIFY_EVENT = 'mangashelf:notify';
export const DURATIONS = { info: 5000, success: 5000, error: 8000 };
export const UNEXPECTED_ERROR = 'Unerwarteter Fehler – bitte erneut versuchen.';

const listeners = new Set();
let nextId = 1;

/** Toast text for a string, an ApiError (with the server's error ID) or another error; null for an abort. */
export function toastText(input, fallback) {
  if (input === null || input === undefined || input === '') return fallback ? { message: fallback, ref: null } : null;
  if (typeof input === 'string') return { message: input, ref: null };
  if (isAbortError(input)) return null;
  if (input instanceof ApiError) return { message: input.message || fallback || UNEXPECTED_ERROR, ref: input.ref || null };
  return { message: fallback || UNEXPECTED_ERROR, ref: null };
}

function emit(kind, input, { action = null, fallback, duration } = {}) {
  const text = toastText(input, fallback);
  if (!text) return null;
  const toast = {
    id: nextId++,
    kind,
    message: text.message,
    ref: text.ref,
    action: action && typeof action.onClick === 'function' ? { label: action.label || 'Rückgängig', onClick: action.onClick } : null,
    duration: duration ?? DURATIONS[kind]
  };
  for (const listener of [...listeners]) listener({ type: 'show', toast });
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(NOTIFY_EVENT, { detail: { kind, message: toast.message } }));
  }
  return toast.id;
}

export function dismiss(id) {
  for (const listener of [...listeners]) listener({ type: 'dismiss', id });
}

/** Changes the text of a shown toast in place: no new announcement, and a toast the user closed stays closed. */
export function update(id, input) {
  const text = toastText(input);
  if (!text || id === null || id === undefined) return;
  for (const listener of [...listeners]) listener({ type: 'update', id, message: text.message, ref: text.ref });
}

/** Called with { type: 'show', toast }, { type: 'update', id, message, ref } and { type: 'dismiss', id }; returns the unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * notify.error / success / info(messageOrError, { action: { label, onClick }, fallback, duration }).
 * An ApiError shows its message (and the server's error ID), an AbortError nothing, any other error the fallback.
 */
export const notify = {
  error: (input, options) => emit('error', input, options),
  success: (input, options) => emit('success', input, options),
  info: (input, options) => emit('info', input, options),
  update,
  dismiss,
  subscribe
};

/** Error toast for a failed response: the server's `error`, else `fallback (HTTP n)`, else a text for the status. */
export async function notifyResponseError(res, fallback) {
  return notify.error(await errorFromResponse(res, fallback));
}

export default notify;
