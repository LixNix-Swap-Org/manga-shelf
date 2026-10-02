import { Link } from 'react-router-dom';
import BarcodeScannerButton from '../common/BarcodeScannerButton';
import { 
  ShoppingCart, RefreshCw, Search, X, CheckCircle2, 
  BookOpen, Building2, Check, WifiOff 
} from 'lucide-react';

export default function ShoppingListView({
  shoppingData,
  loadingShopping,
  fetchShoppingList,
  isOfflineMode,
  offlineLastUpdated,
  syncPendingPurchases,
  shoppingSearch,
  setShoppingSearch,
  shoppingPublisherFilter,
  setShoppingPublisherFilter,
  normalizePubName,
  setActiveMainView,
  canEdit,
  handleQuickBuy,
  buyingId,
  failedImages,
  setFailedImages
}) {
  const handleBarcodeScan = async (scannedCode) => {
    const cleanIsbn = scannedCode.replace(/[^0-9X]/gi, '');
    const matchedItem = (shoppingData?.items || []).find(it => {
      const itIsbn = (it.isbn || '').replace(/[^0-9X]/gi, '');
      return itIsbn && itIsbn === cleanIsbn;
    });

    if (matchedItem) {
      setShoppingSearch(matchedItem.title);
      alert(`🎯 Treffer auf der Einkaufsliste: "${matchedItem.title} Band ${matchedItem.volume_number}" gefunden!`);
      return;
    }

    try {
      const res = await fetch(`/api/lookup/isbn?isbn=${encodeURIComponent(cleanIsbn)}`);
      const data = await res.json();
      if (data && data.found) {
        if (data.matched_volume && data.matched_volume.status === 'Vorhanden') {
          alert(`✅ Bereits in deiner Sammlung: "${data.matched_manga.title} Band ${data.matched_volume.volume_number}" besitzt du bereits!`);
        } else if (data.matched_manga) {
          setShoppingSearch(data.matched_manga.title);
          alert(`ℹ️ "${data.matched_manga.title}" ist in deiner Sammlung – dieser Band (${data.book?.volume_number || ''}) fehlt dir noch.`);
        } else {
          setShoppingSearch(data.book?.title || cleanIsbn);
          alert(`📖 Gefunden: "${data.book?.title || 'Unbekannt'}". Diese Reihe ist noch nicht in deiner Sammlung.`);
        }
      } else {
        setShoppingSearch(cleanIsbn);
      }
    } catch (_) {
      setShoppingSearch(cleanIsbn);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Offline Banner when offline or using cached shopping list */}
      {isOfflineMode && (
        <div className="bg-amber-500/15 border border-amber-500/30 text-amber-300 p-3.5 rounded-2xl text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-fade-in shadow-lg">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center shrink-0">
              <WifiOff className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <p className="font-bold text-amber-200 text-sm flex items-center gap-2">
                <span>Offline-Einkaufsmodus aktiv</span>
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping"></span>
              </p>
              <p className="text-amber-300/90 text-xs mt-0.5">
                Keine Internetverbindung. Die Liste wird aus dem lokalen Smartphone-Speicher bereitgestellt{offlineLastUpdated ? ` (Stand: ${new Date(offlineLastUpdated).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr)` : ''}. Im Laden getätigte Käufe werden vorgemerkt und automatisch synchronisiert.
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              if (navigator.onLine) {
                fetchShoppingList();
                if (syncPendingPurchases) syncPendingPurchases();
              } else {
                alert('Gerät ist noch immer offline. Sobald wieder Netz vorhanden ist, wird automatisch synchronisiert.');
              }
            }}
            className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded-xl text-amber-200 text-xs font-semibold transition-all shrink-0 flex items-center justify-center gap-1.5 self-stretch sm:self-auto cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Verbindung prüfen</span>
          </button>
        </div>
      )}

      {/* Shopping Summary Card */}
      <div className="glass-panel p-5 sm:p-6 rounded-2xl border border-slate-800/80 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gradient-to-r from-slate-900/90 via-slate-900/70 to-emerald-950/20">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <ShoppingCart className="w-6 h-6 text-emerald-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <span>Einkaufsliste & Wunschbände</span>
              {shoppingData && (
                <span className="bg-emerald-500/20 text-emerald-300 text-xs px-2.5 py-0.5 rounded-full border border-emerald-500/30">
                  {shoppingData.total_missing} Bände
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Alle Bände mit Status „Fehlt“, sortiert nach Verlag zum schnellen Finden und Abhaken im Laden
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          <div className="bg-slate-950/70 border border-slate-800 px-4 py-2 rounded-xl text-right flex-1 sm:flex-initial">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Geschätzter Gesamtpreis</p>
            <p className="text-lg font-extrabold text-emerald-400 font-mono">
              {shoppingData ? shoppingData.total_cost.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00'} €
            </p>
          </div>
          <button
            onClick={fetchShoppingList}
            disabled={loadingShopping}
            className="btn-secondary text-xs p-2.5 text-slate-300 flex items-center gap-1.5"
            title="Liste aktualisieren"
          >
            <RefreshCw className={`w-4 h-4 ${loadingShopping ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Shopping Filters Bar */}
      <div className="glass-panel p-4 rounded-2xl border border-slate-800/80 flex flex-col sm:flex-row justify-between items-center gap-3">
        {/* Search */}
        <div className="flex items-center gap-2 bg-slate-950/70 border border-slate-800 rounded-xl px-3 py-2 w-full sm:w-72">
          <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <input
            type="text"
            placeholder="Titel oder Band filtern..."
            className="w-full bg-transparent border-0 p-0 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-0"
            value={shoppingSearch}
            onChange={e => setShoppingSearch(e.target.value)}
          />
          <div className="flex items-center gap-1 shrink-0">
            <BarcodeScannerButton compact onDetected={handleBarcodeScan} buttonText="Laden-Scan" />
            {shoppingSearch && (
              <button onClick={() => setShoppingSearch('')} className="text-slate-500 hover:text-white p-0.5">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Publisher Filter Chips */}
        {shoppingData?.publishers && shoppingData.publishers.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0 scrollbar-none">
            <button
              onClick={() => setShoppingPublisherFilter('ALL')}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
                shoppingPublisherFilter === 'ALL'
                  ? 'bg-brand-600 text-white shadow'
                  : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-700/50'
              }`}
            >
              Alle Verlage ({shoppingData.total_missing})
            </button>
            {shoppingData.publishers.map(p => (
              <button
                key={p.publisher}
                onClick={() => setShoppingPublisherFilter(p.publisher)}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all flex items-center gap-1.5 ${
                  shoppingPublisherFilter === p.publisher
                    ? 'bg-brand-600 text-white shadow'
                    : 'bg-slate-800/60 text-slate-400 hover:text-white border border-slate-700/50'
                }`}
              >
                <span>{p.publisher}</span>
                <span className="text-[10px] bg-slate-900/80 px-1.5 py-0.5 rounded-full font-mono">
                  {p.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Loading State */}
      {loadingShopping && !shoppingData && (
        <div className="flex justify-center items-center py-20 text-slate-400 gap-2">
          <RefreshCw className="w-5 h-5 animate-spin text-brand-400" />
          <span>Einkaufsliste wird geladen...</span>
        </div>
      )}

      {/* Empty State */}
      {!loadingShopping && (!shoppingData || shoppingData.items.length === 0) && (
        <div className="glass-panel p-12 rounded-3xl border border-slate-800 text-center max-w-lg mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="w-8 h-8 text-emerald-400" />
          </div>
          <h3 className="text-lg font-bold text-white">Alles komplett im Regal!</h3>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Aktuell hast du keine Bände mit dem Status „Fehlt“. Sobald du bei einer Reihe Bände als fehlend markierst, erscheinen sie hier automatisch in deiner Einkaufsliste.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 mt-6">
            <button
              onClick={() => setActiveMainView('shelf')}
              className="btn-primary text-xs px-4 py-2"
            >
              Zurück zur Sammlung
            </button>
          </div>
        </div>
      )}

      {/* Shopping List Items Grid */}
      {shoppingData && shoppingData.items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3.5 sm:gap-4">
          {shoppingData.items
            .filter(item => {
              const effectivePub = item.effective_publisher || '';
              const matchPub = shoppingPublisherFilter === 'ALL' || 
                (normalizePubName ? normalizePubName(effectivePub).toLowerCase() : effectivePub.toLowerCase()) === shoppingPublisherFilter.toLowerCase();
              const matchSearch = !shoppingSearch || 
                item.manga_title.toLowerCase().includes(shoppingSearch.toLowerCase()) || 
                String(item.volume_number).includes(shoppingSearch) ||
                (effectivePub && effectivePub.toLowerCase().includes(shoppingSearch.toLowerCase()));
              return matchPub && matchSearch;
            })
            .map(item => (
              <div
                key={item.id}
                className="glass-card rounded-2xl p-3 border border-slate-800/80 flex gap-3 relative group hover:border-emerald-500/50 transition-all bg-slate-900/60"
              >
                {/* Cover Thumbnail */}
                <Link to={`/manga/${item.manga_id}`} className="shrink-0 relative group/cover">
                  {item.manga_cover && !failedImages[`shop-${item.id}`] ? (
                    <img
                      src={item.manga_cover}
                      alt={item.manga_title}
                      onError={() => setFailedImages(prev => ({ ...prev, [`shop-${item.id}`]: true }))}
                      className="w-16 h-24 object-cover rounded-xl shadow-md border border-slate-800 group-hover/cover:scale-105 transition-transform"
                    />
                  ) : (
                    <div className="w-16 h-24 bg-slate-800 rounded-xl flex items-center justify-center text-slate-500 border border-slate-700/60">
                      <BookOpen className="w-6 h-6" />
                    </div>
                  )}
                  <span className="absolute top-1 left-1 bg-amber-500/90 text-slate-950 font-black text-[9px] px-1.5 py-0.5 rounded shadow uppercase">
                    Fehlt
                  </span>
                </Link>

                {/* Info & Buy Button */}
                <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                  <div>
                    <Link
                      to={`/manga/${item.manga_id}`}
                      className="text-xs font-bold text-white hover:text-brand-300 truncate block transition-colors"
                      title={item.manga_title}
                    >
                      {item.manga_title}
                    </Link>
                    
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold px-2 py-0.5 rounded-lg font-mono">
                        Band {item.volume_number}
                      </span>
                      {item.price > 0 && (
                        <span className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono px-2 py-0.5 rounded-lg font-bold">
                          {item.price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                        </span>
                      )}
                    </div>

                    <p className="text-[11px] text-slate-400 mt-1.5 truncate flex items-center gap-1">
                      <Building2 className="w-3 h-3 text-brand-400 shrink-0" />
                      <span className="truncate">{item.effective_publisher}</span>
                    </p>
                    {item.isbn && (
                      <p className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">
                        ISBN: {item.isbn}
                      </p>
                    )}
                  </div>

                  {/* Quick Buy Button */}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => handleQuickBuy(item.id)}
                      disabled={buyingId === item.id}
                      className="mt-2.5 w-full bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/40 hover:border-emerald-500 py-1.5 px-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-all active:scale-95 shadow-sm"
                      title="Als gekauft markieren und ins Regal stellen"
                    >
                      {buyingId === item.id ? (
                        <RefreshCw className="w-3 h-3 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5 text-emerald-400 group-hover:text-white" />
                      )}
                      <span>Gekauft</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
