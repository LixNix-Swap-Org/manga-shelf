import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { 
  TrendingUp, Coins, Building2, BookCheck, BookOpen, X, 
  Wallet, Calendar, Clock, Award, CheckCircle2 
} from 'lucide-react';
import SpendingCard from './SpendingCard';
import OwnerStatsCard from './OwnerStatsCard';
import useDialogA11y from '../../hooks/useDialogA11y';

export default function StatsModal({ isOpen, onClose, user }) {
  const [statsData, setStatsData] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [editingStartDate, setEditingStartDate] = useState(false);
  const [newStartDate, setNewStartDate] = useState('');
  const [savingStartDate, setSavingStartDate] = useState(false);
  const [statsTab, setStatsTab] = useState('overview'); // 'overview' | 'publishers' | 'reading'
  const [detailedReaderStats, setDetailedReaderStats] = useState(null);
  const readerRequestRef = useRef(0); // the newest click wins when reader details load out of order
  const [loadingDetailedStats, setLoadingDetailedStats] = useState(false);
  const [failedImages, setFailedImages] = useState({});

  const fetchStats = async () => {
    try {
      setLoadingStats(true);
      const res = await fetch('/api/stats');
      if (res.ok) {
        const data = await res.json();
        setStatsData(data);
        setNewStartDate(data.settings?.collection_start_date || '2021-04-09');
      }
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setStatsTab('overview');
      setDetailedReaderStats(null);
      setEditingStartDate(false);
      fetchStats();
    }
  }, [isOpen]);

  const fetchReaderDetailedStats = async (userId) => {
    const requestId = ++readerRequestRef.current;
    try {
      setLoadingDetailedStats(true);
      const res = await fetch(`/api/users/${userId}/stats`);
      if (requestId !== readerRequestRef.current) return;
      if (res.ok) {
        const data = await res.json();
        if (requestId !== readerRequestRef.current) return;
        setDetailedReaderStats(data);
      } else {
        alert('Fehler beim Laden der Leser-Details');
      }
    } catch (e) {
      console.error(e);
      if (requestId === readerRequestRef.current) alert('Netzwerkfehler');
    } finally {
      if (requestId === readerRequestRef.current) setLoadingDetailedStats(false);
    }
  };

  const handleSaveStartDate = async (e) => {
    e.preventDefault();
    if (!newStartDate) return;
    try {
      setSavingStartDate(true);
      const res = await fetch('/api/stats/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_start_date: newStartDate })
      });
      if (res.ok) {
        setEditingStartDate(false);
        await fetchStats();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Speichern');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setSavingStartDate(false);
    }
  };

  const dialogRef = useDialogA11y(isOpen);
  if (!isOpen) return null;

  return (
    <div 
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Statistiken"
      tabIndex={-1}
      className="outline-none fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 animate-fade-in overflow-y-auto"
    >
      <div className="glass-panel w-full max-w-4xl max-h-[90vh] rounded-3xl p-6 sm:p-8 border border-slate-700/80 shadow-2xl relative flex flex-col overflow-hidden">
        
        {/* Modal Header */}
        <div className="flex items-start justify-between pb-5 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-950/40">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-xl font-extrabold text-white tracking-tight flex items-center gap-2">
                Statistik- & Finanz-Dashboard
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Finanzen, Monatsausgaben, Verlagsdiagramm, Sammelzeit & Lese-Tracking
              </p>
            </div>
          </div>
          <button 
            id="btn-close-stats-modal-x"
            onClick={onClose} 
            className="text-slate-400 hover:text-white p-1 rounded-xl hover:bg-slate-800 transition-colors"
            title="Schließen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 pt-4 pb-2 shrink-0 border-b border-slate-800/80">
          <button
            onClick={() => setStatsTab('overview')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
              statsTab === 'overview'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Coins className="w-3.5 h-3.5" /> Finanzen & Sammelzeit
          </button>
          <button
            onClick={() => setStatsTab('publishers')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
              statsTab === 'publishers'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" /> Verlagsdiagramm
          </button>
          <button
            onClick={() => setStatsTab('reading')}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${
              statsTab === 'reading'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <BookCheck className="w-3.5 h-3.5" /> Lese-Tracking (User)
          </button>
        </div>

        {/* Modal Body / Scrollable */}
        <div className="overflow-y-auto custom-scrollbar flex-1 pr-1 pt-4 space-y-6">
          {loadingStats ? (
            <div className="py-20 flex flex-col items-center justify-center text-slate-400 gap-3">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs">Berechne Statistiken & Finanzdaten...</p>
            </div>
          ) : !statsData ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              Keine Statistikdaten verfügbar.
            </div>
          ) : (() => {
              const summary = statsData.summary || statsData || {};
              const totalOwnedVal = typeof summary.total_owned_value === 'number' ? summary.total_owned_value : (parseFloat(summary.total_owned_value) || 0);
              const totalPossibleVal = typeof summary.total_possible_value === 'number' ? summary.total_possible_value : (parseFloat(summary.total_possible_value) || 0);
              const avgMonthly = typeof summary.avg_monthly_spending === 'number' ? summary.avg_monthly_spending : (parseFloat(summary.avg_monthly_spending) || 0);
              const avgPrice = typeof summary.avg_price_per_volume === 'number' ? summary.avg_price_per_volume : (parseFloat(summary.avg_price_per_volume) || 0);
              const collMonths = summary.collection_months || statsData.duration?.months || 1;
              const collYears = summary.collection_years || statsData.duration?.years || 0;
              const collDays = summary.collection_days || statsData.duration?.days || 0;
              const ownedVols = summary.total_owned_volumes || 0;
              const totalVolsRecorded = summary.total_volumes_recorded || (summary.total_owned_volumes || 0) + (summary.total_missing_volumes || 0);
              const publishersList = Array.isArray(statsData.publishers) ? statsData.publishers : [];
              const readersList = Array.isArray(statsData.user_reading_stats) ? statsData.user_reading_stats : [];
              const topSeriesList = Array.isArray(statsData.top_series) ? statsData.top_series : [];

              return (
                <>
                  {/* TAB 1: OVERVIEW & FINANCES */}
                  {statsTab === 'overview' && (
                    <div className="space-y-6 animate-fade-in">
                      {/* Top 4 KPI Cards */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                        
                        {/* 1: Sammlungswert (Besitz) */}
                        <div className="p-4 rounded-2xl bg-gradient-to-br from-emerald-950/40 via-slate-900/90 to-slate-950 border border-emerald-500/30 shadow-lg">
                          <div className="flex items-center justify-between text-emerald-400 mb-2">
                            <span className="text-xs font-bold uppercase tracking-wider">Sammlungswert</span>
                            <Coins className="w-4 h-4" />
                          </div>
                          <div className="text-2xl font-extrabold text-white font-mono">
                            {totalOwnedVal.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1">
                            {ownedVols} Bände im Besitz (Ø {avgPrice.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €/Band)
                          </p>
                        </div>

                        {/* 2: Monatsausgaben */}
                        <div className="p-4 rounded-2xl bg-gradient-to-br from-sky-950/40 via-slate-900/90 to-slate-950 border border-sky-500/30 shadow-lg">
                          <div className="flex items-center justify-between text-sky-400 mb-2">
                            <span className="text-xs font-bold uppercase tracking-wider">Monatsausgaben</span>
                            <TrendingUp className="w-4 h-4" />
                          </div>
                          <div className="text-2xl font-extrabold text-sky-300 font-mono">
                            {avgMonthly.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Durchschnitt pro Monat über {collMonths} Monate
                          </p>
                        </div>

                        {/* 3: Sammelzeit */}
                        <div className="p-4 rounded-2xl bg-gradient-to-br from-amber-950/40 via-slate-900/90 to-slate-950 border border-amber-500/30 shadow-lg">
                          <div className="flex items-center justify-between text-amber-400 mb-2">
                            <span className="text-xs font-bold uppercase tracking-wider">Sammelzeit</span>
                            <Clock className="w-4 h-4" />
                          </div>
                          <div className="text-2xl font-extrabold text-amber-300 font-mono">
                            {collYears} Jahre
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
                            <span>{collDays} Tage aktiv</span>
                            {user?.role === 'admin' && (
                              <button
                                type="button"
                                onClick={() => setEditingStartDate(!editingStartDate)}
                                className="text-amber-400 hover:text-amber-300 underline font-medium text-[10px]"
                              >
                                {editingStartDate ? 'Schließen' : 'Datum ändern'}
                              </button>
                            )}
                          </p>
                        </div>

                        {/* 4: Gesamtwert (inkl. fehlende) */}
                        <div className="p-4 rounded-2xl bg-gradient-to-br from-purple-950/40 via-slate-900/90 to-slate-950 border border-purple-500/30 shadow-lg">
                          <div className="flex items-center justify-between text-purple-400 mb-2">
                            <span className="text-xs font-bold uppercase tracking-wider">Vollständiger Wert</span>
                            <Wallet className="w-4 h-4" />
                          </div>
                          <div className="text-2xl font-extrabold text-purple-300 font-mono">
                            {totalPossibleVal.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1">
                            Gesamtwert aller {totalVolsRecorded} erfassten Bände
                          </p>
                        </div>

                      </div>

                      {/* Collection Start Date Editor (Admin Only) */}
                      {editingStartDate && user?.role === 'admin' && (
                        <form onSubmit={handleSaveStartDate} className="p-4 bg-slate-950/90 rounded-2xl border border-amber-500/40 flex flex-wrap items-center gap-3">
                          <Calendar className="w-4 h-4 text-amber-400 shrink-0" />
                          <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-semibold text-slate-300 mb-1">
                              Sammlungs-Startdatum festlegen (Berechnung der Sammelzeit & Monatsausgaben)
                            </label>
                            <input
                              type="date"
                              required
                              className="input-field text-xs py-1.5"
                              value={newStartDate}
                              onChange={e => setNewStartDate(e.target.value)}
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={savingStartDate}
                            className="btn-primary text-xs py-2 px-3 !bg-amber-600 hover:!bg-amber-500 text-white mt-auto"
                          >
                            {savingStartDate ? 'Speichert...' : 'Datum speichern'}
                          </button>
                        </form>
                      )}

                      {/* Quick Summary Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Reading Summary Card */}
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
                            <BookCheck className="w-4 h-4 text-emerald-400" /> Lese-Fortschritt der Community
                          </h4>
                          <div className="space-y-3.5">
                            {readersList.map(r => {
                              const pct = r.read_pct !== undefined ? r.read_pct : (r.percentage || 0);
                              return (
                                <div key={r.user_id} className="space-y-1.5">
                                  <div className="flex justify-between items-center text-xs">
                                    <span className="font-semibold text-white">{r.display_name || r.username}</span>
                                    <span className="text-slate-400 font-mono">
                                      <strong className="text-emerald-400">{r.read_count}</strong> / {r.total_owned || ownedVols} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                                    <div 
                                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                  <div className="flex justify-between text-[10px] text-slate-500">
                                    <span>Gelesen: {r.read_count} Bände</span>
                                    <span>Noch ungelesen (SuB): {r.unread_count} Bände</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        <SpendingCard spending={statsData.spending} />

                        <OwnerStatsCard ownerStats={statsData.owner_stats} />

                        {/* Top Publishers Quick View */}
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center justify-between">
                            <span className="flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-sky-400" /> Größte Verlage im Regal
                            </span>
                            <button
                              type="button"
                              onClick={() => setStatsTab('publishers')}
                              className="text-sky-400 hover:text-sky-300 font-medium text-xs normal-case"
                            >
                              Alle anzeigen ↗
                            </button>
                          </h4>
                          <div className="space-y-3">
                            {publishersList.slice(0, 4).map(pub => (
                              <div key={pub.publisher} className="space-y-1">
                                <div className="flex justify-between items-center text-xs">
                                  <span className="font-medium text-slate-200 truncate">{pub.publisher}</span>
                                  <span className="font-mono text-slate-400 shrink-0">
                                    <strong className="text-white">{pub.volume_count ?? pub.volumes_count}</strong> Bände ({pub.percentage}%)
                                  </span>
                                </div>
                                <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                                  <div 
                                    className="h-full bg-sky-500 rounded-full"
                                    style={{ width: `${Math.min(100, pub.percentage * 2)}%` }}
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Top Series Showcase */}
                      {topSeriesList && topSeriesList.length > 0 && (
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-4 flex items-center gap-2">
                            <Award className="w-4 h-4 text-amber-400" /> Top Reihen mit den meisten Bänden
                          </h4>
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                            {topSeriesList.map((ts, idx) => (
                              <Link
                                key={ts.id}
                                to={`/manga/${ts.id}`}
                                onClick={onClose}
                                className="group p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 hover:border-brand-500/50 hover:bg-slate-850 transition-all flex flex-col items-center text-center"
                              >
                                <div className="relative w-full aspect-[2/3] rounded-lg overflow-hidden mb-2 bg-slate-950 border border-slate-800">
                                  {ts.cover_image && !failedImages[`ts-${ts.id}`] ? (
                                    <img 
                                      src={ts.cover_image} 
                                      alt="" 
                                      className="w-full h-full object-cover group-hover:scale-105 transition-transform" 
                                      onError={() => setFailedImages(prev => ({ ...prev, [`ts-${ts.id}`]: true }))}
                                    />
                                  ) : (
                                    <div className="w-full h-full flex flex-col items-center justify-center text-slate-600 bg-gradient-to-b from-slate-900 to-slate-950 p-2">
                                      <BookOpen className="w-6 h-6 opacity-40 mb-1" />
                                      <span className="text-[10px] text-slate-500 line-clamp-1">Kein Cover</span>
                                    </div>
                                  )}
                                  <span className="absolute top-1 left-1 bg-black/90 text-amber-400 font-mono text-[10px] px-1.5 py-0.5 rounded font-bold border border-amber-500/30 z-10 shadow">
                                    #{idx + 1}
                                  </span>
                                </div>
                                <span className="font-semibold text-xs text-white truncate w-full group-hover:text-brand-300">
                                  {ts.title}
                                </span>
                                <span className="text-[11px] font-mono text-emerald-400 mt-0.5">
                                  {ts.owned_volumes} Bände
                                </span>
                              </Link>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 2: PUBLISHERS DIAGRAM & BREAKDOWN */}
                  {statsTab === 'publishers' && (
                    <div className="space-y-6 animate-fade-in">
                      <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
                          <div>
                            <h4 className="text-sm font-bold text-white flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-sky-400" />
                              Verlagsverteilung & Sammlungsanteile
                            </h4>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Prozentualer Anteil jedes Verlags an allen vorhandenen Bänden
                            </p>
                          </div>
                          <span className="text-xs font-mono font-semibold text-slate-300 bg-slate-900 px-3 py-1 rounded-xl border border-slate-800">
                            {publishersList.length} Verlage gesamt
                          </span>
                        </div>

                        {/* Visual Colored Bar Diagram */}
                        <div className="mb-6 space-y-2">
                          <div className="w-full h-5 rounded-xl overflow-hidden flex bg-slate-900 border border-slate-800">
                            {publishersList.slice(0, 8).map((pub, idx) => {
                              const colors = [
                                'bg-sky-500', 'bg-indigo-500', 'bg-emerald-500', 'bg-amber-500',
                                'bg-rose-500', 'bg-purple-500', 'bg-teal-500', 'bg-orange-500'
                              ];
                              const colorClass = colors[idx % colors.length];
                              return (
                                <div
                                  key={pub.publisher}
                                  className={`${colorClass} hover:opacity-90 transition-opacity`}
                                  style={{ width: `${pub.percentage}%` }}
                                  title={`${pub.publisher}: ${pub.percentage}% (${pub.volume_count ?? pub.volumes_count} Bände)`}
                                />
                              );
                            })}
                          </div>
                          <p className="text-[11px] text-slate-500 text-center">
                            Fahre mit der Maus über die Segmente, um Anteile zu sehen
                          </p>
                        </div>

                        {/* Detailed Table / Cards */}
                        <div className="space-y-2.5">
                          {publishersList.map((pub, idx) => {
                            const colors = [
                              'bg-sky-500', 'bg-indigo-500', 'bg-emerald-500', 'bg-amber-500',
                              'bg-rose-500', 'bg-purple-500', 'bg-teal-500', 'bg-orange-500'
                            ];
                            const dotColor = colors[idx % colors.length] || 'bg-slate-500';
                            return (
                              <div
                                key={pub.publisher}
                                className="p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 hover:border-slate-700 transition-colors flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs"
                              >
                                <div className="flex items-center gap-2.5 min-w-[200px]">
                                  <span className={`w-3 h-3 rounded-full ${dotColor} shrink-0`}></span>
                                  <div>
                                    <span className="font-bold text-white text-sm">{pub.publisher}</span>
                                    <span className="text-[11px] text-slate-400 block">{pub.series_count} Reihen</span>
                                  </div>
                                </div>

                                <div className="flex-1 w-full sm:w-auto sm:max-w-xs mx-0 sm:mx-4">
                                  <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                                    <span>Anteil:</span>
                                    <strong className="text-white font-mono">{pub.percentage}%</strong>
                                  </div>
                                  <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                                    <div
                                      className={`h-full ${dotColor} rounded-full`}
                                      style={{ width: `${pub.percentage}%` }}
                                    />
                                  </div>
                                </div>

                                <div className="flex items-center gap-4 text-right shrink-0">
                                  <div>
                                    <span className="font-mono font-bold text-white text-sm">{pub.volume_count ?? pub.volumes_count}</span>
                                    <span className="text-[11px] text-slate-400 block">Bände</span>
                                  </div>
                                  <div className="min-w-[80px]">
                                    <span className="font-mono font-bold text-emerald-400 text-sm">
                                      {pub.total_value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €
                                    </span>
                                    <span className="text-[11px] text-slate-400 block">Gesamtwert</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* TAB 3: USER READING STATS */}
                  {statsTab === 'reading' && (
                    <div className="space-y-6 animate-fade-in">
                      {detailedReaderStats ? (
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <div className="flex items-center gap-3 mb-6">
                            <button 
                              onClick={() => setDetailedReaderStats(null)} 
                              className="p-2 bg-slate-800/80 hover:bg-slate-700 rounded-lg text-slate-300 hover:text-white transition-colors text-xs"
                            >
                              Zurück
                            </button>
                            <div>
                              <h4 className="text-sm font-bold text-white">Gelesene Mangas von {detailedReaderStats.user.username}</h4>
                              <p className="text-xs text-slate-400">
                                {detailedReaderStats.stats.totalVolumes} Bände ({detailedReaderStats.stats.totalPages} Seiten) insgesamt gelesen
                              </p>
                            </div>
                          </div>
                          
                          <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
                            {detailedReaderStats.stats.readMangas.map(m => (
                              <div key={m.id} className="p-4 rounded-xl bg-slate-900 border border-slate-800 flex gap-4 items-start">
                                <div className="w-12 h-16 bg-slate-800 rounded overflow-hidden shrink-0 shadow-md">
                                  {m.cover_image ? (
                                    <img src={m.cover_image} alt={m.title} className="w-full h-full object-cover" />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-slate-600">
                                      <BookOpen className="w-5 h-5"/>
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <Link to={`/manga/${m.id}`} onClick={onClose} className="font-bold text-white text-sm mb-2 hover:text-emerald-400 transition-colors inline-block">
                                    {m.title}
                                  </Link>
                                  <div className="flex flex-wrap gap-1.5">
                                    {m.volumes.map(v => (
                                      <span 
                                        key={v.volume_number} 
                                        className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 text-[10px] font-mono flex items-center gap-1"
                                        title={`Gelesen am: ${new Date(v.read_at).toLocaleString('de-DE')}`}
                                      >
                                        <CheckCircle2 className="w-3 h-3" />
                                        Bd. {v.volume_number}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            ))}
                            {detailedReaderStats.stats.readMangas.length === 0 && (
                              <div className="text-center py-8 bg-slate-900/50 rounded-xl border border-slate-800/50">
                                <BookOpen className="w-8 h-8 mx-auto text-slate-600 mb-2" />
                                <p className="text-xs text-slate-400">Noch keine Bände als gelesen markiert.</p>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="p-5 rounded-2xl bg-slate-950/70 border border-slate-800">
                          <h4 className="text-sm font-bold text-white flex items-center gap-2 mb-2">
                            <BookCheck className="w-4 h-4 text-emerald-400" />
                            Lese-Tracking & SuB (Stapel ungelesener Bücher)
                          </h4>
                          <p className="text-xs text-slate-400 mb-6">
                            Übersicht aller Leser und deren Lesestatus über die gesamte Manga-Sammlung.
                          </p>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {readersList.map(r => {
                              const pct = r.read_pct !== undefined ? r.read_pct : (r.percentage || 0);
                              return (
                                <div key={r.user_id} className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
                                  <div>
                                    <div className="flex items-center justify-between mb-3">
                                      <div className="flex items-center gap-2.5">
                                        <div className="w-9 h-9 rounded-xl bg-brand-500/20 border border-brand-500/40 flex items-center justify-center font-bold text-brand-300">
                                          {(r.display_name || r.username || '?').charAt(0).toUpperCase()}
                                        </div>
                                        <div>
                                          <h5 className="font-bold text-white text-base">{r.display_name || r.username}</h5>
                                          <span className="text-[11px] text-slate-400">@{r.username}</span>
                                        </div>
                                      </div>
                                      <div className="text-right">
                                        <span className="text-xl font-extrabold font-mono text-emerald-400">{pct}%</span>
                                        <span className="text-[10px] text-slate-400 block">gelesen</span>
                                      </div>
                                    </div>

                                    <div className="w-full h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800 mb-4">
                                      <div 
                                        className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>

                                    <div className="grid grid-cols-3 gap-2 text-center p-3 rounded-xl bg-slate-950/60 border border-slate-800/60 text-xs">
                                      <div>
                                        <span className="text-slate-400 text-[10px] block">Gelesen</span>
                                        <strong className="font-mono text-emerald-400 text-sm">{r.read_count}</strong>
                                      </div>
                                      <div>
                                        <span className="text-slate-400 text-[10px] block">SuB (Offen)</span>
                                        <strong className="font-mono text-amber-400 text-sm">{r.unread_count}</strong>
                                      </div>
                                      <div>
                                        <span className="text-slate-400 text-[10px] block">Im Besitz</span>
                                        <strong className="font-mono text-white text-sm">{r.total_owned || ownedVols}</strong>
                                      </div>
                                    </div>
                                  </div>

                                  <div className="mt-4 pt-4 border-t border-slate-800">
                                    <button 
                                      onClick={() => fetchReaderDetailedStats(r.user_id)}
                                      disabled={loadingDetailedStats}
                                      className="w-full py-2.5 rounded-xl bg-slate-800/50 hover:bg-slate-700/80 border border-slate-700 hover:border-slate-600 text-slate-300 text-xs font-semibold transition-colors flex items-center justify-center gap-2"
                                    >
                                      {loadingDetailedStats ? 'Lädt...' : 'Alle gelesenen Bände anzeigen'}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
        </div>

        {/* Modal Footer */}
        <div className="pt-4 mt-4 border-t border-slate-800 flex justify-end shrink-0">
          <button 
            id="btn-close-stats-modal"
            type="button" 
            onClick={onClose} 
            className="btn-secondary text-xs px-4 py-2"
          >
            Schließen
          </button>
        </div>

      </div>
    </div>
  );
}
