// Parts of the settings dialog (AccountModal) that are not account fields of their own: the section heading, "Ansicht
// zurücksetzen", the overview "Wer sieht was", the calendar addresses and the devices of the account.
import { useState } from 'react';
import { CalendarPlus, LogOut, RotateCcw } from 'lucide-react';
import useAccountDefaults from '../../hooks/useAccountDefaults';
import { apiFetch, isAppMode, readJson, rememberToken } from '../../utils/api';
import { notify } from '../../utils/notify';
import { resetViewPreferences } from '../../utils/viewReset';
import { markReopenAccount } from '../../i18n/preference.js';
import { serverText } from '../../i18n/serverText.js';
import { t } from '../../i18n/index.js';
import { roleBadgeClass, roleLabel } from '../dashboard/dashboardShell';
import { CalendarFeedPanel } from '../dashboard/radar/PersonalSummary';
import ConnectQr from '../common/ConnectQr';

/** Heading of a group inside a tab; every group but the first is set off by a line. */
export function SettingsSection({ title, first = false, children }) {
  return (
    <section className={`space-y-3 ${first ? '' : 'pt-4 border-t border-slate-800'}`}>
      <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</h3>
      {children}
    </section>
  );
}

const reloadPage = () => window.location.reload();

/**
 * "Ansicht zurücksetzen": drops what this device remembers about sorting, filters and shelf size and loads the page
 * again without the filter parameters of the address; the dialog comes back on this tab.
 */
export function ResetViewField({ reload = reloadPage }) {
  const reset = () => {
    resetViewPreferences();
    markReopenAccount('general');
    try {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    } catch (_) { /* the address stays */ }
    reload();
  };
  return (
    <SettingsSection title={t('Ansicht auf diesem Gerät')}>
      <p className="text-xs text-slate-400">{t('Sortierung, Filter, Regalgröße und „Lücken zeigen“ merkt sich jedes Gerät für sich.')}</p>
      <button type="button" id="btn-reset-view" onClick={reset} className="btn-secondary text-sm inline-flex items-center gap-2">
        <RotateCcw className="w-4 h-4" aria-hidden="true" /> {t('Ansicht zurücksetzen')}
      </button>
      <p className="text-xs text-slate-400">{t('Die Seite lädt danach neu. Gemerkte Filter bleiben erhalten.')}</p>
    </SettingsSection>
  );
}

/** "Wer sieht was": what the other accounts see of this one; the anime rows follow the two settings above. */
export function WhoSeesWhat({ offline = false }) {
  const stored = useAccountDefaults({ enabled: !offline });
  const shelfMates = t('Mitglieder deiner Regale');
  const onlyYou = t('Nur du');
  const ratings = { public: t('Alle Konten, mit deinem Namen'), anonymous: t('Alle Konten, ohne Namen'), private: onlyYou };
  const rows = [
    [t('Sammlung, Besitz und Gelesen'), shelfMates],
    [t('Wunschliste'), shelfMates],
    [t('Anime-Liste'), stored.shareAnime === false ? onlyYou : t('Alle Konten, mit deinem Namen')],
    [t('Neue Anime-Bewertungen'), ratings[stored.animeVisibility] || ratings.public],
    [t('Anime-Notizen'), onlyYou]
  ];
  return (
    <SettingsSection title={t('Wer sieht was')}>
      <dl id="settings-who-sees" className="rounded-xl border border-slate-800 bg-slate-950/50 divide-y divide-slate-800 text-xs">
        {rows.map(([what, who]) => (
          <div key={what} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3.5 py-2.5">
            <dt className="font-semibold text-slate-300">{what}</dt>
            <dd className="text-slate-400">{who}</dd>
          </div>
        ))}
      </dl>
    </SettingsSection>
  );
}

/** "Kalender-Abo": the two personal calendar addresses (the same panels as in the radar and the anime calendar). */
export function CalendarFeeds() {
  const [open, setOpen] = useState(null);
  const toggle = (which) => setOpen((cur) => (cur === which ? null : which));
  const button = (which, label) => (
    <button
      type="button"
      id={`btn-settings-feed-${which}`}
      aria-expanded={open === which}
      onClick={() => toggle(which)}
      className={`btn-secondary text-xs inline-flex items-center gap-1.5 ${open === which ? 'text-white border-brand-500/60' : ''}`}
    >
      <CalendarPlus className="w-3.5 h-3.5" aria-hidden="true" /> {label}
    </button>
  );
  return (
    <SettingsSection title={t('Kalender-Abo')} first>
      <p className="text-xs text-slate-400">{t('Erscheinungstermine und neue Folgen im eigenen Kalender. Dieselben Adressen findest du auch im Radar und im Anime-Kalender.')}</p>
      <div className="flex flex-wrap gap-2">
        {button('radar', t('Manga-Termine'))}
        {button('anime', t('Anime-Folgen'))}
      </div>
      {open && <CalendarFeedPanel key={open} anime={open === 'anime'} />}
    </SettingsSection>
  );
}

/** "Angemeldet als" with the role, as in the account menu. */
export function SignedInAs({ user }) {
  return (
    <div id="settings-signed-in" className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/50 px-3.5 py-2.5 text-xs">
      <span className="text-slate-400 truncate">{t('Angemeldet als:')} <span className="font-semibold text-slate-100">{user?.username}</span></span>
      <span className={`${roleBadgeClass(user)} border text-[10px] px-1.5 py-px rounded font-mono font-bold uppercase shrink-0`}>{roleLabel(user)}</span>
    </div>
  );
}

/**
 * "Geräte": the QR code for the app (browser build, editors and admins: the footer entry) and "Auf anderen Geräten
 * abmelden" (POST /api/auth/logout-others; this device stays signed in, the app takes its new token from the answer).
 */
export function DevicesSection({ user }) {
  const [busy, setBusy] = useState(false);
  const canConnect = !isAppMode() && (user?.role === 'admin' || user?.role === 'editor');

  const logoutOthers = async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/api/auth/logout-others', { method: 'POST', body: {} });
      const data = (await readJson(res)) ?? {};
      if (!res.ok) {
        notify.error(serverText(data) || t('Abmelden fehlgeschlagen'));
        return;
      }
      rememberToken(data, { rotate: true });
      notify.success(t('Alle anderen Geräte sind abgemeldet.'));
    } catch (_) {
      notify.error(t('Netzwerkfehler – bitte erneut versuchen.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t('Geräte')}>
      {canConnect && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-xs text-slate-400 min-w-0 flex-1 basis-56">{t('Die Manga-Shelf-App auf Handy oder Desktop mit diesem Server verbinden.')}</p>
          <ConnectQr id="settings-connect-app" buttonClass="btn-secondary text-xs inline-flex items-center gap-1.5" />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-xs text-slate-400 min-w-0 flex-1 basis-56">{t('Beendet deine Anmeldung auf allen anderen Geräten. Dieses Gerät bleibt angemeldet.')}</p>
        <button type="button" id="btn-logout-others" onClick={logoutOthers} disabled={busy} className="btn-secondary text-xs inline-flex items-center gap-1.5">
          <LogOut className="w-3.5 h-3.5" aria-hidden="true" /> {t('Auf anderen Geräten abmelden')}
        </button>
      </div>
    </SettingsSection>
  );
}
