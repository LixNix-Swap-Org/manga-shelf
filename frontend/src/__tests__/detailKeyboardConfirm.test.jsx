// useDetailKeyboard next to a confirmation: J / K / E / Space and Escape stay inert while one is open, and the
// discard question of a dirty series form goes through askConfirm (the app's dialog, not window.confirm).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import useDetailKeyboard from '../hooks/useDetailKeyboard';
import ConfirmDialog from '../components/modals/ConfirmDialog';
import ConfirmHost from '../components/modals/askConfirm';

const VOLS = [
  { id: 1, volume_number: '1', status: 'Vorhanden' },
  { id: 2, volume_number: '2', status: 'Vorhanden' }
];

const key = (target, k) => fireEvent.keyDown(target, { key: k, bubbles: true, cancelable: true });

function Page({ confirmOpen = false, onCancelConfirm = vi.fn(), ...props }) {
  const [focusedVolumeId, setFocusedVolumeId] = useState(null);
  useDetailKeyboard({
    lightboxData: null, setLightboxData: vi.fn(), activeVolume: null, setActiveVolume: vi.fn(),
    showBatchModal: false, setShowBatchModal: vi.fn(), showBatchReadModal: false, setShowBatchReadModal: vi.fn(),
    fillingGapNumber: null, setFillingGapNumber: vi.fn(), showMpEditionModal: false, setShowMpEditionModal: vi.fn(),
    editing: false, setEditing: vi.fn(), filteredVolumes: VOLS, canEdit: true, volumeViewMode: 'spine',
    handleToggleVolumeRead: vi.fn(), handleOpenEditVolume: vi.fn(),
    ...props,
    focusedVolumeId, setFocusedVolumeId
  });
  return (
    <>
      <p data-testid="focused">{String(focusedVolumeId)}</p>
      {VOLS.map((v) => <div key={v.id} className="manga-spine" role="button" tabIndex={0} data-volume-id={v.id}>{`Band ${v.volume_number}`}</div>)}
      <ConfirmDialog isOpen={confirmOpen} title="Reihe löschen?" onConfirm={vi.fn()} onCancel={onCancelConfirm} />
    </>
  );
}

const focused = () => screen.getByTestId('focused').textContent;

beforeEach(() => {
  window.history.replaceState(null, '', '/manga/7');
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  cleanup();
  await act(() => new Promise((r) => setTimeout(r, 200)));
  vi.restoreAllMocks();
});

describe('useDetailKeyboard while a confirmation is open', () => {
  it('J, K, E and Space do nothing behind an open ConfirmDialog; after it closes they work again', () => {
    const handleOpenEditVolume = vi.fn();
    const handleToggleVolumeRead = vi.fn();
    const props = { handleOpenEditVolume, handleToggleVolumeRead };
    const { rerender } = render(<Page confirmOpen {...props} />);
    const cancel = screen.getByRole('button', { name: 'Abbrechen' });
    expect(document.activeElement).toBe(cancel);
    for (const k of ['j', 'k', 'J']) expect(key(cancel, k)).toBe(true);
    expect(focused()).toBe('null');
    expect(document.activeElement).toBe(cancel);
    key(document.body, 'e');
    key(screen.getByText('Band 1'), ' ');
    expect(handleOpenEditVolume).not.toHaveBeenCalled();
    expect(handleToggleVolumeRead).not.toHaveBeenCalled();

    rerender(<Page {...props} />);
    key(document.body, 'j');
    expect(focused()).toBe('1');
    key(document.body, 'e');
    expect(handleOpenEditVolume).toHaveBeenCalledWith(VOLS[0]);
  });

  it('Escape in the confirmation cancels only the confirmation, the series form stays', () => {
    const onCancelConfirm = vi.fn();
    const cancelEditing = vi.fn();
    render(<Page confirmOpen onCancelConfirm={onCancelConfirm} editing isEditDirty={false} cancelEditing={cancelEditing} />);
    key(screen.getByRole('dialog', { name: 'Reihe löschen?' }), 'Escape');
    expect(onCancelConfirm).toHaveBeenCalledTimes(1);
    expect(cancelEditing).not.toHaveBeenCalled();
  });

  it('a dirty series form asks through the app dialog: Escape there keeps the form, "Verwerfen" discards it', async () => {
    const native = vi.spyOn(window, 'confirm');
    const cancelEditing = vi.fn();
    const handleOpenEditVolume = vi.fn();
    render(<><ConfirmHost /><Page editing isEditDirty cancelEditing={cancelEditing} handleOpenEditVolume={handleOpenEditVolume} /></>);

    key(document.body, 'Escape');
    const question = await screen.findByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
    expect(question.textContent).toContain('Deine Eingaben wurden noch nicht gespeichert und gehen verloren.');
    expect(question.hasAttribute('data-confirm')).toBe(true);
    key(document.body, 'e');
    expect(handleOpenEditVolume).not.toHaveBeenCalled();

    key(question, 'Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(cancelEditing).not.toHaveBeenCalled();

    key(document.body, 'Escape');
    fireEvent.click(await screen.findByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(cancelEditing).toHaveBeenCalledTimes(1));
    expect(native).not.toHaveBeenCalled();
  });

  it('a discard confirmed after the form was closed meanwhile does nothing more', async () => {
    const cancelEditing = vi.fn();
    const { rerender } = render(<><ConfirmHost /><Page editing isEditDirty cancelEditing={cancelEditing} /></>);
    key(document.body, 'Escape');
    const discard = await screen.findByRole('button', { name: 'Verwerfen' });
    rerender(<><ConfirmHost /><Page editing={false} isEditDirty={false} cancelEditing={cancelEditing} /></>);
    fireEvent.click(discard);
    await act(async () => {});
    expect(cancelEditing).not.toHaveBeenCalled();
  });
});
