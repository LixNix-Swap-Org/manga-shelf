import { useState } from 'react';
import { assetImgProps } from '../../utils/api';

/**
 * Cover <img> that remembers its own failed URLs, so a broken image re-renders only itself. `src` may be a list of
 * candidates (volume cover, then series cover): the first one that has not failed is shown, else `fallback`.
 * Server paths get crossOrigin in the app build (see assetImgProps). `onFail(url)` reports a URL that failed.
 */
export default function CoverImage({ src, alt = '', className, fallback = null, loading = 'lazy', onFail, ...rest }) {
  const [failed, setFailed] = useState(() => new Set());
  const candidates = (Array.isArray(src) ? src : [src]).filter((url) => typeof url === 'string' && url);
  const current = candidates.find((url) => !failed.has(url));
  if (!current) return fallback;
  return (
    <img
      key={current}
      loading={loading}
      decoding="async"
      {...rest}
      {...assetImgProps(current)}
      alt={alt}
      className={className}
      onError={() => {
        setFailed((prev) => new Set(prev).add(current));
        onFail?.(current);
      }}
    />
  );
}
