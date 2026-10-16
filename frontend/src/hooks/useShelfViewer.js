import { useEffect, useState } from 'react';
import { apiFetch, readJson } from '../utils/api';

// true while the signed-in user is only a viewer of the given shelf (shared read-only); false until known or when unsure
export default function useShelfViewer(shelfId, enabled) {
  const [viewer, setViewer] = useState(false);
  useEffect(() => {
    setViewer(false);
    if (!enabled || !shelfId) return undefined;
    let current = true;
    (async () => {
      try {
        const res = await apiFetch('/api/shelves');
        if (!res.ok) return;
        const data = await readJson(res);
        const shelf = data?.shelves?.find(s => s.id === shelfId);
        if (current && shelf) setViewer(shelf.role === 'viewer');
      } catch { /* the server enforces the role anyway */ }
    })();
    return () => { current = false; };
  }, [shelfId, enabled]);
  return viewer;
}
