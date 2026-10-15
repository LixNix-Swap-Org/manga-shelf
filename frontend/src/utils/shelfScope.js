// The shelf chosen in the collection toolbar (localStorage mangashelf_shelf_filter) narrows statistics and trash too.
export function shelfQuery(prefix = '?') {
  try {
    const id = localStorage.getItem('mangashelf_shelf_filter');
    return id && id !== 'ALL' && /^\d+$/.test(id) ? `${prefix}shelf_id=${id}` : '';
  } catch {
    return '';
  }
}
