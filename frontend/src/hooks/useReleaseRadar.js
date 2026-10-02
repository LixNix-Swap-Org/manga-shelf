import { useState, useEffect } from 'react';

/** Release radar: personal pre-orders / upcoming volumes and the Manga-Passion monthly calendar. */
export default function useReleaseRadar({ canEdit, activeMainView, fetchMangas, fetchShoppingList }) {
  // Release-Radar State
  const [radarData, setRadarData] = useState(null);
  const [loadingRadar, setLoadingRadar] = useState(false);
  const [radarPublisherFilter, setRadarPublisherFilter] = useState('ALL');
  const [radarStatusFilter, setRadarStatusFilter] = useState('ALL');
  const [radarSearch, setRadarSearch] = useState('');
  const [markingDeliveredId, setMarkingDeliveredId] = useState(null);

  // Manga Passion Kalender State
  const initialDate = new Date();
  const [radarSubView, setRadarSubView] = useState('passion'); // 'passion' | 'personal'
  const [mpYear, setMpYear] = useState(initialDate.getFullYear());
  const [mpMonth, setMpMonth] = useState(initialDate.getMonth() + 1);
  const [mpData, setMpData] = useState(null);
  const [loadingMp, setLoadingMp] = useState(false);
  const [mpSearch, setMpSearch] = useState('');
  const [mpPublisherFilter, setMpPublisherFilter] = useState('ALL');
  const [mpPrintOnly, setMpPrintOnly] = useState(true);
  const [mpMySeriesOnly, setMpMySeriesOnly] = useState(false);
  const [importingMpId, setImportingMpId] = useState(null);

  const fetchReleaseRadar = async () => {
    try {
      setLoadingRadar(true);
      const res = await fetch('/api/release-radar');
      if (res.ok) {
        const data = await res.json();
        setRadarData(data);
      }
    } catch (err) {
      console.error('Error fetching release radar:', err);
    } finally {
      setLoadingRadar(false);
    }
  };

  const handleMarkDelivered = async (item) => {
    if (!canEdit) return;
    setMarkingDeliveredId(item.id);
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const res = await fetch(`/api/volumes/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'Vorhanden',
          purchase_date: item.purchase_date || todayStr
        })
      });
      if (res.ok) {
        await Promise.all([fetchReleaseRadar(), fetchMangas()]);
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Markieren als erhalten');
      }
    } catch (e) {
      console.error(e);
      alert('Netzwerkfehler');
    } finally {
      setMarkingDeliveredId(null);
    }
  };

  const fetchMangaPassionReleases = async (year, month, forceRefresh = false) => {
    try {
      setLoadingMp(true);
      const targetYear = year !== undefined ? year : mpYear;
      const targetMonth = month !== undefined ? month : mpMonth;
      const url = `/api/manga-passion/releases?year=${targetYear}&month=${targetMonth}${forceRefresh ? '&force_refresh=true' : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setMpData(data);
      }
    } catch (err) {
      console.error('Error fetching Manga Passion releases:', err);
    } finally {
      setLoadingMp(false);
    }
  };

  const handlePrevMonth = () => {
    let nextMonth = mpMonth - 1;
    let nextYear = mpYear;
    if (nextMonth < 1) {
      nextMonth = 12;
      nextYear -= 1;
    }
    setMpMonth(nextMonth);
    setMpYear(nextYear);
    fetchMangaPassionReleases(nextYear, nextMonth);
  };

  const handleNextMonth = () => {
    let nextMonth = mpMonth + 1;
    let nextYear = mpYear;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }
    setMpMonth(nextMonth);
    setMpYear(nextYear);
    fetchMangaPassionReleases(nextYear, nextMonth);
  };

  const handleCurrentMonth = () => {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    setMpYear(curYear);
    setMpMonth(curMonth);
    fetchMangaPassionReleases(curYear, curMonth);
  };

  const handleImportMangaPassion = async (item, targetStatus = 'Vorbestellt') => {
    if (!canEdit) return;
    setImportingMpId(item.id);
    try {
      const res = await fetch('/api/manga-passion/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          manga_id: item.user_manga_id || null,
          title: item.title,
          volume_number: item.volume_number,
          publisher: item.publisher,
          release_date: item.date,
          price: item.price,
          cover_image: item.cover_image,
          target_status: targetStatus
        })
      });
      if (res.ok) {
        const resData = await res.json();
        setMpData(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map(it => {
              if (it.id === item.id) {
                return {
                  ...it,
                  in_collection: true,
                  user_manga_id: resData.manga_id,
                  user_volume_id: resData.volume_id,
                  user_volume_status: targetStatus
                };
              }
              return it;
            })
          };
        });
        fetchReleaseRadar();
        fetchMangas();
        fetchShoppingList();
      } else {
        const err = await res.json();
        alert(err.error || 'Fehler beim Übernehmen des Bands');
      }
    } catch (e) {
      console.error(e);
      alert('Netzwerkfehler');
    } finally {
      setImportingMpId(null);
    }
  };

  // Fetch heavy Manga Passion monthly calendar releases only when radar view is active
  useEffect(() => {
    if (activeMainView === 'radar' && !mpData && !loadingMp) {
      fetchMangaPassionReleases(mpYear, mpMonth);
    }
  }, [activeMainView, mpData, loadingMp, mpYear, mpMonth]);

  return {
    radarData, loadingRadar, radarPublisherFilter, setRadarPublisherFilter, radarStatusFilter, setRadarStatusFilter,
    radarSearch, setRadarSearch, markingDeliveredId, radarSubView, setRadarSubView,
    mpYear, setMpYear, mpMonth, setMpMonth, mpData, loadingMp, mpSearch, setMpSearch,
    mpPublisherFilter, setMpPublisherFilter, mpPrintOnly, setMpPrintOnly, mpMySeriesOnly, setMpMySeriesOnly, importingMpId,
    fetchReleaseRadar, handleMarkDelivered, fetchMangaPassionReleases,
    handlePrevMonth, handleNextMonth, handleCurrentMonth, handleImportMangaPassion
  };
}
