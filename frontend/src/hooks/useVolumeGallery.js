import { useState } from 'react';
import { getVolumeDisplayTitle } from '../utils/volumeHelpers';

/** Photo lightbox state for volume covers and extra photos. */
export default function useVolumeGallery({ manga, canEdit, fetchManga }) {
  const [lightboxData, setLightboxData] = useState(null);

  const openVolumeGallery = (vol, initialImageOrIndex = 0) => {
    if (!vol) return;
    const allImages = [];
    if (vol.cover_image) allImages.push(vol.cover_image);
    if (Array.isArray(vol.images)) {
      vol.images.forEach(img => {
        if (img && !allImages.includes(img)) allImages.push(img);
      });
    }
    if (allImages.length === 0) return;

    let startIndex = 0;
    if (typeof initialImageOrIndex === 'number') {
      startIndex = initialImageOrIndex;
    } else if (typeof initialImageOrIndex === 'string') {
      const found = allImages.indexOf(initialImageOrIndex);
      if (found !== -1) startIndex = found;
    }

    setLightboxData({
      volumeId: vol.id,
      volume: vol,
      title: getVolumeDisplayTitle(vol),
      subtitle: `${manga?.title || ''}${vol.publisher ? ` • ${vol.publisher}` : ''}${vol.price ? ` • ${vol.price} €` : ''}`,
      images: allImages,
      currentIndex: Math.max(0, Math.min(startIndex, allImages.length - 1))
    });
  };

  const setPreviewImage = (url) => {
    if (!url) {
      setLightboxData(null);
      return;
    }
    const vol = (manga?.volumes || []).find(v => v.cover_image === url || (Array.isArray(v.images) && v.images.includes(url)));
    if (vol) {
      openVolumeGallery(vol, url);
    } else {
      setLightboxData({
        title: manga?.title || 'Vorschau',
        subtitle: 'Foto-Ansicht',
        images: [url],
        currentIndex: 0
      });
    }
  };

  const handleSetCoverFromLightbox = async () => {
    if (!canEdit || !lightboxData || !lightboxData.volumeId) return;
    const currentImg = lightboxData.images[lightboxData.currentIndex];
    if (!currentImg) return;
    try {
      const res = await fetch(`/api/volumes/${lightboxData.volumeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...lightboxData.volume,
          cover_image: currentImg
        })
      });
      if (res.ok) {
        await fetchManga();
        setLightboxData(prev => ({
          ...prev,
          volume: { ...prev.volume, cover_image: currentImg }
        }));
      }
    } catch (e) {
      console.error(e);
    }
  };

  return { lightboxData, setLightboxData, openVolumeGallery, setPreviewImage, handleSetCoverFromLightbox };
}
