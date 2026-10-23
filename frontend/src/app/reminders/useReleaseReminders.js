import { useEffect, useRef } from 'react';
import { REMINDER_BUILD, canRemind, clearReleaseReminders, remindersAvailable } from './reminderState';

/**
 * Apps: starts the opt-in release-day reminders (reminderScheduler.startReleaseReminders, loaded on demand) for a signed-in
 * editor or admin or the opened device collection, and stops them on logout, user, role or server change (`scopeKey`).
 * Going offline keeps them (the role before the drop counts). Nothing on the web.
 */
export default function useReleaseReminders(user, scopeKey) {
  const userRef = useRef(user);
  userRef.current = user;
  const role = user?.offline ? user?.realRole : user?.role;
  const key = canRemind(user) && scopeKey ? `${scopeKey}:${user.id}:${role}` : null;
  // a signed-in account without reminders (a guest) gets none left over from an account of an earlier start
  const other = user && !user.offline && !canRemind(user) ? `${scopeKey}:${user.id}` : null;
  useEffect(() => {
    if (!REMINDER_BUILD) return undefined;
    if (!key || !remindersAvailable()) return undefined;
    let stop = null;
    let cancelled = false;
    import('./reminderScheduler.js')
      .then(({ startReleaseReminders }) => { if (!cancelled) stop = startReleaseReminders({ user: userRef.current }); })
      .catch((err) => console.warn('[App] Erinnerungen nicht geladen:', err?.message || err));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [key]);
  useEffect(() => {
    if (REMINDER_BUILD && other) clearReleaseReminders();
  }, [other]);
}
