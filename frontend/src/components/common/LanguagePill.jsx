import { useSyncExternalStore } from 'react';
import { editionCode, editionLanguage, editionName, getDefaultLanguage, subscribeDefaultLanguage, volumeLanguage } from '../../utils/editions';
import { t } from '../../i18n/index.js';

/** The account's default edition language (users.default_language); re-renders when the account dialog changes it. */
export function useDefaultLanguage() {
  return useSyncExternalStore(subscribeDefaultLanguage, getDefaultLanguage, getDefaultLanguage);
}

const SIZES = {
  sm: 'text-[10px] px-1.5 py-0.5 rounded-md',
  md: 'text-xs px-2 py-0.5 rounded-lg'
};

/**
 * Edition language as a short code ('EN', 'EN-US'); hidden for the default language unless `always`. The title and the
 * screen reader text carry the language name in the UI language.
 */
export default function LanguagePill({ language, region = null, always = false, size = 'sm', className = '' }) {
  const defaultLanguage = useDefaultLanguage();
  if (!language || (!always && language === defaultLanguage)) return null;
  const name = editionName(language, region);
  return (
    <span
      className={`language-pill inline-flex items-center font-bold uppercase tracking-wide border border-teal-400/50 bg-teal-500/15 text-teal-200 shrink-0 ${SIZES[size] || SIZES.sm} ${className}`}
      title={t('Ausgabe: {language}', { language: name })}
      data-language={language}
    >
      <span aria-hidden="true">{editionCode(language, region)}</span>
      <span className="sr-only">{t('Ausgabe: {language}', { language: name })}</span>
    </span>
  );
}

/** A volume in another language than its series (volumes.language override); nothing otherwise. */
export function VolumeLanguagePill({ volume, manga, className = '' }) {
  if (!volume?.language) return null;
  const language = volumeLanguage(volume, manga);
  if (language === editionLanguage(manga)) return null;
  return <LanguagePill language={language} always className={className} />;
}
