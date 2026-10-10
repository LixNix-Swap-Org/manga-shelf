import { useId } from 'react';
import { Eye, History, LogIn, RefreshCw, Unplug } from 'lucide-react';
import { formatDayMonth, formatRelative } from '../../utils/format';
import useCrunchyroll from './useCrunchyroll';
import { t } from '../../i18n/index.js';

// i18n
export const CARD_TEXTS = {
  title: 'Crunchyroll-Verlauf (experimentell)',
  benefit: 'Übernimmt gesehene Folgen aus deinem Crunchyroll-Verlauf in deine Anime-Liste. Die höhere Folgenzahl gewinnt, nie rückwärts.',
  toggle: 'Crunchyroll-Verlauf abgleichen',
  warning: 'Inoffizielle Schnittstelle: kann jederzeit aufhören zu funktionieren. Bitte beachte die Nutzungsbedingungen von Crunchyroll. '
    + 'Anmeldung mit deinem Crunchyroll-Passwort – die Anmeldung über Google oder Apple funktioniert in der eingebetteten Anmeldung meist nicht.',
  privacy: 'Die Anmeldung bleibt im sicheren Speicher dieses Geräts, auch beim Wechsel des Servers. An die Sammlung gehen nur Serien, Folgennummern und der Gerätetyp; für neue Serien sucht der Server die Titel bei AniList/MyAnimeList. Abgeglichen wird nur, während die App geöffnet ist.',
  autoAdd: 'Neue Serien aus dem Verlauf automatisch in die gemeinsame Liste aufnehmen',
  locked: 'Schlüsselbund gesperrt – entsperren und Manga Shelf neu starten',
  unreadable: 'Anmeldung auf diesem Gerät nicht lesbar – trennen und neu verbinden',
  unavailable: 'Kein sicherer Schlüsselspeicher – unter Linux GNOME Keyring oder KWallet einrichten und Manga Shelf neu starten',
  connect: 'Mit Crunchyroll verbinden',
  syncNow: 'Jetzt abgleichen',
  disconnect: 'Trennen',
  unskip: (n) => t('Übersprungene wieder anzeigen ({n})', { n })
};

const BUTTON = 'hit-44 text-xs inline-flex items-center gap-1.5 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

/** 'verbunden · zuletzt abgeglichen vor 5 Minuten', 'nicht verbunden', or the error of the last attempt. */
export function crunchyrollStateText({ connected, state = {} }, now = Date.now()) {
  // i18n-dynamic: a SYNC_TEXTS text or a server message, stored German in the sync state
  if (state.last_error) return t(state.last_error);
  if (!connected) return t('nicht verbunden');
  const at = state.last_ok ? formatRelative(state.last_ok, now) : null;
  return at ? t('verbunden · zuletzt abgeglichen {time}', { time: at }) : t('verbunden · noch nicht abgeglichen');
}

/**
 * Settings card of the Crunchyroll history sync (apps and desktop; the parent mounts it only when watchAvailable()). Opt-in
 * switch (default off) with the warning, the login, state, 'Jetzt abgleichen' and 'Trennen'.
 */
export default function CrunchyrollCard({ headingLevel = 3 }) {
  const ids = useId();
  const Heading = `h${headingLevel}`;
  const cr = useCrunchyroll();
  const working = Boolean(cr.busy);
  // an automatic sync locks 'Trennen' and the switch as well: aria-disabled keeps the focus where it is
  const locked = working || Boolean(cr.running);
  const store = cr.available === false ? cr.reason || 'unreadable' : null;
  const error = Boolean(store) || Boolean(cr.state?.last_error);
  const guard = (fn) => () => { if (!locked) fn(); };
  const stateText = store ? t(CARD_TEXTS[store])
    : cr.busy === 'connect' ? t('Anmeldung läuft…') : cr.busy === 'sync' || cr.running ? t('Gleiche ab…') : crunchyrollStateText(cr);
  const since = !store && cr.connected && cr.state?.connected_at ? formatDayMonth(new Date(cr.state.connected_at)) : null;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4" aria-labelledby={`${ids}-title`} aria-busy={locked || undefined} data-provider="crunchyroll-history" data-busy={locked ? 'true' : undefined}>
      <Heading id={`${ids}-title`} className="text-sm font-bold text-white flex items-center gap-2">
        <History className="w-4 h-4 text-brand-400" aria-hidden="true" /> {t(CARD_TEXTS.title)}
      </Heading>
      <p className="text-xs text-slate-400 mt-2">{t(CARD_TEXTS.benefit)}</p>

      <label className="mt-3 flex items-center gap-2 min-h-11 text-xs text-slate-300 cursor-pointer">
        <input
          type="checkbox"
          className="w-4 h-4 shrink-0 aria-disabled:opacity-50"
          checked={cr.enabled}
          disabled={cr.loading}
          aria-disabled={locked || undefined}
          aria-describedby={`${ids}-warning ${ids}-privacy`}
          onChange={(e) => { if (!locked) cr.setEnabled(e.target.checked); }}
        />
        <span>{t(CARD_TEXTS.toggle)}</span>
      </label>
      <p id={`${ids}-warning`} className="text-[11px] text-amber-300 mt-2">{t(CARD_TEXTS.warning)}</p>
      <p id={`${ids}-privacy`} className="text-[11px] text-slate-400 mt-1">{t(CARD_TEXTS.privacy)}</p>

      {cr.enabled && !cr.loading && (
        <div className="mt-3 pt-3 border-t border-slate-800 space-y-2">
          <p aria-live="polite" className={`text-xs ${error ? 'text-rose-300' : cr.connected ? 'text-emerald-300' : 'text-slate-400'}`} data-testid="crunchyroll-state">
            {stateText}
          </p>
          {since && <p className="text-[11px] text-slate-400" data-testid="crunchyroll-since">{t('Verbunden seit {date}', { date: since })}</p>}
          {cr.autoAdd !== null && cr.autoAdd !== undefined && (
            <label className="flex items-center gap-2 min-h-11 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 shrink-0 aria-disabled:opacity-50"
                checked={cr.autoAdd}
                aria-disabled={locked || undefined}
                onChange={(e) => { if (!locked) cr.setAutoAdd(e.target.checked); }}
              />
              <span>{t(CARD_TEXTS.autoAdd)}</span>
            </label>
          )}
          {store === 'unavailable' ? null : store ? (
            <div className="flex flex-wrap items-center gap-2 [@media(pointer:coarse)]:gap-5">
              <button type="button" className={`btn-secondary ${BUTTON}`} onClick={guard(cr.disconnect)} aria-disabled={locked || undefined}>
                <Unplug className="w-3.5 h-3.5" aria-hidden="true" /> {t(CARD_TEXTS.disconnect)}
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2 [@media(pointer:coarse)]:gap-5">
              {!cr.connected && (
                <button type="button" className={`btn-primary ${BUTTON}`} onClick={guard(cr.connect)} aria-disabled={locked || undefined}>
                  <LogIn className="w-3.5 h-3.5" aria-hidden="true" /> {t(CARD_TEXTS.connect)}
                </button>
              )}
              {cr.connected && (
                <>
                  <button type="button" className={`btn-secondary ${BUTTON}`} onClick={guard(cr.sync)} aria-disabled={locked || undefined}>
                    <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {t(CARD_TEXTS.syncNow)}
                  </button>
                  <button type="button" className={`btn-secondary ${BUTTON}`} onClick={guard(cr.disconnect)} aria-disabled={locked || undefined}>
                    <Unplug className="w-3.5 h-3.5" aria-hidden="true" /> {t(CARD_TEXTS.disconnect)}
                  </button>
                </>
              )}
              {cr.skipped > 0 && (
                <button type="button" className={`btn-secondary ${BUTTON}`} onClick={guard(cr.unskip)} aria-disabled={locked || undefined}>
                  <Eye className="w-3.5 h-3.5" aria-hidden="true" /> {CARD_TEXTS.unskip(cr.skipped)}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
