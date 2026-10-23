// Pure: the release radar and the anime list → the local notifications of the next days, one per release day.
import { t, tn } from '../../i18n/index.js';
import { getVolumeDisplayTitle } from '../../utils/volumeHelpers';
import { displayTitle } from '../../utils/animeHelpers';
import { REMINDER_CHANNEL, REMINDER_ID_BASE, REMINDER_ID_COUNT } from './reminderState';

export const REMINDER_DAYS = 14;
export const REMINDER_HOUR = 9;
const MAX_LINES = 6;
const EXACT_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// i18n-ignore: stored anime status values
const FOLLOWED = ['Schaue', 'Geplant'];

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local `hour`:00 of that calendar day, or null for a day that does not exist (2026-02-30). */
function fireAt(year, month, day, hour) {
  const at = new Date(year, month - 1, day, hour, 0, 0, 0);
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day ? at : null;
}

/** Radar volumes with an exact day; a month-only date (`date_precision: 'month'`, "2026-11") or a bare year stays out. */
export function volumeReleases(radar, hour = REMINDER_HOUR) {
  const out = [];
  for (const group of radar?.groups || []) {
    for (const item of group?.items || []) {
      if (!item || item.date_precision === 'month') continue;
      const m = EXACT_DAY.exec(String(item.release_date ?? '').trim());
      const at = m && fireAt(Number(m[1]), Number(m[2]), Number(m[3]), hour);
      if (!at) continue;
      const title = String(item.manga_title ?? '').trim();
      const volume = getVolumeDisplayTitle(item);
      out.push({ at, kind: 'volume', line: title ? `${title} – ${volume}` : volume });
    }
  }
  return out;
}

/** Next episodes of my "Schaue" and "Geplant" entries with a confirmed airing (`estimated` ones stay out), on their local day. */
export function episodeReleases(list, hour = REMINDER_HOUR) {
  const out = [];
  for (const anime of Array.isArray(list) ? list : []) {
    const next = anime?.next_airing;
    if (!FOLLOWED.includes(anime?.my_progress?.status) || !next || next.estimated) continue;
    const seconds = Number(next.at);
    const episode = Number(next.episode);
    if (!Number.isFinite(seconds) || !(episode > 0)) continue;
    const local = new Date(seconds * 1000);
    const at = fireAt(local.getFullYear(), local.getMonth() + 1, local.getDate(), hour);
    if (at) out.push({ at, kind: 'episode', line: t('{title} – Folge {episode}', { title: displayTitle(anime), episode }) });
  }
  return out;
}

function titleOf(volumes, episodes) {
  if (!episodes) return tn('{n} Band erscheint heute', '{n} Bände erscheinen heute', volumes);
  if (!volumes) return tn('{n} neue Folge heute', '{n} neue Folgen heute', episodes);
  return tn('{n} Neuerscheinung heute', '{n} Neuerscheinungen heute', volumes + episodes);
}

/**
 * One notification per release day whose reminder (local `hour`:00) lies after `now` and at most `days` calendar days
 * ahead (the same clock time, so a DST switch in between moves nothing). Several volumes and episodes of the same day
 * share one; volumes come first. Ids count up from REMINDER_ID_BASE.
 */
export function planReminders({ radar, anime, now = new Date(), days = REMINDER_DAYS, hour = REMINDER_HOUR } = {}) {
  const from = now.getTime();
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()).getTime();
  const byDay = new Map();
  for (const release of [...volumeReleases(radar, hour), ...episodeReleases(anime, hour)]) {
    const time = release.at.getTime();
    if (time <= from || time > until) continue;
    if (!byDay.has(time)) byDay.set(time, { at: release.at, volume: [], episode: [] });
    const lines = byDay.get(time)[release.kind];
    if (!lines.includes(release.line)) lines.push(release.line);
  }
  return [...byDay.values()]
    .sort((a, b) => a.at - b.at)
    .slice(0, REMINDER_ID_COUNT)
    .map((day, i) => {
      const lines = [...day.volume, ...day.episode];
      const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES - 1) : lines;
      const rest = lines.length - shown.length;
      const body = [...shown, ...(rest ? [tn('+ {n} weiterer Titel', '+ {n} weitere Titel', rest)] : [])].join('\n');
      return {
        id: REMINDER_ID_BASE + i,
        title: titleOf(day.volume.length, day.episode.length),
        body,
        largeBody: body,
        schedule: { at: day.at, allowWhileIdle: true },
        channelId: REMINDER_CHANNEL,
        extra: { kind: 'release-day', day: dayKey(day.at) }
      };
    });
}
