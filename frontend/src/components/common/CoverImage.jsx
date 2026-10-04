import { useState } from 'react';
import { assetImgProps } from '../../utils/api';

/**
 * Cover <img> that tracks its own failed URLs; `src` may be a candidate list (first non-failed wins, else `fallback`).
 * `onFail(url)` reports a failure; server paths get crossOrigin in the app build (assetImgProps).
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
