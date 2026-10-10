import { useState, useMemo, useEffect, useRef } from 'react';
import { buildMpGapMap, detectGapEntries, countAnnouncedEntries, announcedGapNumbers, isGapEditionUnconfirmed, canFixVolumeCount, gapStatusText } from '../utils/volumeHelpers';
import { apiFetch, readJson, TIMEOUTS } from '../utils/api';
import { notify, notifyResponseError } from '../utils/notify';
import { formatCount } from '../utils/format';
import { deleteVolumeRequest } from '../components/detail/volumeEdit/editorUtils';
import { t, tn } from '../i18n/index.js';
import { payloadText, serverText } from '../i18n/serverText.js';
import { statusLabel } from '../utils/enumLabels';
import { isMpEdition } from '../utils/editions';
import { readCache, cacheOwner, LIST_KEY } from '../utils/dataCache';

/** Confirm text for importing the detected gaps (regular volumes, or with `extras` the special editions/schuber). */
export function gapFillConfirmText(gaps, targetStatus, editionTitle, { extras = false } = {}) {
  const status = statusLabel(targetStatus);
  const shopping = targetStatus === 'Fehlt';
  let question;
  if (extras) {
    question = shopping
      ? tn('{n} Sonderausgabe/Schuber auf die Einkaufsliste setzen?', '{n} Sonderausgaben/Schuber auf die Einkaufsliste setzen?', gaps.length)
      : tn("{n} Sonderausgabe/Schuber auf Status '{status}' erfassen?", "{n} Sonderausgaben/Schuber auf Status '{status}' erfassen?", gaps.length, { status });
  } else if (gaps.length === 1) {
    question = shopping
      ? t('Den fehlenden Band {volume} auf die Einkaufsliste setzen?', { volume: gaps[0] })
      : t("Den fehlenden Band {volume} auf Status '{status}' erfassen?", { volume: gaps[0], status });
  } else {
    question = shopping
      ? tn('{n} fehlender Band auf die Einkaufsliste setzen?', '{n} fehlende Bände auf die Einkaufsliste setzen?', gaps.length)
      : t("{count} fehlende Bände auf Status '{status}' erfassen?", { count: gaps.length, status });
  }
  if (!editionTitle) return question;
  return `${question} ${t('Preise, Termine und Cover kommen aus der Manga-Passion-Edition „{edition}“.', { edition: editionTitle })}`;
}

// i18n
export const LONG_JOB_TIMEOUT_TEXT = 'Der Server hat nicht rechtzeitig geantwortet; der Auftrag kann trotzdem durchgelaufen sein. Der aktuelle Stand wurde neu geladen.';

/** Manga-Passion gap check: official edition data, detected gaps and the actions that fix them. */
export default function useMpGaps({ id, canEdit, volumes, manga, fetchManga, setShowMpEditionModal, user = null }) {
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
  // a check asked for before the series language was known runs once the detail arrives
  const deferredRef = useRef(false);
  useEffect(() => {
    idRef.current = id;
    requestRef.current += 1;
    deferredRef.current = false;
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
    if (!confirm(t('Möchtest du alle fehlenden Erscheinungsdaten, Jahre, Seitenzahlen und Preise für die Bände dieser Reihe automatisch ausfüllen?'))) return;

    setBatchAutofilling(true);
    try {
      let { ok, data } = await runAutofill();
      if (data.needs_confirmation) {
        const suggested = isGapEditionUnconfirmed(mpGapData) ? mpGapData.edition : null;
        if (!suggested?.id) {
          notify.error(payloadText(data, 'message') || t('Bitte zuerst die Manga-Passion-Edition bestätigen.'));
          return;
        }
        if (!confirm(t('{reason}\n\nEdition „{edition}“ jetzt bestätigen und danach ausfüllen?', { reason: payloadText(data, 'message') || t('Die Manga-Passion-Edition ist nicht bestätigt.'), edition: suggested.title || suggested.id }))) return;
        if (!(await handleSelectMpEdition(suggested))) return;
        ({ ok, data } = await runAutofill());
      }
      if (ok && data.success) {
        await fetchManga();
        notify.success(t('{updated} von {volumes} mit offiziellen Daten aktualisiert.', { updated: data.updated_count, volumes: formatCount(data.total_user_volumes, 'Band', 'Bänden') }));
      } else {
        notify.error(payloadText(data, 'message') || serverText(data) || t('Fehler beim automatischen Ausfüllen'));
      }
    } catch (err) {
      if (err?.isTimeout) {
        notify.error(t(LONG_JOB_TIMEOUT_TEXT));
        await fetchManga();
      } else {
        notify.error(err, { fallback: t('Fehler beim automatischen Ausfüllen') });
      }
    } finally {
      setBatchAutofilling(false);
    }
  };

  // the row that knows this series' language: the loaded detail, else the shelf's cached list row (null = unknown yet)
  const languageRow = () => {
    if (manga && (manga.id == null || String(manga.id) === String(id))) return manga;
    return readCache(cacheOwner(user), LIST_KEY)?.data?.find?.((m) => String(m?.id) === String(id)) || null;
  };

  const fetchMpGaps = async (forcedEditionId = null, forceRefresh = false) => {
    // Manga Passion only knows German editions: never ask /gaps (409 MP_LANGUAGE) before the language is known
    const row = languageRow();
    if (!row) {
      deferredRef.current = true;
      return null;
    }
    if (!isMpEdition(row)) return null;
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
      setMpGapError(serverText(data) || t('Manga-Passion-Abgleich fehlgeschlagen.'));
    } catch {
      if (isCurrent()) setMpGapError(t('Manga-Passion-Abgleich nicht möglich (Netzwerkfehler).'));
    } finally {
      if (isCurrent()) setMpGapLoading(false);
    }
    return null;
  };

  useEffect(() => {
    if (!deferredRef.current || !manga || String(manga.id) !== String(id)) return;
    deferredRef.current = false;
    fetchMpGaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only once the deferred series' detail is there
  }, [manga, id]);

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
    notify.success(t('{gaps} erfasst', { gaps: formatCount(count, 'Lücke', 'Lücken') }), undoable ? {
      action: {
        label: t('Rückgängig'),
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

  const handleBatchFillGaps = async (targetStatus = 'Fehlt', { extrasOnly = false } = {}) => {
    const labels = detectedGapEntries.filter(e => (e.type !== 'volume') === extrasOnly).map(e => e.label);
    if (!canEdit || labels.length === 0 || fillingGapLoading) return;
    if (isGapEditionUnconfirmed(mpGapData)) {
      notify.error(t('Die Manga-Passion-Edition „{edition}“ ist nicht bestätigt. Bitte zuerst „Edition bestätigen“ oder eine andere Edition wählen, sonst werden Bände dieser Vermutung erfasst.', { edition: mpGapData.edition?.title || '?' }));
      return;
    }
    const edition = mpGapData?.matched ? mpGapData.edition : null;
    if (!confirm(gapFillConfirmText(labels, targetStatus, edition?.title, { extras: extrasOnly }))) return;
    const requestedFor = id;
    setFillingGapLoading(true);
    try {
      const res = await apiFetch(`/api/mangas/${id}/batch-import-gaps`, {
        method: 'POST',
        body: {
          volume_numbers: labels.map(String),
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
        await notifyResponseError(res, t('Fehler beim Erfassen der Lücken'));
      }
    } catch (err) {
      // the import is not idempotent: show what the server committed instead of inviting a second click
      if (err?.isTimeout && idRef.current === requestedFor) {
        notify.error(t(LONG_JOB_TIMEOUT_TEXT));
        await fetchManga();
        await fetchMpGaps();
      } else {
        notify.error(err, { fallback: t('Fehler beim Erfassen der Lücken') });
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
      if (isGapEditionUnconfirmed(mpGapData)) notify.error(t('Die Manga-Passion-Edition ist nicht bestätigt. „Edition bestätigen“ verknüpft sie und übernimmt die Bandzahl.'));
      return false;
    }
    return syncEdition(mpGapData.edition.id, { updateStatus: false, errorMessage: t('Fehler beim Abgleich') });
  };

  const handleSelectMpEdition = async (selectedEdition) =>
    syncEdition(selectedEdition?.id, { closeModal: true, errorMessage: t('Fehler beim Auswählen der Edition') });

  // other edition languages: no Manga Passion data, notice or pill; the gaps come from the volume numbers alone
  const mpEnabled = !manga || isMpEdition(manga);
  const gapData = mpEnabled ? mpGapData : null;
  const gapError = mpEnabled ? mpGapError : null;
  const mpGapMap = useMemo(() => buildMpGapMap(gapData?.gaps), [gapData]);
  const detectedGapEntries = useMemo(
    () => detectGapEntries(gapData, volumes, manga?.total_volumes),
    [gapData, volumes, manga?.total_volumes]
  );
  const detectedGaps = useMemo(() => detectedGapEntries.map(e => e.label), [detectedGapEntries]);
  const announcedGapCount = useMemo(
    () => (gapData?.matched ? countAnnouncedEntries(gapData.gaps, volumes) : 0),
    [gapData, volumes]
  );
  const announcedGaps = useMemo(
    () => (gapData?.matched ? announcedGapNumbers(gapData.gaps, volumes) : []),
    [gapData, volumes]
  );
  const mpGapNotice = useMemo(() => gapStatusText(gapData, gapError), [gapData, gapError]);

  return {
    showGaps, handleToggleShowGaps, fillingGapLoading,
    mpGapData: gapData, mpGapLoading: mpEnabled && mpGapLoading, mpGapError: gapError, mpGapNotice, fetchMpGaps, batchAutofilling, handleBatchAutofillManga,
    handleBatchFillGaps, handleSyncTotalVolumes, handleSelectMpEdition, mpEnabled,
    gapEditionUnconfirmed: isGapEditionUnconfirmed(gapData), canSyncVolumeCount: canFixVolumeCount(gapData),
    mpGapMap, detectedGapEntries, detectedGaps, announcedGapCount, announcedGaps
  };
}
