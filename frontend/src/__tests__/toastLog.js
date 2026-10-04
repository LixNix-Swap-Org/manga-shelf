import { subscribe } from '../utils/notify';

/** Collects the toasts emitted through utils/notify.js; call stop() in afterEach. */
export function recordToasts() {
  const list = [];
  const stop = subscribe((event) => { if (event.type === 'show') list.push(event.toast); });
  return {
    list,
    stop,
    messages: (kind) => list.filter((t) => !kind || t.kind === kind).map((t) => t.message),
    last: () => list[list.length - 1] || null
  };
}
