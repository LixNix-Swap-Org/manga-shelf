// The addresses of the statistics page: /statistik for the overview, /statistik/<tab> for another tab.
export const STATS_PATH = '/statistik';
export const STATS_TAB_IDS = ['ueberblick', 'finanzen', 'personen', 'lesen', 'verlauf', 'verlage', 'verliehen', 'anime'];

/** The tab of a /statistik address ('ueberblick' for an unknown one), or null outside the statistics page. */
export function statsTabFromPath(pathname) {
  const match = /^\/statistik(?:\/([^/]*))?\/?$/.exec(pathname || '');
  if (!match) return null;
  return STATS_TAB_IDS.includes(match[1]) ? match[1] : 'ueberblick';
}

export const statsPath = (tab) => (tab && tab !== 'ueberblick' && STATS_TAB_IDS.includes(tab) ? `${STATS_PATH}/${tab}` : STATS_PATH);
