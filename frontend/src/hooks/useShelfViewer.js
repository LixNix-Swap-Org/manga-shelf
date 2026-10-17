import { useEffect, useState } from 'react';
import { apiFetch, readJson } from '../utils/api';

// viewer: true while the signed-in user is only a viewer of the given shelf; movableShelves: target shelves when the user owns this shelf and can write to at least one other shelf.
export function useShelfAccess(shelfId, enabled) {
  const [state, setState] = useState({ viewer: false, movableShelves: [] });
  useEffect(() => {
    setState({ viewer: false, movableShelves: [] });
    if (!enabled || !shelfId) return undefined;
    let current = true;
    (async () => {
      try {
        const res = await apiFetch('/api/shelves');
        if (!res.ok) return;
        const data = await readJson(res);
        const list = Array.isArray(data?.shelves) ? data.shelves : [];
        const shelf = list.find(s => s.id === shelfId);
        const editable = list.filter(s => s.role !== 'viewer');
        if (current && shelf) {
          setState({
            viewer: shelf.role === 'viewer',
            movableShelves: shelf.role === 'owner' && editable.length > 1 ? editable : []
          });
        }
      } catch { /* the server enforces the role anyway */ }
    })();
    return () => { current = false; };
  }, [shelfId, enabled]);
  return state;
}

// true while the signed-in user is only a viewer of the given shelf (shared read-only); false until known or when unsure
export default function useShelfViewer(shelfId, enabled) {
  return useShelfAccess(shelfId, enabled).viewer;
}
