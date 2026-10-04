// Which mode the app build runs in: 'local' (standalone, no server) or the server modes (no entry). Kept in
// localStorage; the profile is the users row of the local database that the app acts as (role admin, no password).
export const MODE_KEY = 'mangashelf_mode';
export const PROFILE_KEY = 'mangashelf_local_profile';
export const LOCAL = 'local';

const listeners = new Set();

const storage = () => {
  try { return globalThis.localStorage ?? null; } catch (_) { return null; }
};

function read(key) {
  try { return storage()?.getItem(key) ?? null; } catch (_) { return null; }
}

function write(key, value) {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch (_) { /* storage unavailable */ }
}

export const storedModeIsLocal = () => read(MODE_KEY) === LOCAL;

/** { id, name } of the local profile, or null before the first standalone start. */
export function getLocalProfile() {
  try {
    const value = JSON.parse(read(PROFILE_KEY) || 'null');
    return value && typeof value.name === 'string' ? { id: Number.isInteger(value.id) ? value.id : null, name: value.name } : null;
  } catch (_) {
    return null;
  }
}

export function setLocalProfile(profile) {
  write(PROFILE_KEY, profile ? JSON.stringify({ id: profile.id ?? null, name: profile.name ?? profile.username }) : null);
  for (const listener of [...listeners]) listener();
}

export function enterLocalMode(profile) {
  if (profile) setLocalProfile(profile);
  write(MODE_KEY, LOCAL);
  for (const listener of [...listeners]) listener();
}

/** Back to the server modes; the local database and profile stay on the device. */
export function leaveLocalMode() {
  write(MODE_KEY, null);
  for (const listener of [...listeners]) listener();
}

export function subscribeMode(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
