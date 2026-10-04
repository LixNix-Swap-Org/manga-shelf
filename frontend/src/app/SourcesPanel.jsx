import { lazy, Suspense } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useApiKeys, listSyncProps } from '../components/modals/AccountModal';
import ApiKeyCard from '../components/modals/ApiKeyCard';
import { INSECURE_STORAGE_TEXT } from '../local/credentials';
import { WATCH_BUILD, watchAvailable } from './watch/watchState';
import { t } from '../i18n/index.js';

const CrunchyrollCard = WATCH_BUILD ? lazy(() => import('./watch/CrunchyrollCard')) : null;

/** "Quellen & Schlüssel" of the standalone mode (onboarding step 3 and the device screen): the AccountModal cards. */
export default function SourcesPanel({ headingLevel = 3 }) {
  const keys = useApiKeys({ admin: true, listSync: true });
  if (keys.error) return <p role="alert" className="text-sm text-rose-300">{keys.error}</p>;
  if (!keys.guides) return <p className="text-sm text-slate-400" role="status">{t('Wird geladen…')}</p>;
  const insecure = [...keys.userKeys, ...keys.instanceKeys].some((k) => k.insecure_storage);
  const card = (scope, state) => {
    const guide = keys.guideOf(state.provider);
    if (!guide) return null;
    return (
      <ApiKeyCard
        key={`${scope}:${state.provider}`}
        guide={guide}
        state={state}
        scope={scope}
        headingLevel={headingLevel}
        busy={keys.busy === `${scope}:${state.provider}`}
        onSave={(secret, opts) => keys.save(scope, state.provider, secret, opts)}
        onRemove={() => keys.remove(scope, state.provider)}
        onToggleBackground={scope === 'user' ? (on) => keys.toggleBackground(state.provider, on) : undefined}
        {...(scope === 'user' ? listSyncProps(keys, state.provider) : {})}
      />
    );
  };
  // MAL and Google Books exist per user and per instance; without a server one card each is enough
  const userProviders = new Set(keys.userKeys.map((k) => k.provider));
  return (
    <div className="space-y-4" id="local-sources">
      <p className="text-xs text-slate-400">
        {t('Freiwillig: ohne eigene Schlüssel laufen Suche und Daten über die öffentlichen Zugänge (AniList ohne Token, Jikan statt MyAnimeList), nur mit deren Limit.')}
      </p>
      {insecure && (
        <p role="note" className="flex items-start gap-2 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/40 rounded-xl p-3">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t(INSECURE_STORAGE_TEXT)}</span>
        </p>
      )}
      {keys.userKeys.map((state) => card('user', state))}
      {keys.instanceKeys.filter((state) => !userProviders.has(state.provider)).map((state) => card('instance', state))}
      {CrunchyrollCard && watchAvailable() && (
        <Suspense fallback={null}>
          <CrunchyrollCard headingLevel={headingLevel} />
        </Suspense>
      )}
    </div>
  );
}
