// Release-day reminders (apps only): the build gate, feature detection of the LocalNotifications plugin, the per-device
// setting in Preferences and the cancel of the reminders this module scheduled. Kept free of the scheduler, because App,
// the account dialog and the device screen import it in every build.

export const REMINDER_KEY = 'reminders:release-day';
export const REMINDER_CHANNEL = 'release-day';
// own id range: every run cancels exactly these and nothing another notification of the app might use
export const REMINDER_ID_BASE = 1000000;
export const REMINDER_ID_COUNT = 100;

// the one gate of every lazy reminder import: Rollup drops the chunks when the build folds it to false
export const REMINDER_BUILD = import.meta.env.VITE_APP_MODE === 'app';

/** The native bridge when it carries LocalNotifications and Preferences (bridge version 4 and up), otherwise null. */
export function reminderBridge(win = globalThis.window) {
  if (import.meta.env.VITE_APP_MODE !== 'app') return null;
  const native = win?.mangashelfNative;
  const p = native?.plugins;
  return p?.LocalNotifications && p.Preferences ? native : null;
}

export const remindersAvailable = (win) => reminderBridge(win) !== null;

const REMINDER_ROLES = ['admin', 'editor'];

/** Editors and admins (offline: the role before the connection dropped); the profile of a device collection is an admin. */
export const canRemind = (user) => Boolean(user) && REMINDER_ROLES.includes(user.offline ? user.realRole : user.role);

/** Off by default and per device: only a stored `{ enabled: true }` switches it on. */
export async function readEnabled(native) {
  try {
    const raw = (await native.plugins.Preferences.get({ key: REMINDER_KEY }))?.value;
    return raw ? JSON.parse(raw)?.enabled === true : false;
  } catch (_) {
    return false;
  }
}

export const writeEnabled = (native, enabled) => native.plugins.Preferences.set({ key: REMINDER_KEY, value: JSON.stringify({ enabled: Boolean(enabled) }) });

export const isReminderId = (id) => Number.isInteger(id) && id >= REMINDER_ID_BASE && id < REMINDER_ID_BASE + REMINDER_ID_COUNT;

// every plugin write runs in order: a cancel at logout never lands after the schedule of the next session
let queue = Promise.resolve();
export function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/** Cancels the pending reminders of the own id range; resolves their number. Call it inside serial(). */
export async function cancelOwn(native) {
  const pending = (await native.plugins.LocalNotifications.getPending())?.notifications;
  const own = (Array.isArray(pending) ? pending : []).map((n) => Number(n?.id)).filter(isReminderId).map((id) => ({ id }));
  if (own.length) await native.plugins.LocalNotifications.cancel({ notifications: own });
  return own.length;
}

// the scheduler session that may still write: start takes a new number, stop and logout end it
let session = 0;
export const beginSession = () => ++session;
export const isCurrentSession = (id) => id === session;
export function endSession(id) {
  if (id === session) session += 1;
}

/**
 * Logout, session end, server or profile switch: the reminders of that collection go (their titles would still show on
 * the lock screen). Never rejects; nothing outside the app build.
 */
export function clearReleaseReminders(win) {
  if (!REMINDER_BUILD) return Promise.resolve(0);
  const native = reminderBridge(win);
  if (!native) return Promise.resolve(0);
  return serial(() => cancelOwn(native)).catch(() => 0);
}
