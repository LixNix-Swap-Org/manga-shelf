import { useEffect, useState } from 'react';
import { ShieldCheck, Sparkles, X } from 'lucide-react';
import { getLanguage, t, tn } from '../../i18n/index.js';
import { isLocalMode } from '../../utils/api';
import { updateSummary } from '../../utils/whatsNew.js';
import { loadChangelog } from './changelog.js';

/** "„A“ und „B“" / "„A“" of up to two titles. */
const quoted = (titles) => titles.map((title) => `„${title}“`).join(` ${t('und')} `);

/**
 * The card on the start page after an update: what came since the version the account last saw. "Ansehen" opens
 * "Was ist neu", X marks it seen, "Später" hides it until the next browser session. Nothing for this account (no item
 * for everybody and, for an admin, no note before updating): it is marked seen without a card.
 */
export default function WhatsNewHint({ whatsNew, isAdmin = false, onOpen }) {
  const { unseen, later, seen, current, markSeen, putOff } = whatsNew;
  const [summary, setSummary] = useState(null);
  const wanted = unseen && !later;

  useEffect(() => {
    if (!wanted) return undefined;
    let alive = true;
    loadChangelog()
      .then((versions) => {
        if (!alive) return;
        const next = updateSummary(versions, { seen, current, language: getLanguage(), admin: isAdmin });
        if (next) setSummary(next);
        else markSeen();
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [wanted, seen, current, isAdmin, markSeen]);

  if (!wanted || !summary) return null;
  const several = summary.versions.length > 1;
  const migrations = summary.migrations.join(', ');
  return (
    <section
      aria-labelledby="whats-new-hint-title"
      data-testid="whats-new-hint"
      className="mb-6 rounded-2xl border border-brand-500/45 bg-gradient-to-r from-brand-950/60 to-slate-900/85 p-4 flex flex-wrap sm:flex-nowrap items-start gap-3 shadow-xl"
    >
      <div className="w-9 h-9 shrink-0 rounded-xl bg-brand-500/15 border border-brand-400/40 flex items-center justify-center text-brand-300">
        <Sparkles className="w-5 h-5" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0 basis-[calc(100%-3.5rem)] sm:basis-auto space-y-1">
        <h2 id="whats-new-hint-title" className="text-[15px] font-bold text-slate-100">
          {t('Manga Shelf {version} ist da', { version: current })}
        </h2>
        {summary.count > 0 && (
          <p className="text-sm text-slate-300 leading-relaxed">
            {several
              ? tn('{n} Neuerung seit {seen}', '{n} Neuerungen seit {seen}', summary.count, { seen })
              : tn('{n} Neuerung für dich', '{n} Neuerungen für dich', summary.count)}
            {summary.titles.length > 0 && <>, {t('zum Beispiel {titles}', { titles: quoted(summary.titles) })}</>}.
          </p>
        )}
        {isAdmin && summary.adminNotes > 0 && (
          <p className="flex items-start gap-2 mt-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-px text-amber-400" aria-hidden="true" />
            <span>
              <b>{t('Für Admins:')}</b>{' '}
              {migrations
                ? (isLocalMode()
                  ? t('Datenbank-Migration {numbers} ist beim Start gelaufen.', { numbers: migrations })
                  : t('Datenbank-Migration {numbers} ist beim Start gelaufen, die Sicherung davor liegt in „backups“.', { numbers: migrations }))
                : t('Es gibt Hinweise vor dem Update, siehe „Für Admins“.')}
            </span>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 w-full sm:w-auto sm:self-center">
        <button
          type="button"
          onClick={() => { markSeen(); onOpen?.(); }}
          className="btn-primary text-sm px-4 py-2 flex-1 sm:flex-none"
        >
          {t('Ansehen')}
        </button>
        <button type="button" onClick={putOff} className="btn-secondary text-sm px-4 py-2">
          {t('Später')}
        </button>
        <button
          type="button"
          onClick={markSeen}
          className="hit-44 p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800"
          aria-label={t('Hinweis schließen')}
          title={t('Hinweis schließen')}
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
