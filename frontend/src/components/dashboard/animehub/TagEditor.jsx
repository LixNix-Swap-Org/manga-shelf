import { useId, useState } from 'react';
import { Tag, X } from 'lucide-react';
import { t } from '../../../i18n/index.js';

const MAX_TAG = 30;
const MAX_TAGS = 20;

/**
 * Tags of one entry as chips, shared by everybody. Adding or removing one sends only that change (`onSave({ tags_add })`,
 * `onSave({ tags_remove })`), so a tag someone else added meanwhile stays; `onSave` resolves false when nothing was stored,
 * and the typed name then stays in the field.
 */
export default function TagEditor({ tags = [], known = [], canEdit, busy, onSave }) {
  const [value, setValue] = useState('');
  const ids = useId();
  const add = async (e) => {
    e.preventDefault();
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name || tags.some((x) => x.toLowerCase() === name.toLowerCase())) { setValue(''); return; }
    if (await onSave({ tags_add: [name] }) !== false) setValue('');
  };
  const suggestions = known.filter((k) => !tags.some((x) => x.toLowerCase() === k.toLowerCase()));
  return (
    <div id="anime-tags">
      <p className="block text-[11px] text-slate-400 mb-1 flex items-center gap-1"><Tag className="w-3 h-3" aria-hidden="true" /> {t('Tags')}</p>
      <ul className="flex flex-wrap gap-1.5 mb-2">
        {tags.length === 0 && <li className="text-xs text-slate-400">{t('Noch keine Tags')}</li>}
        {tags.map((tag) => (
          <li key={tag} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-100">
            {tag}
            {canEdit && (
              <button type="button" disabled={busy} className="text-fuchsia-300 hover:text-white" aria-label={t('Tag „{tag}“ entfernen', { tag })} onClick={() => onSave({ tags_remove: [tag] })}>
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && tags.length < MAX_TAGS && (
        <form onSubmit={add} className="flex gap-2">
          <input id={`${ids}-tag`} list={`${ids}-known`} aria-label={t('Neuer Tag')} placeholder={t('z. B. Mit Freunden')} maxLength={MAX_TAG} className="input-field text-base sm:text-sm"
            value={value} onChange={(e) => setValue(e.target.value)} />
          <datalist id={`${ids}-known`}>{suggestions.map((k) => <option key={k} value={k} />)}</datalist>
          <button type="submit" className="btn-secondary text-xs" disabled={busy || !value.trim()}>{t('Hinzufügen')}</button>
        </form>
      )}
    </div>
  );
}
