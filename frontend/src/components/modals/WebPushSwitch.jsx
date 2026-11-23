import { useEffect, useId, useState } from 'react';
import { BellRing } from 'lucide-react';
import { notify } from '../../utils/notify';
import { t } from '../../i18n/index.js';
import { disableWebPush, enableWebPush, readWebPushState, setWebPushHour, testWebPush, webPushSupport, WEB_PUSH_DEFAULT_HOUR } from '../../utils/webPush';

// i18n
export const WEB_PUSH_TEXTS = {
  toggle: 'Erinnerungen am Erscheinungstag',
  help: 'Meldet sich am Erscheinungstag zur gewählten Uhrzeit in diesem Browser, wenn ein Band aus dem Release-Radar erscheint oder eine neue Folge eines Anime auf deiner Liste läuft, auch bei geschlossenem Tab. Gilt nur für diesen Browser.',
  insecure: 'Geht nur, wenn Manga Shelf über HTTPS aufgerufen wird.',
  unsupported: 'Dieser Browser kann hier keine Mitteilungen empfangen. Auf dem iPhone geht es nur in der Web-App vom Home-Bildschirm.',
  denied: 'Mitteilungen sind für diese Seite blockiert – erlaube sie in den Website-Einstellungen des Browsers.',
  failed: 'Erinnerungen konnten nicht umgestellt werden',
  service: 'Der Push-Dienst des Browsers ist gerade nicht erreichbar. Bitte später erneut versuchen.',
  hour: 'Uhrzeit',
  hourFailed: 'Uhrzeit konnte nicht gespeichert werden'
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Settings → Allgemein in a browser: the Web Push switch of the release-day reminders (off by default, per browser).
 * Greyed out with the reason where the browser cannot do it; while on, "Uhrzeit" picks the hour (server time zone, default 9)
 * and "Test senden" checks the way to this browser.
 */
export default function WebPushSwitch({ env = globalThis }) {
  const ids = useId();
  const [support] = useState(() => webPushSupport(env));
  const [enabled, setEnabled] = useState(support === 'ok' ? null : false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hour, setHour] = useState(WEB_PUSH_DEFAULT_HOUR);

  useEffect(() => {
    if (support !== 'ok') return undefined;
    let active = true;
    readWebPushState()
      .then((state) => {
        if (!active) return;
        setEnabled(state.subscribed);
        setHour(state.hour);
      })
      .catch(() => { if (active) setEnabled(false); });
    return () => { active = false; };
  }, [support]);

  const toggle = async (on) => {
    setBusy(true);
    setDenied(false);
    try {
      const result = on ? await enableWebPush() : await disableWebPush();
      setEnabled(Boolean(result.enabled));
      if (result.denied) setDenied(true);
      if (result.unsupported) notify.error(t(WEB_PUSH_TEXTS.unsupported));
    } catch (e) {
      // the browser's own subscribe() failures (no push service, blocked) are DOMExceptions without a server answer
      if (e?.name === 'AbortError' || e?.name === 'NotAllowedError' || e?.name === 'InvalidStateError') notify.error(t(WEB_PUSH_TEXTS.service));
      else notify.error(e, { fallback: t(WEB_PUSH_TEXTS.failed) });
    } finally {
      setBusy(false);
    }
  };

  const changeHour = async (next) => {
    const before = hour;
    setHour(next);
    setBusy(true);
    try {
      if (!(await setWebPushHour(next))) setHour(before);
    } catch (e) {
      setHour(before);
      notify.error(e, { fallback: t(WEB_PUSH_TEXTS.hourFailed) });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      if (await testWebPush()) notify.success(t('Test-Mitteilung gesendet'));
      else notify.error(t('Test-Mitteilung konnte nicht gesendet werden'));
    } catch (e) {
      notify.error(e, { fallback: t('Test-Mitteilung konnte nicht gesendet werden') });
    } finally {
      setBusy(false);
    }
  };

  const reason = support === 'insecure' ? WEB_PUSH_TEXTS.insecure : support === 'unsupported' ? WEB_PUSH_TEXTS.unsupported : null;
  return (
    <div data-testid="web-push">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className={`flex items-center gap-2 min-h-11 text-xs font-semibold ${reason ? 'text-slate-400 opacity-70 cursor-not-allowed' : 'text-slate-300 cursor-pointer'}`}>
          <input
            type="checkbox"
            className="w-4 h-4 shrink-0"
            checked={Boolean(enabled)}
            disabled={Boolean(reason) || enabled === null || busy}
            aria-describedby={`${ids}-help${reason ? ` ${ids}-reason` : ''}${denied ? ` ${ids}-denied` : ''}`}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span>{t(WEB_PUSH_TEXTS.toggle)}</span>
        </label>
        {enabled && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <span>{t(WEB_PUSH_TEXTS.hour)}</span>
            <select
              className="input-field bg-slate-950 !w-auto !px-3 !py-1.5"
              value={hour}
              disabled={busy}
              onChange={(e) => changeHour(Number(e.target.value))}
            >
              {HOURS.map((h) => <option key={h} value={h}>{`${h}:00`}</option>)}
            </select>
          </label>
        )}
        {enabled && (
          <button
            type="button"
            onClick={sendTest}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-xs text-slate-300 hover:text-white hover:border-slate-600 disabled:opacity-50"
          >
            <BellRing className="w-3.5 h-3.5" aria-hidden="true" />
            {t('Test senden')}
          </button>
        )}
      </div>
      <p id={`${ids}-help`} className="text-xs text-slate-400">{t(WEB_PUSH_TEXTS.help)}</p>
      {reason && <p id={`${ids}-reason`} className="text-xs text-amber-300 mt-1">{t(reason)}</p>}
      {denied && <p id={`${ids}-denied`} role="alert" className="text-xs text-amber-300 mt-1">{t(WEB_PUSH_TEXTS.denied)}</p>}
    </div>
  );
}
