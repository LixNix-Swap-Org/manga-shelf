// Test doubles of the device database: a store that fails on demand, navigator.locks and BroadcastChannel.
import { memoryStore } from '../local/store.js';

const quota = () => Object.assign(new Error('Speicher voll'), { name: 'QuotaExceededError' });

/** memoryStore whose writes fail while `fail(store, key)` says so. */
export function flakyStore(fail) {
  const base = memoryStore();
  return { ...base, put: async (store, key, value) => { if (fail(store, key)) throw quota(); return base.put(store, key, value); } };
}

/** navigator.locks for one page: exclusive locks in request order, ifAvailable and signal. */
export function fakeLocks() {
  const queues = new Map();
  const grant = (name) => {
    const entry = queues.get(name)?.[0];
    if (!entry || entry.running) return;
    entry.running = true;
    Promise.resolve().then(() => entry.cb({ name })).then((value) => {
      queues.get(name).shift();
      entry.resolve(value);
      grant(name);
    }, (err) => {
      queues.get(name).shift();
      entry.reject(err);
      grant(name);
    });
  };
  return {
    request(name, options, cb) {
      return new Promise((resolve, reject) => {
        const queue = queues.get(name) || [];
        queues.set(name, queue);
        if (options.ifAvailable && queue.length) {
          Promise.resolve().then(() => cb(null)).then(resolve, reject);
          return;
        }
        const entry = { cb, resolve, reject };
        queue.push(entry);
        options.signal?.addEventListener('abort', () => {
          if (entry.running) return;
          queue.splice(queue.indexOf(entry), 1);
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
        grant(name);
      });
    }
  };
}

/** BroadcastChannel between the runtimes of one test. */
export function fakeChannels() {
  const members = new Set();
  return (name) => {
    const channel = {
      name,
      onmessage: null,
      postMessage(data) {
        for (const m of members) if (m !== channel && m.name === name) setTimeout(() => m.onmessage?.({ data }), 0);
      },
      close() { members.delete(channel); }
    };
    members.add(channel);
    return channel;
  };
}
