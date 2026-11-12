// What this device remembers about the view (sorting, filters, shelf size, "Lücken zeigen" …), for "Ansicht
// zurücksetzen" in the settings dialog. Saved filters live in the account and stay.
export const VIEW_PREFERENCE_KEYS = [
  'mangashelf_status_filter', 'mangashelf_publisher_filter', 'mangashelf_collect_filter', 'mangashelf_tag_filter',
  'mangashelf_language_filter', 'mangashelf_shelf_filter', 'mangashelf_person_filter', 'mangashelf_sort_by',
  'mangashelf_view_mode', 'mangashelf_shelf_mode', 'mangashelf_shelf_scale', 'mangashelf_show_gaps',
  'mangashelf_volume_view_mode', 'mangashelf_detail_notices_open', 'mangashelf_search', 'mangashelf_search_scope',
  'mangashelf_anime_kind', 'mangashelf_anime_language', 'mangashelf_anime_calendar_view', 'mangashelf_anime_search_kind'
];

const isViewKey = (key) => VIEW_PREFERENCE_KEYS.some((name) => key === name || key.startsWith(`${name}:`));

/** Removes the stored view of this device (also the per-account variants `<key>:<scope>`); returns how many entries went. */
export function resetViewPreferences() {
  let removed = 0;
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[name];
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i));
      for (const key of keys.filter((k) => typeof k === 'string' && isViewKey(k))) {
        storage.removeItem(key);
        removed += 1;
      }
    } catch (_) { /* storage unavailable */ }
  }
  return removed;
}
