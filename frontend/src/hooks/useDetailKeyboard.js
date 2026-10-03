import { useEffect } from 'react';

/** Escape closes the topmost dialog, arrows page the lightbox, J / K / Space / E drive the volume list. */
export default function useDetailKeyboard({
  lightboxData, setLightboxData, activeVolume, setActiveVolume, showBatchModal, setShowBatchModal,
  showBatchReadModal, setShowBatchReadModal, fillingGapNumber, setFillingGapNumber,
  showMpEditionModal, setShowMpEditionModal, editing, setEditing,
  filteredVolumes, focusedVolumeId, setFocusedVolumeId, canEdit, handleToggleVolumeRead, handleOpenEditVolume
}) {
  // Keyboard navigation & Escape handling for modals, edit mode and photo gallery lightbox
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (lightboxData) {
          setLightboxData(null);
          return;
        }
        if (activeVolume) {
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
          setEditing(false);
          return;
        }
      }
      // Lightbox arrow keys are handled in LightboxGallery itself (a second handler here skipped every other image)
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxData, activeVolume, showBatchModal, showBatchReadModal, fillingGapNumber, showMpEditionModal, editing]);

  // Desktop keyboard shortcuts (J / K / Space / E) for shelf & volume navigation
  useEffect(() => {
    const handleVolumeKeyboardNav = (e) => {
      const isInputActive = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
      if (isInputActive) return;

      const hasModalOpen = lightboxData || activeVolume || showBatchModal || showBatchReadModal || fillingGapNumber !== null || showMpEditionModal || editing;
      if (hasModalOpen) return;

      const volList = filteredVolumes || [];
      if (volList.length === 0) return;

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        setFocusedVolumeId(prev => {
          if (!prev) return volList[0].id;
          const currIdx = volList.findIndex(v => v.id === prev);
          const nextIdx = (currIdx + 1) % volList.length;
          return volList[nextIdx].id;
        });
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setFocusedVolumeId(prev => {
          if (!prev) return volList[volList.length - 1].id;
          const currIdx = volList.findIndex(v => v.id === prev);
          const nextIdx = (currIdx - 1 + volList.length) % volList.length;
          return volList[nextIdx].id;
        });
      } else if (e.key === ' ' || e.code === 'Space') {
        if (focusedVolumeId) {
          e.preventDefault();
          const targetVol = volList.find(v => v.id === focusedVolumeId);
          if (targetVol && canEdit) {
            handleToggleVolumeRead(targetVol);
          }
        }
      } else if (e.key === 'e' || e.key === 'E') {
        if (focusedVolumeId && canEdit) {
          e.preventDefault();
          const targetVol = volList.find(v => v.id === focusedVolumeId);
          if (targetVol) {
            handleOpenEditVolume(targetVol);
          }
        }
      }
    };
    window.addEventListener('keydown', handleVolumeKeyboardNav);
    return () => window.removeEventListener('keydown', handleVolumeKeyboardNav);
  }, [lightboxData, activeVolume, showBatchModal, showBatchReadModal, fillingGapNumber, showMpEditionModal, editing, filteredVolumes, focusedVolumeId, canEdit, handleToggleVolumeRead, handleOpenEditVolume, setFocusedVolumeId]);
}
