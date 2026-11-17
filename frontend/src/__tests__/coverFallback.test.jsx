import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { installCoverFallback, originalCoverUrl } from '../utils/coverFallback';
import { assetImgProps, coverCachePath } from '../utils/api';

describe('cover fallback', () => {
  let remove = () => {};
  afterEach(() => { remove(); cleanup(); });

  it('reads the original URL of a cover cache address only', () => {
    expect(originalCoverUrl(coverCachePath('https://media.example.org/a.jpg?x=1'))).toBe('https://media.example.org/a.jpg?x=1');
    expect(originalCoverUrl('https://shelf.example.org/api/covers?url=https%3A%2F%2Fcdn.example%2Fb.jpg')).toBe('https://cdn.example/b.jpg');
    expect(originalCoverUrl('/api/covers?url=javascript%3Aalert(1)')).toBeNull();
    expect(originalCoverUrl('/uploads/a.jpg')).toBeNull();
    expect(originalCoverUrl('/api/other?url=https%3A%2F%2Fa.example')).toBeNull();
    expect(originalCoverUrl(null)).toBeNull();
  });

  it('a cover the server cannot serve loads from its host before the own onError runs', () => {
    remove = installCoverFallback(document);
    const onError = vi.fn();
    const { container } = render(<img {...assetImgProps('https://media.example.org/a.jpg')} alt="" onError={onError} />);
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe('/api/covers?url=https%3A%2F%2Fmedia.example.org%2Fa.jpg');
    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe('https://media.example.org/a.jpg');
    expect(onError).not.toHaveBeenCalled();
    fireEvent.error(img);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('other images keep their own error handling', () => {
    remove = installCoverFallback(document);
    const onError = vi.fn();
    const { container } = render(<img src="/uploads/a.jpg" alt="" onError={onError} />);
    fireEvent.error(container.querySelector('img'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img').getAttribute('src')).toBe('/uploads/a.jpg');
  });
});
