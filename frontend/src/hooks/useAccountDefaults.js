import { useEffect, useState } from 'react';
import { apiFetch, readJson } from '../utils/api';
import { dropCache, readCache, writeCache } from '../utils/dataCache';

// The account's defaults from GET /api/auth/me. They sit with the in-memory server copies (utils/dataCache), so a logout
// or a session end drops them together with everything else of the previous account.
const KEY = 'account-defaults';
const LOADING_KEY = 'account-defaults:loading';

export const ANIME_VISIBILITIES = ['public', 'anonymous', 'private'];

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
  writeCache(null, KEY, { animeVisibility: visibility });
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
 * `{ animeVisibility, loaded }`: the default visibility of new anime ratings (users.default_anime_visibility), null
 * while unknown. Asked once per session; `fresh` asks again (the account dialog), `enabled: false` asks nothing.
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

  return { animeVisibility: state.defaults?.animeVisibility ?? null, loaded: state.loaded };
}
