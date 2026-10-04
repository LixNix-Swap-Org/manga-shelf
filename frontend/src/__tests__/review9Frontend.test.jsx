// LightboxGallery swipe gestures.
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import LightboxGallery from '../components/detail/LightboxGallery';

const IMAGES = ['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/c.jpg'];

function Gallery() {
  const [data, setData] = useState({ title: 'Band 1', subtitle: '', images: IMAGES, currentIndex: 0 });
  return <LightboxGallery lightboxData={data} setLightboxData={setData} onClose={vi.fn()} canEdit={false} />;
}

const shown = () => screen.getByAltText(/^Foto \d$/).getAttribute('src');
const swipe = (from, to, pointerType = 'touch') => {
  const area = screen.getByAltText(/^Foto \d$/).parentElement;
  fireEvent.pointerDown(area, { clientX: from[0], clientY: from[1], pointerType });
  fireEvent.pointerUp(area, { clientX: to[0], clientY: to[1], pointerType });
};

describe('LightboxGallery: swipe', () => {
  it('a horizontal swipe shows the next or previous image, wrapping around', () => {
    render(<Gallery />);
    expect(shown()).toBe(IMAGES[0]);
    swipe([300, 200], [180, 210]);
    expect(shown()).toBe(IMAGES[1]);
    swipe([100, 200], [220, 190]);
    expect(shown()).toBe(IMAGES[0]);
    swipe([100, 200], [220, 190]);
    expect(shown()).toBe(IMAGES[2]);
  });

  it('short, mostly vertical, cancelled and mouse drags change nothing', () => {
    render(<Gallery />);
    swipe([300, 200], [270, 200]);
    swipe([300, 200], [220, 320]);
    swipe([300, 200], [100, 200], 'mouse');
    expect(shown()).toBe(IMAGES[0]);
    const area = screen.getByAltText('Foto 1').parentElement;
    fireEvent.pointerDown(area, { clientX: 300, clientY: 200, pointerType: 'touch' });
    fireEvent.pointerCancel(area);
    fireEvent.pointerUp(area, { clientX: 100, clientY: 200, pointerType: 'touch' });
    expect(shown()).toBe(IMAGES[0]);
    expect(area.className).toContain('touch-pan-y');
  });

  it('arrow keys and buttons still step through the images', () => {
    render(<Gallery />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(shown()).toBe(IMAGES[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Vorheriges Bild' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vorheriges Bild' }));
    expect(shown()).toBe(IMAGES[2]);
  });
});
