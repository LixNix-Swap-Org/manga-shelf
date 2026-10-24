import { useMemo } from 'react';
import { AlertTriangle, Users } from 'lucide-react';
import CoverImage from '../../common/CoverImage';
import { togetherRows } from '../../../utils/animeHub';
import { displayTitle } from '../../../utils/animeHelpers';
import { animeProgressLabel } from '../../../utils/enumLabels.js';
import { t, tn } from '../../../i18n/index.js';

/** Tab "Gemeinsam": entries that two or more accounts follow, who is how far and where everybody can watch together. */
export default function AnimeTogetherTab({ list, userId, username, onOpen }) {
  const me = username;
  const rows = useMemo(() => togetherRows(list), [list]);
  if (!rows.length) {
    return (
      <p className="text-sm text-slate-400 bg-slate-900/60 border border-slate-800 rounded-2xl px-4 py-6 text-center">
        {t('Noch kein Anime, den mehrere Accounts schauen oder planen. Sobald zwei Personen denselben Eintrag haben, siehst du hier, wer wo steht.')}
      </p>
    );
  }
  return (
    <ul className="space-y-2" id="anime-together">
      {rows.map(({ anime, people, reached, ahead, finished }) => (
        <li key={anime.id} className="glass-card rounded-2xl border border-slate-800 p-3 flex flex-wrap items-start gap-3">
          <div className="w-12 h-16 shrink-0 rounded-lg overflow-hidden bg-slate-900 border border-slate-800">
            <CoverImage src={anime.cover_image} className="w-full h-full object-cover" fallback={<div className="w-full h-full" />} />
          </div>
          <div className="min-w-0 flex-1 basis-56">
            <button type="button" onClick={() => onOpen(anime)} className="text-left font-semibold text-white hover:underline line-clamp-2 break-words">{displayTitle(anime)}</button>
            <p className="text-xs mt-0.5 flex items-center gap-1.5 text-sky-300">
              <Users className="w-3.5 h-3.5" aria-hidden="true" />
              {finished
                ? t('Alle haben ihn gesehen')
                : reached > 0 ? t('Gemeinsam bis Folge {n}', { n: reached }) : t('Noch nicht alle haben angefangen')}
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {people.map((p) => (
                <li key={p.user_id} className={`text-[11px] px-2 py-1 rounded-full border ${p.user_id === userId ? 'border-brand-500/60 bg-brand-600/20 text-white' : 'border-slate-700 text-slate-300'}`}>
                  <span className="font-semibold">{p.user_id === userId ? t('Du') : p.username}</span>
                  {' · '}{animeProgressLabel(p.status)}{p.status !== 'Gesehen' && p.episodes > 0 ? ` · ${tn('{n} Folge', '{n} Folgen', p.episodes)}` : ''}
                </li>
              ))}
            </ul>
            {ahead.length > 0 && (
              <p className="text-[11px] text-amber-300 mt-2 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                {t('Weiter sind: {names} – bei Spoilern aufpassen.', { names: ahead.map((name) => (name === me ? t('Du') : name)).join(', ') })}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
