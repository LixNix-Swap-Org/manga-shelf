import { useEffect, useId, useState } from 'react';
import { Copy, ExternalLink, Link2, Share2 } from 'lucide-react';
import api from '../../../utils/api';
import { notify } from '../../../utils/notify';
import { formatRelative } from '../../../utils/format';
import { feedAddress } from '../radar/PersonalSummary';
import { t } from '../../../i18n/index.js';

const SHARE_API = '/api/wishlist/share-token';

/**
 * "Meine Wunschliste teilen": a read-only link to the caller's own wishes (GET/POST/DELETE /api/wishlist/share-token,
 * the page is GET /api/wishlist/shared?token=…) for family and friends without an account. A new link replaces the old.
 */
export default function WishlistSharePanel() {
  const ids = useId();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRenew, setConfirmRenew] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get(SHARE_API, { fallback: t('Teilen-Link konnte nicht geladen werden') })
      .then((data) => { if (alive) setState(data); })
      .catch((err) => { if (alive) setError(err?.message || t('Teilen-Link konnte nicht geladen werden')); });
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
      notify.error(err, { fallback: t('Teilen-Link konnte nicht geändert werden') });
    } finally {
      setBusy(false);
    }
  };
  const create = (renew) => act(() => api.post(SHARE_API, {}), renew ? t('Neuer Link erzeugt – der alte funktioniert nicht mehr') : t('Link zur Wunschliste erzeugt'));
  const revoke = () => act(async () => {
    await api.del(SHARE_API);
    return { active: false };
  }, t('Wunschliste wird nicht mehr geteilt'));

  const address = feedAddress(state);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      notify.success(t('Link kopiert'));
    } catch (_) {
      notify.info(t('Kopieren nicht möglich – bitte den Link im Feld markieren und kopieren.'));
    }
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const share = async () => {
    try {
      await navigator.share({ title: t('Meine Manga-Wunschliste'), url: address });
    } catch (_) { /* closed by the user */ }
  };

  return (
    <div id="wishlist-share" className="w-full rounded-2xl border border-rose-500/25 bg-slate-950/60 p-4 space-y-3 text-xs">
      <p className="text-slate-300">
        {t('Ein Link zu deinen eigenen Wünschen, zum Ansehen ohne Konto – etwa für Familie und Freunde vor dem Geburtstag. Er zeigt Titel, Verlag und Priorität, keine Preise, Regale oder Wünsche anderer. Wer den Link hat, kann die Liste sehen.')}
      </p>
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      {!state && !error && <p role="status" className="text-slate-400">{t('Wird geladen…')}</p>}
      {state && !state.active && (
        <button type="button" id="btn-wishlist-share-create" className="btn-primary text-xs inline-flex items-center gap-1.5" disabled={busy} onClick={() => create(false)}>
          <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('Link erzeugen')}
        </button>
      )}
      {state?.active && (
        <div className="space-y-2">
          {address ? (
            <>
              <label htmlFor={`${ids}-url`} className="block text-slate-400">{t('Link zur Wunschliste')}</label>
              <div className="flex flex-wrap gap-2">
                {/* on a phone the link gets its own row, the buttons the next one */}
                <input
                  id={`${ids}-url`}
                  readOnly
                  value={address}
                  onFocus={(e) => e.target.select()}
                  className="input-field text-base sm:text-xs basis-full sm:basis-0 flex-1 min-w-0 font-mono"
                />
                <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={copy}>
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" /> {t('Kopieren')}
                </button>
                {canShare && (
                  <button type="button" className="btn-secondary text-xs inline-flex items-center gap-1.5" onClick={share}>
                    <Share2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('Teilen')}
                  </button>
                )}
                <a href={address} target="_blank" rel="noreferrer" className="btn-secondary text-xs inline-flex items-center gap-1.5">
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /> {t('Ansehen')}
                </a>
              </div>
            </>
          ) : (
            <p className="text-amber-300">{t('Der Link lässt sich nicht mehr anzeigen (der Server-Schlüssel hat sich geändert). Bitte neu erzeugen.')}</p>
          )}
          <p className="text-slate-400">
            {state.last_used_at ? t('Zuletzt angesehen {time}.', { time: formatRelative(state.last_used_at) }) : t('Noch nicht angesehen.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {confirmRenew ? (
              <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={t('Neuen Link erzeugen?')}>
                <span className="text-amber-200">{t('Der alte Link hört sofort auf zu funktionieren.')}</span>
                <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => create(true)}>{t('Neu erzeugen')}</button>
                <button type="button" className="btn-secondary text-xs" onClick={() => setConfirmRenew(false)}>{t('Abbrechen')}</button>
              </span>
            ) : (
              <button type="button" id="btn-wishlist-share-renew" className="btn-secondary text-xs" disabled={busy} onClick={() => setConfirmRenew(true)}>{t('Neuen Link erzeugen')}</button>
            )}
            <button type="button" id="btn-wishlist-share-revoke" className="btn-secondary text-xs text-rose-300" disabled={busy} onClick={revoke}>{t('Nicht mehr teilen')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
