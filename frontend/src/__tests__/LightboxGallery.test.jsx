import { describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import VolumePhotoManager, { editorGalleryImages } from '../components/detail/VolumePhotoManager';
import LightboxGallery from '../components/detail/LightboxGallery';
import useDialogA11y from '../hooks/useDialogA11y';

const SAVED = '/uploads/saved.jpg';
const NEW_PHOTO = '/uploads/new-unsaved.jpg';

// Editor stand-in: a z-50 dialog holding the form state, plus the page-level Escape handler of useDetailKeyboard
function Editor({ onEditorEscape }) {
  const [form, setForm] = useState({ volume_number: '3', type: 'volume', cover_image: SAVED, images: [SAVED, NEW_PHOTO] });
  const ref = useDialogA11y(true);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onEditorEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEditorEscape]);
  const noop = () => {};
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Band bearbeiten" tabIndex={-1} className="fixed inset-0 z-50">
      <span data-testid="form-cover">{form.cover_image}</span>
      <VolumePhotoManager
        editVolForm={form}
        handleAddImageUrl={noop}
        handleMoveVolumeImage={noop}
        handleRemoveVolumeImage={noop}
        handleSetVolumeCover={(url) => setForm((prev) => ({ ...prev, cover_image: url }))}
        handleUploadVolumeImages={noop}
        manualImageUrl=""
        setManualImageUrl={noop}
        setShowUrlInput={noop}
        showUrlInput={false}
        uploadingVolImage={false}
      />
    </div>
  );
}

const gallery = () => screen.getByRole('dialog', { name: 'Bildergalerie' });

describe('editorGalleryImages', () => {
  it('keeps the photo order, drops duplicates and empty entries, prepends a cover that is not a photo', () => {
    expect(editorGalleryImages({ cover_image: 'b', images: ['a', 'b', '', null, 'a'] })).toEqual(['a', 'b']);
    expect(editorGalleryImages({ cover_image: 'c', images: ['a', 'b'] })).toEqual(['c', 'a', 'b']);
    expect(editorGalleryImages({ cover_image: '', images: undefined })).toEqual([]);
  });
});

describe('photo preview from the volume editor', () => {
  it('opens a lightbox on top of the editor with the unsaved photos', () => {
    render(<Editor onEditorEscape={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Foto 2 vergrößern' }));
    const box = gallery();
    expect(box.className).toMatch(/\bz-60\b/);
    // portaled to body: a fixed child of the editor would be clipped by its backdrop-filter/transform containing block
    expect(box.parentElement).toBe(document.body);
    expect(screen.getByRole('dialog', { name: 'Band bearbeiten' }).contains(box)).toBe(false);
    expect(within(box).getByAltText('Foto 2').getAttribute('src')).toBe(NEW_PHOTO);
    expect(within(box).getByText('2 / 2')).toBeTruthy();
  });

  it('"Als Cover festlegen" changes only the editor form, no request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<Editor onEditorEscape={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Foto 2 vergrößern' }));
    fireEvent.click(within(gallery()).getByTitle('Dieses Bild als Coverbild für diesen Eintrag festlegen'));
    expect(screen.getByTestId('form-cover').textContent).toBe(NEW_PHOTO);
    expect(within(gallery()).getByText('Aktuelles Cover')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Escape closes only the lightbox and focus returns to the thumbnail', () => {
    const onEditorEscape = vi.fn();
    render(<Editor onEditorEscape={onEditorEscape} />);
    const thumb = screen.getByRole('button', { name: 'Foto 1 vergrößern' });
    thumb.focus();
    fireEvent.click(thumb);
    expect(gallery().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Bildergalerie' })).toBeNull();
    expect(onEditorEscape).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(thumb);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(onEditorEscape).toHaveBeenCalledTimes(1);
  });

  it('arrow keys page through the editor images', () => {
    render(<Editor onEditorEscape={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Foto 1 vergrößern' }));
    expect(within(gallery()).getByText('1 / 2')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(within(gallery()).getByText('2 / 2')).toBeTruthy();
  });
});

describe('LightboxGallery on the detail page', () => {
  it('sets the cover through the API when it has a volumeId and no onSetCover', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onSuccess = vi.fn();
    const data = { volumeId: 7, volume: { id: 7, cover_image: 'a.jpg' }, title: 'Band 1', subtitle: '', images: ['a.jpg', 'b.jpg'], currentIndex: 1 };
    render(<LightboxGallery lightboxData={data} setLightboxData={vi.fn()} onClose={vi.fn()} canEdit onSuccess={onSuccess} />);
    fireEvent.click(screen.getByTitle('Dieses Bild als Coverbild für diesen Eintrag festlegen'));
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/volumes/7');
    expect(JSON.parse(init.body).cover_image).toBe('b.jpg');
  });

  it('hides the cover button for a plain preview without volume', () => {
    const data = { title: 'Vorschau', subtitle: '', images: ['a.jpg'], currentIndex: 0 };
    render(<LightboxGallery lightboxData={data} setLightboxData={vi.fn()} onClose={vi.fn()} canEdit />);
    expect(screen.queryByTitle('Dieses Bild als Coverbild für diesen Eintrag festlegen')).toBeNull();
  });
});
