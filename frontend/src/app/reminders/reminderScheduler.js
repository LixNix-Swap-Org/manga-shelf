// Release-day reminders (opt-in, per device): reads the release radar and the anime list through utils/api.js (the device
// core in local mode) and schedules local notifications on this device. No server change, no push service.
import api from '../../utils/api';
import { PURCHASE_RECORDED_EVENT } from '../../appShell';
import { t } from '../../i18n/index.js';
import { planReminders } from './reminderPlan';
import {
  REMINDER_CHANNEL, REMINDERS_CHANGED_EVENT, reminderBridge, canRemind, readEnabled, writeEnabled, serial, cancelOwn, clearOwn,
  beginSession, isCurrentSession, endSession
} from './reminderState';

// a return to the foreground or going to the background plans again at most this often, unless a write changed something
// since the last plan; a new session, the switch, a write and a forced run always do
export const REFRESH_FLOOR_MS = 15 * 60 * 1000;
const CHANGE_EVENTS = [REMINDERS_CHANGED_EVENT, PURCHASE_RECORDED_EVENT];

let active = null;

/** Notification permission as the system reports it now ('granted', 'denied', 'prompt' …), 'denied' when the call fails. */
export async function permissionState(native = reminderBridge()) {
  try {
    return (await native.plugins.LocalNotifications.checkPermissions())?.display || 'denied';
  } catch (_) {
    return 'denied';
  }
}

// Android 8+: its own channel, so the reminders can be silenced in the system settings apart from anything else. The name
// follows the UI language on every run (Android keeps the importance the user chose). Visibility private: a lock screen
// set to hide sensitive content shows no titles (the plugin's default would be public). Below Android 8 the call rejects
// and the notifications need no channel.
export const CHANNEL_IMPORTANCE_DEFAULT = 3;
export const CHANNEL_VISIBILITY_PRIVATE = 0;
async function ensureChannel(native) {
  if (native.platform !== 'android') return;
  try {
    await native.plugins.LocalNotifications.createChannel({
      id: REMINDER_CHANNEL,
      name: t('Erinnerungen am Erscheinungstag'),
      description: t('Neue Bände aus dem Release-Radar und neue Folgen deiner Anime'),
      importance: CHANNEL_IMPORTANCE_DEFAULT,
      visibility: CHANNEL_VISIBILITY_PRIVATE
    });
  } catch (_) { /* Android 7 or an older plugin: no channels */ }
}

async function run(mine, now) {
  const { native } = mine;
  // the writes this run covers: a later one keeps its replan pending
  const seen = mine.changes;
  if (!(await readEnabled(native))) {
    mine.planned = seen;
    return { ran: false, reason: 'off' };
  }
  let radar;
  let anime;
  try {
    [radar, anime] = await Promise.all([api.get('/api/release-radar'), api.get('/api/anime')]);
  } catch (_) {
    // offline or the server failed: the reminders planned last time stay
    return { ran: false, reason: 'unreachable' };
  }
  return serial(async () => {
    if (!isCurrentSession(mine.session)) return { ran: false, reason: 'stale' };
    if (!(await readEnabled(native))) {
      await cancelOwn(native);
      return { ran: false, reason: 'off' };
    }
    if ((await permissionState(native)) !== 'granted') {
      mine.planned = seen;
      return { ran: false, reason: 'denied' };
    }
    const notifications = planReminders({ radar, anime: Array.isArray(anime) ? anime : [], now: now() });
    await ensureChannel(native);
    await cancelOwn(native);
    if (notifications.length) await native.plugins.LocalNotifications.schedule({ notifications });
    mine.lastOk = now().getTime();
    mine.planned = seen;
    return { ran: true, scheduled: notifications.length };
  });
}

/**
 * Plans the reminders of the running session again: reads both lists, cancels the own pending reminders and schedules
 * the new ones. A call during a run makes it run once more afterwards. Without `force` the floor applies unless a write
 * since the last plan is still pending. Never rejects.
 */
export function refreshReleaseReminders({ force = true, now = () => new Date() } = {}) {
  const mine = active;
  if (!mine) return Promise.resolve({ ran: false, reason: 'no_session' });
  const changed = mine.changes !== mine.planned;
  if (!force && !changed && mine.lastOk && now().getTime() - mine.lastOk < REFRESH_FLOOR_MS) return Promise.resolve({ ran: false, reason: 'floor' });
  if (mine.running) {
    mine.again = true;
    return mine.running;
  }
  const loop = async () => {
    let result;
    do {
      mine.again = false;
      result = await run(mine, now).catch(() => ({ ran: false, reason: 'error' }));
    } while (mine.again && active === mine);
    return result;
  };
  mine.running = loop().finally(() => { mine.running = null; });
  return mine.running;
}

/**
 * Starts the reminders for a signed-in editor or admin (or the opened device collection): plans once now, after every
 * write that can change a reminder (releaseRemindersChanged, a purchase of the shopping list or the shop basket), and on
 * every return to the foreground and every move to the background (App appStateChange, both directions: going away
 * catches an edit whose own replan could not read the lists). Returns stop(), which also cancels the reminders, so a
 * logout leaves none behind; the next session plans its own after that cancel.
 */
export function startReleaseReminders({ user, native = reminderBridge(), now = () => new Date(), win = globalThis.window } = {}) {
  if (!native || !canRemind(user)) return () => {};
  const mine = { native, session: beginSession(), running: null, again: false, lastOk: 0, changes: 0, planned: 0 };
  active = mine;
  let stopped = false;
  const trigger = (force) => {
    if (!stopped && active === mine) refreshReleaseReminders({ force, now }).catch(() => {});
  };
  const onChange = () => {
    mine.changes += 1;
    trigger(true);
  };
  trigger(true);
  CHANGE_EVENTS.forEach((name) => win?.addEventListener?.(name, onChange));
  const handle = Promise.resolve()
    .then(() => native.plugins.App?.addListener?.('appStateChange', () => trigger(false)))
    .catch(() => null);
  return () => {
    stopped = true;
    if (active === mine) active = null;
    endSession(mine.session);
    CHANGE_EVENTS.forEach((name) => win?.removeEventListener?.(name, onChange));
    serial(() => cancelOwn(native)).catch(() => {});
    handle.then((h) => h?.remove?.()).catch(() => {});
  };
}

/**
 * The switch "Erinnerungen am Erscheinungstag". On: asks for the notification permission, stores the setting and plans at
 * once; resolves { enabled: false, denied: true } when the system refuses. Off: stores it and removes every own
 * reminder, pending and shown.
 */
export async function setReleaseReminders(on, { native = reminderBridge(), now = () => new Date() } = {}) {
  if (!native) return { enabled: false };
  if (!on) {
    await writeEnabled(native, false);
    await serial(() => clearOwn(native)).catch(() => {});
    return { enabled: false };
  }
  let display;
  try {
    display = (await native.plugins.LocalNotifications.requestPermissions())?.display;
  } catch (_) {
    display = 'denied';
  }
  if (display !== 'granted') return { enabled: false, denied: true };
  await writeEnabled(native, true);
  refreshReleaseReminders({ now }).catch(() => {});
  return { enabled: true };
}
