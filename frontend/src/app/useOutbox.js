import { useEffect, useMemo, useState } from 'react';
import { getOutbox, outboxScope, isPurchaseEntry } from '../utils/outbox';

/** The outbox entries of this user on the active server, re-rendered on every change. */
export function useOutboxEntries(userId) {
  const outbox = getOutbox();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = outbox.subscribe(() => setVersion((v) => v + 1));
    outbox.load();
    return unsubscribe;
  }, [outbox]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version: neu lesen bei jeder Änderung
  return useMemo(() => (userId === null || userId === undefined ? [] : outbox.list(outboxScope(userId))), [outbox, userId, version]);
}

/** { total, purchases, purchaseIds } of the pending changes; purchases are volumes bought but not confirmed yet. */
export function useOutboxPending(userId) {
  const entries = useOutboxEntries(userId);
  return useMemo(() => {
    const purchases = entries.filter(isPurchaseEntry);
    return { total: entries.length, purchases: purchases.length, purchaseIds: new Set(purchases.map((e) => e.volumeId)), entries };
  }, [entries]);
}
