import { useState, useEffect } from 'react';

/** Shopping list (missing volumes) with offline cache, quick buy and the queue of purchases made offline. */
export default function useShoppingList({ setNetworkOffline, fetchMangas }) {
  // Shopping / Wishlist state with offline local storage cache
  const [shoppingData, setShoppingData] = useState(() => {
    try {
      const cached = localStorage.getItem('mangashelf_shopping_cache');
      return cached ? JSON.parse(cached) : null;
    } catch (_) { return null; }
  });
  const [loadingShopping, setLoadingShopping] = useState(false);
  const [shoppingPublisherFilter, setShoppingPublisherFilter] = useState('ALL');
  const [shoppingSearch, setShoppingSearch] = useState('');
  const [buyingId, setBuyingId] = useState(null);
  const [offlineLastUpdated, setOfflineLastUpdated] = useState(() => {
    try {
      const meta = localStorage.getItem('mangashelf_shopping_meta');
      return meta ? JSON.parse(meta)?.timestamp : null;
    } catch (_) { return null; }
  });

  // Sync offline queued purchases once online
  const syncPendingPurchases = async () => {
    try {
      const queue = JSON.parse(localStorage.getItem('mangashelf_pending_purchases') || '[]');
      if (!queue.length) return;
      console.log(`[PWA] Synchronisiere ${queue.length} offline getätigte Käufe...`);
      // Only drop what the server accepted (or what no longer exists); a 401/5xx keeps the purchase queued for the next try
      const remaining = [];
      for (const volId of queue) {
        try {
          const res = await fetch(`/api/volumes/${volId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Vorhanden' })
          });
          if (!res.ok && res.status !== 404) remaining.push(volId);
        } catch (_) {
          remaining.push(volId);
        }
      }
      if (remaining.length) localStorage.setItem('mangashelf_pending_purchases', JSON.stringify(remaining));
      else localStorage.removeItem('mangashelf_pending_purchases');
      fetchShoppingList();
      fetchMangas();
    } catch (err) {
      console.warn('Sync pending purchases deferred:', err);
    }
  };

  useEffect(() => {
    if (navigator.onLine) syncPendingPurchases();
  }, []);

  const fetchShoppingList = async () => {
    try {
      setLoadingShopping(true);
      const res = await fetch('/api/shopping-list');
      if (res.ok) {
        const data = await res.json();
        setShoppingData(data);
        setNetworkOffline(false);
        const now = new Date().toISOString();
        setOfflineLastUpdated(now);
        try {
          localStorage.setItem('mangashelf_shopping_cache', JSON.stringify(data));
          localStorage.setItem('mangashelf_shopping_meta', JSON.stringify({ timestamp: now }));
        } catch (_) {}
      } else {
        // Fallback to cache if server error
        const cached = localStorage.getItem('mangashelf_shopping_cache');
        if (cached) {
          setShoppingData(JSON.parse(cached));
          setNetworkOffline(true);
        }
      }
    } catch (e) {
      console.warn('Network issue fetching shopping list, using offline cache:', e);
      try {
        const cached = localStorage.getItem('mangashelf_shopping_cache');
        if (cached) {
          setShoppingData(JSON.parse(cached));
          setNetworkOffline(true);
        }
      } catch (_) {}
    } finally {
      setLoadingShopping(false);
    }
  };

  const handleQuickBuy = async (volumeId) => {
    setBuyingId(volumeId);

    const updateLocalState = () => {
      setShoppingData(prev => {
        if (!prev) return prev;
        const updatedItems = prev.items.filter(item => item.id !== volumeId);
        const boughtItem = prev.items.find(item => item.id === volumeId);
        const newCost = Math.max(0, prev.total_cost - (boughtItem?.price || 0));
        const updated = {
          ...prev,
          total_missing: updatedItems.length,
          total_cost: Math.round(newCost * 100) / 100,
          items: updatedItems
        };
        try {
          localStorage.setItem('mangashelf_shopping_cache', JSON.stringify(updated));
        } catch (_) {}
        if ('vibrate' in navigator) {
          try { navigator.vibrate([25, 45, 25]); } catch (_) {}
        }
        return updated;
      });
    };

    if (!navigator.onLine) {
      // Offline mode: queue purchase in local storage
      try {
        const queue = JSON.parse(localStorage.getItem('mangashelf_pending_purchases') || '[]');
        if (!queue.includes(volumeId)) queue.push(volumeId);
        localStorage.setItem('mangashelf_pending_purchases', JSON.stringify(queue));
      } catch (_) {}
      updateLocalState();
      setBuyingId(null);
      return;
    }

    try {
      const res = await fetch(`/api/volumes/${volumeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Vorhanden' })
      });
      if (res.ok) {
        updateLocalState();
        fetchMangas();
        fetchShoppingList();
      } else {
        alert('Fehler beim Aktualisieren des Bands');
      }
    } catch (e) {
      // Network drop: queue purchase offline
      try {
        const queue = JSON.parse(localStorage.getItem('mangashelf_pending_purchases') || '[]');
        if (!queue.includes(volumeId)) queue.push(volumeId);
        localStorage.setItem('mangashelf_pending_purchases', JSON.stringify(queue));
      } catch (_) {}
      updateLocalState();
      setNetworkOffline(true);
    } finally {
      setBuyingId(null);
    }
  };

  return {
    shoppingData, loadingShopping, shoppingPublisherFilter, setShoppingPublisherFilter,
    shoppingSearch, setShoppingSearch, buyingId, offlineLastUpdated,
    fetchShoppingList, handleQuickBuy, syncPendingPurchases
  };
}
