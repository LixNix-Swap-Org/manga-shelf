import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import BarcodeScannerButton from '../components/common/BarcodeScannerButton';

describe('BarcodeScannerButton', () => {
  it('names the compact button after buttonText without visible text', () => {
    render(<BarcodeScannerButton compact buttonText="Laden-Scan" onDetected={() => {}} />);
    const button = screen.getByRole('button', { name: 'Laden-Scan' });
    expect(button.textContent).toBe('');
  });

  it('keeps the default name for the compact header button', () => {
    render(<BarcodeScannerButton compact onDetected={() => {}} />);
    expect(screen.getByRole('button', { name: 'Barcode scannen' })).toBeTruthy();
  });

  it('shows the text in the regular mode', () => {
    render(<BarcodeScannerButton buttonText="Scannen" onDetected={() => {}} />);
    expect(screen.getByRole('button', { name: 'Scannen' }).textContent).toBe('Scannen');
  });
});
