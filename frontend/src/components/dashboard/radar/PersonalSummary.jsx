import { useEffect, useId, useState } from 'react';
import { Package, RefreshCw, Coins, CalendarPlus, Copy, ExternalLink } from 'lucide-react';
import api, { apiUrl } from '../../../utils/api';
import { notify } from '../../../utils/notify';
import { formatCount, formatEuro, formatRelative } from '../../../utils/format';

const euro = (value) => formatEuro(value || 0);

const FEED_API = '/api/radar/feed-token';

/** Absolute feed address as this client reaches the server (relative in the browser build, the server base in the app). */
export function feedAddress(state) {
  if (!state?.path) return null;
  try {
    return new URL(apiUrl(state.path), window.location.href).href;
  } catch (_) {
    return state.url || null;
  }
}

/**
 * "Kalender abonnieren": the personal iCal address of the radar (GET/POST/DELETE /api/radar/feed-token). The token
 * is its own secret, never the session; a new one replaces the old.
 */
export function CalendarFeedPanel() {
  const ids = useId();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRenew, setConfirmRenew] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get(FEED_API, { fallback: 'Kalender-Abo konnte nicht geladen werden' })
      .then((data) => { if (alive) setState(data); })
      .catch((err) => { if (alive) setError(err?.message || 'Kalender-Abo konnte nicht geladen werden'); });
    return () => { alive = false; };
  }, []);

  const act = async (fn, success) => {
    setBusy(true);
    setConfirmRenew(false);
    try {
      setState(await fn());
      setError('');
      if (success) notify.success(success);
    } catch (err) {
      notify.error(err, { fallback: 'Kalender-Abo konnte nicht geändert werden' });
    } finally {
      setBusy(false);
    }
  };
  const create = (renew) => act(() => api.post(FEED_API, {}), renew ? 'Neue Adresse erzeugt – die alte funktioniert nicht mehr' : 'Kalender-Adresse erzeugt');
  const revoke = () => act(async () => {
    await api.del(FEED_API);
    return { active: false };
  }, 'Kalender-Abo beendet');

  const address = feedAddress(state);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      notify.success('Kalender-Adresse kopiert');
    } catch (_) {
      notify.info('Kopieren nicht möglich – bitte die Adresse im Feld markieren und kopieren.');
    }
  };

  return (
    <div id="radar-calendar-feed" className="w-full rounded-2xl border border-sky-500/25 bg-slate-950/60 p-4 space-y-3 text-xs">
      <p className="text-slate-300">
        Vorbestellte und angekündigte Bände mit genauem Erscheinungstag als Kalender-Abo (iCal) – für iPhone, Android oder Thunderbird.
        Die Adresse ist persönlich und funktioniert ohne Anmeldung: nicht weitergeben.
      </p>
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      {!state && !error && <p role="status" className="text-slate-400">Wird geladen…</p>}
      {state && !state.active && (
        <button type="button" id="btn-calendar-feed-create" className="btn-primary text-xs inline-flex items-center gap-1.5" disabled={busy} onClick={() => create(false)}>
          <CalendarPlus className="w-3.5 h-3.5" aria-hidden="true" /> Abo-Adresse erzeugen
        </button>
      )}
      {state?.active && (
        <div className="space-y-2">
          {address ? (
            <>
              <label htmlFor={`${ids}-url`} className="block text-slate-400">Kalender-Adresse</label>
              <div className="flex flex-wrap gap-2">
                <input
                  id={`${ids}-url`}
                  readOnly
                  value={address}
                  onFocus={(e) => e.target.select()}
                  className="input-field text-base sm:text-xs flex-1 min-w-0 font-mono"
                />
                <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={copy}>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" /> Kopieren
                </button>
                <a href={address.replace(/^https?:/, 'webcal:')} className="btn-secondary text-xs inline-flex items-center gap-1.5">
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /> In Kalender-App öffnen
                </a>
              </div>
            </>
          ) : (
            <p className="text-amber-300">Die Adresse lässt sich nicht mehr anzeigen (der Server-Schlüssel hat sich geändert). Bitte neu erzeugen und im Kalender ersetzen.</p>
          )}
          <p className="text-slate-400">
            {state.last_used_at ? `Zuletzt abgerufen ${formatRelative(state.last_used_at)}.` : 'Noch nicht abgerufen.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {confirmRenew ? (
              <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label="Neue Adresse erzeugen?">
                <span className="text-amber-200">Die alte Adresse hört sofort auf zu funktionieren.</span>
                <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => create(true)}>Neu erzeugen</button>
                <button type="button" className="btn-secondary text-xs" onClick={() => setConfirmRenew(false)}>Abbrechen</button>
              </span>
            ) : (
              <button type="button" id="btn-calendar-feed-renew" className="btn-secondary text-xs" disabled={busy} onClick={() => setConfirmRenew(true)}>Neue Adresse erzeugen</button>
            )}
            <button type="button" id="btn-calendar-feed-revoke" className="btn-secondary text-xs text-rose-300" disabled={busy} onClick={revoke}>Abo beenden</button>
          </div>
        </div>
      )}
      <details className="text-slate-300">
        <summary className="cursor-pointer text-brand-300 hover:text-brand-200">So abonnierst du den Kalender</summary>
        <ul className="mt-2 space-y-1.5 list-disc pl-5">
          <li><strong>iPhone/iPad:</strong> „In Kalender-App öffnen“ tippen und „Abonnieren“ – oder Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo hinzufügen, Adresse einfügen.</li>
          <li><strong>Android:</strong> im Browser calendar.google.com öffnen → bei „Weitere Kalender“ auf + → „Per URL“ → Adresse einfügen. Danach in der Google-Kalender-App unter Einstellungen die Synchronisierung des Kalenders einschalten. Ohne Google-Konto geht es mit der App ICSx⁵.</li>
          <li><strong>Thunderbird:</strong> Kalender → Neuer Kalender → Im Netzwerk → Adresse einfügen → Abonnieren.</li>
        </ul>
        <p className="mt-2 text-slate-400">Google ruft den Kalender von seinen eigenen Servern ab: das klappt nur, wenn Manga Shelf aus dem Internet erreichbar ist. iPhone und Thunderbird holen ihn direkt vom Gerät. Kalender-Apps aktualisieren Abos nur alle paar Stunden.</p>
      </details>
    </div>
  );
}

/** Pre-order count and budget of the personal radar ('–' while nothing is loaded, never a made-up 0,00 €). */
export default function PersonalSummary({
  radarData,
  loadingRadar,
  fetchReleaseRadar
}) {
  const [feedOpen, setFeedOpen] = useState(false);
  return (
    <>
      <div className="glass-panel p-5 sm:p-6 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gradient-to-r from-slate-900/90 via-slate-900/70 to-sky-950/30">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center shrink-0">
            <Package className="w-6 h-6 text-sky-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span>Meine Vorbestellungen & Lieferungen</span>
              {radarData && (
                <span className="bg-sky-500/20 text-sky-300 text-xs px-2.5 py-0.5 rounded-full border border-sky-500/30 font-mono font-bold">
                  {formatCount(radarData.total_releases, 'Band', 'Bände')}
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Verfolge deine offenen Vorbestellungen und behalte dein geplantes Manga-Budget im Blick
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3 w-full md:w-auto">
          <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
              <Package className="w-3 h-3 text-sky-400" /> Vorbestellt ({radarData ? radarData.preordered_count : '–'})
            </p>
            <p className="text-base sm:text-lg font-extrabold text-sky-400 font-mono">
              {radarData ? euro(radarData.preordered_budget) : '–'}
            </p>
          </div>

          <div className="bg-slate-950/70 border border-slate-800 px-3.5 py-2 rounded-xl text-right flex-1 sm:flex-initial">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold flex items-center justify-end gap-1">
              <Coins className="w-3 h-3 text-emerald-400" /> Gesamt geplant
            </p>
            <p className="text-base sm:text-lg font-extrabold text-emerald-400 font-mono">
              {radarData ? euro(radarData.total_budget) : '–'}
            </p>
          </div>

          <button
            type="button"
            id="btn-calendar-feed"
            onClick={() => setFeedOpen((v) => !v)}
            aria-expanded={feedOpen}
            aria-controls="radar-calendar-feed"
            className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 shrink-0"
            title="Erscheinungstermine als Kalender abonnieren"
            aria-label="Kalender abonnieren"
          >
            <CalendarPlus className="w-4 h-4 text-sky-400" aria-hidden="true" />
            <span className="hidden sm:inline" aria-hidden="true">Kalender abonnieren</span>
          </button>

          <button
            type="button"
            onClick={fetchReleaseRadar}
            disabled={loadingRadar}
            className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5 shrink-0"
            title="Release-Radar aktualisieren"
            aria-label="Release-Radar aktualisieren"
          >
            <RefreshCw className={`w-4 h-4 ${loadingRadar ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      {feedOpen && <CalendarFeedPanel />}
    </>
  );
}
