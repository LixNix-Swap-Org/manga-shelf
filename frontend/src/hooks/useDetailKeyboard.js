import { useEffect, useRef } from 'react';
import { t } from '../i18n/index.js';

// Space on these is the control's own key; a focused spine (role=button) is the shortcut's target instead
const CONTROL_SELECTOR = 'button, a, input, select, textarea, [role="button"]:not(.manga-spine)';
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

const asElement = (target) => (target && typeof target.closest === 'function' ? target : null);

function isTextEntry(target) {
  const el = asElement(target);
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
}

/** What a dialog's fields and toggles hold right now (file pickers aside). */
export function dialogFormState(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const fields = Array.from(root.querySelectorAll('input, select, textarea'))
    .filter((el) => String(el.type || '').toLowerCase() !== 'file')
    .map((el) => (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value));
  const toggles = Array.from(root.querySelectorAll('[aria-pressed]')).map((el) => el.getAttribute('aria-pressed'));
  return JSON.stringify([fields, toggles]);
}

/** Unknown counts as changed: without a recorded start the editor stays open. */
function dialogChanged(starts, target) {
  const dialog = asElement(target)?.closest('[role="dialog"]');
  if (!dialog || !starts.has(dialog)) return true;
  return starts.get(dialog) !== dialogFormState(dialog);
}

/**
 * Which shelf shortcut a keydown means: 'next' | 'prev' | 'toggleRead' | 'edit' | null.
 * Only in the shelf view (the only view that shows the focused volume), never with modifiers, auto-repeat or IME input.
 */
export function resolveVolumeShortcut(e, { shelfActive, modalOpen }) {
  if (!shelfActive || modalOpen) return null;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return null;
  const el = asElement(e.target);
  if (el && (el.isContentEditable || el.closest('input, textarea, select'))) return null;
  switch (e.key) {
    case 'j': case 'J': return 'next';
    case 'k': case 'K': return 'prev';
    case 'e': case 'E': return 'edit';
    case ' ': return el && el.closest(CONTROL_SELECTOR) ? null : 'toggleRead';
    default: return null;
  }
}

/**
 * Escape closes the topmost dialog (one that handles Escape itself calls preventDefault). J / K / Space / E drive
 * the shelf view; Space follows `canToggle` (default canEdit), E follows `canEdit`.
 */
export default function useDetailKeyboard({
  lightboxData, setLightboxData, activeVolume, setActiveVolume, showBatchModal, setShowBatchModal,
  showBatchReadModal, setShowBatchReadModal, fillingGapNumber, setFillingGapNumber,
  showMpEditionModal, setShowMpEditionModal, editing, setEditing, cancelEditing, isEditDirty, volumeViewMode,
  filteredVolumes, focusedVolumeId, setFocusedVolumeId, canEdit, canToggle = canEdit, handleToggleVolumeRead,
  handleOpenEditVolume
}) {
  const latest = useRef({});
  latest.current = { isEditDirty, cancelEditing, setEditing };

  // each dialog's state when focus first entered it (the dialog focuses itself on open, before any input)
  const dialogStart = useRef(new WeakMap());
  useEffect(() => {
    const remember = (e) => {
      const dialog = asElement(e.target)?.closest('[role="dialog"]');
      if (dialog && !dialogStart.current.has(dialog)) dialogStart.current.set(dialog, dialogFormState(dialog));
    };
    document.addEventListener('focusin', remember, true);
    return () => document.removeEventListener('focusin', remember, true);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (lightboxData) {
        setLightboxData(null);
        return;
      }
      if (activeVolume) {
        // Escape in a field must not throw away the editor's unsaved input; an untouched editor closes
        if (isTextEntry(e.target) && dialogChanged(dialogStart.current, e.target)) return;
        setActiveVolume(null);
        return;
      }
      if (showBatchModal) {
        setShowBatchModal(false);
        return;
      }
      if (showBatchReadModal) {
        setShowBatchReadModal(false);
        return;
      }
      if (fillingGapNumber !== null) {
        setFillingGapNumber(null);
        return;
      }
      if (showMpEditionModal) {
        setShowMpEditionModal(false);
        return;
      }
      if (editing) {
        const { isEditDirty: dirty, cancelEditing: cancel, setEditing: set } = latest.current;
        if (isTextEntry(e.target) && dirty !== false) return;
        // cancelEditing resets the form: without a dirty flag from the caller, ask rather than lose input
        const mayLoseInput = cancel ? dirty !== false : Boolean(dirty);
        if (mayLoseInput && !confirm(t('Ungespeicherte Änderungen verwerfen?'))) return;
        if (cancel) cancel();
        else set(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxData, activeVolume, showBatchModal, showBatchReadModal, fillingGapNumber, showMpEditionModal, editing,
    setLightboxData, setActiveVolume, setShowBatchModal, setShowBatchReadModal, setFillingGapNumber, setShowMpEditionModal]);

  const viewModeRef = useRef(volumeViewMode);
  useEffect(() => {
    if (viewModeRef.current === volumeViewMode) return;
    viewModeRef.current = volumeViewMode;
    setFocusedVolumeId(null);
  }, [volumeViewMode, setFocusedVolumeId]);

  useEffect(() => {
    if (focusedVolumeId == null) return;
    if (!(filteredVolumes || []).some(v => String(v.id) === String(focusedVolumeId))) setFocusedVolumeId(null);
  }, [filteredVolumes, focusedVolumeId, setFocusedVolumeId]);

  // after J / K: real DOM focus on the spine (ring, scrolling and screen readers follow it)
  const movedByKeyRef = useRef(false);
  useEffect(() => {
    if (!movedByKeyRef.current) return;
    movedByKeyRef.current = false;
    if (focusedVolumeId == null) return;
    const el = document.querySelector(`[data-volume-id="${String(focusedVolumeId).replace(/["\\]/g, '\\$&')}"]`);
    if (!el) return;
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusedVolumeId]);

  useEffect(() => {
    const handleVolumeKeyboardNav = (e) => {
      const modalOpen = Boolean(lightboxData || activeVolume || showBatchModal || showBatchReadModal || fillingGapNumber !== null || showMpEditionModal || editing);
      // without a view mode from the caller, fall back to whether shelf spines are on the page
      const shelfActive = volumeViewMode === undefined ? Boolean(document.querySelector('.manga-spine')) : volumeViewMode === 'spine';
      const action = resolveVolumeShortcut(e, { shelfActive, modalOpen });
      if (!action) return;

      const volList = filteredVolumes || [];
      if (volList.length === 0) return;

      if (action === 'next' || action === 'prev') {
        e.preventDefault();
        const step = action === 'next' ? 1 : -1;
        const currIdx = volList.findIndex(v => String(v.id) === String(focusedVolumeId));
        const nextIdx = currIdx === -1
          ? (step === 1 ? 0 : volList.length - 1)
          : (currIdx + step + volList.length) % volList.length;
        movedByKeyRef.current = true;
        setFocusedVolumeId(volList[nextIdx].id);
        return;
      }

      const spineId = asElement(e.target)?.closest('[data-volume-id]')?.getAttribute('data-volume-id');
      const targetId = spineId ?? focusedVolumeId;
      if (targetId == null) return;
      const targetVol = volList.find(v => String(v.id) === String(targetId));
      if (!targetVol) return;

      e.preventDefault();
      if (action === 'toggleRead') {
        // the read toggle exists only for owned volumes
        if (canToggle && targetVol.status === 'Vorhanden') handleToggleVolumeRead(targetVol);
      } else if (action === 'edit' && canEdit) {
        handleOpenEditVolume(targetVol);
      }
    };
    window.addEventListener('keydown', handleVolumeKeyboardNav);
    return () => window.removeEventListener('keydown', handleVolumeKeyboardNav);
  }, [lightboxData, activeVolume, showBatchModal, showBatchReadModal, fillingGapNumber, showMpEditionModal, editing, volumeViewMode, filteredVolumes, focusedVolumeId, canEdit, canToggle, handleToggleVolumeRead, handleOpenEditVolume, setFocusedVolumeId]);
}
