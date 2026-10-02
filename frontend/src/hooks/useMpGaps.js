import { useState, useMemo } from 'react';
import { isGapCovered } from '../utils/volumeHelpers';

/** Manga-Passion gap check: official edition data, detected gaps and the actions that fix them. */
export default function useMpGaps({ id, canEdit, volumes, manga, fetchManga, setShowMpEditionModal }) {
  const [showGaps, setShowGaps] = useState(() => {
    return localStorage.getItem('mangashelf_show_gaps') !== 'false';
  });
  const [fillingGapLoading, setFillingGapLoading] = useState(false);

  // Manga Passion Live Gap Reconciliation States
  const [mpGapData, setMpGapData] = useState(null);
  const [mpGapLoading, setMpGapLoading] = useState(false);
  const [batchAutofilling, setBatchAutofilling] = useState(false);

  const handleBatchAutofillManga = async (overwrite = false) => {
    if (!canEdit) return;
    const confirmMsg = overwrite 
      ? 'Möchtest du wirklich alle Bände dieser Reihe mit den offiziellen Daten (Erscheinungsdatum, Jahr, Seitenzahl, Preise) überschreiben?' 
      : 'Möchtest du alle fehlenden Erscheinungsdaten, Jahre, Seitenzahlen und Preise für die Bände dieser Reihe automatisch ausfüllen?';
    if (!confirm(confirmMsg)) return;

    setBatchAutofilling(true);
    try {
      const res = await fetch(`/api/mangas/${id}/autofill-volumes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overwrite })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await fetchManga();
        alert(`Erfolg: ${data.updated_count} von ${data.total_user_volumes} Bänden wurden mit offiziellen Daten aktualisiert!`);
      } else {
        alert(data.message || data.error || 'Fehler beim automatischen Ausfüllen');
      }
    } catch (err) {
      alert('Netzwerkfehler beim automatischen Ausfüllen der Bände');
    } finally {
      setBatchAutofilling(false);
    }
  };

  const fetchMpGaps = async (forcedEditionId = null, forceRefresh = false) => {
    try {
      setMpGapLoading(true);
      let url = `/api/mangas/${id}/gaps`;
      const params = [];
      if (forcedEditionId) params.push(`edition_id=${forcedEditionId}`);
      if (forceRefresh) params.push(`force_refresh=true`);
      if (params.length > 0) url += `?${params.join('&')}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setMpGapData(data);
      }
    } catch (e) {
      console.warn('Manga Passion gaps fetch failed:', e);
    } finally {
      setMpGapLoading(false);
    }
  };

  const handleToggleShowGaps = () => {
    setShowGaps(prev => {
      const next = !prev;
      localStorage.setItem('mangashelf_show_gaps', String(next));
      return next;
    });
  };

  const handleBatchFillGaps = async (targetStatus = 'Fehlt') => {
    if (!canEdit || detectedGaps.length === 0) return;
    if (!confirm(`${detectedGaps.length} fehlende Bände auf Status '${targetStatus}' erfassen?`)) return;
    setFillingGapLoading(true);
    try {
      const res = await fetch(`/api/mangas/${id}/batch-import-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          volume_numbers: detectedGaps.map(String),
          target_status: targetStatus,
          edition_id: mpGapData?.edition?.id || null
        })
      });
      if (res.ok) {
        await fetchManga();
        await fetchMpGaps();
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Erfassen der Lücken');
      }
    } catch (err) {
      alert('Fehler beim Erfassen der Lücken');
    } finally {
      setFillingGapLoading(false);
    }
  };

  const handleSyncTotalVolumes = async (officialTotal) => {
    if (!canEdit || !mpGapData?.edition?.id) return;
    setMpGapLoading(true);
    try {
      const res = await fetch(`/api/mangas/${id}/sync-edition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edition_id: mpGapData.edition.id,
          update_total_volumes: true,
          update_status: true,
          update_publisher: false
        })
      });
      if (res.ok) {
        await fetchManga();
        await fetchMpGaps(mpGapData.edition.id, true);
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Abgleich');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setMpGapLoading(false);
    }
  };

  const handleSelectMpEdition = async (selectedEdition) => {
    if (!canEdit || !selectedEdition) return;
    setMpGapLoading(true);
    try {
      const res = await fetch(`/api/mangas/${id}/sync-edition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          edition_id: selectedEdition.id,
          update_total_volumes: true,
          update_status: true,
          update_publisher: false
        })
      });
      if (res.ok) {
        setShowMpEditionModal(false);
        await fetchManga();
        await fetchMpGaps(selectedEdition.id, true);
      } else {
        const data = await res.json();
        alert(data.error || 'Fehler beim Auswählen der Edition');
      }
    } catch (err) {
      alert('Netzwerkfehler');
    } finally {
      setMpGapLoading(false);
    }
  };

  // Map of Manga Passion gaps by volume_number for quick lookup of price, cover, date
  const mpGapMap = useMemo(() => {
    const map = new Map();
    if (mpGapData && mpGapData.gaps) {
      mpGapData.gaps.forEach(g => {
        map.set(String(g.volume_number).trim().toLowerCase(), g);
      });
    }
    return map;
  }, [mpGapData]);

  // Gap Detection for numeric volumes:
  // Prioritizes verified Manga Passion official edition data if available;
  // falls back to local detection.
  // Filters out volumes already present in user's collection to avoid duplicates!
  // Gaps as { label, type }: label is what the banner shows ("26 (Titel)", "5 (Collectors Edition)", 114),
  // type decides how it is drawn (only regular volumes get ghost entries) and imported.
  const detectedGapEntries = useMemo(() => {
    // If Manga Passion matched the German edition, use the verified official missing entries:
    if (mpGapData && mpGapData.matched && Array.isArray(mpGapData.gaps)) {
      return mpGapData.gaps
        .filter(g => !isGapCovered(g, volumes))
        .map(g => {
          const match = String(g.volume_number).trim().match(/^(\d+)$/);
          const label = match
            ? (g.title ? `${match[1]} (${g.title.trim()})` : parseInt(match[1], 10))
            : (g.title || g.volume_number);
          return { label, type: g.type || 'volume' };
        });
    }

    // Local fallback:
    const existingNums = new Set();
    let maxFound = 0;
    
    volumes.forEach(v => {
      const isRegular = (!v.type || v.type === 'volume') && 
        !String(v.volume_number).toLowerCase().includes('schuber') && 
        !String(v.volume_number).toLowerCase().includes('special');
      if (isRegular) {
        const match = String(v.volume_number).trim().match(/^(\d+)$/);
        if (match) {
          const parsed = parseInt(match[1], 10);
          if (parsed > 0 && parsed <= 300) {
            existingNums.add(parsed);
            if (parsed > maxFound) maxFound = parsed;
          }
        }
      }
    });

    const targetMax = Math.min(200, Math.max(maxFound, parseInt(manga?.total_volumes, 10) || 0));
    if (targetMax <= 1 || existingNums.size === 0) return [];

    const gaps = [];
    for (let i = 1; i <= targetMax; i++) {
      if (!existingNums.has(i)) {
        gaps.push({ label: i, type: 'volume' });
      }
    }
    return gaps;
  }, [mpGapData, volumes, manga?.total_volumes]);
  const detectedGaps = useMemo(() => detectedGapEntries.map(e => e.label), [detectedGapEntries]);

  return {
    showGaps, handleToggleShowGaps, fillingGapLoading,
    mpGapData, mpGapLoading, fetchMpGaps, batchAutofilling, handleBatchAutofillManga,
    handleBatchFillGaps, handleSyncTotalVolumes, handleSelectMpEdition,
    mpGapMap, detectedGapEntries, detectedGaps
  };
}
