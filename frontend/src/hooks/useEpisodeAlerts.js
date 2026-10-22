import { useCallback, useEffect, useRef, useState } from 'react';
import { notify } from '../utils/notify';
import { alertsEnabled, dueAlerts, readSeenAlerts, setAlertsEnabled, writeSeenAlerts } from '../utils/animeHub';
import { displayTitle } from '../utils/animeHelpers';
import { t } from '../i18n/index.js';

const CHECK_MS = 60 * 1000;
const supportsNotifications = () => typeof window !== 'undefined' && 'Notification' in window;

/**
 * "Hinweis bei neuen Folgen": while the app is open, an episode of an anime I follow that just aired is announced once, as a toast
 * and, when the browser allows it, as a system notification. Off by default; the switch is per device.
 * (Without the app open the calendar subscription of the Anime-Radar does the same through the calendar app.)
 */
export default function useEpisodeAlerts(list) {
  const [enabled, setEnabled] = useState(alertsEnabled);
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    if (!enabled) return undefined;
    const check = () => {
      const seen = readSeenAlerts();
      const due = dueAlerts(listRef.current, new Date(), seen);
      if (!due.length) return;
      writeSeenAlerts([...seen, ...due.map((d) => d.key)]);
      due.slice(0, 3).forEach(({ anime, episode }) => {
        const text = t('Neue Folge: {title}, Folge {episode}', { title: displayTitle(anime), episode });
        notify.info(text);
        try {
          if (supportsNotifications() && Notification.permission === 'granted') new Notification(text, { icon: anime.cover_image || undefined, tag: `anime-${anime.id}-${episode}` });
        } catch (_) { /* some embedded browsers refuse the constructor */ }
      });
    };
    check();
    const timer = window.setInterval(check, CHECK_MS);
    return () => window.clearInterval(timer);
  }, [enabled, list?.length]);

  const enable = useCallback(async () => {
    if (supportsNotifications() && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) { /* answered later */ }
    }
    setAlertsEnabled(true);
    setEnabled(true);
  }, []);
  const disable = useCallback(() => {
    setAlertsEnabled(false);
    setEnabled(false);
  }, []);
  const permission = supportsNotifications() ? Notification.permission : 'unsupported';
  return { enabled, enable, disable, permission };
}
