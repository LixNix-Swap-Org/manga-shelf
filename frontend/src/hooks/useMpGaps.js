import { useState, useMemo, useEffect, useRef } from 'react';
import { buildMpGapMap, detectGapEntries, isGapEditionUnconfirmed, canFixVolumeCount, gapStatusText } from '../utils/volumeHelpers';
import { apiFetch, readJson, TIMEOUTS } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import { formatCount } from '../utils/format';
import { deleteVolumeRequest } from '../components/detail/volumeEdit/editorUtils';

/** Confirm text for importing the detected gaps; one gap is named as "den fehlenden Band". */
export function gapFillConfirmText(gaps, targetStatus, editionTitle) {
  const what = gaps.length === 1 ? `Den fehlenden Band ${gaps[0]}` : `${gaps.length} fehlende Bände`;
  const source = editionTitle ? ` Preise, Termine und Cover kommen aus der Manga-Passion-Edition „${editionTitle}“.` : '';
  return `${what} auf Status '${targetStatus}' erfassen?${source}`;
}

export const LONG_JOB_TIMEOUT_TEXT = 'Der Server hat nicht rechtzeitig geantwortet; der Auftrag kann trotzdem durchgelaufen sein. Der aktuelle Stand wurde neu geladen.';

/** Manga-Passion gap check: official edition data, detected gaps and the actions that fix them. */
export default function useMpGaps({ id, canEdit, volumes, manga, fetchManga, setShowMpEditionModal }) {
  const [showGaps, setShowGaps] = useState(() => {
    return localStorage.getItem('mangashelf_show_gaps') !== 'false';
  });
  const [fillingGapLoading, setFillingGapLoading] = useState(false);

  // Manga Passion Live Gap Reconciliation States
  const [mpGapData, setMpGapData] = useState(null);
  const [mpGapLoading, setMpGapLoading] = useState(false);
  const [mpGapError, setMpGapError] = useState(null);
  const [batchAutofilling, setBatchAutofilling] = useState(false);

  // Only the latest gap request of the current series may write state: a slow first check must not overwrite the
  // edition picked meanwhile, and series A's result must never show (or be imported) on series B.
  const idRef = useRef(id);
  const requestRef = useRef(0);
  useEffect(() => {
    idRef.current = id;
    requestRef.current += 1;
    setMpGapData(null);
    setMpGapError(null);
    setMpGapLoading(false);
  }, [id]);

  const runAutofill = async () => {
    const res = await apiFetch(`/api/mangas/${id}/autofill-volumes`, { method: 'POST', body: {}, timeout: TIMEOUTS.long });
    const data = (await readJson(res)) ?? {};
    return { ok: res.ok, data: data || {} };
  };

  // Never sends a guessed edition_id: the server only fills from the linked edition and asks for a confirmation otherwise
  const handleBatchAutofillManga = async () => {
    if (!canEdit) return;
    if (!confirm('Möchtest du alle fehlenden Erscheinungsdaten, Jahre, Seitenzahlen und Preise für die Bände dieser Reihe automatisch ausfüllen?')) return;

    setBatchAutofilling(true);
    try {
      let { ok, data } = await runAutofill();
      if (data.needs_confirmation) {
        const suggested = isGapEditionUnconfirmed(mpGapData) ? mpGapData.edition : null;
        if (!suggested?.id) {
          notify.error(data.message || 'Bitte zuerst die Manga-Passion-Edition bestätigen.');
          return;
        }
        if (!confirm(`${data.message || 'Die Manga-Passion-Edition ist nicht bestätigt.'}\n\nEdition „${suggested.title || suggested.id}“ jetzt bestätigen und danach ausfüllen?`)) return;
        if (!(await handleSelectMpEdition(suggested))) return;
        ({ ok, data } = await runAutofill());
      }
      if (ok && data.success) {
        await fetchManga();
        notify.success(`${data.updated_count} von ${formatCount(data.total_user_volumes, 'Band', 'Bänden')} mit offiziellen Daten aktualisiert.`);
      } else {
        notify.error(data.message || data.error || 'Fehler beim automatischen Ausfüllen');
      }
    } catch (err) {
      if (err?.isTimeout) {
        notify.error(LONG_JOB_TIMEOUT_TEXT);
        await fetchManga();
      } else {
        notify.error(err, { fallback: 'Fehler beim automatischen Ausfüllen' });
      }
    } finally {
      setBatchAutofilling(false);
    }
  };

  const fetchMpGaps = async (forcedEditionId = null, forceRefresh = false) => {
    const requestId = ++requestRef.current;
    const requestedFor = id;
    const isCurrent = () => requestRef.current === requestId && idRef.current === requestedFor;
    setMpGapLoading(true);
    setMpGapError(null);
    try {
      const params = [];
      if (forcedEditionId) params.push(`edition_id=${encodeURIComponent(forcedEditionId)}`);
      if (forceRefresh) params.push('force_refresh=true');
      const res = await apiFetch(`/api/mangas/${id}/gaps${params.length ? `?${params.join('&')}` : ''}`, { timeout: TIMEOUTS.long });
      const data = await readJson(res);
      if (!isCurrent()) return null;
      if (res.ok && data) {
        setMpGapData(data);
        return data;
      }
      setMpGapError(data?.error || 'Manga-Passion-Abgleich fehlgeschlagen.');
    } catch {
      if (isCurrent()) setMpGapError('Manga-Passion-Abgleich nicht möglich (Netzwerkfehler).');
    } finally {
      if (isCurrent()) setMpGapLoading(false);
    }
    return null;
  };

  const handleToggleShowGaps = () => {
    setShowGaps(prev => {
      const next = !prev;
      localStorage.setItem('mangashelf_show_gaps', String(next));
      return next;
    });
  };

  // Undo removes the new volumes; offered only when the import changed no existing ones (the server lists the new ids)
  const notifyGapsImported = (result) => {
    const created = Array.isArray(result.imported_ids) ? result.imported_ids : null;
    const count = Number(result.imported_count ?? created?.length ?? 0) + Number(result.updated_count || 0);
    const undoable = created && created.length > 0 && !Number(result.updated_count);
    notify.success(`${formatCount(count, 'Lücke', 'Lücken')} erfasst`, undoable ? {
      action: {
        label: 'Rückgängig',
        onClick: async () => {
          const results = [];
          for (const volumeId of created) results.push(await deleteVolumeRequest(volumeId));
          const failed = results.find((r) => !r.ok && !r.aborted);
          if (failed) notify.error(failed.error);
          await fetchManga();
          await fetchMpGaps();
        }
      }
    } : undefined);
  };

  const handleBatchFillGaps = async (targetStatus = 'Fehlt') => {
    if (!canEdit || detectedGaps.length === 0 || fillingGapLoading) return;
    if (isGapEditionUnconfirmed(mpGapData)) {
      notify.error(`Die Manga-Passion-Edition „${mpGapData.edition?.title || '?'}“ ist nicht bestätigt. Bitte zuerst „Edition bestätigen“ oder eine andere Edition wählen, sonst werden Bände dieser Vermutung erfasst.`);
      return;
    }
    const edition = mpGapData?.matched ? mpGapData.edition : null;
    if (!confirm(gapFillConfirmText(detectedGaps, targetStatus, edition?.title))) return;
    const requestedFor = id;
    setFillingGapLoading(true);
    try {
      const res = await apiFetch(`/api/mangas/${id}/batch-import-gaps`, {
        method: 'POST',
        body: {
          volume_numbers: detectedGaps.map(String),
          target_status: targetStatus,
          edition_id: edition?.id || null
        },
        timeout: TIMEOUTS.long
      });
      if (idRef.current !== requestedFor) return;
      if (res.ok) {
        const result = (await readJson(res)) ?? {};
        await fetchManga();
        await fetchMpGaps();
        notifyGapsImported(result);
      } else {
        await notifyResponseError(res, 'Fehler beim Erfassen der Lücken');
      }
    } catch (err) {
      // the import is not idempotent: show what the server committed instead of inviting a second click
      if (err?.isTimeout && idRef.current === requestedFor) {
        notify.error(LONG_JOB_TIMEOUT_TEXT);
        await fetchManga();
        await fetchMpGaps();
      } else {
        notify.error(err, { fallback: 'Fehler beim Erfassen der Lücken' });
      }
    } finally {
      setFillingGapLoading(false);
    }
  };

  const syncEdition = async (editionId, { closeModal = false, updateStatus = true, errorMessage }) => {
    if (!canEdit || !editionId) return false;
    const requestedFor = id;
    setMpGapLoading(true);
    try {
      const res = await apiFetch(`/api/mangas/${id}/sync-edition`, {
        method: 'POST',
        body: {
          edition_id: editionId,
          update_total_volumes: true,
          update_status: updateStatus,
          update_publisher: false
        },
        timeout: TIMEOUTS.remote
      });
      if (idRef.current !== requestedFor) return false;
      if (res.ok) {
        if (closeModal) setShowMpEditionModal(false);
        await fetchManga();
        await fetchMpGaps(editionId, true);
        return true;
      }
      await notifyResponseError(res, errorMessage);
    } catch (err) {
      notify.error(err);
    } finally {
      if (idRef.current === requestedFor) setMpGapLoading(false);
    }
    return false;
  };

  // only promises the volume count: the series status stays as the user set it
  const handleSyncTotalVolumes = async () => {
    if (!canFixVolumeCount(mpGapData)) {
      if (isGapEditionUnconfirmed(mpGapData)) notify.error('Die Manga-Passion-Edition ist nicht bestätigt. „Edition bestätigen“ verknüpft sie und übernimmt die Bandzahl.');
      return false;
    }
    return syncEdition(mpGapData.edition.id, { updateStatus: false, errorMessage: 'Fehler beim Abgleich' });
  };

  const handleSelectMpEdition = async (selectedEdition) =>
    syncEdition(selectedEdition?.id, { closeModal: true, errorMessage: 'Fehler beim Auswählen der Edition' });

  const mpGapMap = useMemo(() => buildMpGapMap(mpGapData?.gaps), [mpGapData]);
  const detectedGapEntries = useMemo(
    () => detectGapEntries(mpGapData, volumes, manga?.total_volumes),
    [mpGapData, volumes, manga?.total_volumes]
  );
  const detectedGaps = useMemo(() => detectedGapEntries.map(e => e.label), [detectedGapEntries]);
  const mpGapNotice = useMemo(() => gapStatusText(mpGapData, mpGapError), [mpGapData, mpGapError]);

  return {
    showGaps, handleToggleShowGaps, fillingGapLoading,
    mpGapData, mpGapLoading, mpGapError, mpGapNotice, fetchMpGaps, batchAutofilling, handleBatchAutofillManga,
    handleBatchFillGaps, handleSyncTotalVolumes, handleSelectMpEdition,
    gapEditionUnconfirmed: isGapEditionUnconfirmed(mpGapData), canSyncVolumeCount: canFixVolumeCount(mpGapData),
    mpGapMap, detectedGapEntries, detectedGaps
  };
}
