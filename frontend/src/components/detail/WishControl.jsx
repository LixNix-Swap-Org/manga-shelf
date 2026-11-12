import { useState } from 'react';
import { Heart } from 'lucide-react';
import { request } from '../../utils/api';
import { notify } from '../../utils/notify';
import { DEFAULT_WISH_PRIORITY, isWishedSeries, priorityBadgeClass, wishLabel, wishersText } from '../../utils/priority';
import { t } from '../../i18n/index.js';

/**
 * The wish of a series on its detail page (migration 57: a wishlist per person, visible to the shelf): the pill names who
 * wishes it, and everyone who may keep a wishlist (online, not a guest) puts the series on their own list or takes it
 * off with one button. A series that has volumes already is no wish any more; the button is not offered there.
 * onSaved({ wish_priority, wishes, my_wish }) updates the page's copy.
 */
export default function WishControl({ manga, canWish = false, onSaved }) {
  const [saving, setSaving] = useState(false);
  if (!manga) return null;
  const wished = isWishedSeries(manga);
  const mine = manga.my_wish !== null && manga.my_wish !== undefined;
  const names = wishersText(manga.wishes);
  const offer = Boolean(canWish && manga.id) && !(Number(manga.owned_volumes) > 0);

  const toggle = async () => {
    if (saving) return;
    const priority = mine ? null : DEFAULT_WISH_PRIORITY;
    setSaving(true);
    try {
      const data = await request('PUT', `/api/mangas/${manga.id}/wish`, { priority }, { fallback: t('Wunschliste konnte nicht geändert werden') });
      onSaved?.({ wish_priority: data?.wish_priority ?? null, wishes: data?.wishes || [], my_wish: data?.my_wish ?? null });
      notify.success(priority === null ? t('Von deiner Wunschliste genommen') : t('Auf deine Wunschliste gesetzt'));
    } catch (e) {
      notify.error(e, { fallback: t('Wunschliste konnte nicht geändert werden') });
    } finally {
      setSaving(false);
    }
  };

  if (!wished && !offer) return null;
  return (
    <>
      {wished && (
        <span
          id="detail-wish-pill"
          className={`px-3 py-1 rounded-xl border font-semibold flex items-center gap-1.5 ${priorityBadgeClass(manga.wish_priority)}`}
          title={names ? t('Gewünscht von {names}', { names }) : undefined}
        >
          <Heart className="w-3.5 h-3.5" aria-hidden="true" />
          {wishLabel(manga)}
          {names && <span className="font-normal opacity-90">· {names}</span>}
        </span>
      )}
      {offer && (
        <button
          type="button"
          id="detail-wish-toggle"
          onClick={toggle}
          disabled={saving}
          aria-pressed={mine}
          className={`px-3 py-1 rounded-xl border font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-60 ${
            mine ? 'bg-rose-500/15 text-rose-200 border-rose-500/40 hover:bg-rose-500/25' : 'text-slate-300 border-slate-700 hover:text-white hover:border-rose-500/50'
          }`}
        >
          <Heart className={`w-3.5 h-3.5 ${mine ? 'fill-current' : ''}`} aria-hidden="true" />
          {mine ? t('Von meiner Wunschliste') : t('Auf meine Wunschliste')}
        </button>
      )}
    </>
  );
}
