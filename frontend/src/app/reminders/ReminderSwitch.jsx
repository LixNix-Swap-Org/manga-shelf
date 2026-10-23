import { useEffect, useId, useState } from 'react';
import { notify } from '../../utils/notify';
import { t } from '../../i18n/index.js';
import { readEnabled, reminderBridge } from './reminderState';
import { permissionState, setReleaseReminders } from './reminderScheduler';

// i18n
export const REMINDER_TEXTS = {
  toggle: 'Erinnerungen am Erscheinungstag',
  help: 'Meldet sich am Erscheinungstag morgens auf diesem Gerät, wenn ein Band aus dem Release-Radar erscheint oder eine neue Folge eines Anime auf deiner Liste läuft. Gilt nur für dieses Gerät.',
  denied: 'Mitteilungen sind für Manga Shelf ausgeschaltet – erlaube sie in den Einstellungen des Geräts.',
  failed: 'Erinnerungen konnten nicht umgestellt werden'
};

/**
 * The switch of the release-day reminders (apps with the LocalNotifications plugin): off by default, stored per device.
 * Switching on asks for the notification permission, switching off cancels every reminder.
 */
export default function ReminderSwitch() {
  const ids = useId();
  const [native] = useState(() => reminderBridge());
  const [enabled, setEnabled] = useState(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!native) return undefined;
    let active = true;
    readEnabled(native).then(async (on) => {
      const blocked = on && (await permissionState(native)) === 'denied';
      if (!active) return;
      setEnabled(on);
      setDenied(blocked);
    });
    return () => { active = false; };
  }, [native]);

  if (!native) return null;

  const toggle = async (on) => {
    setBusy(true);
    try {
      const result = await setReleaseReminders(on, { native });
      setEnabled(result.enabled);
      setDenied(Boolean(result.denied));
    } catch (_) {
      notify.error(t(REMINDER_TEXTS.failed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="release-reminders">
      <label className="flex items-center gap-2 min-h-11 text-xs font-semibold text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          id={`${ids}-toggle`}
          className="w-4 h-4 shrink-0"
          checked={Boolean(enabled)}
          disabled={enabled === null || busy}
          aria-describedby={`${ids}-help${denied ? ` ${ids}-denied` : ''}`}
          onChange={(e) => toggle(e.target.checked)}
        />
        <span>{t(REMINDER_TEXTS.toggle)}</span>
      </label>
      <p id={`${ids}-help`} className="text-xs text-slate-400">{t(REMINDER_TEXTS.help)}</p>
      {denied && <p id={`${ids}-denied`} role="alert" className="text-xs text-amber-300 mt-1">{t(REMINDER_TEXTS.denied)}</p>}
    </div>
  );
}
