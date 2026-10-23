// Release-day reminders (opt-in, per device): reads the release radar and the anime list through utils/api.js (the device
// core in local mode) and schedules local notifications on this device. No server change, no push service.
import api from '../../utils/api';
import { t } from '../../i18n/index.js';
import { planReminders } from './reminderPlan';
import {
  REMINDER_CHANNEL, reminderBridge, canRemind, readEnabled, writeEnabled, serial, cancelOwn, beginSession, isCurrentSession, endSession
} from './reminderState';

// a return to the foreground plans again at most this often; a new session, the switch and a forced run always do
export const REFRESH_FLOOR_MS = 15 * 60 * 1000;

let active = null;

/** Notification permission as the system reports it now ('granted', 'denied', 'prompt' …), 'denied' when the call fails. */
export async function permissionState(native = reminderBridge()) {
  try {
    return (await native.plugins.LocalNotifications.checkPermissions())?.display || 'denied';
  } catch (_) {
    return 'denied';
  }
}

// Android only: its own channel, so the reminders can be silenced in the system settings apart from anything else
async function ensureChannel(native) {
  if (native.platform !== 'android') return;
  try {
    await native.plugins.LocalNotifications.createChannel({
      id: REMINDER_CHANNEL,
      name: t('Erinnerungen am Erscheinungstag'),
      description: t('Neue Bände aus dem Release-Radar und neue Folgen deiner Anime'),
      importance: 3
    });
  } catch (_) { /* older plugin or system: the default channel takes them */ }
}

async function run(mine, now) {
  const { native } = mine;
  if (!(await readEnabled(native))) return { ran: false, reason: 'off' };
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
    if ((await permissionState(native)) !== 'granted') return { ran: false, reason: 'denied' };
    const notifications = planReminders({ radar, anime: Array.isArray(anime) ? anime : [], now: now() });
    await ensureChannel(native);
    await cancelOwn(native);
    if (notifications.length) await native.plugins.LocalNotifications.schedule({ notifications });
    mine.lastOk = now().getTime();
    return { ran: true, scheduled: notifications.length };
  });
}

/**
 * Plans the reminders of the running session again: reads both lists, cancels the own pending reminders and schedules
 * the new ones. A call during a run makes it run once more afterwards. Never rejects.
 */
export function refreshReleaseReminders({ force = true, now = () => new Date() } = {}) {
  const mine = active;
  if (!mine) return Promise.resolve({ ran: false, reason: 'no_session' });
  if (!force && mine.lastOk && now().getTime() - mine.lastOk < REFRESH_FLOOR_MS) return Promise.resolve({ ran: false, reason: 'floor' });
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
 * Starts the reminders for a signed-in editor or admin (or the opened device collection): plans once now and again on
 * every return to the foreground (App appStateChange isActive). Returns stop(), which also cancels the reminders, so a
 * logout leaves none behind; the next session plans its own after that cancel.
 */
export function startReleaseReminders({ user, native = reminderBridge(), now = () => new Date() } = {}) {
  if (!native || !canRemind(user)) return () => {};
  const mine = { native, session: beginSession(), running: null, again: false, lastOk: 0 };
  active = mine;
  let stopped = false;
  const trigger = (force) => {
    if (!stopped && active === mine) refreshReleaseReminders({ force, now }).catch(() => {});
  };
  trigger(true);
  const handle = Promise.resolve()
    .then(() => native.plugins.App?.addListener?.('appStateChange', ({ isActive } = {}) => { if (isActive) trigger(false); }))
    .catch(() => null);
  return () => {
    stopped = true;
    if (active === mine) active = null;
    endSession(mine.session);
    serial(() => cancelOwn(native)).catch(() => {});
    handle.then((h) => h?.remove?.()).catch(() => {});
  };
}

/**
 * The switch "Erinnerungen am Erscheinungstag". On: asks for the notification permission, stores the setting and plans at
 * once; resolves { enabled: false, denied: true } when the system refuses. Off: stores it and cancels every own reminder.
 */
export async function setReleaseReminders(on, { native = reminderBridge(), now = () => new Date() } = {}) {
  if (!native) return { enabled: false };
  if (!on) {
    await writeEnabled(native, false);
    await serial(() => cancelOwn(native)).catch(() => {});
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
