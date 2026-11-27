import { useEffect, useState } from 'react';
import { apiFetch, readJson } from '../utils/api';
import { dropCache, readCache, writeCache } from '../utils/dataCache';

// The account's defaults from GET /api/auth/me. They sit with the in-memory server copies (utils/dataCache), so a logout
// or a session end drops them together with everything else of the previous account.
const KEY = 'account-defaults';
const LOADING_KEY = 'account-defaults:loading';

export const ANIME_VISIBILITIES = ['public', 'anonymous', 'private'];
// after how many days a lent copy is listed in "Zu erledigen" (users.lent_reminder_days, core/lib/locales.js)
export const LENT_REMINDER_CHOICES = [14, 30, 60, 90, 180, 365];

const listeners = new Set();
let loading = false;

const stored = () => readCache(null, KEY)?.data ?? null;

function emit() {
  const defaults = stored();
  for (const listener of [...listeners]) listener(defaults);
}

/** Takes the defaults from a user object of GET /api/auth/me or PUT /api/auth/profile. */
export function rememberAccountDefaults(user) {
  if (!user || typeof user !== 'object') return;
  const visibility = ANIME_VISIBILITIES.includes(user.default_anime_visibility) ? user.default_anime_visibility : null;
  const shareAnime = typeof user.share_anime_activity === 'boolean' ? user.share_anime_activity : null;
  const showTodo = typeof user.show_todo === 'boolean' ? user.show_todo : null;
  const lentReminderDays = LENT_REMINDER_CHOICES.includes(user.lent_reminder_days) ? user.lent_reminder_days : null;
  // users.whats_new_seen (migration 62): the last version whose "Was ist neu" the account saw; null for a new account.
  // A server before 4.3 does not send the field at all (whatsNewKnown false): then the device remembers it.
  const whatsNewKnown = Object.prototype.hasOwnProperty.call(user, 'whats_new_seen');
  const whatsNewSeen = whatsNewKnown && typeof user.whats_new_seen === 'string' ? user.whats_new_seen : null;
  writeCache(null, KEY, { animeVisibility: visibility, shareAnime, showTodo, lentReminderDays, whatsNewSeen, whatsNewKnown });
  emit();
}

function load(fresh) {
  if (loading || (!fresh && stored())) return;
  loading = true;
  const ticket = writeCache(null, LOADING_KEY, true);
  apiFetch('/api/auth/me')
    .then((res) => (res.ok ? readJson(res) : null))
    .catch(() => null)
    .then((data) => {
      loading = false;
      // cleared meanwhile (logout): the answer belongs to the previous session
      if (readCache(null, LOADING_KEY) !== ticket) {
        if (listeners.size) load(false);
        return;
      }
      dropCache(null, LOADING_KEY);
      if (data?.user) rememberAccountDefaults(data.user);
      else emit();
    });
}

/**
 * `{ animeVisibility, shareAnime, loaded }`: the default visibility of new anime ratings (users.default_anime_visibility)
 * , whether others see the own anime list by name (users.share_anime_activity) and whether the shelf shows "Zu erledigen"
 * (users.show_todo), after how many days a lending is listed there (users.lent_reminder_days) and the last version whose
 * "Was ist neu" the account saw (users.whats_new_seen, `whatsNewKnown` false on a server without it), null while unknown. Asked once per session; `fresh` asks again (the account dialog), `enabled: false` asks nothing.
 */
export default function useAccountDefaults({ enabled = true, fresh = false } = {}) {
  const [state, setState] = useState(() => {
    const defaults = stored();
    return { defaults, loaded: Boolean(defaults) && !fresh };
  });

  useEffect(() => {
    const listener = (defaults) => setState({ defaults, loaded: true });
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (enabled) load(fresh);
  }, [enabled, fresh]);

  return {
    animeVisibility: state.defaults?.animeVisibility ?? null,
    shareAnime: state.defaults?.shareAnime ?? null,
    showTodo: state.defaults?.showTodo ?? null,
    lentReminderDays: state.defaults?.lentReminderDays ?? null,
    whatsNewSeen: state.defaults?.whatsNewSeen ?? null,
    whatsNewKnown: Boolean(state.defaults?.whatsNewKnown),
    loaded: state.loaded
  };
}
