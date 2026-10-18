import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { loadShelves, shelvesGeneration, shelvesOf, shelvesScope, shelvesVersion, subscribeShelves } from '../utils/shelfScope';

/** The signed-in user's shelves with their role (shared store in utils/shelfScope.js); null while unknown or disabled. */
export function useShelves(userId, enabled = true) {
  useSyncExternalStore(subscribeShelves, shelvesVersion, shelvesVersion);
  const scope = shelvesScope(userId);
  const known = userId !== null && userId !== undefined;
  const generation = shelvesGeneration();
  useEffect(() => {
    if (enabled && known) loadShelves(scope);
  }, [enabled, known, scope, generation]);
  return enabled && known ? shelvesOf(scope) : null;
}

// viewer: true while the signed-in user is only a viewer of the given shelf; movableShelves: target shelves when the user owns this shelf and can write to at least one other shelf.
export function useShelfAccess(shelfId, enabled, userId) {
  const shelves = useShelves(userId, Boolean(enabled && shelfId));
  return useMemo(() => {
    const list = Array.isArray(shelves) ? shelves : [];
    const shelf = list.find((s) => s.id === shelfId);
    if (!shelf) return { viewer: false, movableShelves: [] };
    const editable = list.filter((s) => s.role !== 'viewer');
    return { viewer: shelf.role === 'viewer', movableShelves: shelf.role === 'owner' && editable.length > 1 ? editable : [] };
  }, [shelves, shelfId]);
}

// true while the signed-in user is only a viewer of the given shelf (shared read-only); false until known or when unsure
export default function useShelfViewer(shelfId, enabled, userId) {
  return useShelfAccess(shelfId, enabled, userId).viewer;
}
