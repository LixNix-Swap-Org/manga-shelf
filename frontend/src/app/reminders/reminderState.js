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

/**
 * Cancels the pending reminders of the own id range (a shown one stays in the notification shade); resolves their number.
 * Call it inside serial().
 */
export async function cancelOwn(native) {
  const pending = (await native.plugins.LocalNotifications.getPending())?.notifications;
  const own = (Array.isArray(pending) ? pending : []).map((n) => Number(n?.id)).filter(isReminderId).map((id) => ({ id }));
  if (own.length) await native.plugins.LocalNotifications.cancel({ notifications: own });
  return own.length;
}

const OWN_RANGE = Array.from({ length: REMINDER_ID_COUNT }, (_, i) => ({ id: REMINDER_ID_BASE + i }));

/**
 * Removes every reminder of the own id range, pending and already shown: a fired reminder is no longer pending, Android's
 * cancel also takes it off the shade, iOS needs removeDeliveredNotifications. Call it inside serial().
 */
export async function clearOwn(native) {
  const plugin = native.plugins.LocalNotifications;
  await plugin.cancel({ notifications: OWN_RANGE });
  if (typeof plugin.removeDeliveredNotifications === 'function') await plugin.removeDeliveredNotifications({ notifications: OWN_RANGE });
}

export const REMINDERS_CHANGED_EVENT = 'mangashelf:reminders-changed';

/**
 * A write that can change a reminder went through (a volume owned or deleted, a release date, the owners): the running
 * scheduler plans again. Nothing outside the app build.
 */
export function releaseRemindersChanged(win = globalThis.window) {
  if (!REMINDER_BUILD || !win?.dispatchEvent) return;
  win.dispatchEvent(new CustomEvent(REMINDERS_CHANGED_EVENT));
}

// the scheduler session that may still write: start takes a new number, stop and logout end it
let session = 0;
export const beginSession = () => ++session;
export const isCurrentSession = (id) => id === session;
export function endSession(id) {
  if (id === session) session += 1;
}

/**
 * Logout, session end, server or profile switch: the reminders of that collection go, pending and shown (their titles
 * would still show on the lock screen), and the switch goes off, so the next account on this device starts without
 * them. `keepSetting`: the same collection again (a restore), only the reminders go. Resolves true once done; never
 * rejects; nothing outside the app build.
 */
export function clearReleaseReminders(win, { keepSetting = false } = {}) {
  if (!REMINDER_BUILD) return Promise.resolve(false);
  const native = reminderBridge(win);
  if (!native) return Promise.resolve(false);
  return serial(async () => {
    const cleared = await clearOwn(native).then(() => true, () => false);
    if (!keepSetting) await writeEnabled(native, false);
    return cleared;
  }).catch(() => false);
}
