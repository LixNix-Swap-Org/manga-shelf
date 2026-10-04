import { useState, useEffect, useRef } from 'react';
import {
  shouldAutoFetchMp, mpMonthKey, reconcilePublisherFilter, shiftMonth, localISODate,
  applyImportToMpItems, withId, withoutId
} from '../utils/radarHelpers';
import { apiFetch, readJson, TIMEOUTS } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import useLatestRequest from './useLatestRequest';

const RADAR_LOAD_ERROR = 'Release-Radar konnte nicht geladen werden';
const MP_LOAD_ERROR = 'Neuerscheinungen konnten nicht geladen werden';

// a proxy 502/503 may answer with HTML
const errorText = async (res, fallback) => {
  const body = (await readJson(res)) ?? {};
  return (body && body.error) || fallback;
};

/** Release radar: personal pre-orders / upcoming volumes and the Manga-Passion monthly calendar. */
export default function useReleaseRadar({ canEdit, activeMainView, fetchMangas, fetchShoppingList, offline = false }) {
  const [radarData, setRadarData] = useState(null);
  const [loadingRadar, setLoadingRadar] = useState(false);
  const [radarError, setRadarError] = useState(null);
  const beginRadarRequest = useLatestRequest();
  const [radarPublisherFilter, setRadarPublisherFilter] = useState('ALL');
  const [radarStatusFilter, setRadarStatusFilter] = useState('ALL');
  const [radarSearch, setRadarSearch] = useState('');
  const [markingDeliveredIds, setMarkingDeliveredIds] = useState(() => new Set());

  const initialDate = new Date();
  const [radarSubView, setRadarSubView] = useState('passion'); // 'passion' | 'personal'
  const [mpYear, setMpYear] = useState(initialDate.getFullYear());
  const [mpMonth, setMpMonth] = useState(initialDate.getMonth() + 1);
  const [mpData, setMpData] = useState(null);
  const [mpError, setMpError] = useState(null);
  const beginMpRequest = useLatestRequest();
  const mpFailedKeyRef = useRef(null); // 'year-month' whose last load failed
  const mpLastMonthRef = useRef({ year: mpYear, month: mpMonth }); // month of the newest requested load
  const [loadingMp, setLoadingMp] = useState(false);
  const mpLoadingRef = useRef(false);
  const [mpSearch, setMpSearch] = useState('');
  const [mpPublisherFilter, setMpPublisherFilter] = useState('ALL');
  const [mpPrintOnly, setMpPrintOnly] = useState(true);
  const [mpMySeriesOnly, setMpMySeriesOnly] = useState(false);
  const [importingMpIds, setImportingMpIds] = useState(() => new Set());

  // disabled buttons only take effect after a render; this stops a fast second click synchronously
  const busyRef = useRef(new Set());

  const fetchReleaseRadar = async () => {
    if (offline) return;
    const { signal, isCurrent } = beginRadarRequest();
    setLoadingRadar(true);
    try {
      const res = await apiFetch('/api/release-radar', { signal });
      if (!isCurrent()) return;
      if (!res.ok) {
        const message = await errorText(res, RADAR_LOAD_ERROR);
        if (isCurrent()) setRadarError(message);
        return;
      }
      const data = await readJson(res);
      if (!isCurrent()) return;
      if (data === null) throw new Error('Antwort ist kein JSON');
      setRadarError(null);
      setRadarData(data);
      setRadarPublisherFilter(f => reconcilePublisherFilter(f, data.publishers, 'publisher'));
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error fetching release radar:', err);
      setRadarError(`${RADAR_LOAD_ERROR} (keine Verbindung zum Server)`);
    } finally {
      if (isCurrent()) setLoadingRadar(false);
    }
  };

  /** Marks a radar volume as received; resolves true on success. */
  const handleMarkDelivered = async (item) => {
    if (!canEdit) return false;
    const busyKey = `deliver:${item.id}`;
    if (busyRef.current.has(busyKey)) return false;
    busyRef.current.add(busyKey);
    setMarkingDeliveredIds(s => withId(s, item.id));
    try {
      // without purchase_date the server keeps the stored one
      const body = { status: 'Vorhanden' };
      if (!item.purchase_date) body.purchase_date = localISODate();
      const res = await apiFetch(`/api/volumes/${item.id}`, { method: 'PUT', body });
      if (res.ok) {
        // a future 'Fehlt' volume is on the shopping list as well
        await Promise.all([fetchReleaseRadar(), fetchMangas(), fetchShoppingList()]);
        return true;
      }
      await notifyResponseError(res, 'Fehler beim Markieren als erhalten');
    } catch (e) {
      console.error(e);
      notify.error(e);
    } finally {
      busyRef.current.delete(busyKey);
      setMarkingDeliveredIds(s => withoutId(s, item.id));
    }
    return false;
  };

  const setMpLoading = (value) => {
    mpLoadingRef.current = value;
    setLoadingMp(value);
  };

  /**
   * Loads a calendar month. `silent` reloads the month last asked for without the loading state and keeps the shown
   * data on failure; while another load runs it replaces that load (same month) as a normal one.
   */
  const fetchMangaPassionReleases = async (year, month, forceRefresh = false, { silent: wantSilent = false } = {}) => {
    if (offline) return;
    const silent = wantSilent && !mpLoadingRef.current;
    const target = wantSilent
      ? mpLastMonthRef.current
      : { year: year !== undefined ? year : mpYear, month: month !== undefined ? month : mpMonth };
    mpLastMonthRef.current = target;
    const { signal, isCurrent } = beginMpRequest(); // only the newest request may update the view (month/year can change quickly)
    if (!silent) {
      setMpLoading(true);
      setMpError(null);
    }
    // the auto-fetch effect must not retry a failed month by itself
    const fail = (message) => {
      if (silent) return;
      mpFailedKeyRef.current = mpMonthKey(target.year, target.month);
      setMpData(null);
      setMpError(message);
    };
    try {
      const url = `/api/manga-passion/releases?year=${target.year}&month=${target.month}${forceRefresh ? '&force_refresh=true' : ''}`;
      const res = await apiFetch(url, { signal, timeout: TIMEOUTS.remote });
      if (!isCurrent()) return;
      if (!res.ok) {
        const message = await errorText(res, MP_LOAD_ERROR);
        if (isCurrent()) fail(message);
        return;
      }
      const data = await readJson(res);
      if (!isCurrent()) return;
      if (data === null) throw new Error('Antwort ist kein JSON');
      mpFailedKeyRef.current = null;
      setMpError(null);
      setMpData(data);
      setMpPublisherFilter(f => reconcilePublisherFilter(f, data.publishers, 'name'));
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Error fetching Manga Passion releases:', err);
      fail(`${MP_LOAD_ERROR} (keine Verbindung zum Server)`);
    } finally {
      if (isCurrent()) setMpLoading(false);
    }
  };

  const goToMonth = (target) => {
    if (!target) return;
    setMpYear(target.year);
    setMpMonth(target.month);
    fetchMangaPassionReleases(target.year, target.month);
  };

  const handlePrevMonth = () => goToMonth(shiftMonth(mpYear, mpMonth, -1));
  const handleNextMonth = () => goToMonth(shiftMonth(mpYear, mpMonth, 1));
  const handleCurrentMonth = () => {
    const now = new Date();
    goToMonth({ year: now.getFullYear(), month: now.getMonth() + 1 });
  };

  /** Takes a calendar entry into the collection; resolves the server's answer, or null when nothing was imported. */
  const handleImportMangaPassion = async (item, targetStatus = 'Vorbestellt') => {
    if (!canEdit) return null;
    const busyKey = `import:${item.id}`;
    if (busyRef.current.has(busyKey)) return null;
    busyRef.current.add(busyKey);
    setImportingMpIds(s => withId(s, item.id));
    try {
      const res = await apiFetch('/api/manga-passion/import', {
        method: 'POST',
        body: {
          // a prefix match is another work: without manga_id the server reuses a series of the same title or creates one
          manga_id: item.match_kind === 'prefix' ? null : (item.user_manga_id || null),
          title: item.title,
          volume_number: item.volume_number,
          type: item.type || undefined,
          volume_title: item.volume_title || undefined,
          publisher: item.publisher,
          release_date: item.date,
          price: item.price,
          cover_image: item.cover_image,
          mp_volume_id: item.id,
          edition_id: item.is_digital ? null : (item.edition_id || null),
          target_status: targetStatus
        },
        timeout: TIMEOUTS.remote
      });
      if (!res.ok) {
        await notifyResponseError(res, 'Fehler beim Übernehmen des Bands');
        return null;
      }
      const result = await readJson(res);
      if (result === null) throw new Error('Antwort ist kein JSON');
      setMpData(prev => (prev ? { ...prev, items: applyImportToMpItems(prev.items || [], item, result, targetStatus) } : prev));
      // the server re-matches the whole month (siblings of a new series, eBook entries)
      fetchMangaPassionReleases(undefined, undefined, false, { silent: true });
      fetchReleaseRadar();
      fetchMangas();
      fetchShoppingList();
      return result;
    } catch (e) {
      console.error(e);
      notify.error(e);
      return null;
    } finally {
      busyRef.current.delete(busyKey);
      setImportingMpIds(s => withoutId(s, item.id));
    }
  };

  // the heavy Manga Passion calendar is only loaded while the radar view is open
  useEffect(() => {
    if (shouldAutoFetchMp({
      active: activeMainView === 'radar', offline, hasData: Boolean(mpData), loading: loadingMp,
      failedKey: mpFailedKeyRef.current, year: mpYear, month: mpMonth
    })) {
      fetchMangaPassionReleases(mpYear, mpMonth);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchMangaPassionReleases ist pro Render neu; Auslöser sind Ansicht, Monat und Ladezustand
  }, [activeMainView, offline, mpData, loadingMp, mpYear, mpMonth]);

  return {
    radarData, loadingRadar, radarError, radarPublisherFilter, setRadarPublisherFilter, radarStatusFilter, setRadarStatusFilter,
    radarSearch, setRadarSearch, markingDeliveredIds, radarSubView, setRadarSubView,
    mpYear, setMpYear, mpMonth, setMpMonth, mpData, loadingMp, mpError, mpSearch, setMpSearch,
    mpPublisherFilter, setMpPublisherFilter, mpPrintOnly, setMpPrintOnly, mpMySeriesOnly, setMpMySeriesOnly, importingMpIds,
    fetchReleaseRadar, handleMarkDelivered, fetchMangaPassionReleases,
    handlePrevMonth, handleNextMonth, handleCurrentMonth, handleImportMangaPassion
  };
}
