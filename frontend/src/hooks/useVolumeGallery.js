import { useState } from 'react';
import { getVolumeDisplayTitle } from '../utils/volumeHelpers';
import { formatMoney } from '../utils/format';
import { editionCurrency } from '../utils/editions';

/** Photo lightbox state for volume covers and extra photos. */
export default function useVolumeGallery({ manga }) {
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

    const price = formatMoney(vol.price, editionCurrency(manga));
    setLightboxData({
      volumeId: vol.id,
      volume: vol,
      title: getVolumeDisplayTitle(vol),
      subtitle: `${manga?.title || ''}${vol.publisher ? ` • ${vol.publisher}` : ''}${price ? ` • ${price}` : ''}`,
      images: allImages,
      currentIndex: Math.max(0, Math.min(startIndex, allImages.length - 1))
    });
  };

  return { lightboxData, setLightboxData, openVolumeGallery };
}
